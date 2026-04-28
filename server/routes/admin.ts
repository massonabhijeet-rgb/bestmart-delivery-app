import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import {
  countCustomersWithDevices,
  findCustomerByIdentifier,
  listRidersForPresence,
} from '../db.js';
import {
  broadcastToCustomers,
  notifyCustomerById,
} from '../push.js';
import { getConnectedRiderIds, getRiderLocations } from '../ws.js';
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
