-- One-shot maintenance script — plain SQL only, no PL/pgSQL.
--   1. Snapshot product names (so the rollback can restore casing).
--   2. INITCAP every name (APPLE IPHONE → Apple Iphone).
--   3. Lowercase unit suffixes after digits (5Kg → 5kg, 500Ml → 500ml).
--   4. Re-uppercase whitelisted brand acronyms (Ak → AK, Mdh → MDH, 7Up → 7UP …).
--   5. Auto-link sibling SKUs by setting variant_group_id on every product
--      that shares a brand_id + normalized name stem with another product.
--
-- Run inside a transaction so you can ROLLBACK if the preview looks wrong.
-- Each statement is independent — if any step errors, you'll see exactly which.
-- After committing, flush Redis (bm:products:*, bm:categories:*, bm:temp:*)
-- or restart the API so storefront caches refresh.

BEGIN;

-- ── 0. Snapshot original names (used by the rollback script) ────────────
DROP TABLE IF EXISTS products_backup_2026_04_18;
CREATE TABLE products_backup_2026_04_18 AS
  SELECT id, name FROM products;

-- ── 1. Title-case everything ────────────────────────────────────────────
UPDATE products
SET name = initcap(name),
    updated_date = NOW()
WHERE name <> initcap(name);

-- ── 2. Lowercase unit suffixes that follow a digit ──────────────────────
-- After INITCAP, "5KG" becomes "5Kg", "500ML" becomes "500Ml", etc.
-- We rewrite each unit individually so a single bad regex can't cascade.
UPDATE products SET name = regexp_replace(name, '(\d\s*)Kgs\M', '\1kgs', 'g')      WHERE name ~ '\d\s*Kgs\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Kg\M',  '\1kg',  'g')      WHERE name ~ '\d\s*Kg\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Mg\M',  '\1mg',  'g')      WHERE name ~ '\d\s*Mg\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Gms\M', '\1gms', 'g')      WHERE name ~ '\d\s*Gms\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Gm\M',  '\1gm',  'g')      WHERE name ~ '\d\s*Gm\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Grams\M', '\1grams', 'g')  WHERE name ~ '\d\s*Grams\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Gram\M',  '\1gram',  'g')  WHERE name ~ '\d\s*Gram\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)G\M',   '\1g',   'g')      WHERE name ~ '\d\s*G\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Ml\M',  '\1ml',  'g')      WHERE name ~ '\d\s*Ml\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Litres\M', '\1litres', 'g') WHERE name ~ '\d\s*Litres\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Litre\M',  '\1litre',  'g') WHERE name ~ '\d\s*Litre\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Ltr\M',  '\1ltr',  'g')    WHERE name ~ '\d\s*Ltr\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)L\M',   '\1l',   'g')      WHERE name ~ '\d\s*L\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Pcs\M', '\1pcs', 'g')      WHERE name ~ '\d\s*Pcs\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Pieces\M', '\1pieces', 'g') WHERE name ~ '\d\s*Pieces\M';
UPDATE products SET name = regexp_replace(name, '(\d\s*)Piece\M',  '\1piece',  'g') WHERE name ~ '\d\s*Piece\M';
UPDATE products SET updated_date = NOW() WHERE updated_date < NOW();  -- bump touched rows

