-- Rollback for 2026-04-18_titlecase_and_autogroup_variants.sql
--
-- WHAT THIS UNDOES
--   ✓ Step 2 (auto-grouping): clears variant_group_id on every product.
--     Fully reversible — variant_group_id was NULL for everything before
--     the migration ran (the column was added in the same release).
--
-- WHAT THIS CANNOT UNDO
--   ✗ Step 1 (title-case): once "APPLE IPHONE" was overwritten with
--     "Apple Iphone", the original casing is gone. To undo it you need
--     a backup taken BEFORE the forward migration ran. See section B
--     below for the snapshot-based recovery if you saved one.
--
-- After running, flush Redis (bm:products:*, bm:temp:*) or restart the API.

BEGIN;

-- ── A. Clear all variant_group_id (always safe to run) ──────────────────
UPDATE products
SET variant_group_id = NULL,
    updated_date = NOW()
WHERE variant_group_id IS NOT NULL;

-- ── B. Restore original names FROM A SNAPSHOT (only if you took one) ────
-- If you ran `CREATE TABLE products_backup_2026_04_18 AS SELECT id, name FROM products;`
-- BEFORE the forward migration, uncomment the block below. Otherwise leave
-- it commented — there is no other way to recover the prior casing.
--
-- UPDATE products p
-- SET name = b.name,
--     updated_date = NOW()
-- FROM products_backup_2026_04_18 b
-- WHERE p.id = b.id
--   AND p.name <> b.name;

-- ── C. Verify ───────────────────────────────────────────────────────────
SELECT
  COUNT(*) FILTER (WHERE variant_group_id IS NOT NULL) AS still_grouped,
  COUNT(*) AS total
FROM products;
-- Expect: still_grouped = 0

-- COMMIT;   -- uncomment after the verify SELECT looks right
-- ROLLBACK; -- or back out
