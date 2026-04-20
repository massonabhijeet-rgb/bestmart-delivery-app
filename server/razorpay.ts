import { createHmac } from 'crypto';

// Placeholder-safe: if keys are missing we still boot, but the payments
// routes return 503. Drop real keys into .env before going live.
const KEY_ID = process.env.RAZORPAY_KEY_ID ?? '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';

export function razorpayConfigured() {
  return Boolean(KEY_ID && KEY_SECRET);
}

export function razorpayPublicKey() {
  return KEY_ID;
}

interface CreateOrderArgs {
  amountCents: number;
  currency?: string;
  receipt: string;
  notes?: Record<string, string>;
}

interface RazorpayOrderResponse {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

export async function createRazorpayOrder(args: CreateOrderArgs): Promise<RazorpayOrderResponse> {
  if (!razorpayConfigured()) {
    throw new Error('Razorpay is not configured on the server.');
  }
  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      amount: args.amountCents,
      currency: args.currency ?? 'INR',
      receipt: args.receipt,
      notes: args.notes ?? {},
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Razorpay order creation failed: ${res.status} ${text}`);
  }
  return (await res.json()) as RazorpayOrderResponse;
}

// Official signature format: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
export function verifyRazorpaySignature(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}) {
  if (!razorpayConfigured()) return false;
  const expected = createHmac('sha256', KEY_SECRET)
    .update(`${params.razorpayOrderId}|${params.razorpayPaymentId}`)
    .digest('hex');
  return expected === params.razorpaySignature;
}

export function verifyWebhookSignature(rawBody: string, signature: string) {
  if (!WEBHOOK_SECRET) return false;
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  return expected === signature;
}
