import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { deleteFromS3, uploadToS3 } from '../s3.js';
import {
  attachUserIfPresent,
  authenticateToken,
  requireRole,
} from '../middleware/auth.js';
import {
  bulkImportProducts,
  createProduct,
  deactivateProduct,
  getDefaultCompanyId,
  getHomeRails,
  getInventorySummary,
  getProductByUniqueId,
  getStorefrontSpotlight,
  logClickEvent,
  logSearchEvent,
  hardDeleteProduct,
  listProducts,
  listProductNameIndex,
  listProductsPage,
  listProductVariants,
  listSlowMovers,
  restoreProduct,
  setProductOffer,
  updateProduct,
  updateProductImage,
  type BulkImportProductRow,
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
    brandId: has('brandId')
      ? body.brandId === '' || body.brandId == null
        ? null
        : Number(body.brandId)
      : undefined,
    variantGroupId: has('variantGroupId')
      ? body.variantGroupId === '' || body.variantGroupId == null
        ? null
        : Number(body.variantGroupId)
      : undefined,
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

// Paged listing.
// Public (default): inactive & hidden categories excluded.
// Admin (?admin=1, requires admin/editor): everything visible plus status,
// categoryId, onOffer, sort filters. Cache key embeds every filter.
router.get('/page', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
  if (!companyId) return res.status(404).json({ error: 'Company not found' });

  const wantsAdmin = req.query.admin === '1' || req.query.admin === 'true';
  const isAdmin =
    wantsAdmin &&
    !!req.user &&
    (req.user.role === 'admin' || req.user.role === 'editor') &&
    req.user.companyId === companyId;

  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.max(1, Math.min(200, parseInt(String(req.query.pageSize ?? '24'), 10) || 24));
  const category = req.query.category ? String(req.query.category) : null;
  const categoryIdRaw = req.query.categoryId ? Number(req.query.categoryId) : null;
  const categoryId = Number.isFinite(categoryIdRaw) ? categoryIdRaw : null;
  const brand = req.query.brand ? String(req.query.brand) : null;
  const search = req.query.q ? String(req.query.q) : null;
  const idsRaw = req.query.ids ? String(req.query.ids) : null;
  const ids = idsRaw
    ? idsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const status = isAdmin && req.query.status
    ? (String(req.query.status) as 'all' | 'active' | 'archived' | 'low_stock')
    : null;
  const onOfferRaw = req.query.onOffer;
  const onOffer = isAdmin && (onOfferRaw === '1' || onOfferRaw === 'true')
    ? true
    : isAdmin && (onOfferRaw === '0' || onOfferRaw === 'false')
      ? false
      : null;
  const sortRaw = req.query.sort ? String(req.query.sort) : null;
  const sort = (['price_asc','price_desc','stock_asc','stock_desc','created_desc','default'] as const).includes(
    sortRaw as never,
  )
    ? (sortRaw as 'price_asc' | 'price_desc' | 'stock_asc' | 'stock_desc' | 'created_desc' | 'default')
    : null;

  const cacheKey = `bm:products:page:${isAdmin ? 'a' : 'p'}:${companyId}:${page}:${pageSize}:${category ?? ''}:${categoryId ?? ''}:${brand ?? ''}:${search ?? ''}:${ids ? ids.join(',') : ''}:${status ?? ''}:${onOffer ?? ''}:${sort ?? ''}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) return res.json(cached);

  const result = await listProductsPage({
    companyId, page, pageSize, category, categoryId, brand, search, ids,
    admin: isAdmin, status, onOffer, sort,
  });
  await cacheSet(cacheKey, result, 60); // 1 min — short to keep stock fresh
  return res.json(result);
});

// Admin overview: aggregates + low-stock + recents in one round-trip.
// Replaces the old pattern of fetching the entire product catalog just to
// count rows on the Dashboard.
router.get(
  '/admin-summary',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      const cacheKey = `bm:products:adminsummary:${req.user.companyId}`;
      const cached = await cacheGet<unknown>(cacheKey);
      if (cached) return res.json(cached);
      const summary = await getInventorySummary(req.user.companyId);
      await cacheSet(cacheKey, summary, 60);
      return res.json(summary);
    } catch (error) {
      console.error('Admin summary error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Lightweight name index — used by the bulk-image picker to match files to
// products without pulling the full catalog payload.
router.get(
  '/name-index',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      const cacheKey = `bm:products:nameindex:${req.user.companyId}`;
      const cached = await cacheGet<unknown>(cacheKey);
      if (cached) return res.json(cached);
      const index = await listProductNameIndex(req.user.companyId);
      const payload = { products: index };
      await cacheSet(cacheKey, payload, 120);
      return res.json(payload);
    } catch (error) {
      console.error('Name index error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Bundle of homepage-strip products in one round-trip.
router.get('/spotlight', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
  if (!companyId) return res.status(404).json({ error: 'Company not found' });

  const mood = req.query.mood ? String(req.query.mood) : null;
  const cacheKey = `bm:products:spotlight:${companyId}:${mood ?? 'none'}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) return res.json(cached);

  const spotlight = await getStorefrontSpotlight(companyId, mood, 12);
  await cacheSet(cacheKey, spotlight, 120); // 2 min
  return res.json(spotlight);
});

