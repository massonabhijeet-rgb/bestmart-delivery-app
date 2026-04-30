import { Router } from 'express';
import { getCart, replaceCart } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

// Defensive caps so a buggy / malicious client can't blow up the table.
const MAX_QTY_PER_ITEM = 99;
const MAX_ITEMS = 100;

router.get('/', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const items = await getCart(req.user!.id);
    return res.json({ items });
  } catch (err) {
    console.error('Cart fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Full-replace sync. The client owns the cart shape (it's the renderer),
// so we don't try to merge — we just persist whatever it sends, drop
// inactive products, and return the canonical state for the client to
// reconcile against (e.g. show a toast if items disappeared).
router.put('/', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const body = req.body as {
      items?: Array<{ productId?: unknown; qty?: unknown }>;
    };
    if (!Array.isArray(body.items)) {
      return res.status(400).json({ error: 'items must be an array' });
    }
    if (body.items.length > MAX_ITEMS) {
      return res.status(400).json({ error: 'Too many items in cart' });
    }

    // Sanitize: drop garbage, dedupe, clamp qty. We don't 400 on bad
    // entries because the client may have a slightly stale state and we
    // don't want a single corrupt row to block a sync.
    const cleaned: Array<{ productId: number; qty: number }> = [];
    const seen = new Set<number>();
    for (const it of body.items) {
      const productId = Number(it.productId);
      const qty = Math.floor(Number(it.qty));
      if (!Number.isInteger(productId) || productId <= 0) continue;
      if (!Number.isInteger(qty) || qty <= 0) continue;
      if (qty > MAX_QTY_PER_ITEM) continue;
      if (seen.has(productId)) continue;
      seen.add(productId);
      cleaned.push({ productId, qty });
    }

    await replaceCart(req.user!.id, cleaned);
    const items = await getCart(req.user!.id);
    return res.json({ items });
  } catch (err) {
    console.error('Cart sync error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
