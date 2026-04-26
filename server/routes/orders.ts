import { Router } from 'express';
import geoip from 'geoip-lite';
import { ORDER_STATUS_VALUES, PAYMENT_METHOD_VALUES } from '../constants.js';
import {
  createOrder,
  getAppSettings,
  getDefaultCompanyId,
  getDashboardSummary,
  getOrderByPublicId,
  getOrderOwnerUserId,
  getSalesReport,
  listOrders,
  listOrdersForUser,
  rejectOrderItem,
  updateOrderStatus,
  updateUserProfileIfEmpty,
  upsertUserAddress,
  validateCoupon,
} from '../db.js';
import {
  notifyOrderItemRejected,
  notifyOrderStatus,
  notifyRiderAssigned,
} from '../push.js';
import { verifyRazorpaySignature } from '../razorpay.js';
import {
  attachUserIfPresent,
  authenticateToken,
  requireRole,
} from '../middleware/auth.js';
import { broadcast } from '../ws.js';
import { TTL, cacheDel, cacheGet, cacheSet, key } from '../cache.js';
import type { AuthenticatedRequest, OrderStatus } from '../types.js';

const router = Router();

function getRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getGeoLabel(ipAddress: string | undefined) {
  if (!ipAddress) {
    return null;
  }
  const normalized = ipAddress.split(',')[0].trim().replace('::ffff:', '');
  const match = geoip.lookup(normalized);
  if (!match) {
    return null;
  }
  return [match.city, match.region, match.country].filter(Boolean).join(', ');
}

async function invalidateOrdersCache(companyId: number) {
  await Promise.all([
    cacheDel(key.ordersList(companyId)),
    cacheDel(key.ordersSummary(companyId)),
  ]);
}