// Storefront home page rails: global bestsellers + one rail per category, all
// sorted by 30-day units sold. Cached for 10 min — product writes bust via
// the existing bm:products:* invalidation in write paths.
router.get('/home-rails', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
  if (!companyId) return res.status(404).json({ error: 'Company not found' });

  // Per-user cache when logged in (shorter TTL because affinity drifts with
  // every order); shared anonymous cache otherwise. Both fan-out from the
  // same bm:products:* invalidation pattern on product writes.
  const userId = req.user?.id ?? null;
  const cacheKey = userId
    ? `bm:products:home-rails:${companyId}:u${userId}`
    : `bm:products:home-rails:${companyId}:all`;
  const ttl = userId ? 300 : 600;

  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) return res.json(cached);

  const rails = await getHomeRails(companyId, { limit: 8, days: 30, userId });
  await cacheSet(cacheKey, rails, ttl);
  return res.json(rails);
});

// Fire-and-forget search logging from the storefront. Anonymous users are
// tracked with user_id=null. Popular queries feed category-level ranking in
// getHomeRails via getCategorySearchScores.
router.post('/search/log', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
  if (!companyId) return res.status(204).end();

  const { query, categoryId } = req.body ?? {};
  if (typeof query !== 'string') return res.status(204).end();

  try {
    await logSearchEvent(companyId, query, {
      userId: req.user?.id,
      categoryId: typeof categoryId === 'number' ? categoryId : undefined,
    });
  } catch (err) {
    console.error('logSearchEvent failed:', err);
  }
  return res.status(204).end();
});

// Fire-and-forget click logging for CTR + per-user personalization. Called
// from rail card taps and search-result clicks on the storefront.
router.post('/click/log', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
  if (!companyId) return res.status(204).end();

  const { productId, categoryId, source } = req.body ?? {};
  if (typeof source !== 'string' || source.trim().length === 0) {
    return res.status(204).end();
  }

  try {
    await logClickEvent(companyId, {
      userId: req.user?.id,
      productId: typeof productId === 'number' ? productId : undefined,
      categoryId: typeof categoryId === 'number' ? categoryId : undefined,
      source,
    });
  } catch (err) {
    console.error('logClickEvent failed:', err);
  }
  return res.status(204).end();
});

router.get(
  '/slow-movers',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const suggestions = await listSlowMovers(req.user.companyId);
      return res.json({ suggestions });
    } catch (error) {
      console.error('Slow movers error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Sibling variants (same variant_group_id). Storefront uses this to render the
// "Other sizes" strip with unit-price comparison.
router.get('/:uniqueId/variants', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
  const uniqueId = getRouteParam(req.params.uniqueId);
  if (!companyId) return res.status(404).json({ error: 'Company not found' });
  if (!uniqueId) return res.status(400).json({ error: 'Product ID is required' });

  const cacheKey = `${key.productDetail(companyId, uniqueId)}:variants`;
  const cached = await cacheGet<{ variants: unknown[] }>(cacheKey);
  if (cached) return res.json(cached);

  const variants = await listProductVariants(uniqueId, companyId);
  const visible = req.user ? variants : variants.filter((p) => p.isActive);
  const result = { variants: visible };
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
        brandId: payload.brandId ?? null,
        variantGroupId: payload.variantGroupId ?? null,
      });

      await cacheDelPattern(`bm:products:*:${req.user.companyId}:*`);
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
        brandId: payload.brandId !== undefined ? payload.brandId : existing.brandId,
        variantGroupId:
          payload.variantGroupId !== undefined ? payload.variantGroupId : existing.variantGroupId,
      });

      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }

      await Promise.all([
        cacheDelPattern(`bm:products:*:${req.user.companyId}:*`),
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
      cacheDelPattern(`bm:products:*:${req.user.companyId}:*`),
      cacheDel(key.productDetail(req.user.companyId, uniqueId)),
    ]);
    return res.json({ message: 'Product moved to trash' });
  }
);

router.post(
  '/:uniqueId/restore',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    const uniqueId = getRouteParam(req.params.uniqueId);
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!uniqueId) return res.status(400).json({ error: 'Product ID is required' });
    const ok = await restoreProduct(uniqueId, req.user.companyId);
    if (!ok) return res.status(404).json({ error: 'Product not found' });
    await Promise.all([
      cacheDelPattern(`bm:products:*:${req.user.companyId}:*`),
      cacheDel(key.productDetail(req.user.companyId, uniqueId)),
    ]);
    return res.json({ message: 'Product restored' });
  }
);

