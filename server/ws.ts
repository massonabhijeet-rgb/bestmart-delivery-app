import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import { findUserByUid, setRiderAvailability } from './db.js';
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

export type WsEvent =
  | { type: 'connected' }
  | { type: 'new_order'; payload: OrderRecord }
  | { type: 'order_updated'; payload: OrderRecord }
  | { type: 'rider_location'; payload: RiderLocation }
  | { type: 'shop_status_changed'; payload: ShopStatusPayload };

// In-memory cache so newly connected admins can get last-known positions
const riderLocations = new Map<number, RiderLocation>();

export function updateRiderLocation(loc: RiderLocation): void {
  riderLocations.set(loc.riderId, loc);
  broadcast({ type: 'rider_location', payload: loc });
}

export function getRiderLocations(): RiderLocation[] {
  return [...riderLocations.values()];
}

// Tagged socket: we stash the authenticated rider's userId so we can flip
// is_available=false when the socket closes (app killed, network lost, etc.)
// without waiting for a mobile-lifecycle beacon that may never arrive.
interface TaggedSocket extends WebSocket {
  riderUserId?: number;
}

const clients = new Set<TaggedSocket>();

async function authenticateUpgrade(req: IncomingMessage): Promise<{
  userId: number;
  role: string;
} | null> {
  try {
    // Token travels as ?token= because browsers can't set custom headers on
    // WebSocket handshakes. This is a normal pattern for ws auth.
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET) as { uid: string };
    const user = await findUserByUid(payload.uid);
    if (!user) return null;
    return { userId: user.id, role: user.role };
  } catch {
    return null;
  }
}

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws: TaggedSocket, req: IncomingMessage) => {
    clients.add(ws);

    // Auth is optional: anonymous clients (admin web, customer app) keep
    // working as broadcast listeners. Authenticated rider clients get tagged
    // so we can mark them offline on disconnect.
    const auth = await authenticateUpgrade(req);
    if (auth && auth.role === 'rider') {
      ws.riderUserId = auth.userId;
    }

    ws.send(JSON.stringify({ type: 'connected' } satisfies WsEvent));

    // Push last-known rider positions to the newly connected client
    for (const loc of riderLocations.values()) {
      ws.send(JSON.stringify({ type: 'rider_location', payload: loc } satisfies WsEvent));
    }

    ws.on('close', () => {
      clients.delete(ws);
      if (ws.riderUserId !== undefined) {
        void setRiderAvailability(ws.riderUserId, false).catch((err) =>
          console.error('Failed to mark rider offline on ws close:', err)
        );
      }
    });
    ws.on('error', () => {
      ws.terminate();
      clients.delete(ws);
      if (ws.riderUserId !== undefined) {
        void setRiderAvailability(ws.riderUserId, false).catch((err) =>
          console.error('Failed to mark rider offline on ws error:', err)
        );
      }
    });
  });

  console.log('WebSocket server attached at /ws');
}

export function broadcast(event: WsEvent): void {
  const msg = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}
