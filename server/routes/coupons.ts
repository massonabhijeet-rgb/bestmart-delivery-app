import { Router } from 'express';
import {
  createCoupon,
  deleteCoupon,
  getDefaultCompanyId,
  listCoupons,
  listPublicCoupons,
  updateCoupon,
  validateCoupon,
} from '../db.js';
import {
  attachUserIfPresent,
  authenticateToken,
  requireRole,
} from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

// Public: list active coupons for the storefront landing page
router.get('/public', async (_req, res) => {
  try {
    const companyId = await getDefaultCompanyId();
    if (!companyId) return res.status(404).json({ error: 'Company not found' });
    const coupons = await listPublicCoupons(companyId);
    return res.json({ coupons });
  } catch (err) {
    console.error('List public coupons error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: list
router.get(
  '/',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const coupons = await listCoupons(req.user.companyId);
    return res.json({ coupons });
  }
);

// Admin: create
router.post(
  '/',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    try {
      const body = req.body as Record<string, unknown>;
      const code = String(body.code ?? '').trim();
      const discountType = body.discountType === 'flat' ? 'flat' : 'percent';
      const discountValue = Number(body.discountValue);
      const maxUsesPerUser = Number(body.maxUsesPerUser);

      if (!code) return res.status(400).json({ error: 'Code is required.' });
      if (!Number.isFinite(discountValue) || discountValue <= 0) {
        return res.status(400).json({ error: 'Discount value must be greater than 0.' });
      }
      if (discountType === 'percent' && discountValue > 100) {
        return res.status(400).json({ error: 'Percent discount cannot exceed 100.' });
      }
      if (!Number.isInteger(maxUsesPerUser) || maxUsesPerUser < 1) {
        return res.status(400).json({ error: 'Per-user usage limit (N) must be at least 1.' });
      }

      const coupon = await createCoupon(req.user.companyId, {
        code,
        description: body.description != null ? String(body.description) : '',
        discountType,
        discountValue: Math.round(discountValue),
        maxDiscountCents: body.maxDiscountCents != null ? Math.round(Number(body.maxDiscountCents)) : null,
        minSubtotalCents: body.minSubtotalCents != null ? Math.round(Number(body.minSubtotalCents)) : 0,
        maxUsesPerUser,
        maxTotalUses: body.maxTotalUses != null && body.maxTotalUses !== '' ? Math.round(Number(body.maxTotalUses)) : null,
        isActive: body.isActive == null ? true : Boolean(body.isActive),
        validFrom: body.validFrom ? String(body.validFrom) : null,
        validUntil: body.validUntil ? String(body.validUntil) : null,
      });
      return res.status(201).json({ coupon });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not create coupon';
      // Unique violation
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return res.status(409).json({ error: 'A coupon with this code already exists.' });
      }
      return res.status(400).json({ error: msg });
    }
  }
);

// Admin: update
router.patch(
  '/:id',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid coupon id' });
    try {
      const body = req.body as Record<string, unknown>;
      const coupon = await updateCoupon(req.user.companyId, id, {
        code: body.code != null ? String(body.code) : undefined,
        description: body.description != null ? String(body.description) : undefined,
        discountType: body.discountType === 'flat' ? 'flat' : body.discountType === 'percent' ? 'percent' : undefined,
        discountValue: body.discountValue != null ? Math.round(Number(body.discountValue)) : undefined,
        maxDiscountCents: body.maxDiscountCents !== undefined
          ? (body.maxDiscountCents === '' || body.maxDiscountCents == null ? null : Math.round(Number(body.maxDiscountCents)))
          : undefined,
        minSubtotalCents: body.minSubtotalCents != null ? Math.round(Number(body.minSubtotalCents)) : undefined,
        maxUsesPerUser: body.maxUsesPerUser != null ? Math.round(Number(body.maxUsesPerUser)) : undefined,
        maxTotalUses: body.maxTotalUses !== undefined
          ? (body.maxTotalUses === '' || body.maxTotalUses == null ? null : Math.round(Number(body.maxTotalUses)))
          : undefined,
        isActive: body.isActive != null ? Boolean(body.isActive) : undefined,
        validFrom: body.validFrom !== undefined ? (body.validFrom ? String(body.validFrom) : null) : undefined,
        validUntil: body.validUntil !== undefined ? (body.validUntil ? String(body.validUntil) : null) : undefined,
      });
      if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
      return res.json({ coupon });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not update coupon';
      return res.status(400).json({ error: msg });
    }
  }
);

// Admin: delete
router.delete(
  '/:id',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid coupon id' });
    const ok = await deleteCoupon(req.user.companyId, id);
    if (!ok) return res.status(404).json({ error: 'Coupon not found' });
    return res.json({ ok: true });
  }
);

// Customer-facing: preview/apply check
router.post(
  '/preview',
  attachUserIfPresent,
  async (req: AuthenticatedRequest, res) => {
    try {
      const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
      if (!companyId) return res.status(404).json({ error: 'Company not found' });
      const { code, subtotalCents } = req.body as { code?: string; subtotalCents?: number };
      if (!code || typeof subtotalCents !== 'number' || !Number.isFinite(subtotalCents)) {
        return res.status(400).json({ error: 'Code and subtotalCents are required.' });
      }
      const result = await validateCoupon(companyId, req.user?.id ?? null, code, subtotalCents);
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json({
        code: result.coupon.code,
        description: result.coupon.description,
        discountCents: result.discountCents,
        discountType: result.coupon.discountType,
        discountValue: result.coupon.discountValue,
      });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid coupon' });
    }
  }
);

export default router;
