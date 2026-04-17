import { Router } from 'express';
import { getCompanyPublic, updateStoreLocation } from '../db.js';
import { TTL, cacheDel, cacheGet, cacheSet, key } from '../cache.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

router.get('/public', async (_req, res) => {
  const cacheKey = key.companyPublic();
  const cached = await cacheGet<{ company: unknown }>(cacheKey);
  if (cached) return res.json(cached);

  const company = await getCompanyPublic();
  if (!company) {
    return res.status(404).json({ error: 'Company not found' });
  }

  const result = {
    company: {
      ...company,
      promises: [
        'Delivery windows from 20 to 35 minutes',
        'Fresh produce sourced daily',
        'Live tracking from packing to doorstep',
      ],
    },
  };
  await cacheSet(cacheKey, result, TTL.COMPANY);
  return res.json(result);
});

router.patch(
  '/store-location',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const { latitude, longitude } = req.body as { latitude?: number; longitude?: number };
    if (
      typeof latitude !== 'number' || typeof longitude !== 'number' ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
    ) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }
    await updateStoreLocation(req.user.companyId, latitude, longitude);
    await cacheDel(key.companyPublic());
    return res.json({ ok: true });
  }
);

export default router;
