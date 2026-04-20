import { Router } from 'express';
import { attachUserIfPresent } from '../middleware/auth.js';
import {
  createRazorpayOrder,
  razorpayConfigured,
  razorpayPublicKey,
  verifyRazorpaySignature,
} from '../razorpay.js';
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

export default router;
