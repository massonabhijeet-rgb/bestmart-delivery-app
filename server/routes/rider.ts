import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import {
  acceptRiderOrder,
  attachRazorpayQrToOrder,
  getOrderByPublicId,
  getOrderOwnerUserId,
  getRiderArrivalContext,
  getRiderAvailability,
  getRiderStats,
  listRiderOrders,
  markOrderArrivalNotified,
  setRiderAvailability,
  updateOrderStatus,
} from '../db.js';
import { maybeRefreshRouteForRider } from '../googleMaps.js';
import { notifyCustomerById, notifyOrderStatus } from '../push.js';
import { createRazorpayQrCode, razorpayConfigured } from '../razorpay.js';
import { broadcast, broadcastRiderRoster, updateRiderLocation } from '../ws.js';

/// Great-circle distance between two lat/lng points in meters. Standard
/// haversine — accurate to a meter or two at the scales we care about
/// (last-mile delivery, < 5 km), which is what the proximity push uses.
function haversineMeters(
  lat1: number, lng1: number, lat2: number, lng2: number,
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/// "At your doorstep" radius — the rider's GPS first reading inside this
/// radius triggers the arrival push. 25m balances false-positives (multi-
/// floor buildings, GPS jitter parking next door) against waiting too
/// long (50m can mean "still on the bike one block away").
const ARRIVAL_RADIUS_METERS = 25;
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

function getRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/// Strips fields the rider isn't allowed to see (per-order customer
/// rating belongs to admin reporting, not the rider's own surface).
/// Defense-in-depth: the rider Flutter model also doesn't parse the
/// field, but stripping at the wire keeps it out of network logs.
function stripForRider<T extends { riderRating?: unknown }>(order: T): T {
  const { riderRating: _ignored, ...rest } = order;
  void _ignored;
  return rest as T;
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
    return res.json({ orders: orders.map(stripForRider) });
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
      return res.json({ order: stripForRider(order) });
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

      return res.json({ order: stripForRider(order) });
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

/// Rider's own home-screen stats: average rating + count of customer
/// ratings, deliveries today (IST midnight reset), lifetime delivered.
router.get(
  '/stats',
  authenticateToken,
  requireRole('rider'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      const stats = await getRiderStats(req.user.id);
      return res.json(stats);
    } catch (error) {
      console.error('getRiderStats error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get(
  '/availability',
  authenticateToken,
  requireRole('rider'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const available = await getRiderAvailability(req.user.id);
    return res.json({ available });
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
    // Push the fresh roster to admin/editor sockets so the dispatch picker
    // stays live without needing a dashboard reload.
    void broadcastRiderRoster(req.user.companyId);
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

    // Proximity push: fires "your rider has arrived" exactly once when the
    // rider's GPS first lands within ARRIVAL_RADIUS_METERS of the customer.
    // Race-safe via markOrderArrivalNotified — concurrent location updates
    // can't double-fire because only the first UPDATE returns rowCount > 0.
    void (async () => {
      try {
        const ctx = await getRiderArrivalContext(req.user!.id);
        if (!ctx || ctx.alreadyNotified || ctx.customerUserId === null) return;
        const dist = haversineMeters(
          latitude, longitude,
          ctx.deliveryLatitude, ctx.deliveryLongitude,
        );
        if (dist > ARRIVAL_RADIUS_METERS) return;
        const claimed = await markOrderArrivalNotified(ctx.publicId);
        if (!claimed) return;
        await notifyCustomerById(
          ctx.customerUserId,
          'Your rider has arrived',
          `Order #${ctx.publicId} is at your doorstep. Please collect it.`,
          { type: 'order_arrived', orderId: ctx.publicId },
        );
      } catch (error) {
        console.error('[rider/location] arrival proximity check failed:', error);
      }
    })();

    return res.json({ ok: true });
  }
);

export default router;