-- ── 3. Re-uppercase brand acronyms ──────────────────────────────────────
-- Add or remove rows to taste. \m and \M are Postgres word-boundary anchors,
-- so "Ak" matches but "Aki" or "Bak" do not.
UPDATE products SET name = regexp_replace(name, '\mAk\M',   'AK',   'g') WHERE name ~ '\mAk\M';
UPDATE products SET name = regexp_replace(name, '\mMdh\M',  'MDH',  'g') WHERE name ~ '\mMdh\M';
UPDATE products SET name = regexp_replace(name, '\mMtr\M',  'MTR',  'g') WHERE name ~ '\mMtr\M';
UPDATE products SET name = regexp_replace(name, '\mItc\M',  'ITC',  'g') WHERE name ~ '\mItc\M';
UPDATE products SET name = regexp_replace(name, '\mGrb\M',  'GRB',  'g') WHERE name ~ '\mGrb\M';
UPDATE products SET name = regexp_replace(name, '\m7Up\M',  '7UP',  'g') WHERE name ~ '\m7Up\M';
UPDATE products SET name = regexp_replace(name, '\mTata\M', 'TATA', 'g') WHERE name ~ '\mTata\M';
UPDATE products SET name = regexp_replace(name, '\mKfc\M',  'KFC',  'g') WHERE name ~ '\mKfc\M';
UPDATE products SET name = regexp_replace(name, '\mPvr\M',  'PVR',  'g') WHERE name ~ '\mPvr\M';
UPDATE products SET name = regexp_replace(name, '\mLg\M',   'LG',   'g') WHERE name ~ '\mLg\M';
UPDATE products SET name = regexp_replace(name, '\mBpl\M',  'BPL',  'g') WHERE name ~ '\mBpl\M';
UPDATE products SET name = regexp_replace(name, '\mTvs\M',  'TVS',  'g') WHERE name ~ '\mTvs\M';
UPDATE products SET name = regexp_replace(name, '\mUsa\M',  'USA',  'g') WHERE name ~ '\mUsa\M';
UPDATE products SET name = regexp_replace(name, '\mUk\M',   'UK',   'g') WHERE name ~ '\mUk\M';
UPDATE products SET name = regexp_replace(name, '\mUae\M',  'UAE',  'g') WHERE name ~ '\mUae\M';
UPDATE products SET name = regexp_replace(name, '\mIpl\M',  'IPL',  'g') WHERE name ~ '\mIpl\M';
UPDATE products SET name = regexp_replace(name, '\mXl\M',   'XL',   'g') WHERE name ~ '\mXl\M';
UPDATE products SET name = regexp_replace(name, '\mXxl\M',  'XXL',  'g') WHERE name ~ '\mXxl\M';
UPDATE products SET name = regexp_replace(name, '\mHd\M',   'HD',   'g') WHERE name ~ '\mHd\M';
UPDATE products SET name = regexp_replace(name, '\mUht\M',  'UHT',  'g') WHERE name ~ '\mUht\M';
UPDATE products SET name = regexp_replace(name, '\mXo\M',   'XO',   'g') WHERE name ~ '\mXo\M';
UPDATE products SET name = regexp_replace(name, '\mHp\M',   'HP',   'g') WHERE name ~ '\mHp\M';

-- ── 4. Preview groupings (read-only — inspect before continuing) ────────
WITH stems AS (
  SELECT
    id,
    brand_id,
    name,
    btrim(regexp_replace(
      regexp_replace(
        lower(name),
        '\m\d+(\.\d+)?\s*(ml|l|ltr|litre|litres|g|gm|gms|gram|grams|kg|kgs|pcs?|pack|can|bottle|pouch|x)\M',
        '', 'g'
      ),
      '[^a-z0-9]+', ' ', 'g'
    )) AS stem
  FROM products
  WHERE brand_id IS NOT NULL
)
SELECT brand_id, stem,
       COUNT(*) AS variants,
       array_agg(name ORDER BY name) AS names
FROM stems
WHERE stem <> ''
GROUP BY brand_id, stem
HAVING COUNT(*) > 1
ORDER BY variants DESC, brand_id;

-- ── 5. Apply auto-grouping ──────────────────────────────────────────────
WITH stems AS (
  SELECT
    id,
    brand_id,
    btrim(regexp_replace(
      regexp_replace(
        lower(name),
        '\m\d+(\.\d+)?\s*(ml|l|ltr|litre|litres|g|gm|gms|gram|grams|kg|kgs|pcs?|pack|can|bottle|pouch|x)\M',
        '', 'g'
      ),
      '[^a-z0-9]+', ' ', 'g'
    )) AS stem
  FROM products
  WHERE brand_id IS NOT NULL
),
groups AS (
  SELECT brand_id, stem, MIN(id) AS anchor_id
  FROM stems
  WHERE stem <> ''
  GROUP BY brand_id, stem
  HAVING COUNT(*) > 1
)
UPDATE products p
SET variant_group_id = g.anchor_id,
    updated_date = NOW()
FROM stems s
JOIN groups g ON g.brand_id = s.brand_id AND g.stem = s.stem
WHERE p.id = s.id
  AND p.variant_group_id IS NULL;

-- ── 6. Verify before commit ─────────────────────────────────────────────
SELECT b.name AS before, p.name AS after, p.variant_group_id
FROM products p
JOIN products_backup_2026_04_18 b ON b.id = p.id
WHERE b.name <> p.name OR p.variant_group_id IS NOT NULL
ORDER BY p.id
LIMIT 80;

-- COMMIT;   -- uncomment after the verify SELECT looks right
-- ROLLBACK; -- or back out
