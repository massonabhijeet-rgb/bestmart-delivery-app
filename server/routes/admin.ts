import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import {
  assignPickerToOrder,
  countCustomersWithDevices,
  findCustomerByIdentifier,
  listPickers,
  listRidersForPresence,
  setProductLowStockThreshold,
  setUserPickerInventoryPermission,
} from '../db.js';
import {
  broadcastToCustomers,
  notifyCustomerById,
  notifyPickerAssigned,
} from '../push.js';
import { broadcast, getConnectedRiderIds, getRiderLocations } from '../ws.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

const TITLE_MAX = 120;
const BODY_MAX = 1000;

// Why isn't auto-dispatch picking my rider? Returns each rider's full
// eligibility breakdown: DB availability flag, FCM token presence, live
// WebSocket connection, last-known GPS location. Eligible = isAvailable
// && (hasDeviceToken || wsConnected) && location && !onTheWay.
router.get(
  '/rider-presence',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Auth required' });
    try {
      const riders = await listRidersForPresence(req.user.companyId);
      const connected = getConnectedRiderIds();
      const locations = new Map(
        getRiderLocations().map((l) => [l.riderId, l]),
      );
      const enriched = riders.map((r) => {
        const loc = locations.get(r.id);
        const wsConnected = connected.has(r.id);
        const reachable = r.hasDeviceToken || wsConnected;
        const eligibleForDispatch =
          r.isAvailable && reachable && loc != null && !r.onTheWay;
        return {
          ...r,
          wsConnected,
          location: loc
            ? { lat: loc.latitude, lng: loc.longitude, updatedAt: loc.updatedAt }
            : null,
          eligibleForDispatch,
          missing: eligibleForDispatch
            ? null
            : [
                !r.isAvailable && 'not toggled Available',
                !reachable && 'no FCM token AND no live WebSocket',
                !loc && 'no GPS location pushed since last server restart',
                r.onTheWay && 'currently on a delivery (out_for_delivery)',
              ].filter(Boolean),
        };
      });
      return res.json({ riders: enriched });
    } catch (error) {
      console.error('Admin rider-presence error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ----- Picker management endpoints --------------------------------------

/// List of all pickers in this company — drives the admin's "Assign
/// picker" dropdown on the order detail page. Editors see this too so
/// they can also reassign on the floor.
router.get(
  '/pickers',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Auth required' });
    try {
      const pickers = await listPickers(req.user.companyId);
      return res.json({ pickers });
    } catch (error) {
      console.error('Admin listPickers error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/// Manually assign (or unassign with body.pickerUserId === null) a picker
/// to an order. Fires an FCM push to the picker on every new assignment
/// — including a re-assign from picker A to picker B (B gets the push,
/// A's app drops the order from its queue on the next /picker/orders
/// fetch or order_updated WebSocket event).
router.post(
  '/orders/:publicId/assign-picker',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Auth required' });
    const publicId = Array.isArray(req.params.publicId)
      ? req.params.publicId[0]
      : req.params.publicId;
    if (!publicId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }
    const { pickerUserId } = (req.body ?? {}) as {
      pickerUserId?: number | null;
    };
    if (
      pickerUserId !== null &&
      pickerUserId !== undefined &&
      typeof pickerUserId !== 'number'
    ) {
      return res
        .status(400)
        .json({ error: 'pickerUserId must be a number or null' });
    }
    try {
      const targetPickerId = pickerUserId ?? null;
      const order = await assignPickerToOrder(
        publicId,
        req.user.companyId,
        targetPickerId,
      );
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }
      broadcast({ type: 'order_updated', payload: order });
      if (targetPickerId !== null) {
        void notifyPickerAssigned({
          pickerUserId: targetPickerId,
          publicId: order.publicId,
          itemCount: order.items.length,
          customerName: order.customerName ?? 'Customer',
        });
      }
      return res.json({ order });
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : 'Internal server error';
      console.error('Admin assign-picker error:', error);
      return res.status(400).json({ error: msg });
    }
  }
);

/// Toggle a picker's inventory write permission. Idempotent — calling
/// again with the same value is a no-op.
router.patch(
  '/users/:userId/picker-permissions',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Auth required' });
    const userIdParam = Array.isArray(req.params.userId)
      ? req.params.userId[0]
      : req.params.userId;
    const userId = Number(userIdParam);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'userId must be a number' });
    }
    const { canUpdateInventory } = (req.body ?? {}) as {
      canUpdateInventory?: boolean;
    };
    if (typeof canUpdateInventory !== 'boolean') {
      return res
        .status(400)
        .json({ error: 'canUpdateInventory (boolean) is required' });
    }
    try {
      const ok = await setUserPickerInventoryPermission(
        userId,
        req.user.companyId,
        canUpdateInventory,
      );
      if (!ok) {
        return res
          .status(404)
          .json({ error: 'Picker not found in this company' });
      }
      return res.json({ ok: true, canUpdateInventory });
    } catch (error) {
      console.error('Admin picker-permissions error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/// Per-product low-stock threshold. Pickers see / get notified when
/// stock_quantity ≤ this value. Threshold is a non-negative integer; 0
/// effectively disables low-stock alerts for that product.
router.patch(
  '/products/:productUniqueId/low-stock-threshold',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Auth required' });
    const productUniqueId = Array.isArray(req.params.productUniqueId)
      ? req.params.productUniqueId[0]
      : req.params.productUniqueId;
    if (!productUniqueId) {
      return res.status(400).json({ error: 'Product ID is required' });
    }
    const { threshold } = (req.body ?? {}) as { threshold?: number };
    if (
      typeof threshold !== 'number' ||
      !Number.isFinite(threshold) ||
      threshold < 0
    ) {
      return res
        .status(400)
        .json({ error: 'threshold must be a non-negative number' });
    }
    try {
      const ok = await setProductLowStockThreshold(
        productUniqueId,
        req.user.companyId,
        threshold,
      );
      if (!ok) {
        return res.status(404).json({ error: 'Product not found' });
      }
      return res.json({ ok: true, threshold });
    } catch (error) {
      console.error('Admin low-stock-threshold error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ----- end picker management ---------------------------------------------

router.get(
  '/broadcast/recipients',
  authenticateToken,
  requireRole('admin'),
  async (_req: AuthenticatedRequest, res) => {
    try {
      const count = await countCustomersWithDevices();
      return res.json({ customersWithDevices: count });
    } catch (error) {
      console.error('Admin broadcast recipients error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/broadcast/lookup',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { identifier } = (req.body ?? {}) as { identifier?: string };
      if (typeof identifier !== 'string' || identifier.trim().length === 0) {
        return res.status(400).json({ error: 'identifier is required' });
      }
      const customer = await findCustomerByIdentifier(identifier);
      if (!customer) {
        return res.status(404).json({ error: 'No customer found with that phone or email' });
      }
      return res.json({ customer });
    } catch (error) {
      console.error('Admin broadcast lookup error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/broadcast',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const {
        title: rawTitle,
        body: rawBody,
        url,
        recipientIdentifier,
      } = (req.body ?? {}) as {
        title?: string;
        body?: string;
        url?: string;
        recipientIdentifier?: string;
      };

      const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
      const body = typeof rawBody === 'string' ? rawBody.trim() : '';
      if (!title || !body) {
        return res.status(400).json({ error: 'title and body are required' });
      }
      if (title.length > TITLE_MAX) {
        return res.status(400).json({ error: `title must be ${TITLE_MAX} characters or fewer` });
      }
      if (body.length > BODY_MAX) {
        return res.status(400).json({ error: `body must be ${BODY_MAX} characters or fewer` });
      }

      const data: Record<string, string> = { type: 'admin_broadcast' };
      if (typeof url === 'string' && url.trim()) data.url = url.trim();

      if (recipientIdentifier && recipientIdentifier.trim()) {
        const customer = await findCustomerByIdentifier(recipientIdentifier);
        if (!customer) {
          return res.status(404).json({ error: 'No customer found with that phone or email' });
        }
        const result = await notifyCustomerById(customer.id, title, body, data);
        return res.json({
          scope: 'individual',
          recipient: {
            id: customer.id,
            fullName: customer.fullName,
            email: customer.email,
            phone: customer.phone,
          },
          ...result,
        });
      }

      const result = await broadcastToCustomers(title, body, data);
      return res.json({ scope: 'all_customers', ...result });
    } catch (error) {
      console.error('Admin broadcast error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