router.post('/', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  try {
    const companyId = await getDefaultCompanyId();
    if (!companyId) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Refuse new orders when admin has closed the shop.
    const storeSettings = await getAppSettings(companyId);
    if (!storeSettings.shopOpen) {
      return res.status(503).json({
        error: storeSettings.shopClosedMessage || 'The shop is closed right now. Please come back later.',
      });
    }

    const {
      customerName,
      customerPhone,
      customerEmail,
      deliveryAddress,
      deliveryNotes,
      deliverySlot,
      paymentMethod,
      items,
      deliveryLatitude,
      deliveryLongitude,
      couponCode,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    } = req.body as {
      customerName?: string;
      customerPhone?: string;
      customerEmail?: string;
      deliveryAddress?: string;
      deliveryNotes?: string;
      deliverySlot?: string;
      paymentMethod?: string;
      items?: Array<{ productId: string; quantity: number }>;
      deliveryLatitude?: number | null;
      deliveryLongitude?: number | null;
      couponCode?: string | null;
      razorpayOrderId?: string;
      razorpayPaymentId?: string;
      razorpaySignature?: string;
    };

    const validLat =
      typeof deliveryLatitude === 'number' &&
      Number.isFinite(deliveryLatitude) &&
      deliveryLatitude >= -90 &&
      deliveryLatitude <= 90;
    const validLng =
      typeof deliveryLongitude === 'number' &&
      Number.isFinite(deliveryLongitude) &&
      deliveryLongitude >= -180 &&
      deliveryLongitude <= 180;

    if (
      !customerName ||
      !customerPhone ||
      !deliveryAddress ||
      !paymentMethod ||
      !PAYMENT_METHOD_VALUES.includes(paymentMethod as (typeof PAYMENT_METHOD_VALUES)[number]) ||
      !Array.isArray(items) ||
      items.length === 0 ||
      items.some(
        (item) => !item.productId || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0
      )
    ) {
      return res.status(400).json({ error: 'Missing required order fields' });
    }

    if (!validLat || !validLng) {
      return res.status(400).json({
        error: 'Please share your delivery location so the rider can find you.',
      });
    }

    // Two valid razorpay shapes:
    //   1. Standard Checkout: client returns orderId + paymentId + signature;
    //      we verify the signature and commit as paid.
    //   2. UPI intent (Blinkit-style): client only has a razorpay_order_id;
    //      the real payment confirmation arrives later via webhook, so we
    //      commit the order with payment_status='pending' and flip it when
    //      `payment.captured` fires.
    let razorpayFlow: 'verified' | 'pending' | null = null;
    if (paymentMethod === 'razorpay') {
      if (razorpayOrderId && razorpayPaymentId && razorpaySignature) {
        const verified = verifyRazorpaySignature({
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature,
        });
        if (!verified) {
          return res.status(400).json({ error: 'Payment verification failed' });
        }
        razorpayFlow = 'verified';
      } else if (razorpayOrderId) {
        razorpayFlow = 'pending';
      } else {
        return res.status(400).json({ error: 'Payment details missing' });
      }
    }

    // Pre-check the coupon (covers code-not-found, expired, inactive, and
    // per-user / global usage limits) before we touch products. The actual
    // discount and redemption are still computed inside createOrder, which
    // re-validates atomically against the live subtotal.
    if (couponCode && couponCode.trim()) {
      // Estimate subtotal from the cart at the highest possible value so the
      // min-subtotal check inside validateCoupon doesn't false-fail. The real
      // subtotal check happens inside createOrder.
      const estimateSubtotal = Number.MAX_SAFE_INTEGER;
      const check = await validateCoupon(
        companyId,
        req.user?.id ?? null,
        couponCode,
        estimateSubtotal,
      );
      if (!check.ok) {
        return res.status(400).json({ error: check.error, couponError: true });
      }
    }

    const order = await createOrder({
      companyId,
      customerName,
      customerPhone,
      customerEmail,
      deliveryAddress,
      deliveryNotes,
      deliverySlot,
      paymentMethod,
      items: items.map((item) => ({
        productId: item.productId,
        quantity: Number(item.quantity),
      })),
      geoLabel: getGeoLabel(req.headers['x-forwarded-for']?.toString() || req.socket.remoteAddress),
      deliveryLatitude: deliveryLatitude as number,
      deliveryLongitude: deliveryLongitude as number,
      createdByUserId: req.user?.id ?? null,
      couponCode: couponCode ?? null,
      razorpayOrderId: paymentMethod === 'razorpay' ? razorpayOrderId ?? null : null,
      razorpayPaymentId:
        razorpayFlow === 'verified' ? razorpayPaymentId ?? null : null,
      razorpaySignature:
        razorpayFlow === 'verified' ? razorpaySignature ?? null : null,
      paymentStatus: razorpayFlow === 'verified' ? 'paid' : 'pending',
    });

    if (req.user?.id) {
      await updateUserProfileIfEmpty(req.user.id, customerName, customerPhone);
      await upsertUserAddress(req.user.id, {
        fullName: customerName,
        phone: customerPhone,
        deliveryAddress,
        deliveryNotes: deliveryNotes ?? null,
        latitude: deliveryLatitude as number,
        longitude: deliveryLongitude as number,
      });
    }

    await invalidateOrdersCache(companyId);
    broadcast({ type: 'new_order', payload: order });

    if (req.user) {
      void notifyOrderStatus({
        userId: req.user.id,
        publicId: order.publicId,
        status: 'placed',
      });
    }

    return res.status(201).json({ order });
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'Unable to place order at the moment';
    if (raw.startsWith('COUPON_INVALID:')) {
      return res.status(400).json({
        error: raw.slice('COUPON_INVALID:'.length),
        couponError: true,
      });
    }
    return res.status(400).json({ error: raw });
  }
});

router.get('/track/:publicId', async (req, res) => {
  const publicId = getRouteParam(req.params.publicId);
  if (!publicId) {
    return res.status(400).json({ error: 'Order ID is required' });
  }
  const order = await getOrderByPublicId(publicId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  return res.json({ order });
});

router.get('/summary', authenticateToken, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const cacheKey = key.ordersSummary(req.user.companyId);
  const cached = await cacheGet<{ summary: unknown }>(cacheKey);
  if (cached) return res.json(cached);

  const summary = await getDashboardSummary(req.user.companyId);
  const result = { summary };
  await cacheSet(cacheKey, result, TTL.ORDERS_SUMMARY);
  return res.json(result);
});

