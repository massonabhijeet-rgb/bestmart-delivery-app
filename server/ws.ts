import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { OrderRecord } from './db.js';

export type RiderLocation = {
  riderId: number;
  riderName: string | null;
  latitude: number;
  longitude: number;
  updatedAt: string;
};

export type WsEvent =
  | { type: 'connected' }
  | { type: 'new_order'; payload: OrderRecord }
  | { type: 'order_updated'; payload: OrderRecord }
  | { type: 'rider_location'; payload: RiderLocation };

// In-memory cache so newly connected admins can get last-known positions
const riderLocations = new Map<number, RiderLocation>();

export function updateRiderLocation(loc: RiderLocation): void {
  riderLocations.set(loc.riderId, loc);
  broadcast({ type: 'rider_location', payload: loc });
}

export function getRiderLocations(): RiderLocation[] {
  return [...riderLocations.values()];
}

const clients = new Set<WebSocket>();

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);

    ws.send(JSON.stringify({ type: 'connected' } satisfies WsEvent));

    // Push last-known rider positions to the newly connected client
    for (const loc of riderLocations.values()) {
      ws.send(JSON.stringify({ type: 'rider_location', payload: loc } satisfies WsEvent));
    }

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => {
      ws.terminate();
      clients.delete(ws);
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
