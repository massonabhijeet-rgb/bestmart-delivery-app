import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import {
  attachUserIfPresent,
  authenticateToken,
  requireRole,
} from '../middleware/auth.js';
import {
  createCategory,
  deleteCategory,
  getCategoryById,
  getDefaultCompanyId,
  listActiveTempCategories,
  listCategories,
  refreshTemporaryCategories,
  updateCategory,
  updateCategoryImage,
  type WeatherMood,
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

const ALLOWED_MOODS: ReadonlySet<WeatherMood> = new Set(['hot', 'warm', 'cool', 'cold', 'rainy']);

// Auto-curated weekly buckets (Diwali Specials, Summer Coolers…). Refreshed
// in-place on each call: expired rows pruned, active defs upserted.
router.get('/temporary', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  try {
    const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
    if (!companyId) {
      return res.status(404).json({ error: 'Company not found' });
    }
    const rawMood = String((req.query.mood as string | undefined) ?? '').toLowerCase();
    const mood = ALLOWED_MOODS.has(rawMood as WeatherMood) ? (rawMood as WeatherMood) : null;
    await refreshTemporaryCategories(companyId, mood);
    const tempCategories = await listActiveTempCategories(companyId);
    return res.json({ tempCategories });
  } catch (error) {
    console.error('Temp categories error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
  if (!companyId) {
    return res.status(404).json({ error: 'Company not found' });
  }

  // Admins/editors see hidden + image-less categories so they can
  // manage them; everyone else (storefront shoppers) gets only the
  // visible categories that actually have an image to render. A
  // category without artwork would draw a blank tile on mobile.
  const isManagement =
    req.user?.role === 'admin' || req.user?.role === 'editor';

  const cacheKey = `${key.categoriesList(companyId)}:${isManagement ? 'all' : 'visible'}`;
  const cached = await cacheGet<{ categories: unknown[] }>(cacheKey);
  if (cached) return res.json(cached);

  const categories = await listCategories(companyId);
  const filtered = isManagement
    ? categories
    : categories.filter(
        (c) =>
          !c.isHidden &&
          c.imageUrl != null &&
          c.imageUrl.trim().length > 0,
      );
  const result = { categories: filtered };
  await cacheSet(cacheKey, result, TTL.CATEGORIES);
  return res.json(result);
});


router.post(
  '/',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const body = req.body as { name?: string; parentId?: number | null };
      const name = String(body.name ?? '').trim();
      if (!name) {
        return res.status(400).json({ error: 'Category name is required' });
      }
      const parentId =
        body.parentId == null
          ? null
          : Number.isFinite(Number(body.parentId))
            ? Number(body.parentId)
            : null;
      const category = await createCategory(req.user.companyId, name, parentId);
      await cacheDel(
        `${key.categoriesList(req.user.companyId)}:all`,
        `${key.categoriesList(req.user.companyId)}:visible`,
      );
      return res.status(201).json({ category });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create category';
      if (message.includes('duplicate')) {
        return res.status(409).json({ error: 'Category already exists' });
      }
      console.error('Create category error:', error);
      return res.status(400).json({ error: message });
    }
  }
);

router.put(
  '/:id',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const id = Number(getRouteParam(req.params.id));
      const body = req.body as {
        name?: string;
        isHidden?: boolean;
        parentId?: number | null;
      };
      const name = String(body.name ?? '').trim();
      const isHidden = typeof body.isHidden === 'boolean' ? body.isHidden : undefined;
      // `parentId` left out of the body = leave the existing parent alone.
      // `parentId: null` = clear (make root). A number = set this parent.
      let parentId: number | null | undefined;
      if ('parentId' in body) {
        parentId =
          body.parentId == null
            ? null
            : Number.isFinite(Number(body.parentId))
              ? Number(body.parentId)
              : null;
      }
      if (!Number.isFinite(id) || !name) {
        return res.status(400).json({ error: 'Category ID and name are required' });
      }
      const category = await updateCategory(
        id,
        req.user.companyId,
        name,
        isHidden,
        parentId,
      );
      if (!category) {
        return res.status(404).json({ error: 'Category not found' });
      }
      await cacheDel(
        `${key.categoriesList(req.user.companyId)}:all`,
        `${key.categoriesList(req.user.companyId)}:visible`,
        key.productsList(req.user.companyId, true),
        key.productsList(req.user.companyId, false),
      );
      return res.json({ category });
    } catch (error) {
      console.error('Update category error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete(
  '/:id',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const id = Number(getRouteParam(req.params.id));
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Category ID is required' });
      }
      const result = await deleteCategory(id, req.user.companyId);
      if (!result.deleted) {
        return res.status(404).json({ error: 'Category not found' });
      }
      await cacheDel(
        `${key.categoriesList(req.user.companyId)}:all`,
        `${key.categoriesList(req.user.companyId)}:visible`,
      );
      return res.json({
        message: 'Category deleted',
        productsDeleted: result.productsDeleted,
        productsArchived: result.productsArchived,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete category';
      return res.status(400).json({ error: message });
    }
  }
);

router.post(
  '/:id/upload-image',
  authenticateToken,
  requireRole('admin', 'editor'),
  imageUpload.single('categoryImage'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const id = Number(getRouteParam(req.params.id));
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Category ID is required' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const existing = await getCategoryById(id, req.user.companyId);
      if (!existing) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const webpBuffer = await sharp(req.file.buffer)
        .resize({ width: 250, height: 250, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      // Replace, not append: drop the prior object and cache-bust the URL.
      if (existing.imageUrl) {
        await deleteFromS3(existing.imageUrl);
      }
      const baseUrl = await uploadToS3(`categories/${id}.webp`, webpBuffer, 'image/webp');
      const s3Url = `${baseUrl}?v=${Date.now()}`;
      const updated = await updateCategoryImage(id, req.user.companyId, s3Url);

      await cacheDel(
        `${key.categoriesList(req.user.companyId)}:all`,
        `${key.categoriesList(req.user.companyId)}:visible`,
      );
      return res.json({
        message: 'Category image uploaded successfully',
        category: updated,
      });
    } catch (error) {
      console.error('Upload category image error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
