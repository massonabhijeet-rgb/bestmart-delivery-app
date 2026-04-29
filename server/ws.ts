import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import { findUserByUid, listRiders } from './db.js';
import type { OrderRecord } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'bestmart-secret-key-2026';

export type RiderLocation = {
  riderId: number;
  riderName: string | null;
  latitude: number;
  longitude: number;
  updatedAt: string;
};

export type ShopStatusPayload = {
  shopOpen: boolean;
  shopClosedMessage: string;
};

export type RiderRosterEntry = {
  id: number;
  uid: string;
  email: string;
  fullName: string | null;
  phone: string | null;
  // Sticky — flips only when the rider explicitly toggles in their app.
  // Survives WS disconnects, screen locks, app backgrounding.
  isAvailable: boolean;
  // Live WS presence indicator (green dot in the picker). Not a dispatch
  // gate — purely informational.
  isOnline: boolean;
  // True when at least one FCM token is registered for this rider. With
  // FCM as the primary dispatch channel, this means push notifications
  // can wake the app even if it's killed/suspended. Either `isOnline` OR
  // `hasDeviceToken` is enough for dispatch eligibility.
  hasDeviceToken: boolean;
};

export type RiderRosterPayload = {
  companyId: number;
  riders: RiderRosterEntry[];
};

// Fired by the rider-assignment sweep when a rider didn't accept in
// time. Gives the admin dashboard enough context to show a toast that
// reads either "Rider X didn't accept; reassigned to Rider Y" or
// "Rider X didn't accept; no riders available". Order is also pushed
// via order_updated immediately before this so the order list itself
// is already up to date when the toast fires.
export type RiderReassignedPayload = {
  publicId: string;
  companyId: number;
  customerName: string | null;
  previousRiderName: string | null;
  newRiderName: string | null;
};

export type WsEvent =
  | { type: 'connected' }
  | { type: 'new_order'; payload: OrderRecord }
  | { type: 'order_updated'; payload: OrderRecord }
  | { type: 'rider_location'; payload: RiderLocation }
  | { type: 'shop_status_changed'; payload: ShopStatusPayload }
  | { type: 'rider_roster_changed'; payload: RiderRosterPayload }
  | { type: 'rider_reassigned'; payload: RiderReassignedPayload };

// In-memory cache so newly connected admins can get last-known positions
const riderLocations = new Map<number, RiderLocation>();

export function updateRiderLocation(loc: RiderLocation): void {
  riderLocations.set(loc.riderId, loc);
  broadcast({ type: 'rider_location', payload: loc });
}

export function getRiderLocations(): RiderLocation[] {
  return [...riderLocations.values()];
}

/// Last-known location for a single rider, or null if we've never
/// received a ping from them this server uptime. Used by the track
/// endpoint so customers see the rider on the map the instant the
/// page opens, instead of waiting up to 10s for the next WS ping.
export function getRiderLocation(riderUserId: number): RiderLocation | null {
  return riderLocations.get(riderUserId) ?? null;
}

// Tagged socket: stashes auth context so we can (a) flip rider availability
// off on socket close (app killed / network lost) and (b) scope roster
// broadcasts to admins/editors of the same company.
interface TaggedSocket extends WebSocket {
  riderUserId?: number;
  companyId?: number;
  role?: string;
}

const clients = new Set<TaggedSocket>();

