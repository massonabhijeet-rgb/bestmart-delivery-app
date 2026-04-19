import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const Pool = pg.Pool;

// Pool sizing: default node-pg max is 10, which queues requests under
// bursty load even on small apps. Railway managed Postgres allows ~100
// total connections, so 20 leaves plenty of headroom for other services.
const POOL_MAX = parseInt(process.env.PG_POOL_MAX || '20', 10);

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: POOL_MAX,
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'postgres',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'admin',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: POOL_MAX,
    });

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err);
});

export default pool;
