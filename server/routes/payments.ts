import { Router } from 'express';
import { attachUserIfPresent } from '../middleware/auth.js';
import {
  createRazorpayOrder,
  createUpiIntentPayment,
  razorpayConfigured,
  razorpayPublicKey,
  verifyRazorpaySignature,
  verifyWebhookSignature,
} from '../razorpay.js';
import {
  getOrderByPublicId,
  markOrderPaidByRazorpayOrderId,
} from '../db.js';
import { broadcast } from '../ws.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

// Public: lets the checkout UI know whether online payment is usable.
router.get('/config', (_req, res) => {
  return res.json({
    enabled: razorpayConfigured(),
    keyId: razorpayConfigured() ? razorpayPublicKey() : null,
  });
});

// Create a Razorpay order for the current cart total. The frontend passes
// the amount it has already shown the customer; the backend re-validates
// final totals when the real order is committed via POST /orders.
router.post('/create-order', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  try {
    if (!razorpayConfigured()) {
      return res.status(503).json({ error: 'Online payments are not available right now.' });
    }
    const body = (req.body ?? {}) as { amountCents?: number; currency?: string };
    const amount = Math.round(Number(body.amountCents ?? 0));
    if (!Number.isFinite(amount) || amount < 100) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const receipt = `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const order = await createRazorpayOrder({
      amountCents: amount,
      currency: body.currency ?? 'INR',
      receipt,
      notes: req.user?.id ? { userId: String(req.user.id) } : undefined,
    });
    return res.json({
      razorpayOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: razorpayPublicKey(),
    });
  } catch (error) {
    console.error('[payments] create-order failed:', error);
    return res.status(500).json({ error: 'Unable to start payment' });
  }
});

// Signature verification so clients (or curl) can confirm a payment
// outside the order-create flow. The POST /orders handler re-runs this
// before committing, so this route is mostly diagnostic.
router.post('/verify', attachUserIfPresent, (req: AuthenticatedRequest, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = (req.body ?? {}) as {
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    razorpaySignature?: string;
  };
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ error: 'Missing payment fields' });
  }
  const ok = verifyRazorpaySignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });
  return res.json({ verified: ok });
});

// Blinkit-style direct UPI launch: look up the pending order, ask Razorpay
// to mint a UPI intent URL for the chosen app, and hand the URL back to the
// client so it can `window.location` / url_launcher straight into PhonePe /
// GPay / Paytm. The real payment confirmation lands on POST /webhook.
router.post('/upi-intent', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  try {
    if (!razorpayConfigured()) {
      return res.status(503).json({ error: 'Online payments are not available right now.' });
    }
    const { publicOrderId, upiApp } = (req.body ?? {}) as {
      publicOrderId?: string;
      upiApp?: string;
    };
    const allowedApps = ['phonepe', 'google_pay', 'paytm'] as const;
    if (!publicOrderId || !upiApp || !allowedApps.includes(upiApp as (typeof allowedApps)[number])) {
      return res.status(400).json({ error: 'Invalid UPI intent request' });
    }
    const order = await getOrderByPublicId(publicOrderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (!order.razorpayOrderId) {
      return res.status(400).json({ error: 'Order is not tied to a Razorpay payment' });
    }
    if (order.paymentStatus === 'paid') {
      return res.status(400).json({ error: 'Order is already paid' });
    }
    const result = await createUpiIntentPayment({
      razorpayOrderId: order.razorpayOrderId,
      amountCents: order.totalCents,
      upiApp: upiApp as (typeof allowedApps)[number],
      email: order.customerEmail ?? undefined,
      contact: order.customerPhone ?? undefined,
      description: `BestMart order ${order.publicId}`,
    });
    return res.json({
      intentUrl: result.intentUrl,
      paymentId: result.paymentId,
    });
  } catch (error) {
    console.error('[payments] upi-intent failed:', error);
    const raw = error instanceof Error ? error.message : 'Unable to launch UPI payment';
    return res.status(500).json({ error: raw });
  }
});

// Razorpay webhook — signature is over the RAW body bytes, so this route
// must be mounted with express.raw() (see server/index.ts). We only care
// about `payment.captured` for now; everything else is acked and ignored.
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.header('x-razorpay-signature') ?? '';
    const raw = req.body;
    const rawText =
      Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : typeof raw === 'string'
          ? raw
          : JSON.stringify(raw ?? {});
    if (!verifyWebhookSignature(rawText, signature)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    const payload = JSON.parse(rawText) as {
      event?: string;
      payload?: {
        payment?: {
          entity?: {
            id?: string;
            order_id?: string;
          };
        };
      };
    };
    if (payload.event === 'payment.captured') {
      const entity = payload.payload?.payment?.entity;
      const razorpayOrderId = entity?.order_id;
      const razorpayPaymentId = entity?.id;
      if (razorpayOrderId && razorpayPaymentId) {
        const order = await markOrderPaidByRazorpayOrderId(
          razorpayOrderId,
          razorpayPaymentId,
          null
        );
        if (order) {
          broadcast({ type: 'order_updated', payload: order });
        }
      }
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error('[payments] webhook failed:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
