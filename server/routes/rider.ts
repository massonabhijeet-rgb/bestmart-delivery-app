import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import {
  acceptRiderOrder,
  attachRazorpayQrToOrder,
  getOrderByPublicId,
  getOrderOwnerUserId,
  listRiderOrders,
  setRiderAvailability,
  updateOrderStatus,
} from '../db.js';
import { maybeRefreshRouteForRider } from '../googleMaps.js';
import { notifyOrderStatus } from '../push.js';
import { createRazorpayQrCode, razorpayConfigured } from '../razorpay.js';
import { broadcast, updateRiderLocation } from '../ws.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

function getRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

router.get(
  '/orders',
  authenticateToken,
  requireRole('rider'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const orders = await listRiderOrders(req.user.id);
    return res.json({ orders });
  }
);

router.post(
  '/orders/:publicId/accept',
  authenticateToken,
  requireRole('rider'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const publicId = getRouteParam(req.params.publicId);
      if (!publicId) {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      const existing = await getOrderByPublicId(publicId);
      if (!existing) {
        return res.status(404).json({ error: 'Order not found' });
      }
      if (existing.assignedRiderUserId !== req.user.id) {
        return res.status(403).json({ error: 'This order is not assigned to you' });
      }
      if (existing.status === 'delivered' || existing.status === 'cancelled') {
        return res.status(400).json({ error: 'Order is already closed' });
      }

      const order = await acceptRiderOrder(publicId, req.user.id);
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }
      broadcast({ type: 'order_updated', payload: order });
      return res.json({ order });
    } catch (error) {
      console.error('Rider accept error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/orders/:publicId/deliver',
  authenticateToken,
  requireRole('rider'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const publicId = getRouteParam(req.params.publicId);
      if (!publicId) {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      const { otp: rawOtp } = (req.body ?? {}) as { otp?: string };
      const otp = typeof rawOtp === 'string' ? rawOtp.trim() : '';

      const existing = await getOrderByPublicId(publicId);
      if (!existing) {
        return res.status(404).json({ error: 'Order not found' });
      }
      if (existing.assignedRiderUserId !== req.user.id) {
        return res.status(403).json({ error: 'This order is not assigned to you' });
      }
      if (!existing.riderAcceptedAt) {
        return res.status(400).json({ error: 'Accept the order before marking it delivered' });
      }
      if (existing.status === 'delivered' || existing.status === 'cancelled') {
        return res.status(400).json({ error: 'Order is already closed' });
      }
      if (!existing.deliveryOtp) {
        return res.status(400).json({
          error: 'This order has no delivery OTP. Ask the admin to dispatch it again.',
        });
      }
      if (otp !== existing.deliveryOtp) {
        return res.status(400).json({ error: 'Incorrect delivery OTP' });
      }

      const order = await updateOrderStatus(
        publicId,
        existing.companyId,
        'delivered',
        existing.assignedRiderUserId
      );

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      broadcast({ type: 'order_updated', payload: order });

      const ownerId = await getOrderOwnerUserId(publicId);
      void notifyOrderStatus({
        userId: ownerId,
        publicId: order.publicId,
        status: 'delivered',
      });

      return res.json({ order });
    } catch (error) {
      console.error('Rider deliver error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Rider-initiated UPI collection: mints a Razorpay QR (fixed-amount,
// single-use) tied to the order. The rider shows the QR on their device
// to the customer, who scans + pays with any UPI app. On
// `qr_code.credited` the webhook flips payment_status to paid and (since
// the rider is already on site) advances the order to delivered.
router.post(
  '/orders/:publicId/collect-upi',
  authenticateToken,
  requireRole('rider'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!razorpayConfigured()) {
        return res.status(503).json({ error: 'UPI collection is not available right now.' });
      }
      const publicId = getRouteParam(req.params.publicId);
      if (!publicId) {
        return res.status(400).json({ error: 'Order ID is required' });
      }
      const existing = await getOrderByPublicId(publicId);
      if (!existing) {
        return res.status(404).json({ error: 'Order not found' });
      }
      if (existing.assignedRiderUserId !== req.user.id) {
        return res.status(403).json({ error: 'This order is not assigned to you' });
      }
      if (!existing.riderAcceptedAt) {
        return res.status(400).json({ error: 'Accept the order before collecting payment' });
      }
      if (existing.status === 'delivered' || existing.status === 'cancelled') {
        return res.status(400).json({ error: 'Order is already closed' });
      }
      if (existing.paymentStatus === 'paid') {
        return res.status(400).json({ error: 'This order is already paid' });
      }

      const qr = await createRazorpayQrCode({
        amountCents: existing.totalCents,
        description: `BestMart order ${existing.publicId}`,
        notes: { orderId: existing.publicId },
      });

      await attachRazorpayQrToOrder(existing.publicId, existing.companyId, qr.id);

      return res.json({
        qrId: qr.id,
        qrImageUrl: qr.imageUrl,
        amountCents: qr.amountCents,
      });
    } catch (error) {
      console.error('Rider collect-upi error:', error);
      const message = error instanceof Error ? error.message : 'Unable to generate UPI QR';
      return res.status(500).json({ error: message });
    }
  }
);

router.patch(
  '/availability',
  authenticateToken,
  requireRole('rider'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const { available } = req.body as { available?: boolean };
    if (typeof available !== 'boolean') {
      return res.status(400).json({ error: 'available (boolean) is required' });
    }
    await setRiderAvailability(req.user.id, available);
    return res.json({ ok: true, available });
  }
);

router.patch(
  '/location',
  authenticateToken,
  requireRole('rider'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const { latitude, longitude } = req.body as { latitude?: number; longitude?: number };
    if (
      typeof latitude !== 'number' || typeof longitude !== 'number' ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
    ) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }
    updateRiderLocation({
      riderId: req.user.id,
      riderName: req.user.fullName,
      latitude,
      longitude,
      updatedAt: new Date().toISOString(),
    });
    // Fire-and-forget: (re)cache driving route for this rider's active
    // deliveries. Throttled by distance inside the helper so most pings are
    // no-ops.
    void maybeRefreshRouteForRider(req.user.id, latitude, longitude);
    return res.json({ ok: true });
  }
);

export default router;
