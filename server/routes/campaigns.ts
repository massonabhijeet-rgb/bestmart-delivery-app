import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import {
  attachUserIfPresent,
  authenticateToken,
  requireRole,
} from '../middleware/auth.js';
import {
  createCampaign,
  deleteCampaign,
  getActiveCampaign,
  getCampaignById,
  getDefaultCompanyId,
  listCampaigns,
  updateCampaign,
  updateCampaignImage,
} from '../db.js';
import { deleteFromS3, uploadToS3 } from '../s3.js';
import { TTL, cacheDel, cacheGet, cacheSet, key } from '../cache.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
});

function getRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseDate(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const parsed = new Date(String(raw));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

// Public: the single currently-active overlay (null when none set).
router.get('/active', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  try {
    const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
    if (!companyId) {
      return res.status(404).json({ error: 'Company not found' });
    }
    const cacheKey = key.campaignActive(companyId);
    const cached = await cacheGet<{ campaign: unknown }>(cacheKey);
    if (cached) return res.json(cached);

    const campaign = await getActiveCampaign(companyId);
    const payload = { campaign };
    await cacheSet(cacheKey, payload, TTL.CAMPAIGN_ACTIVE);
    return res.json(payload);
  } catch (error) {
    console.error('Get active campaign error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: list all campaigns.
router.get(
  '/',
  authenticateToken,
  requireRole('superuser'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const campaigns = await listCampaigns(req.user.companyId);
      return res.json({ campaigns });
    } catch (error) {
      console.error('List campaigns error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/',
  authenticateToken,
  requireRole('superuser'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const body = req.body as {
        title?: string;
        categoryIds?: unknown;
        isActive?: boolean;
        validFrom?: string | null;
        validUntil?: string | null;
      };
      const title = String(body.title ?? '').trim().slice(0, 120);
      const categoryIds = Array.isArray(body.categoryIds)
        ? body.categoryIds
            .map((v) => Number(v))
            .filter((n): n is number => Number.isFinite(n) && n > 0)
        : [];
      const isActive = typeof body.isActive === 'boolean' ? body.isActive : true;
      const validFrom = parseDate(body.validFrom) ?? null;
      const validUntil = parseDate(body.validUntil) ?? null;

      const campaign = await createCampaign(req.user.companyId, {
        title,
        categoryIds,
        isActive,
        validFrom,
        validUntil,
      });
      await cacheDel(key.campaignActive(req.user.companyId));
      return res.status(201).json({ campaign });
    } catch (error) {
      console.error('Create campaign error:', error);
      const message = error instanceof Error ? error.message : 'Unable to create campaign';
      return res.status(400).json({ error: message });
    }
  }
);

router.put(
  '/:id',
  authenticateToken,
  requireRole('superuser'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const id = Number(getRouteParam(req.params.id));
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Campaign ID is required' });
      }
      const body = req.body as {
        title?: string;
        categoryIds?: unknown;
        isActive?: boolean;
        validFrom?: string | null;
        validUntil?: string | null;
      };
      const patch: Parameters<typeof updateCampaign>[2] = {};
      if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 120);
      if ('categoryIds' in body) {
        patch.categoryIds = Array.isArray(body.categoryIds)
          ? body.categoryIds
              .map((v) => Number(v))
              .filter((n): n is number => Number.isFinite(n) && n > 0)
          : [];
      }
      if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;
      const from = parseDate(body.validFrom);
      if (from !== undefined) patch.validFrom = from;
      const until = parseDate(body.validUntil);
      if (until !== undefined) patch.validUntil = until;

      const campaign = await updateCampaign(id, req.user.companyId, patch);
      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      await cacheDel(key.campaignActive(req.user.companyId));
      return res.json({ campaign });
    } catch (error) {
      console.error('Update campaign error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete(
  '/:id',
  authenticateToken,
  requireRole('superuser'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const id = Number(getRouteParam(req.params.id));
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Campaign ID is required' });
      }
      const result = await deleteCampaign(id, req.user.companyId);
      if (!result.deleted) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      if (result.imageUrl) {
        await deleteFromS3(result.imageUrl);
      }
      await cacheDel(key.campaignActive(req.user.companyId));
      return res.json({ message: 'Campaign deleted' });
    } catch (error) {
      console.error('Delete campaign error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/upload-image',
  authenticateToken,
  requireRole('superuser'),
  imageUpload.single('campaignImage'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const id = Number(getRouteParam(req.params.id));
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Campaign ID is required' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const existing = await getCampaignById(id, req.user.companyId);
      if (!existing) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      // Portrait-ish overlay art — preserve full image, cap dimensions.
      const webpBuffer = await sharp(req.file.buffer)
        .resize({ width: 800, height: 1000, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();

      if (existing.imageUrl) {
        await deleteFromS3(existing.imageUrl);
      }
      const baseUrl = await uploadToS3(
        `campaigns/${id}.webp`,
        webpBuffer,
        'image/webp'
      );
      const s3Url = `${baseUrl}?v=${Date.now()}`;
      const updated = await updateCampaignImage(id, req.user.companyId, s3Url);

      await cacheDel(key.campaignActive(req.user.companyId));
      return res.json({
        message: 'Campaign image uploaded successfully',
        campaign: updated,
      });
    } catch (error) {
      console.error('Upload campaign image error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
