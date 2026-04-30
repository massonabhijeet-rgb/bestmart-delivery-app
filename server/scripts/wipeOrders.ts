// One-shot order-history wipe. Intended for the testing phase only —
// resets orders + every child table that references it (order_items,
// coupon_redemptions cascade automatically) and restarts the SERIAL
// sequence so the next placed order is BM-1 again. Tracking links to
// any previous public_id (BM-xxx) will 404 after this runs.
//
// Safety gate: requires WIPE_CONFIRM=yes in the env so a stray
// `npm run wipe:orders` against production never silently nukes the
// live order history.
//
// Usage:
//   WIPE_CONFIRM=yes npm run wipe:orders                # local DB via .env
//   DATABASE_URL='postgres://...' WIPE_CONFIRM=yes \
//     npm run wipe:orders                               # remote DB

import pool from '../pool.js';

async function main() {
  if (process.env.WIPE_CONFIRM !== 'yes') {
    throw new Error(
      'Refusing to wipe orders. Re-run with WIPE_CONFIRM=yes if this is really what you want.',
    );
  }

  // Pre-count: fail loud if these queries don't add up after the wipe.
  const before = await pool.query<{
    orders: string;
    items: string;
    redemptions: string;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM orders)              AS orders,
      (SELECT COUNT(*) FROM order_items)         AS items,
      (SELECT COUNT(*) FROM coupon_redemptions)  AS redemptions
  `);
  const b = before.rows[0];
  console.log(
    `Before wipe: orders=${b.orders} items=${b.items} redemptions=${b.redemptions}`,
  );

  // TRUNCATE ... CASCADE picks up order_items + coupon_redemptions
  // because both have ON DELETE CASCADE foreign keys to orders.
  // RESTART IDENTITY also resets the SERIAL sequence so the next
  // INSERT begins at id=1 (and public_id BM-1).
  await pool.query('TRUNCATE TABLE orders RESTART IDENTITY CASCADE;');

  const after = await pool.query<{
    orders: string;
    items: string;
    redemptions: string;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM orders)              AS orders,
      (SELECT COUNT(*) FROM order_items)         AS items,
      (SELECT COUNT(*) FROM coupon_redemptions)  AS redemptions
  `);
  const a = after.rows[0];
  console.log(
    `After wipe : orders=${a.orders} items=${a.items} redemptions=${a.redemptions}`,
  );

  if (a.orders !== '0' || a.items !== '0' || a.redemptions !== '0') {
    throw new Error('Wipe completed but row counts are non-zero. Check FKs.');
  }
  console.log('Order history wiped clean. Next order will be BM-1.');
}

main()
  .catch((err) => {
    console.error('wipeOrders failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
