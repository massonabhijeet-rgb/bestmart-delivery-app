import { Router } from 'express';
import {
  createBrand,
  deleteBrand,
  getDefaultCompanyId,
  listBrands,
  updateBrand,
} from '../db.js';
import {
  attachUserIfPresent,
  authenticateToken,
  requireRole,
} from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

// Public list — used by the storefront so brand names render on cards.
router.get('/', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  try {
    const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
    if (!companyId) return res.status(404).json({ error: 'Company not found' });
    const brands = await listBrands(companyId);
    return res.json({ brands });
  } catch (err) {
    console.error('List brands error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post(
  '/',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    try {
      const { name } = req.body as { name?: string };
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Brand name is required' });
      }
      const brand = await createBrand(req.user.companyId, name);
      return res.status(201).json({ brand });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not create brand';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return res.status(409).json({ error: 'A brand with this name already exists.' });
      }
      return res.status(400).json({ error: msg });
    }
  }
);

router.patch(
  '/:id',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid brand id' });
    try {
      const { name } = req.body as { name?: string };
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Brand name is required' });
      }
      const brand = await updateBrand(req.user.companyId, id, name);
      if (!brand) return res.status(404).json({ error: 'Brand not found' });
      return res.json({ brand });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Could not update brand' });
    }
  }
);

router.delete(
  '/:id',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid brand id' });
    const ok = await deleteBrand(req.user.companyId, id);
    if (!ok) return res.status(404).json({ error: 'Brand not found' });
    return res.json({ ok: true });
  }
);

export default router;
