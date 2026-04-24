import { useEffect, useRef } from 'react';
import type { Order } from '../services/api';

export interface RiderLocation {
  riderId: number;
  riderName: string | null;
  latitude: number;
  longitude: number;
  updatedAt: string;
}

export interface ShopStatusPayload {
  shopOpen: boolean;
  shopClosedMessage: string;
}

type WsEvent =
  | { type: 'connected' }
  | { type: 'new_order'; payload: Order }
  | { type: 'order_updated'; payload: Order }
  | { type: 'rider_location'; payload: RiderLocation }
  | { type: 'shop_status_changed'; payload: ShopStatusPayload };

interface Handlers {
  onNewOrder: (order: Order) => void;
  onOrderUpdated: (order: Order) => void;
  onRiderLocation?: (loc: RiderLocation) => void;
  onShopStatusChanged?: (status: ShopStatusPayload) => void;
}

const WS_BASE = import.meta.env.VITE_API_URL
  ? (import.meta.env.VITE_API_URL as string).replace(/\/api$/, '').replace(/^http/, 'ws')
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

export function useOrderSocket(handlers: Handlers): void {
  // Keep handlers ref stable so reconnect closure always uses the latest callbacks
  const handlersRef = useRef<Handlers>(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retryDelay = 1000;
    let destroyed = false;

    function connect() {
      if (destroyed) return;

      ws = new WebSocket(`${WS_BASE}/ws`);

      ws.onopen = () => {
        retryDelay = 1000; // reset backoff on successful connect
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const data = JSON.parse(event.data) as WsEvent;
          if (data.type === 'new_order') {
            handlersRef.current.onNewOrder(data.payload);
          } else if (data.type === 'order_updated') {
            handlersRef.current.onOrderUpdated(data.payload);
          } else if (data.type === 'rider_location') {
            handlersRef.current.onRiderLocation?.(data.payload);
          } else if (data.type === 'shop_status_changed') {
            handlersRef.current.onShopStatusChanged?.(data.payload);
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (destroyed) return;
        // Exponential backoff up to 30 s
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      destroyed = true;
      ws?.close();
    };
  }, []); // mount once – handlers are accessed via ref
}
