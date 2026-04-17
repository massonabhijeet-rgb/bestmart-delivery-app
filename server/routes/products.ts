import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { uploadToS3 } from '../s3.js';
import {
  attachUserIfPresent,
  authenticateToken,
  requireRole,
} from '../middleware/auth.js';
import {
  createProduct,
  deactivateProduct,
  getDefaultCompanyId,
  getProductByUniqueId,
  listProducts,
  setProductOffer,
  updateProduct,
  updateProductImage,
} from '../db.js';
import {
  TTL,
  cacheDelPattern,
  cacheDel,
  cacheGet,
  cacheSet,
  key,
} from '../cache.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
});

function getRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeProductPayload(body: Record<string, unknown>) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  return {
    name: has('name') ? String(body.name ?? '').trim() : undefined,
    slug: has('slug') ? String(body.slug ?? '').trim() : undefined,
    categoryId: has('categoryId')
      ? body.categoryId === '' || body.categoryId == null
        ? null
        : Number(body.categoryId)
      : undefined,
    description: has('description') ? String(body.description ?? '').trim() : undefined,
    unitLabel: has('unitLabel') ? String(body.unitLabel ?? '').trim() : undefined,
    priceCents: has('priceCents') ? Number(body.priceCents) : undefined,
    originalPriceCents: has('originalPriceCents')
      ? body.originalPriceCents === '' || body.originalPriceCents == null
        ? null
        : Number(body.originalPriceCents)
      : undefined,
    stockQuantity: has('stockQuantity') ? Number(body.stockQuantity) : undefined,
    badge: has('badge') ? (body.badge ? String(body.badge).trim() : null) : undefined,
    imageUrl: has('imageUrl') ? (body.imageUrl ? String(body.imageUrl).trim() : null) : undefined,
    isActive: has('isActive') ? Boolean(body.isActive) : undefined,
    isOnOffer: has('isOnOffer') ? Boolean(body.isOnOffer) : undefined,
  };
}

router.get('/', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
  if (!companyId) {
    return res.status(404).json({ error: 'Company not found' });
  }
  const includeInactive =
    req.user?.companyId === companyId &&
    (req.query.includeInactive === '1' || req.query.includeInactive === 'true');

  const cacheKey = key.productsList(companyId, Boolean(includeInactive));
  const cached = await cacheGet<{ products: unknown[] }>(cacheKey);
  if (cached) return res.json(cached);

  const products = await listProducts(companyId, Boolean(includeInactive));
  const filtered = req.user
    ? products
    : products.filter((p: { isActive: boolean }) => p.isActive);
  const result = { products: filtered };
  await cacheSet(cacheKey, result, TTL.PRODUCTS);
  return res.json(result);
});

router.get('/:uniqueId', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
  const uniqueId = getRouteParam(req.params.uniqueId);
  if (!companyId) {
    return res.status(404).json({ error: 'Company not found' });
  }
  if (!uniqueId) {
    return res.status(400).json({ error: 'Product ID is required' });
  }

  const cacheKey = key.productDetail(companyId, uniqueId);
  const cached = await cacheGet<{ product: unknown }>(cacheKey);
  if (cached) {
    const p = cached.product as { isActive: boolean };
    if (!req.user && !p.isActive) return res.status(404).json({ error: 'Product not found' });
    return res.json(cached);
  }

  const product = await getProductByUniqueId(uniqueId, companyId);
  if (!product || (!req.user && !product.isActive)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  await cacheSet(cacheKey, { product }, TTL.PRODUCTS);
  return res.json({ product });
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
      const payload = normalizeProductPayload(req.body as Record<string, unknown>);
      if (
        !payload.name ||
        !payload.categoryId ||
        !payload.description ||
        !payload.unitLabel ||
        !Number.isFinite(payload.priceCents) ||
        !Number.isFinite(payload.stockQuantity)
      ) {
        return res.status(400).json({ error: 'Missing required product fields' });
      }

      const product = await createProduct({
        companyId: req.user.companyId,
        name: payload.name,
        slug: payload.slug ?? '',
        categoryId: payload.categoryId,
        description: payload.description,
        unitLabel: payload.unitLabel,
        priceCents: payload.priceCents as number,
        originalPriceCents: payload.originalPriceCents ?? null,
        stockQuantity: payload.stockQuantity as number,
        badge: payload.badge ?? null,
        imageUrl: payload.imageUrl ?? null,
        isActive: payload.isActive ?? true,
        isOnOffer: payload.isOnOffer ?? false,
      });

      await cacheDelPattern(`bm:products:list:${req.user.companyId}:*`);
      return res.status(201).json({ product });
    } catch (error) {
      console.error('Create product error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.put(
  '/:uniqueId',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const uniqueId = getRouteParam(req.params.uniqueId);
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!uniqueId) {
        return res.status(400).json({ error: 'Product ID is required' });
      }
      const existing = await getProductByUniqueId(uniqueId, req.user.companyId);
      if (!existing) {
        return res.status(404).json({ error: 'Product not found' });
      }

      const payload = normalizeProductPayload(req.body as Record<string, unknown>);
      const product = await updateProduct({
        uniqueId,
        companyId: req.user.companyId,
        name: payload.name || existing.name,
        slug: payload.slug || existing.slug,
        categoryId: payload.categoryId ?? existing.categoryId ?? 0,
        description: payload.description || existing.description,
        unitLabel: payload.unitLabel || existing.unitLabel,
        priceCents:
          payload.priceCents !== undefined && Number.isFinite(payload.priceCents)
            ? payload.priceCents
            : existing.priceCents,
        originalPriceCents:
          payload.originalPriceCents !== undefined &&
          (payload.originalPriceCents === null || Number.isFinite(payload.originalPriceCents))
            ? payload.originalPriceCents
            : existing.originalPriceCents,
        stockQuantity:
          payload.stockQuantity !== undefined && Number.isFinite(payload.stockQuantity)
            ? payload.stockQuantity
            : existing.stockQuantity,
        badge: payload.badge !== undefined ? payload.badge : existing.badge,
        imageUrl: payload.imageUrl !== undefined ? payload.imageUrl : existing.imageUrl,
        isActive: payload.isActive ?? existing.isActive,
        isOnOffer: payload.isOnOffer ?? existing.isOnOffer,
      });

      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }

      await Promise.all([
        cacheDelPattern(`bm:products:list:${req.user.companyId}:*`),
        cacheDel(key.productDetail(req.user.companyId, uniqueId)),
      ]);
      return res.json({ product });
    } catch (error) {
      console.error('Update product error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete(
  '/:uniqueId',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    const uniqueId = getRouteParam(req.params.uniqueId);
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!uniqueId) {
      return res.status(400).json({ error: 'Product ID is required' });
    }
    const success = await deactivateProduct(uniqueId, req.user.companyId);
    if (!success) {
      return res.status(404).json({ error: 'Product not found' });
    }
    await Promise.all([
      cacheDelPattern(`bm:products:list:${req.user.companyId}:*`),
      cacheDel(key.productDetail(req.user.companyId, uniqueId)),
    ]);
    return res.json({ message: 'Product archived' });
  }
);

