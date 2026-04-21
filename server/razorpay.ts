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

// Razorpay S2S UPI Intent: create a UPI payment directly against an existing
// Razorpay order. The response carries an `intent_url` that, when opened on
// a mobile device, launches the specified UPI app (PhonePe / GPay / Paytm)
// with the amount pre-filled. Standard Checkout is bypassed entirely — the
// customer never sees a Razorpay screen.
interface CreateUpiIntentArgs {
  razorpayOrderId: string;
  amountCents: number;
  currency?: string;
  email?: string;
  contact?: string;
  upiApp: 'phonepe' | 'google_pay' | 'paytm';
  description?: string;
}

interface RazorpayUpiIntentResponse {
  razorpay_payment_id?: string;
  intent_url?: string;
  data?: { intent_url?: string };
  // Some API versions nest it differently — we read both shapes below.
  [key: string]: unknown;
}

// Dynamic UPI QR: rider shows this to the customer in person so they can
// scan with any UPI app. Fixed amount, single-use — the QR auto-closes
// once Razorpay captures the payment and fires `qr_code.credited`.
interface CreateQrCodeArgs {
  amountCents: number;
  name?: string;
  description?: string;
  notes?: Record<string, string>;
}

interface RazorpayQrCodeResponse {
  id: string;
  entity: 'qr_code';
  image_url: string;
  short_url?: string;
  status: string;
  payment_amount: number;
  notes?: Record<string, string>;
}

export async function createRazorpayQrCode(args: CreateQrCodeArgs): Promise<{
  id: string;
  imageUrl: string;
  amountCents: number;
}> {
  if (!razorpayConfigured()) {
    throw new Error('Razorpay is not configured on the server.');
  }
  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/payments/qr_codes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      type: 'upi_qr',
      name: args.name ?? 'BestMart',
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: args.amountCents,
      description: args.description ?? 'BestMart order',
      notes: args.notes ?? {},
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Razorpay QR create failed: ${res.status} ${text}`);
  }
  const payload = (await res.json()) as RazorpayQrCodeResponse;
  return {
    id: payload.id,
    imageUrl: payload.image_url,
    amountCents: payload.payment_amount,
  };
}

export async function createUpiIntentPayment(args: CreateUpiIntentArgs): Promise<{
  paymentId: string | null;
  intentUrl: string;
}> {
  if (!razorpayConfigured()) {
    throw new Error('Razorpay is not configured on the server.');
  }
  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  const body = {
    amount: args.amountCents,
    currency: args.currency ?? 'INR',
    order_id: args.razorpayOrderId,
    email: args.email ?? 'customer@bestmart.in',
    contact: args.contact ?? '9999999999',
    method: 'upi',
    description: args.description ?? 'BestMart order',
    upi: {
      flow: 'intent',
      upi_app: args.upiApp,
    },
  };
  const res = await fetch('https://api.razorpay.com/v1/payments/create/upi', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Razorpay UPI intent create failed: ${res.status} ${text}`);
  }
  const payload = (await res.json()) as RazorpayUpiIntentResponse;
  const intentUrl =
    (typeof payload.intent_url === 'string' && payload.intent_url) ||
    (payload.data && typeof payload.data.intent_url === 'string' ? payload.data.intent_url : '');
  if (!intentUrl) {
    throw new Error('Razorpay did not return an intent URL for this UPI app.');
  }
  const paymentId =
    (typeof payload.razorpay_payment_id === 'string' && payload.razorpay_payment_id) ||
    null;
  return { paymentId, intentUrl };
}
