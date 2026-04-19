import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;

let redis: Redis | null = null;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
  redis.on('error', (err: Error) => {
    console.warn('[cache] Redis error:', err.message);
  });
  redis.connect().catch((err: Error) => {
    console.warn('[cache] Redis connect failed, caching disabled:', err.message);
    redis = null;
  });
} else {
  console.info('[cache] REDIS_URL not set, caching disabled');
}

// TTLs in seconds
export const TTL = {
  PRODUCTS: 300,       // 5 min
  CATEGORIES: 600,     // 10 min
  COMPANY: 1800,       // 30 min
  ORDERS_LIST: 60,     // 1 min
  ORDERS_SUMMARY: 120, // 2 min
};

// Cache keys
export const key = {
  productsList: (companyId: number, includeInactive: boolean) =>
    `bm:products:list:${companyId}:${includeInactive ? '1' : '0'}`,
  productDetail: (companyId: number, uniqueId: string) =>
    `bm:products:detail:${companyId}:${uniqueId}`,
  categoriesList: (companyId: number) => `bm:categories:list:${companyId}`,
  companyPublic: () => 'bm:company:public',
  mobileBootstrap: () => 'bm:mobile:bootstrap',
  ordersList: (companyId: number) => `bm:orders:list:${companyId}`,
  ordersSummary: (companyId: number) => `bm:orders:summary:${companyId}`,
};

export function getRedis(): Redis | null {
  return redis;
}

export async function cacheGet<T>(cacheKey: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(cacheKey);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(cacheKey: string, value: unknown, ttl: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(cacheKey, JSON.stringify(value), 'EX', ttl);
  } catch {
    // non-fatal
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch {
    // non-fatal
  }
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  if (!redis) return;
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // non-fatal
  }
}
