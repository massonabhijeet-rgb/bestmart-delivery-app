// One-shot seed for the platform superuser. Provisioned out-of-band so
// the credentials never travel through the admin panel: the admin
// /create-user endpoint rejects role='superuser' and the team list
// hides any superuser row.
//
// Usage: tsx server/scripts/seedSuperuser.ts
//   Optional env: SU_EMAIL, SU_PASSWORD, SU_FULL_NAME (otherwise defaults
//   below). On collision the existing row is updated in place — the
//   password and role are reset, so this is also the recovery path.

import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import pool from '../pool.js';
import { getDefaultCompanyId } from '../db.js';

const EMAIL = (process.env.SU_EMAIL || 'ap@gmail.com').trim().toLowerCase();
const PASSWORD = process.env.SU_PASSWORD || 'pk@123';
const FULL_NAME = process.env.SU_FULL_NAME || 'Platform Owner';

async function main() {
  const companyId = await getDefaultCompanyId();
  if (!companyId) {
    throw new Error('Default company not found — run the API once to seed companies.');
  }
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const upsert = await pool.query(
    `
      INSERT INTO users (uid, email, password, role, company_id, full_name)
      VALUES ($1, $2, $3, 'superuser', $4, $5)
      ON CONFLICT (email) DO UPDATE
        SET password = EXCLUDED.password,
            role = 'superuser',
            full_name = EXCLUDED.full_name,
            failed_attempts = 0,
            locked_at = NULL
      RETURNING id, email, role;
    `,
    [uuidv4(), EMAIL, passwordHash, companyId, FULL_NAME],
  );

  const row = upsert.rows[0];
  console.log(`Superuser ready: id=${row.id} email=${row.email} role=${row.role}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