router.patch(
  '/:uniqueId/offer',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const uniqueId = getRouteParam(req.params.uniqueId);
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!uniqueId) {
        return res.status(400).json({ error: 'Product ID is required' });
      }
      const { isOnOffer, offerPriceCents, offerType } = req.body as {
        isOnOffer?: boolean;
        offerPriceCents?: number | null;
        offerType?: 'price' | 'bogo';
      };
      if (typeof isOnOffer !== 'boolean') {
        return res.status(400).json({ error: 'isOnOffer boolean is required' });
      }
      const resolvedType: 'price' | 'bogo' =
        offerType === 'bogo' ? 'bogo' : 'price';
      const normalizedPrice =
        offerPriceCents == null || offerPriceCents === undefined
          ? null
          : Number(offerPriceCents);
      if (normalizedPrice !== null && (!Number.isFinite(normalizedPrice) || normalizedPrice < 0)) {
        return res.status(400).json({ error: 'offerPriceCents must be a non-negative number' });
      }
      if (isOnOffer && resolvedType === 'price' && normalizedPrice == null) {
        return res.status(400).json({ error: 'offerPriceCents is required for price offers' });
      }
      const product = await setProductOffer(
        uniqueId,
        req.user.companyId,
        isOnOffer,
        normalizedPrice,
        resolvedType
      );
      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }
      await Promise.all([
        cacheDelPattern(`bm:products:list:${req.user.companyId}:*`),
        cacheDel(key.productDetail(req.user.companyId, uniqueId)),
      ]);
      return res.json({ product });
    } catch (error) {
      console.error('Toggle offer error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);


router.post(
  '/:uniqueId/upload-image',
  authenticateToken,
  requireRole('admin', 'editor'),
  imageUpload.single('productImage'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const uniqueId = getRouteParam(req.params.uniqueId);
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!uniqueId) {
        return res.status(400).json({ error: 'Product ID is required' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const product = await getProductByUniqueId(uniqueId, req.user.companyId);
      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }

      const webpBuffer = await sharp(req.file.buffer)
        .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      const s3Url = await uploadToS3(`products/${uniqueId}.webp`, webpBuffer, 'image/webp');
      const updated = await updateProductImage(uniqueId, req.user.companyId, s3Url);

      await Promise.all([
        cacheDelPattern(`bm:products:list:${req.user.companyId}:*`),
        cacheDel(key.productDetail(req.user.companyId, uniqueId)),
      ]);
      return res.json({
        message: 'Product image uploaded successfully',
        product: updated,
      });
    } catch (error) {
      console.error('Upload product image error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/bulk-upload-images',
  authenticateToken,
  requireRole('admin', 'editor'),
  imageUpload.array('images', 100),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

      const allProducts = await listProducts(req.user.companyId, true);
      const productsByName = new Map(
        allProducts.map((p) => [p.name.toLowerCase().trim(), p])
      );

      const results: { filename: string; matched: string | null; status: 'ok' | 'unmatched' | 'error'; error?: string }[] = [];

      await Promise.all(files.map(async (file) => {
        const baseName = file.originalname.replace(/\.[^.]+$/, '').toLowerCase().trim();
        const product = productsByName.get(baseName);
        if (!product) {
          results.push({ filename: file.originalname, matched: null, status: 'unmatched' });
          return;
        }
        try {
          const webpBuffer = await sharp(file.buffer)
            .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
          const s3Url = await uploadToS3(`products/${product.uniqueId}.webp`, webpBuffer, 'image/webp');
          await updateProductImage(product.uniqueId, req.user!.companyId, s3Url);
          await Promise.all([
            cacheDelPattern(`bm:products:list:${req.user!.companyId}:*`),
            cacheDel(key.productDetail(req.user!.companyId, product.uniqueId)),
          ]);
          results.push({ filename: file.originalname, matched: product.name, status: 'ok' });
        } catch (err) {
          results.push({ filename: file.originalname, matched: product.name, status: 'error', error: String(err) });
        }
      }));

      return res.json({
        total: files.length,
        matched: results.filter((r) => r.status === 'ok').length,
        unmatched: results.filter((r) => r.status === 'unmatched').length,
        failed: results.filter((r) => r.status === 'error').length,
        results,
      });
    } catch (error) {
      console.error('Bulk upload images error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