router.get('/my-orders', authenticateToken, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const orders = await listOrdersForUser(req.user.id, req.user.companyId);
    return res.json({ orders });
  } catch (error) {
    console.error('List my-orders error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get(
  '/sales-report',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      const days = Math.min(Math.max(Number(req.query.days ?? 30), 1), 365);
      const report = await getSalesReport(req.user.companyId, days);
      return res.json({ report });
    } catch (error) {
      console.error('Sales report error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get('/', authenticateToken, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const cacheKey = key.ordersList(req.user.companyId);
  const cached = await cacheGet<{ orders: unknown[] }>(cacheKey);
  if (cached) return res.json(cached);

  const orders = await listOrders(req.user.companyId);
  const result = { orders };
  await cacheSet(cacheKey, result, TTL.ORDERS_LIST);
  return res.json(result);
});

router.post('/:publicId/cancel', async (req, res) => {
  try {
    const publicId = getRouteParam(req.params.publicId);
    if (!publicId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    const existing = await getOrderByPublicId(publicId);
    if (!existing) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!['placed', 'confirmed', 'packing'].includes(existing.status)) {
      return res
        .status(400)
        .json({ error: 'This order can no longer be cancelled' });
    }

    const reason = typeof (req.body as { cancellationReason?: unknown })?.cancellationReason === 'string'
      ? ((req.body as { cancellationReason?: string }).cancellationReason ?? null)
      : null;
    const order = await updateOrderStatus(
      publicId,
      existing.companyId,
      'cancelled',
      existing.assignedRiderUserId,
      reason
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await invalidateOrdersCache(existing.companyId);
    broadcast({ type: 'order_updated', payload: order });

    const ownerId = await getOrderOwnerUserId(publicId);
    void notifyOrderStatus({
      userId: ownerId,
      publicId: order.publicId,
      status: 'cancelled',
    });

    return res.json({ order });
  } catch (error) {
    console.error('Cancel order error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch(
  '/:publicId/status',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const publicId = getRouteParam(req.params.publicId);
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!publicId) {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      const body = (req.body ?? {}) as {
        status?: OrderStatus;
        assignedRiderUserId?: number | null;
        cancellationReason?: string | null;
      };
      const { status, cancellationReason } = body;

      if (!status || !ORDER_STATUS_VALUES.includes(status)) {
        return res.status(400).json({ error: 'Invalid order status' });
      }

      const existing = await getOrderByPublicId(publicId);
      const previousRiderId = existing?.assignedRiderUserId ?? null;

      // Preserve the existing rider assignment when the client doesn't
      // include `assignedRiderUserId` in the body at all. Without this
      // guard, a status-only PATCH gets `assignedRiderUserId === undefined`
      // → coerced to null → silently unassigns the rider (and a later
      // status flip could re-assign a *different* rider).
      const riderForUpdate =
        'assignedRiderUserId' in body
          ? (body.assignedRiderUserId ?? null)
          : (existing?.assignedRiderUserId ?? null);

      const order = await updateOrderStatus(
        publicId,
        req.user.companyId,
        status,
        riderForUpdate,
        cancellationReason ?? null
      );

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      await invalidateOrdersCache(req.user.companyId);
      broadcast({ type: 'order_updated', payload: order });

      const ownerId = await getOrderOwnerUserId(publicId);
      void notifyOrderStatus({
        userId: ownerId,
        publicId: order.publicId,
        status,
        deliveryOtp: status === 'out_for_delivery' ? order.deliveryOtp : null,
      });

      // Push to the rider when a new assignment lands on them (null→rider
      // or swap from a different rider). Skip if the rider hasn't changed.
      const newRiderId = order.assignedRiderUserId ?? null;
      if (newRiderId != null && newRiderId !== previousRiderId) {
        void notifyRiderAssigned({
          riderUserId: newRiderId,
          publicId: order.publicId,
          customerName: order.customerName ?? 'Customer',
          deliveryAddress: order.deliveryAddress ?? '',
        });
      }

      return res.json({ order });
    } catch (error) {
      console.error('Update order status error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:publicId/items/:itemId/reject',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const publicId = getRouteParam(req.params.publicId);
      const itemIdRaw = getRouteParam(req.params.itemId);
      const itemId = itemIdRaw ? Number(itemIdRaw) : NaN;
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!publicId || !Number.isFinite(itemId)) {
        return res.status(400).json({ error: 'Order and item IDs are required' });
      }

      const { reason } = req.body as { reason?: string };
      if (!reason || typeof reason !== 'string' || !reason.trim()) {
        return res.status(400).json({ error: 'A rejection reason is required' });
      }

      const result = await rejectOrderItem(
        publicId,
        req.user.companyId,
        itemId,
        reason
      );

      if (!result) {
        return res.status(404).json({ error: 'Order or item not found' });
      }

      const { order, productName } = result;

      await invalidateOrdersCache(req.user.companyId);
      broadcast({ type: 'order_updated', payload: order });

      const ownerUserId = await getOrderOwnerUserId(order.publicId);
      await notifyOrderItemRejected({
        userId: ownerUserId,
        publicId: order.publicId,
        productName,
        reason: reason.trim(),
      });

      return res.json({ order });
    } catch (error) {
      const message = (error as Error)?.message ?? 'Internal server error';
      if (message === 'Item is already rejected') {
        return res.status(409).json({ error: message });
      }
      console.error('Reject order item error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
