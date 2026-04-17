import { Router } from 'express';
import geoip from 'geoip-lite';
import { ORDER_STATUS_VALUES, PAYMENT_METHOD_VALUES } from '../constants.js';
import {
  createOrder,
  getDefaultCompanyId,
  getDashboardSummary,
  getOrderByPublicId,
  listOrders,
  updateOrderStatus,
  updateUserProfileIfEmpty,
  upsertUserAddress,
} from '../db.js';
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
      deliveryLatitude: validLat ? deliveryLatitude : null,
      deliveryLongitude: validLng ? deliveryLongitude : null,
      createdByUserId: req.user?.id ?? null,
    });

    if (req.user?.id) {
      await updateUserProfileIfEmpty(req.user.id, customerName, customerPhone);
      await upsertUserAddress(req.user.id, {
        fullName: customerName,
        phone: customerPhone,
        deliveryAddress,
        deliveryNotes: deliveryNotes ?? null,
        latitude: validLat ? deliveryLatitude : null,
        longitude: validLng ? deliveryLongitude : null,
      });
    }

    await invalidateOrdersCache(companyId);
    broadcast({ type: 'new_order', payload: order });

    return res.status(201).json({ order });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to place order at the moment';
    return res.status(400).json({ error: message });
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

    const order = await updateOrderStatus(
      publicId,
      existing.companyId,
      'cancelled',
      existing.assignedRiderUserId
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await invalidateOrdersCache(existing.companyId);
    broadcast({ type: 'order_updated', payload: order });

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

      const { status, assignedRiderUserId } = req.body as {
        status?: OrderStatus;
        assignedRiderUserId?: number | null;
      };

      if (!status || !ORDER_STATUS_VALUES.includes(status)) {
        return res.status(400).json({ error: 'Invalid order status' });
      }

      const order = await updateOrderStatus(
        publicId,
        req.user.companyId,
        status,
        assignedRiderUserId ?? null
      );

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      await invalidateOrdersCache(req.user.companyId);
      broadcast({ type: 'order_updated', payload: order });

      return res.json({ order });
    } catch (error) {
      console.error('Update order status error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
