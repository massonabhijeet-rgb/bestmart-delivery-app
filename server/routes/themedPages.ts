import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import {
  attachUserIfPresent,
  authenticateToken,
  requireRole,
} from '../middleware/auth.js';
import {
  createThemedPage,
  deleteThemedPage,
  getDefaultCompanyId,
  getThemedPageById,
  getThemedPageBySlug,
  listActiveThemedPages,
  listAllThemedPages,
  replaceThemedPageTiles,
  updateThemedPage,
  updateThemedPageImage,
  updateThemedPageTileImage,
  type ThemedPageTileLinkType,
  type UpsertThemedPageInput,
  type UpsertThemedPageTileInput,
} from '../db.js';
import { deleteFromS3, uploadToS3 } from '../s3.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function getRouteParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asInt(value: unknown): number | null {
  // Treat null / undefined / '' as "absent" — without this, Number(null)
  // becomes 0 and slips into FK columns as a non-existent row id (the
  // themed_page_tiles_link_category_id_fkey violation we hit when a
  // search-type tile carried a null linkCategoryId).
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const VALID_LINK_TYPES: readonly ThemedPageTileLinkType[] = [
  'category',
  'search',
  'product_ids',
];

function parsePageInput(body: unknown): UpsertThemedPageInput | string {
  if (!body || typeof body !== 'object') return 'Invalid request body';
  const b = body as Record<string, unknown>;
  const slug = String(b.slug ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  const title = String(b.title ?? '').trim();
  if (!slug) return 'slug is required';
  if (!title) return 'title is required';
  return {
    slug,
    title,
    subtitle: typeof b.subtitle === 'string' ? b.subtitle.trim() || null : null,
    themeColor:
      typeof b.themeColor === 'string' ? b.themeColor.trim() || null : null,
    isActive: typeof b.isActive === 'boolean' ? b.isActive : true,
    sortOrder: asInt(b.sortOrder) ?? 0,
    validFrom:
      typeof b.validFrom === 'string' && b.validFrom ? b.validFrom : null,
    validTo: typeof b.validTo === 'string' && b.validTo ? b.validTo : null,
  };
}

function parseTileInputs(
  body: unknown,
): UpsertThemedPageTileInput[] | string {
  if (!body || typeof body !== 'object') return 'Invalid request body';
  const tiles = (body as { tiles?: unknown }).tiles;
  if (!Array.isArray(tiles)) return 'tiles must be an array';
  const out: UpsertThemedPageTileInput[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const raw = tiles[i];
    if (!raw || typeof raw !== 'object') return `tiles[${i}] is not an object`;
    const t = raw as Record<string, unknown>;
    const label = String(t.label ?? '').trim();
    if (!label) return `tiles[${i}].label is required`;
    const linkType = String(t.linkType ?? '').trim() as ThemedPageTileLinkType;
    if (!VALID_LINK_TYPES.includes(linkType)) {
      return `tiles[${i}].linkType must be one of: ${VALID_LINK_TYPES.join(', ')}`;
    }
    const linkCategoryId = asInt(t.linkCategoryId);
    const linkSearchQuery =
      typeof t.linkSearchQuery === 'string' && t.linkSearchQuery.trim()
        ? t.linkSearchQuery.trim()
        : null;
    const linkProductIds = Array.isArray(t.linkProductIds)
      ? t.linkProductIds
          .map((x) => asInt(x))
          .filter((n): n is number => n != null)
      : null;
    if (linkType === 'category' && linkCategoryId == null) {
      return `tiles[${i}].linkCategoryId is required when linkType=category`;
    }
    if (linkType === 'search' && !linkSearchQuery) {
      return `tiles[${i}].linkSearchQuery is required when linkType=search`;
    }
    if (
      linkType === 'product_ids' &&
      (!linkProductIds || linkProductIds.length === 0)
    ) {
      return `tiles[${i}].linkProductIds is required when linkType=product_ids`;
    }
    // Belt-and-suspenders: only carry the link target column that
    // matches the link type. Prevents a stale linkCategoryId from a
    // since-changed link type leaking through to the FK column.
    out.push({
      id: asInt(t.id),
      label,
      sublabel:
        typeof t.sublabel === 'string' ? t.sublabel.trim() || null : null,
      imageUrl: typeof t.imageUrl === 'string' ? t.imageUrl : null,
      bgColor:
        typeof t.bgColor === 'string' ? t.bgColor.trim() || null : null,
      linkType,
      linkCategoryId: linkType === 'category' ? linkCategoryId : null,
      linkSearchQuery: linkType === 'search' ? linkSearchQuery : null,
      linkProductIds: linkType === 'product_ids' ? linkProductIds : null,
      sortOrder: asInt(t.sortOrder) ?? i,
    });
  }
  return out;
}

// ─── Public ──────────────────────────────────────────────────────────────

// Storefront list — only active, in-window pages with their tiles inlined.
router.get('/', attachUserIfPresent, async (req: AuthenticatedRequest, res) => {
  try {
    const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
    if (!companyId) return res.status(404).json({ error: 'Company not found' });
    const pages = await listActiveThemedPages(companyId);
    return res.json({ themedPages: pages });
  } catch (err) {
    console.error('list active themed pages failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get(
  '/:slug',
  attachUserIfPresent,
  async (req: AuthenticatedRequest, res) => {
    try {
      const companyId = req.user?.companyId ?? (await getDefaultCompanyId());
      if (!companyId) return res.status(404).json({ error: 'Company not found' });
      const slug = String(getRouteParam(req.params.slug) ?? '').trim();
      if (!slug) return res.status(400).json({ error: 'slug is required' });
      const page = await getThemedPageBySlug(companyId, slug);
      if (!page) return res.status(404).json({ error: 'Themed page not found' });
      return res.json({ themedPage: page });
    } catch (err) {
      console.error('get themed page failed:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Admin ───────────────────────────────────────────────────────────────

router.get(
  '/admin/all',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const pages = await listAllThemedPages(req.user.companyId);
      return res.json({ themedPages: pages });
    } catch (err) {
      console.error('admin list themed pages failed:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const parsed = parsePageInput(req.body);
      if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
      const page = await createThemedPage(req.user.companyId, parsed);
      return res.status(201).json({ themedPage: page });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to create themed page';
      if (msg.toLowerCase().includes('duplicate')) {
        return res.status(409).json({ error: 'A themed page with that slug already exists' });
      }
      console.error('create themed page failed:', err);
      return res.status(400).json({ error: msg });
    }
  },
);

router.put(
  '/:id',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const id = asInt(getRouteParam(req.params.id));
      if (id == null) return res.status(400).json({ error: 'Invalid id' });
      const parsed = parsePageInput(req.body);
      if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
      const page = await updateThemedPage(id, req.user.companyId, parsed);
      if (!page) return res.status(404).json({ error: 'Themed page not found' });
      return res.json({ themedPage: page });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to update themed page';
      if (msg.toLowerCase().includes('duplicate')) {
        return res.status(409).json({ error: 'A themed page with that slug already exists' });
      }
      console.error('update themed page failed:', err);
      return res.status(400).json({ error: msg });
    }
  },
);

router.delete(
  '/:id',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const id = asInt(getRouteParam(req.params.id));
      if (id == null) return res.status(400).json({ error: 'Invalid id' });
      const result = await deleteThemedPage(id, req.user.companyId);
      if (!result.deleted) {
        return res.status(404).json({ error: 'Themed page not found' });
      }
      // Clean up S3 artwork; ignore failures so the row stays deleted even
      // if the bucket complains.
      const objects = [
        result.navIconUrl,
        result.heroImageUrl,
        ...result.tileImageUrls,
      ].filter((u): u is string => !!u);
      await Promise.all(
        objects.map((u) =>
          deleteFromS3(u).catch((err) => {
            console.warn('themed page S3 delete failed for', u, err);
          }),
        ),
      );
      return res.json({ deleted: true });
    } catch (err) {
      console.error('delete themed page failed:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.put(
  '/:id/tiles',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const id = asInt(getRouteParam(req.params.id));
      if (id == null) return res.status(400).json({ error: 'Invalid id' });
      const parsed = parseTileInputs(req.body);
      if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
      const page = await replaceThemedPageTiles(id, req.user.companyId, parsed);
      if (!page) return res.status(404).json({ error: 'Themed page not found' });
      return res.json({ themedPage: page });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to update tiles';
      console.error('replace themed page tiles failed:', err);
      return res.status(400).json({ error: msg });
    }
  },
);

// ─── Image uploads ───────────────────────────────────────────────────────

router.post(
  '/:id/upload-image',
  authenticateToken,
  requireRole('admin', 'editor'),
  imageUpload.single('image'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const id = asInt(getRouteParam(req.params.id));
      if (id == null) return res.status(400).json({ error: 'Invalid id' });
      const kindRaw = String(req.query.kind ?? '').trim();
      if (kindRaw !== 'nav' && kindRaw !== 'hero') {
        return res
          .status(400)
          .json({ error: 'kind query param must be "nav" or "hero"' });
      }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const existing = await getThemedPageById(id, req.user.companyId);
      if (!existing) return res.status(404).json({ error: 'Themed page not found' });

      // Nav icon: square, small. Hero: wide banner, larger but still
      // capped — a 1080×480 JPEG-ish frame keeps the page light enough
      // for slow networks.
      const targetWidth = kindRaw === 'nav' ? 192 : 1080;
      const targetHeight = kindRaw === 'nav' ? 192 : 480;
      const webp = await sharp(req.file.buffer)
        .resize({
          width: targetWidth,
          height: targetHeight,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: kindRaw === 'nav' ? 88 : 82 })
        .toBuffer();

      // Replace the prior object in S3 if there was one, then cache-bust
      // the URL with a timestamp so clients refresh immediately.
      const previous =
        kindRaw === 'nav' ? existing.navIconUrl : existing.heroImageUrl;
      if (previous) await deleteFromS3(previous).catch(() => undefined);
      const baseUrl = await uploadToS3(
        `themed-pages/${id}-${kindRaw}.webp`,
        webp,
        'image/webp',
      );
      const url = `${baseUrl}?v=${Date.now()}`;
      const updated = await updateThemedPageImage(
        id,
        req.user.companyId,
        kindRaw,
        url,
      );
      if (!updated) return res.status(404).json({ error: 'Themed page not found' });
      return res.json({ themedPage: updated });
    } catch (err) {
      console.error('upload themed page image failed:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/:id/tiles/:tileId/upload-image',
  authenticateToken,
  requireRole('admin', 'editor'),
  imageUpload.single('image'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const id = asInt(getRouteParam(req.params.id));
      const tileId = asInt(getRouteParam(req.params.tileId));
      if (id == null || tileId == null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      // Tile artwork: square-ish product cutout, small enough to be cheap
      // to load on a 5-tile grid but big enough to look crisp on tablets.
      const webp = await sharp(req.file.buffer)
        .resize({
          width: 480,
          height: 480,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 84 })
        .toBuffer();

      const baseUrl = await uploadToS3(
        `themed-pages/${id}-tile-${tileId}.webp`,
        webp,
        'image/webp',
      );
      const url = `${baseUrl}?v=${Date.now()}`;
      const updated = await updateThemedPageTileImage(
        tileId,
        id,
        req.user.companyId,
        url,
      );
      if (!updated) return res.status(404).json({ error: 'Tile not found' });
      return res.json({ tile: updated });
    } catch (err) {
      console.error('upload themed page tile image failed:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
