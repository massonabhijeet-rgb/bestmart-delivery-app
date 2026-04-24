import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import {
  listCustomerDeviceTokens,
  listUserDeviceTokens,
  removeUserDeviceTokens,
} from './db.js';
import type { OrderStatus } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let initialized = false;
let available = false;

function init() {
  if (initialized) return;
  initialized = true;
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  let json: string | null = null;
  if (inline) {
    json = inline;
  } else {
    const file = path.join(__dirname, 'secrets', 'firebase-admin.json');
    try {
      json = readFileSync(file, 'utf8');
    } catch {
      console.warn('[push] firebase service account not found; notifications disabled');
      return;
    }
  }
  try {
    const creds = JSON.parse(json);
    admin.initializeApp({ credential: admin.credential.cert(creds) });
    available = true;
  } catch (error) {
    console.error('[push] failed to init firebase-admin:', error);
  }
}

// FCM sendEachForMulticast caps at 500 tokens per call.
const FCM_MULTICAST_BATCH = 500;

export interface BroadcastResult {
  sentCount: number;
  failedCount: number;
  staleRemoved: number;
}

async function sendToTokens(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<BroadcastResult> {
  init();
  if (!available || tokens.length === 0) {
    return { sentCount: 0, failedCount: 0, staleRemoved: 0 };
  }

  let sent = 0;
  let failed = 0;
  const stale: string[] = [];

  for (let i = 0; i < tokens.length; i += FCM_MULTICAST_BATCH) {
    const batch = tokens.slice(i, i + FCM_MULTICAST_BATCH);
    const response = await admin.messaging().sendEachForMulticast({
      tokens: batch,
      notification: { title, body },
      data: data ?? {},
      apns: { payload: { aps: { sound: 'default' } } },
      android: { priority: 'high' },
    });
    sent += response.successCount;
    failed += response.failureCount;
    response.responses.forEach((r, idx) => {
      if (r.error) {
        const code = r.error.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-argument' ||
          code === 'messaging/invalid-registration-token'
        ) {
          stale.push(batch[idx]);
        }
      }
    });
  }

  if (stale.length > 0) {
    await removeUserDeviceTokens(stale);
  }
  return { sentCount: sent, failedCount: failed, staleRemoved: stale.length };
}

async function sendToUser(
  userId: number,
  title: string,
  body: string,
  data?: Record<string, string>
) {
  const tokens = await listUserDeviceTokens(userId);
  await sendToTokens(tokens, title, body, data);
}

export async function broadcastToCustomers(
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<BroadcastResult> {
  const tokens = await listCustomerDeviceTokens();
  return sendToTokens(tokens, title, body, data);
}

export async function notifyCustomerById(
  userId: number,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<BroadcastResult> {
  const tokens = await listUserDeviceTokens(userId);
  return sendToTokens(tokens, title, body, data);
}

export async function notifyRiderAssigned(params: {
  riderUserId: number;
  publicId: string;
  customerName: string;
  deliveryAddress: string;
}) {
  try {
    const tokens = await listUserDeviceTokens(params.riderUserId);
    if (tokens.length === 0) return;
    const body = `${params.customerName} · ${params.deliveryAddress}`;
    await sendToTokens(tokens, `New delivery: ${params.publicId}`, body, {
      type: 'rider_order_assigned',
      orderId: params.publicId,
    });
  } catch (error) {
    console.error('[push] notifyRiderAssigned failed:', error);
  }
}

interface StatusCopy {
  title: string;
  body: (id: string, otp?: string | null) => string;
}

const ORDER_STATUS_COPY: Partial<Record<OrderStatus, StatusCopy>> = {
  placed: {
    title: 'Order placed',
    body: (id) => `We got your order #${id}. We\u2019ll prep it shortly.`,
  },
  confirmed: {
    title: 'Order confirmed',
    body: (id) => `Order #${id} is confirmed and being prepared.`,
  },
  packing: {
    title: 'Packing your order',
    body: (id) => `Order #${id} is being packed.`,
  },
  out_for_delivery: {
    title: 'Out for delivery',
    body: (id, otp) =>
      otp
        ? `Order #${id} is on the way. Share OTP ${otp} with your rider to complete delivery.`
        : `Order #${id} is on the way.`,
  },
  delivered: {
    title: 'Delivered',
    body: (id) => `Order #${id} has arrived. Enjoy!`,
  },
  cancelled: {
    title: 'Order cancelled',
    body: (id) => `Order #${id} was cancelled.`,
  },
};

export async function notifyOrderItemRejected(params: {
  userId: number | null | undefined;
  publicId: string;
  productName: string;
  reason: string;
}) {
  if (!params.userId) return;
  try {
    const body = params.reason
      ? `${params.productName} was removed from order #${params.publicId}. Reason: ${params.reason}`
      : `${params.productName} was removed from order #${params.publicId}.`;
    await sendToUser(
      params.userId,
      'Item removed from your order',
      body,
      {
        type: 'order_item_rejected',
        orderId: params.publicId,
        productName: params.productName,
        reason: params.reason,
      }
    );
  } catch (error) {
    console.error('[push] notifyOrderItemRejected failed:', error);
  }
}

export async function notifyOrderStatus(params: {
  userId: number | null | undefined;
  publicId: string;
  status: OrderStatus;
  deliveryOtp?: string | null;
}) {
  if (!params.userId) return;
  const copy = ORDER_STATUS_COPY[params.status];
  if (!copy) return;
  try {
    const data: Record<string, string> = {
      type: 'order_status',
      orderId: params.publicId,
      status: params.status,
    };
    if (params.deliveryOtp) data.deliveryOtp = params.deliveryOtp;
    await sendToUser(
      params.userId,
      copy.title,
      copy.body(params.publicId, params.deliveryOtp ?? null),
      data
    );
  } catch (error) {
    console.error('[push] notifyOrderStatus failed:', error);
  }
}
