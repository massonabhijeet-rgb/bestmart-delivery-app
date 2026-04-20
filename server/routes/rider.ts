import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import {
  getOrderByPublicId,
  getOrderOwnerUserId,
  listRiderOrders,
  updateOrderStatus,
} from '../db.js';
import { notifyOrderStatus } from '../push.js';
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
    return res.json({ ok: true });
  }
);

export default router;
