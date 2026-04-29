import { Router } from 'express';

import {
  findUserByUid,
  getOrderByPublicId,
  listLowStockProducts,
  listPickerOrders,
  updatePickerOrderStatus,
  updateProductStockByPicker,
} from '../db.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { broadcast } from '../ws.js';
import type { AuthenticatedRequest, OrderStatus } from '../types.js';

const router = Router();

function getRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/// Picker's own queue. Returns every order admin has assigned to them
/// that's still in the pre-delivery phase (confirmed / packing / packed).
/// Once admin moves the order to out_for_delivery the picker drops it
/// from their list — that's the rider's job from there.
router.get(
  '/orders',
  authenticateToken,
  requireRole('picker'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      const orders = await listPickerOrders(req.user.id);
      return res.json({ orders });
    } catch (error) {
      console.error('listPickerOrders error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

/// Picker advances their own order through `packing` → `packed`. Anything
/// else (cancellation, out_for_delivery, etc.) belongs to admin and goes
/// through the existing PATCH /orders/:publicId/status route.
router.patch(
  '/orders/:publicId/status',
  authenticateToken,
  requireRole('picker'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const publicId = getRouteParam(req.params.publicId);
    if (!publicId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }
    const { status } = (req.body ?? {}) as { status?: OrderStatus };
    if (status !== 'packing' && status !== 'packed') {
      return res
        .status(400)
        .json({ error: 'Picker can only set status to packing or packed' });
    }
    try {
      const order = await updatePickerOrderStatus(publicId, req.user.id, status);
      if (!order) {
        return res
          .status(404)
          .json({ error: 'Order not found or not assigned to you' });
      }
      // Same broadcast event admin emits — admin dashboard, rider app,
      // and customer track-order all listen to this single channel.
      broadcast({ type: 'order_updated', payload: order });
      return res.json({ order });
    } catch (error) {
      console.error('updatePickerOrderStatus error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

/// Picker's low-stock view + permission gate. Returns the same low-stock
/// list the admin sees, but only when the picker has the inventory write
/// permission flipped on. Without permission the endpoint 403s — the
/// picker UI uses the response to show / hide the inventory tab.
router.get(
  '/inventory',
  authenticateToken,
  requireRole('picker'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      const me = await findUserByUid(req.user.uid);
      if (!me?.pickerCanUpdateInventory) {
        return res.status(403).json({
          error: 'Inventory access not granted',
          canUpdateInventory: false,
        });
      }
      const lowStock = await listLowStockProducts(req.user.companyId);
      return res.json({ lowStock, canUpdateInventory: true });
    } catch (error) {
      console.error('picker inventory error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

/// Picker stock adjustment — strict: just `stockQuantity`, nothing else.
/// Permission re-checked here (defense in depth: a stale token would
/// still 403 if admin revoked access between calls). Picker can still
/// see other product fields via /products, but only stock is writable.
router.patch(
  '/inventory/:productUniqueId',
  authenticateToken,
  requireRole('picker'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const productUniqueId = getRouteParam(req.params.productUniqueId);
    if (!productUniqueId) {
      return res.status(400).json({ error: 'Product ID is required' });
    }
    const { stockQuantity } = (req.body ?? {}) as { stockQuantity?: number };
    if (typeof stockQuantity !== 'number' || !Number.isFinite(stockQuantity)) {
      return res.status(400).json({ error: 'stockQuantity (number) required' });
    }
    try {
      const me = await findUserByUid(req.user.uid);
      if (!me?.pickerCanUpdateInventory) {
        return res.status(403).json({ error: 'Inventory access not granted' });
      }
      const product = await updateProductStockByPicker(
        productUniqueId,
        req.user.companyId,
        stockQuantity,
      );
      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }
      return res.json({ product });
    } catch (error) {
      console.error('picker stock update error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

/// Lightweight order detail for the picker — same payload as the admin
/// view, so the existing Order shape on the client just works. Auth
/// enforces (a) picker role and (b) the order is assigned to this picker.
router.get(
  '/orders/:publicId',
  authenticateToken,
  requireRole('picker'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const publicId = getRouteParam(req.params.publicId);
    if (!publicId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }
    try {
      const order = await getOrderByPublicId(publicId);
      if (!order || order.assignedPickerUserId !== req.user.id) {
        return res
          .status(404)
          .json({ error: 'Order not found or not assigned to you' });
      }
      return res.json({ order });
    } catch (error) {
      console.error('picker order detail error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