async function authenticateUpgrade(req: IncomingMessage): Promise<{
  userId: number;
  role: string;
  companyId: number;
} | null> {
  try {
    // Token travels as ?token= because browsers can't set custom headers on
    // WebSocket handshakes. This is a normal pattern for ws auth.
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET) as { uid: string; sid?: string };
    const user = await findUserByUid(payload.uid);
    if (!user) return null;
    // Single-sign-on: reject WS handshakes from old sessions just like
    // the HTTP auth middleware does.
    if (user.sessionId && payload.sid !== user.sessionId) return null;
    return { userId: user.id, role: user.role, companyId: user.companyId };
  } catch {
    return null;
  }
}

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws: TaggedSocket, req: IncomingMessage) => {
    clients.add(ws);

    // Auth is optional: anonymous clients (customer app, public track page)
    // keep working as broadcast listeners. Authenticated clients get tagged
    // so we can (a) mark riders offline on disconnect and (b) deliver
    // company-scoped events (rider roster) only to that company's staff.
    const auth = await authenticateUpgrade(req);
    if (auth) {
      ws.companyId = auth.companyId;
      ws.role = auth.role;
      if (auth.role === 'rider') {
        ws.riderUserId = auth.userId;
      }
    }

    ws.send(JSON.stringify({ type: 'connected' } satisfies WsEvent));

    // Push last-known rider positions to the newly connected client
    for (const loc of riderLocations.values()) {
      ws.send(JSON.stringify({ type: 'rider_location', payload: loc } satisfies WsEvent));
    }

    // Sticky availability: a WS disconnect (app backgrounded, screen
    // locked, network blip) does NOT flip is_available=false. The rider's
    // toggle is the source of truth — disconnect just affects `isOnline`
    // (live presence). FCM push is the primary dispatch channel; it can
    // wake the app even when the WS is gone, so backgrounded riders stay
    // reachable. This is the Uber/Swiggy-style architecture.
    ws.on('close', () => {
      clients.delete(ws);
      if (ws.riderUserId !== undefined && ws.companyId !== undefined) {
        // Re-broadcast so the green dot in the dashboard's picker drops
        // even though `is_available` itself didn't change.
        void broadcastRiderRoster(ws.companyId);
      }
    });
    ws.on('error', () => {
      ws.terminate();
      clients.delete(ws);
      if (ws.riderUserId !== undefined && ws.companyId !== undefined) {
        void broadcastRiderRoster(ws.companyId);
      }
    });
  });

  console.log('WebSocket server attached at /ws');
}

export function broadcast(event: WsEvent): void {
  // Per-order customer rating is admin-only — strip it from any payload
  // headed to a rider socket. Riders also shouldn't see it via REST
  // (handled separately in routes/rider.ts), this is the WS leg.
  const fullMsg = JSON.stringify(event);
  let riderMsg: string | null = null;
  if (event.type === 'order_updated' || event.type === 'new_order') {
    const { riderRating: _ignored, ...stripped } = event.payload;
    void _ignored;
    riderMsg = JSON.stringify({ type: event.type, payload: stripped });
  }
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const msg = riderMsg !== null && client.role === 'rider' ? riderMsg : fullMsg;
    client.send(msg);
  }
}

/// User IDs of riders whose mobile app currently has an open WS to this
/// server. Used to annotate the roster with `isOnline` so the dashboard
/// can distinguish a rider who toggled themselves available from one
/// whose phone is actually reachable right now.
export function getConnectedRiderIds(): Set<number> {
  const ids = new Set<number>();
  for (const c of clients) {
    if (c.riderUserId !== undefined && c.readyState === WebSocket.OPEN) {
      ids.add(c.riderUserId);
    }
  }
  return ids;
}

/// Pushes the fresh available-rider roster to every admin/editor socket of
/// the same company. Call this after any mutation that flips rider
/// availability — toggle from rider mobile app, dashboard-side change, or
/// rider WS disconnect — so the dispatch dropdown stays live without
/// requiring a manual reload.
export async function broadcastRiderRoster(companyId: number): Promise<void> {
  let raw: Awaited<ReturnType<typeof listRiders>>;
  try {
    raw = await listRiders(companyId, { onlyAvailable: true });
  } catch (err) {
    console.error('broadcastRiderRoster: listRiders failed', err);
    return;
  }
  const connected = getConnectedRiderIds();
  const riders: RiderRosterEntry[] = raw.map((r) => ({
    ...r,
    isOnline: connected.has(r.id),
  }));
  const msg = JSON.stringify({
    type: 'rider_roster_changed',
    payload: { companyId, riders },
  } satisfies WsEvent);
  for (const client of clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.companyId === companyId &&
      (client.role === 'admin' || client.role === 'editor')
    ) {
      client.send(msg);
    }
  }
}
