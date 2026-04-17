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
  listCategories,
  updateCategory,
  updateCategoryImage,
} from '../db.js';
import { uploadToS3 } from '../s3.js';
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

router.get('/', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
  if (!companyId) {
    return res.status(404).json({ error: 'Company not found' });
  }

  const cacheKey = key.categoriesList(companyId);
  const cached = await cacheGet<{ categories: unknown[] }>(cacheKey);
  if (cached) return res.json(cached);

  const categories = await listCategories(companyId);
  const result = { categories };
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
      const name = String((req.body as { name?: string }).name ?? '').trim();
      if (!name) {
        return res.status(400).json({ error: 'Category name is required' });
      }
      const category = await createCategory(req.user.companyId, name);
      await cacheDel(key.categoriesList(req.user.companyId));
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
      const name = String((req.body as { name?: string }).name ?? '').trim();
      if (!Number.isFinite(id) || !name) {
        return res.status(400).json({ error: 'Category ID and name are required' });
      }
      const category = await updateCategory(id, req.user.companyId, name);
      if (!category) {
        return res.status(404).json({ error: 'Category not found' });
      }
      await cacheDel(key.categoriesList(req.user.companyId));
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
      await cacheDel(key.categoriesList(req.user.companyId));
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

      const s3Url = await uploadToS3(`categories/${id}.webp`, webpBuffer, 'image/webp');
      const updated = await updateCategoryImage(id, req.user.companyId, s3Url);

      await cacheDel(key.categoriesList(req.user.companyId));
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