router.delete(
  '/:uniqueId/permanent',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    const uniqueId = getRouteParam(req.params.uniqueId);
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!uniqueId) return res.status(400).json({ error: 'Product ID is required' });
    const result = await hardDeleteProduct(uniqueId, req.user.companyId);
    if (result.notFound) return res.status(404).json({ error: 'Product not found' });
    if (result.hasOrders) {
      return res.status(409).json({
        error:
          'This product has past orders and cannot be permanently deleted. It will stay in trash so order history keeps working.',
      });
    }
    await Promise.all([
      cacheDelPattern(`bm:products:*:${req.user.companyId}:*`),
      cacheDel(key.productDetail(req.user.companyId, uniqueId)),
    ]);
    return res.json({ message: 'Product permanently deleted' });
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
      const { isOnOffer, offerPriceCents, offerType, bogoBuyQty, bogoGetQty } = req.body as {
        isOnOffer?: boolean;
        offerPriceCents?: number | null;
        offerType?: 'price' | 'bogo';
        bogoBuyQty?: number;
        bogoGetQty?: number;
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
      const buyQty =
        resolvedType === 'bogo' ? Math.max(1, Math.round(Number(bogoBuyQty ?? 1))) : 1;
      const getQty =
        resolvedType === 'bogo' ? Math.max(1, Math.round(Number(bogoGetQty ?? 1))) : 1;
      if (resolvedType === 'bogo' && (!Number.isFinite(buyQty) || !Number.isFinite(getQty))) {
        return res.status(400).json({ error: 'bogoBuyQty and bogoGetQty must be positive integers' });
      }
      const product = await setProductOffer(
        uniqueId,
        req.user.companyId,
        isOnOffer,
        normalizedPrice,
        resolvedType,
        buyQty,
        getQty,
      );
      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }
      await Promise.all([
        cacheDelPattern(`bm:products:*:${req.user.companyId}:*`),
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
  '/bulk-import',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const body = req.body as { products?: unknown };
      if (!Array.isArray(body.products)) {
        return res.status(400).json({ error: 'products array is required' });
      }

      const rows: BulkImportProductRow[] = [];
      for (const raw of body.products as Array<Record<string, unknown>>) {
        const name = String(raw.name ?? '').trim();
        const categoryName = String(raw.categoryName ?? '').trim();
        const unitLabel = String(raw.unitLabel ?? '').trim();
        const description = String(raw.description ?? '').trim();
        const priceCents = Number(raw.priceCents);
        const stockQuantity = Number(raw.stockQuantity);
        if (
          !name ||
          !categoryName ||
          !unitLabel ||
          !description ||
          !Number.isFinite(priceCents) ||
          !Number.isFinite(stockQuantity)
        ) {
          continue;
        }
        const brandRaw = raw.brandName == null ? '' : String(raw.brandName).trim();
        const originalRaw = raw.originalPriceCents;
        const originalPriceCents =
          originalRaw == null || originalRaw === '' ? null : Number(originalRaw);
        rows.push({
          rowNum: Number(raw.rowNum) || 0,
          name,
          categoryName,
          brandName: brandRaw || null,
          unitLabel,
          description,
          priceCents,
          originalPriceCents:
            originalPriceCents != null && Number.isFinite(originalPriceCents)
              ? originalPriceCents
              : null,
          stockQuantity,
          badge: raw.badge ? String(raw.badge).trim() || null : null,
          imageUrl: raw.imageUrl ? String(raw.imageUrl).trim() || null : null,
          isActive: raw.isActive == null ? true : Boolean(raw.isActive),
        });
      }

      const result = await bulkImportProducts(req.user.companyId, rows);

      if (result.created > 0 || result.brandsCreated > 0) {
        await cacheDelPattern(`bm:products:*:${req.user.companyId}:*`);
      }

      return res.json(result);
    } catch (error) {
      console.error('Bulk import error:', error);
      const message = error instanceof Error ? error.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  },
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

      // Replace, don't append: drop the existing object (cleans up stray
      // keys from bulk-import URLs) and cache-bust the saved URL so the
      // browser doesn't keep showing the old image at the same path.
      if (product.imageUrl) {
        await deleteFromS3(product.imageUrl);
      }
      const baseUrl = await uploadToS3(`products/${uniqueId}.webp`, webpBuffer, 'image/webp');
      const s3Url = `${baseUrl}?v=${Date.now()}`;
      const updated = await updateProductImage(uniqueId, req.user.companyId, s3Url);

      await Promise.all([
        cacheDelPattern(`bm:products:*:${req.user.companyId}:*`),
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
          if (product.imageUrl) {
            await deleteFromS3(product.imageUrl);
          }
          const baseUrl = await uploadToS3(`products/${product.uniqueId}.webp`, webpBuffer, 'image/webp');
          const s3Url = `${baseUrl}?v=${Date.now()}`;
          await updateProductImage(product.uniqueId, req.user!.companyId, s3Url);
          await Promise.all([
            cacheDelPattern(`bm:products:*:${req.user!.companyId}:*`),
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
