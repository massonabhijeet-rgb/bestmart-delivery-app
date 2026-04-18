import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import pool from './pool.js';
import type { OrderStatus, UserRole } from './types.js';

export interface DbUser {
  id: number;
  uid: string;
  email: string;
  password: string;
  role: UserRole;
  companyId: number;
  companyName: string;
  failedAttempts: number;
  lockedAt: string | null;
  fullName: string | null;
  phone: string | null;
}

export interface ProductRecord {
  id: number;
  uniqueId: string;
  companyId: number;
  name: string;
  slug: string;
  categoryId: number | null;
  category: string | null;
  categoryImageUrl: string | null;
  description: string;
  unitLabel: string;
  priceCents: number;
  originalPriceCents: number | null;
  stockQuantity: number;
  badge: string | null;
  imageUrl: string | null;
  isActive: boolean;
  isOnOffer: boolean;
  offerPriceCents: number | null;
  offerType: 'price' | 'bogo';
  bogoBuyQty: number;
  bogoGetQty: number;
  brandId: number | null;
  brand: string | null;
  createdDate: string;
  updatedDate: string;
}

export interface CategoryRecord {
  id: number;
  companyId: number;
  name: string;
  slug: string;
  imageUrl: string | null;
  createdDate: string;
  updatedDate: string;
}

export interface OrderItemInput {
  productId: string;
  quantity: number;
}

export interface OrderRecord {
  id: number;
  publicId: string;
  companyId: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  deliveryAddress: string;
  deliveryNotes: string | null;
  deliverySlot: string | null;
  paymentMethod: string;
  subtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  totalCents: number;
  status: OrderStatus;
  assignedRider: string | null;
  assignedRiderUserId: number | null;
  assignedRiderPhone: string | null;
  geoLabel: string | null;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  createdDate: string;
  updatedDate: string;
  items: Array<{
    id: number;
    productId: number | null;
    productName: string;
    unitLabel: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
  }>;
}

type DbUserRow = DbUser;
type ProductRow = ProductRecord;
type OrderRow = Omit<OrderRecord, 'items'>;
type OrderItemRow = OrderRecord['items'][number];

interface OrderLookupProductRow {
  id: number;
  uniqueId: string;
  name: string;
  unitLabel: string;
  priceCents: number;
  regularPriceCents: number;
  offerPriceCents: number | null;
  isOnOffer: boolean;
  offerType: string;
  bogoBuyQty: number;
  bogoGetQty: number;
  stockQuantity: number;
  isActive: boolean;
}

interface CreateUserInput {
  email: string;
  password: string;
  role: UserRole;
  companyId: number;
  fullName?: string | null;
  phone?: string | null;
}

interface CreateProductInput {
  companyId: number;
  name: string;
  slug: string;
  categoryId: number;
  description: string;
  unitLabel: string;
  priceCents: number;
  originalPriceCents?: number | null;
  stockQuantity: number;
  badge?: string | null;
  imageUrl?: string | null;
  isActive?: boolean;
  isOnOffer?: boolean;
  brandId?: number | null;
}

interface UpdateProductInput extends CreateProductInput {
  uniqueId: string;
}

interface CreateOrderInput {
  companyId: number;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  deliveryAddress: string;
  deliveryNotes?: string | null;
  deliverySlot?: string | null;
  paymentMethod: string;
  items: OrderItemInput[];
  geoLabel?: string | null;
  deliveryLatitude?: number | null;
  deliveryLongitude?: number | null;
  createdByUserId?: number | null;
  couponCode?: string | null;
}

function toSlug(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

function makeTrackingCode() {
  return `BM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function mapUser(row: DbUserRow): DbUser {
  return {
    id: row.id,
    uid: row.uid,
    email: row.email,
    password: row.password,
    role: row.role,
    companyId: row.companyId,
    companyName: row.companyName,
    failedAttempts: row.failedAttempts,
    lockedAt: row.lockedAt,
    fullName: row.fullName ?? null,
    phone: row.phone ?? null,
  };
}

function mapProduct(row: ProductRow): ProductRecord {
  return {
    id: row.id,
    uniqueId: row.uniqueId,
    companyId: row.companyId,
    name: row.name,
    slug: row.slug,
    categoryId: row.categoryId,
    category: row.category,
    categoryImageUrl: row.categoryImageUrl,
    description: row.description,
    unitLabel: row.unitLabel,
    priceCents: row.priceCents,
    originalPriceCents: row.originalPriceCents,
    stockQuantity: row.stockQuantity,
    badge: row.badge,
    imageUrl: row.imageUrl,
    isActive: row.isActive,
    isOnOffer: Boolean(row.isOnOffer),
    offerPriceCents: row.offerPriceCents ?? null,
    offerType: row.offerType === 'bogo' ? 'bogo' : 'price',
    bogoBuyQty: Math.max(1, Number(row.bogoBuyQty ?? 1)),
    bogoGetQty: Math.max(1, Number(row.bogoGetQty ?? 1)),
    brandId: row.brandId ?? null,
    brand: row.brand ?? null,
    createdDate: row.createdDate,
    updatedDate: row.updatedDate,
  };
}

function mapCategory(row: {
  id: number;
  companyId: number;
  name: string;
  slug: string;
  imageUrl: string | null;
  createdDate: string;
  updatedDate: string;
}): CategoryRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    slug: row.slug,
    imageUrl: row.imageUrl ?? null,
    createdDate: row.createdDate,
    updatedDate: row.updatedDate,
  };
}

async function createTables(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      slug VARCHAR(255) NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      support_phone VARCHAR(50),
      support_email VARCHAR(255),
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      uid UUID NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_at TIMESTAMPTZ,
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin', 'editor', 'viewer', 'rider'));
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_addresses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      full_name VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      delivery_address TEXT NOT NULL,
      delivery_notes TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      use_count INTEGER NOT NULL DEFAULT 1,
      last_used_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, full_name, phone, delivery_address)
    );
  `);
  await client.query(`
    ALTER TABLE user_addresses ADD COLUMN IF NOT EXISTS updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS brands (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name VARCHAR(120) NOT NULL,
      slug VARCHAR(120) NOT NULL,
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, slug)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name VARCHAR(120) NOT NULL,
      slug VARCHAR(120) NOT NULL,
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, slug)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      unique_id UUID NOT NULL UNIQUE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL,
      category VARCHAR(120),
      description TEXT NOT NULL,
      unit_label VARCHAR(120) NOT NULL,
      price_cents INTEGER NOT NULL,
      original_price_cents INTEGER,
      stock_quantity INTEGER NOT NULL DEFAULT 0,
      badge VARCHAR(120),
      image_url TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS is_on_offer BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_price_cents INTEGER;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_type TEXT NOT NULL DEFAULT 'price';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS bogo_buy_qty INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS bogo_get_qty INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL;
  `);

  await client.query(`
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url TEXT;
  `);

  // One-time migration: copy distinct values from legacy products.category into categories rows,
  // then populate products.category_id, then drop the legacy column.
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'category'
      ) THEN
        INSERT INTO categories (company_id, name, slug)
        SELECT DISTINCT
          p.company_id,
          p.category,
          lower(regexp_replace(p.category, '[^a-zA-Z0-9]+', '-', 'g'))
        FROM products p
        WHERE p.category IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM categories c
            WHERE c.company_id = p.company_id AND c.name = p.category
          );

        UPDATE products p
        SET category_id = c.id
        FROM categories c
        WHERE p.category_id IS NULL
          AND p.category IS NOT NULL
          AND c.company_id = p.company_id
          AND c.name = p.category;

        ALTER TABLE products DROP COLUMN category;
      END IF;
    END $$;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      public_id VARCHAR(20) NOT NULL UNIQUE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      customer_name VARCHAR(255) NOT NULL,
      customer_phone VARCHAR(50) NOT NULL,
      customer_email VARCHAR(255),
      delivery_address TEXT NOT NULL,
      delivery_notes TEXT,
      delivery_slot VARCHAR(120),
      payment_method VARCHAR(60) NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      delivery_fee_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      status VARCHAR(40) NOT NULL CHECK (status IN ('placed', 'confirmed', 'packing', 'out_for_delivery', 'delivered', 'cancelled')),
      assigned_rider VARCHAR(255),
      geo_label VARCHAR(255),
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_latitude DOUBLE PRECISION;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_longitude DOUBLE PRECISION;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_cents INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_rider_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS store_latitude DOUBLE PRECISION;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS store_longitude DOUBLE PRECISION;
  `);

  // Backfill: link orders to users by email, then hydrate user_addresses from orders.
  await client.query(`
    UPDATE orders o
    SET created_by_user_id = u.id
    FROM users u
    WHERE o.created_by_user_id IS NULL
      AND o.customer_email IS NOT NULL
      AND LOWER(u.email) = LOWER(o.customer_email);
  `);

  await client.query(`
    INSERT INTO user_addresses (
      user_id, full_name, phone, delivery_address, delivery_notes, latitude, longitude, use_count, last_used_date
    )
    SELECT
      o.created_by_user_id,
      o.customer_name,
      o.customer_phone,
      o.delivery_address,
      (ARRAY_AGG(o.delivery_notes ORDER BY o.created_date DESC))[1],
      (ARRAY_AGG(o.delivery_latitude ORDER BY o.created_date DESC))[1],
      (ARRAY_AGG(o.delivery_longitude ORDER BY o.created_date DESC))[1],
      COUNT(*)::int,
      MAX(o.created_date)
    FROM orders o
    WHERE o.created_by_user_id IS NOT NULL
    GROUP BY o.created_by_user_id, o.customer_name, o.customer_phone, o.delivery_address
    ON CONFLICT (user_id, full_name, phone, delivery_address)
    DO UPDATE SET
      last_used_date = GREATEST(user_addresses.last_used_date, EXCLUDED.last_used_date);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code VARCHAR(40) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      discount_type VARCHAR(10) NOT NULL CHECK (discount_type IN ('percent', 'flat')),
      discount_value INTEGER NOT NULL CHECK (discount_value > 0),
      max_discount_cents INTEGER,
      min_subtotal_cents INTEGER NOT NULL DEFAULT 0,
      max_uses_per_user INTEGER NOT NULL DEFAULT 1 CHECK (max_uses_per_user >= 1),
      max_total_uses INTEGER,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valid_until TIMESTAMPTZ,
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_company_code
      ON coupons (company_id, LOWER(code));
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id SERIAL PRIMARY KEY,
      coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      discount_cents INTEGER NOT NULL,
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON coupon_redemptions (user_id, coupon_id);
    CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions (coupon_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      key VARCHAR(64) NOT NULL,
      value TEXT NOT NULL,
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (company_id, key)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      product_name VARCHAR(255) NOT NULL,
      unit_label VARCHAR(120) NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL,
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query(`
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS created_date TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS updated_date TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_products_company_active
      ON products(company_id, is_active);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_company_created
      ON orders(company_id, created_date DESC);
  `);
}

async function seedCompany(client: PoolClient) {
  const result = await client.query(
    `
      INSERT INTO companies (name, slug, description, support_phone, support_email)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (slug) DO UPDATE
      SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        support_phone = EXCLUDED.support_phone,
        support_email = EXCLUDED.support_email,
        updated_date = NOW()
      RETURNING id;
    `,
    [
      'BestMart',
      'bestmart',
      'Your neighbourhood grocery store — fresh produce, pantry staples, dairy, snacks, and home essentials delivered to your door.',
      '+91 98765 43210',
      'support@bestmart.local',
    ]
  );
  return result.rows[0].id as number;
}

async function seedUsers(client: PoolClient, companyId: number) {
  const users = [
    { email: 'admin@bestmart.local', role: 'admin' as UserRole, fullName: null, phone: null },
    { email: 'ops@bestmart.local', role: 'editor' as UserRole, fullName: null, phone: null },
    { email: 'viewer@bestmart.local', role: 'viewer' as UserRole, fullName: null, phone: null },
    {
      email: 'rider1@bestmart.local',
      role: 'rider' as UserRole,
      fullName: 'Ravi Kumar',
      phone: '+91 98765 11111',
    },
    {
      email: 'rider2@bestmart.local',
      role: 'rider' as UserRole,
      fullName: 'Priya Sharma',
      phone: '+91 98765 22222',
    },
  ];
  const passwordHash = await bcrypt.hash('BestMart123!', 10);

  for (const user of users) {
    await client.query(
      `
        INSERT INTO users (uid, email, password, role, company_id, full_name, phone)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (email) DO UPDATE SET
          full_name = COALESCE(users.full_name, EXCLUDED.full_name),
          phone = COALESCE(users.phone, EXCLUDED.phone);
      `,
      [uuidv4(), user.email, passwordHash, user.role, companyId, user.fullName, user.phone]
    );
  }
}

async function seedCategories(client: PoolClient, companyId: number) {
  const existing = await client.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM categories WHERE company_id = $1',
    [companyId]
  );
  if (Number(existing.rows[0]?.count ?? '0') > 0) return;

  const names = [
    'Paan Corner',
    'Dairy, Bread & Eggs',
    'Fruits & Vegetables',
    'Cold Drinks & Juices',
    'Snacks & Munchies',
    'Breakfast & Instant Food',
    'Sweet Tooth',
    'Bakery & Biscuits',
    'Tea, Coffee & Milk Drinks',
    'Atta, Rice & Dal',
    'Masala, Oil & More',
    'Sauces & Spreads',
    'Chicken, Meat & Fish',
    'Organic & Healthy Living',
    'Baby Care',
    'Pharma & Wellness',
    'Cleaning Essentials',
    'Home & Office',
    'Personal Care',
    'Pet Care',
  ];
  for (const name of names) {
    await client.query(
      `
        INSERT INTO categories (company_id, name, slug)
        VALUES ($1, $2, $3)
        ON CONFLICT (company_id, slug) DO NOTHING;
      `,
      [companyId, name, toSlug(name)]
    );
  }
}

async function seedProducts(client: PoolClient, companyId: number) {
  const existing = await client.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM products WHERE company_id = $1',
    [companyId]
  );
  if (Number(existing.rows[0]?.count ?? '0') > 0) return;

  const categoryRows = await client.query<{ id: number; name: string }>(
    'SELECT id, name FROM categories WHERE company_id = $1;',
    [companyId]
  );
  const categoryByName = new Map(categoryRows.rows.map((row) => [row.name, row.id]));

  const products: Array<Omit<CreateProductInput, 'companyId' | 'categoryId'> & { categoryName: string }> = [
    {
      name: 'Masala Paan Pack',
      slug: 'masala-paan-pack',
      categoryName: 'Paan Corner',
      description: 'Ready-to-enjoy sweet masala paan with fennel and gulkand.',
      unitLabel: '6 pcs pack',
      priceCents: 9900,
      originalPriceCents: null,
      stockQuantity: 24,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Amul Fresh Milk',
      slug: 'amul-fresh-milk',
      categoryName: 'Dairy, Bread & Eggs',
      description: 'Toned dairy milk — chilled and delivered same day.',
      unitLabel: '1 L pouch',
      priceCents: 6400,
      originalPriceCents: null,
      stockQuantity: 40,
      badge: 'Daily',
      imageUrl: null,
    },
    {
      name: 'Farm Fresh Bananas',
      slug: 'farm-fresh-bananas',
      categoryName: 'Fruits & Vegetables',
      description: 'Sweet, ripe bananas picked at peak freshness.',
      unitLabel: '1 dozen',
      priceCents: 5900,
      originalPriceCents: 6900,
      stockQuantity: 36,
      badge: 'Fresh',
      imageUrl: null,
    },
    {
      name: 'Pepsi Black Can',
      slug: 'pepsi-black-can',
      categoryName: 'Cold Drinks & Juices',
      description: 'Zero-sugar cola with a bold fizz.',
      unitLabel: '300 ml can',
      priceCents: 4000,
      originalPriceCents: null,
      stockQuantity: 60,
      badge: null,
      imageUrl: null,
    },
    {
      name: "Lay's Classic Salted",
      slug: 'lays-classic-salted',
      categoryName: 'Snacks & Munchies',
      description: 'Crispy potato chips with classic salted flavour.',
      unitLabel: '52 g pack',
      priceCents: 2000,
      originalPriceCents: null,
      stockQuantity: 80,
      badge: null,
      imageUrl: null,
    },
    {
      name: "Kellogg's Corn Flakes",
      slug: 'kelloggs-corn-flakes',
      categoryName: 'Breakfast & Instant Food',
      description: 'Crunchy golden flakes, high in iron and B vitamins.',
      unitLabel: '475 g box',
      priceCents: 24900,
      originalPriceCents: 27500,
      stockQuantity: 22,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Cadbury Dairy Milk Silk',
      slug: 'cadbury-dairy-milk-silk',
      categoryName: 'Sweet Tooth',
      description: 'Smooth and creamy milk chocolate bar.',
      unitLabel: '150 g bar',
      priceCents: 20000,
      originalPriceCents: null,
      stockQuantity: 50,
      badge: 'Popular',
      imageUrl: null,
    },
    {
      name: 'Parle-G Biscuits',
      slug: 'parle-g-biscuits',
      categoryName: 'Bakery & Biscuits',
      description: 'Classic glucose biscuits, perfect with chai.',
      unitLabel: '800 g pack',
      priceCents: 9000,
      originalPriceCents: null,
      stockQuantity: 70,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Tata Tea Premium',
      slug: 'tata-tea-premium',
      categoryName: 'Tea, Coffee & Milk Drinks',
      description: 'Strong blend from Assam and Darjeeling gardens.',
      unitLabel: '500 g pack',
      priceCents: 27500,
      originalPriceCents: 29000,
      stockQuantity: 30,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Aashirvaad Atta',
      slug: 'aashirvaad-atta',
      categoryName: 'Atta, Rice & Dal',
      description: 'Whole wheat atta, 100% natural with no maida.',
      unitLabel: '5 kg bag',
      priceCents: 36500,
      originalPriceCents: null,
      stockQuantity: 28,
      badge: 'Family Pack',
      imageUrl: null,
    },
    {
      name: 'Fortune Sunflower Oil',
      slug: 'fortune-sunflower-oil',
      categoryName: 'Masala, Oil & More',
      description: 'Refined sunflower oil rich in vitamin E.',
      unitLabel: '1 L bottle',
      priceCents: 16500,
      originalPriceCents: 17500,
      stockQuantity: 32,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Kissan Mixed Fruit Jam',
      slug: 'kissan-mixed-fruit-jam',
      categoryName: 'Sauces & Spreads',
      description: 'Real fruit jam with apple, pineapple and papaya.',
      unitLabel: '700 g jar',
      priceCents: 22500,
      originalPriceCents: null,
      stockQuantity: 25,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Chicken Breast Boneless',
      slug: 'chicken-breast-boneless',
      categoryName: 'Chicken, Meat & Fish',
      description: 'Fresh, antibiotic-free chicken breast, cleaned and packed.',
      unitLabel: '500 g pack',
      priceCents: 24000,
      originalPriceCents: 26000,
      stockQuantity: 18,
      badge: 'Fresh',
      imageUrl: null,
    },
    {
      name: 'Organic Jaggery',
      slug: 'organic-jaggery',
      categoryName: 'Organic & Healthy Living',
      description: 'Chemical-free sugarcane jaggery, rich and aromatic.',
      unitLabel: '500 g pack',
      priceCents: 11500,
      originalPriceCents: null,
      stockQuantity: 20,
      badge: 'Organic',
      imageUrl: null,
    },
    {
      name: 'Pampers Baby Diapers XL',
      slug: 'pampers-baby-diapers-xl',
      categoryName: 'Baby Care',
      description: 'Soft cotton diapers with up to 12-hour dryness.',
      unitLabel: '44 pcs pack',
      priceCents: 79900,
      originalPriceCents: 84900,
      stockQuantity: 15,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Honitus Cough Remedy',
      slug: 'honitus-cough-remedy',
      categoryName: 'Pharma & Wellness',
      description: 'Ayurvedic cough syrup, non-drowsy and sugar-free.',
      unitLabel: '100 ml bottle',
      priceCents: 12000,
      originalPriceCents: null,
      stockQuantity: 22,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Surf Excel Matic Top Load',
      slug: 'surf-excel-matic-top-load',
      categoryName: 'Cleaning Essentials',
      description: 'Detergent powder for top-load washing machines.',
      unitLabel: '2 kg pack',
      priceCents: 50900,
      originalPriceCents: 54900,
      stockQuantity: 14,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Odonil Room Freshener',
      slug: 'odonil-room-freshener',
      categoryName: 'Home & Office',
      description: 'Long-lasting lavender fragrance room freshener spray.',
      unitLabel: '220 ml can',
      priceCents: 24500,
      originalPriceCents: null,
      stockQuantity: 20,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Whisper Ultra Sanitary Pads',
      slug: 'whisper-ultra-sanitary-pads',
      categoryName: 'Personal Care',
      description: 'Soft cotton-like cover with long-lasting protection.',
      unitLabel: '30 pads pack',
      priceCents: 29900,
      originalPriceCents: 33500,
      stockQuantity: 26,
      badge: null,
      imageUrl: null,
    },
    {
      name: 'Pedigree Adult Chicken',
      slug: 'pedigree-adult-chicken',
      categoryName: 'Pet Care',
      description: 'Complete nutrition dry food for adult dogs.',
      unitLabel: '3 kg pack',
      priceCents: 72000,
      originalPriceCents: 76500,
      stockQuantity: 12,
      badge: null,
      imageUrl: null,
    },
  ];

  for (const product of products) {
    const existing = await client.query(
      'SELECT 1 FROM products WHERE company_id = $1 AND slug = $2 LIMIT 1',
      [companyId, product.slug]
    );
    if (existing.rowCount) {
      continue;
    }
    const categoryId = categoryByName.get(product.categoryName);
    if (!categoryId) {
      console.warn(`Seed skipped: category "${product.categoryName}" not found`);
      continue;
    }
    await client.query(
      `
        INSERT INTO products (
          unique_id,
          company_id,
          name,
          slug,
          category_id,
          description,
          unit_label,
          price_cents,
          original_price_cents,
          stock_quantity,
          badge,
          image_url,
          is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE);
      `,
      [
        uuidv4(),
        companyId,
        product.name,
        product.slug,
        categoryId,
        product.description,
        product.unitLabel,
        product.priceCents,
        product.originalPriceCents,
        product.stockQuantity,
        product.badge,
        product.imageUrl,
      ]
    );
  }
}

export async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createTables(client);
    const companyId = await seedCompany(client);
    await seedUsers(client, companyId);
    await seedCategories(client, companyId);
    await seedProducts(client, companyId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getCompanyPublic() {
  const result = await pool.query(
    `
      SELECT
        id,
        name,
        slug,
        description,
        support_phone AS "supportPhone",
        support_email AS "supportEmail",
        store_latitude AS "storeLatitude",
        store_longitude AS "storeLongitude"
      FROM companies
      WHERE slug = 'bestmart'
      LIMIT 1;
    `
  );
  const company = result.rows[0] ?? null;
  if (!company) return null;
  const settings = await getAppSettings(company.id);
  return { ...company, settings };
}

export async function updateStoreLocation(companyId: number, latitude: number, longitude: number) {
  await pool.query(
    `UPDATE companies SET store_latitude = $1, store_longitude = $2, updated_date = NOW() WHERE id = $3`,
    [latitude, longitude, companyId]
  );
}

// ── App settings (configurable per company) ──────────────────────────
export interface AppSettings {
  freeDeliveryThresholdCents: number;
  deliveryFeeCents: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  freeDeliveryThresholdCents: 20000, // ₹200
  deliveryFeeCents: 4900, // ₹49
};

const SETTING_KEYS: Record<keyof AppSettings, string> = {
  freeDeliveryThresholdCents: 'free_delivery_threshold_cents',
  deliveryFeeCents: 'delivery_fee_cents',
};

export async function getAppSettings(companyId: number): Promise<AppSettings> {
  const result = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE company_id = $1;`,
    [companyId]
  );
  const map = new Map(result.rows.map((r) => [r.key, r.value]));
  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  for (const [field, key] of Object.entries(SETTING_KEYS) as Array<[keyof AppSettings, string]>) {
    const raw = map.get(key);
    if (raw == null) continue;
    const num = Number(raw);
    if (Number.isFinite(num) && num >= 0) settings[field] = Math.round(num);
  }
  return settings;
}

export async function updateAppSettings(
  companyId: number,
  patch: Partial<AppSettings>
): Promise<AppSettings> {
  for (const [field, value] of Object.entries(patch) as Array<[keyof AppSettings, number | undefined]>) {
    if (value == null || !Number.isFinite(value) || value < 0) continue;
    const key = SETTING_KEYS[field];
    if (!key) continue;
    await pool.query(
      `
        INSERT INTO app_settings (company_id, key, value)
        VALUES ($1, $2, $3)
        ON CONFLICT (company_id, key)
        DO UPDATE SET value = EXCLUDED.value, updated_date = NOW();
      `,
      [companyId, key, String(Math.round(value))]
    );
  }
  return getAppSettings(companyId);
}

// ── Coupons ──────────────────────────────────────────────────────────
export type CouponDiscountType = 'percent' | 'flat';

export interface CouponRecord {
  id: number;
  companyId: number;
  code: string;
  description: string;
  discountType: CouponDiscountType;
  discountValue: number;
  maxDiscountCents: number | null;
  minSubtotalCents: number;
  maxUsesPerUser: number;
  maxTotalUses: number | null;
  isActive: boolean;
  validFrom: string;
  validUntil: string | null;
  createdDate: string;
  updatedDate: string;
  totalRedemptions: number;
}

const COUPON_SELECT = `
  c.id,
  c.company_id AS "companyId",
  c.code,
  c.description,
  c.discount_type AS "discountType",
  c.discount_value AS "discountValue",
  c.max_discount_cents AS "maxDiscountCents",
  c.min_subtotal_cents AS "minSubtotalCents",
  c.max_uses_per_user AS "maxUsesPerUser",
  c.max_total_uses AS "maxTotalUses",
  c.is_active AS "isActive",
  c.valid_from AS "validFrom",
  c.valid_until AS "validUntil",
  c.created_date AS "createdDate",
  c.updated_date AS "updatedDate",
  COALESCE((SELECT COUNT(*)::int FROM coupon_redemptions r WHERE r.coupon_id = c.id), 0) AS "totalRedemptions"
`;

export interface PublicCoupon {
  code: string;
  description: string;
  discountType: CouponDiscountType;
  discountValue: number;
  maxDiscountCents: number | null;
  minSubtotalCents: number;
  validUntil: string | null;
}

export async function listPublicCoupons(companyId: number): Promise<PublicCoupon[]> {
  const result = await pool.query<PublicCoupon>(
    `
      SELECT
        c.code,
        c.description,
        c.discount_type AS "discountType",
        c.discount_value AS "discountValue",
        c.max_discount_cents AS "maxDiscountCents",
        c.min_subtotal_cents AS "minSubtotalCents",
        c.valid_until AS "validUntil"
      FROM coupons c
      WHERE c.company_id = $1
        AND c.is_active = TRUE
        AND c.valid_from <= NOW()
        AND (c.valid_until IS NULL OR c.valid_until >= NOW())
        AND (
          c.max_total_uses IS NULL
          OR (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id) < c.max_total_uses
        )
      ORDER BY c.created_date DESC;
    `,
    [companyId]
  );
  return result.rows;
}

export async function listCoupons(companyId: number): Promise<CouponRecord[]> {
  const result = await pool.query<CouponRecord>(
    `SELECT ${COUPON_SELECT} FROM coupons c WHERE c.company_id = $1 ORDER BY c.created_date DESC;`,
    [companyId]
  );
  return result.rows;
}

export interface CouponInput {
  code: string;
  description?: string;
  discountType: CouponDiscountType;
  discountValue: number;
  maxDiscountCents?: number | null;
  minSubtotalCents?: number;
  maxUsesPerUser: number;
  maxTotalUses?: number | null;
  isActive?: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
}

export async function createCoupon(companyId: number, input: CouponInput): Promise<CouponRecord> {
  const inserted = await pool.query<{ id: number }>(
    `
      INSERT INTO coupons (
        company_id, code, description, discount_type, discount_value,
        max_discount_cents, min_subtotal_cents, max_uses_per_user, max_total_uses,
        is_active, valid_from, valid_until
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, NOW()), $12)
      RETURNING id;
    `,
    [
      companyId,
      input.code.trim(),
      input.description ?? '',
      input.discountType,
      input.discountValue,
      input.maxDiscountCents ?? null,
      input.minSubtotalCents ?? 0,
      input.maxUsesPerUser,
      input.maxTotalUses ?? null,
      input.isActive ?? true,
      input.validFrom ?? null,
      input.validUntil ?? null,
    ]
  );
  const newId = inserted.rows[0]?.id;
  if (!newId) throw new Error('Failed to create coupon');
  const created = await pool.query<CouponRecord>(
    `SELECT ${COUPON_SELECT} FROM coupons c WHERE c.id = $1;`,
    [newId]
  );
  return created.rows[0];
}

export async function updateCoupon(
  companyId: number,
  id: number,
  input: Partial<CouponInput>
): Promise<CouponRecord | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const push = (col: string, value: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(value);
  };
  if (input.code != null) push('code', input.code.trim());
  if (input.description != null) push('description', input.description);
  if (input.discountType != null) push('discount_type', input.discountType);
  if (input.discountValue != null) push('discount_value', input.discountValue);
  if (input.maxDiscountCents !== undefined) push('max_discount_cents', input.maxDiscountCents);
  if (input.minSubtotalCents != null) push('min_subtotal_cents', input.minSubtotalCents);
  if (input.maxUsesPerUser != null) push('max_uses_per_user', input.maxUsesPerUser);
  if (input.maxTotalUses !== undefined) push('max_total_uses', input.maxTotalUses);
  if (input.isActive != null) push('is_active', input.isActive);
  if (input.validFrom !== undefined) push('valid_from', input.validFrom);
  if (input.validUntil !== undefined) push('valid_until', input.validUntil);
  if (fields.length === 0) {
    const existing = await pool.query<CouponRecord>(
      `SELECT ${COUPON_SELECT} FROM coupons c WHERE c.id = $1 AND c.company_id = $2;`,
      [id, companyId]
    );
    return existing.rows[0] ?? null;
  }
  fields.push(`updated_date = NOW()`);
  values.unshift(id, companyId);
  await pool.query(
    `UPDATE coupons SET ${fields.join(', ')} WHERE id = $1 AND company_id = $2;`,
    values
  );
  const result = await pool.query<CouponRecord>(
    `SELECT ${COUPON_SELECT} FROM coupons c WHERE c.id = $1 AND c.company_id = $2;`,
    [id, companyId]
  );
  return result.rows[0] ?? null;
}

export async function deleteCoupon(companyId: number, id: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM coupons WHERE id = $1 AND company_id = $2;`,
    [id, companyId]
  );
  return (result.rowCount ?? 0) > 0;
}

export interface CouponValidationOk {
  ok: true;
  coupon: CouponRecord;
  discountCents: number;
}
export interface CouponValidationErr {
  ok: false;
  error: string;
}

export async function validateCoupon(
  companyId: number,
  userId: number | null,
  code: string,
  subtotalCents: number,
): Promise<CouponValidationOk | CouponValidationErr> {
  const result = await pool.query<CouponRecord>(
    `SELECT ${COUPON_SELECT} FROM coupons c WHERE c.company_id = $1 AND LOWER(c.code) = LOWER($2) LIMIT 1;`,
    [companyId, code.trim()]
  );
  const coupon = result.rows[0];
  if (!coupon) return { ok: false, error: 'Coupon not found.' };
  if (!coupon.isActive) return { ok: false, error: 'This coupon is no longer active.' };

  const now = Date.now();
  if (new Date(coupon.validFrom).getTime() > now) {
    return { ok: false, error: 'This coupon is not valid yet.' };
  }
  if (coupon.validUntil && new Date(coupon.validUntil).getTime() < now) {
    return { ok: false, error: 'This coupon has expired.' };
  }
  if (subtotalCents < coupon.minSubtotalCents) {
    return {
      ok: false,
      error: `Minimum order of ₹${(coupon.minSubtotalCents / 100).toFixed(0)} required.`,
    };
  }

  if (coupon.maxTotalUses != null && coupon.totalRedemptions >= coupon.maxTotalUses) {
    return { ok: false, error: 'This coupon has reached its global usage limit.' };
  }

  if (userId != null) {
    const usage = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2;`,
      [coupon.id, userId]
    );
    const used = Number(usage.rows[0]?.count ?? '0');
    if (used >= coupon.maxUsesPerUser) {
      return {
        ok: false,
        error: `You've already used this coupon ${used} time${used === 1 ? '' : 's'} (limit: ${coupon.maxUsesPerUser}).`,
      };
    }
  } else {
    return { ok: false, error: 'Please sign in to use a coupon.' };
  }

  let discountCents = 0;
  if (coupon.discountType === 'flat') {
    discountCents = coupon.discountValue;
  } else {
    discountCents = Math.floor((subtotalCents * coupon.discountValue) / 100);
    if (coupon.maxDiscountCents != null) {
      discountCents = Math.min(discountCents, coupon.maxDiscountCents);
    }
  }
  discountCents = Math.min(discountCents, subtotalCents);
  if (discountCents <= 0) return { ok: false, error: 'Coupon yields no discount on this order.' };

  return { ok: true, coupon, discountCents };
}

export async function recordCouponRedemption(
  client: PoolClient,
  couponId: number,
  userId: number | null,
  orderId: number,
  discountCents: number,
) {
  await client.query(
    `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id, discount_cents) VALUES ($1, $2, $3, $4);`,
    [couponId, userId, orderId, discountCents]
  );
}

export async function getDefaultCompanyId() {
  const result = await pool.query(
    `
      SELECT id
      FROM companies
      WHERE slug = 'bestmart'
      LIMIT 1;
    `
  );
  return (result.rows[0]?.id as number | undefined) ?? null;
}

export async function findUserByEmail(email: string) {
  const result = await pool.query(
    `
      SELECT
        u.id,
        u.uid,
        u.email,
        u.password,
        u.role,
        u.company_id AS "companyId",
        c.name AS "companyName",
        u.failed_attempts AS "failedAttempts",
        u.locked_at AS "lockedAt",
        u.full_name AS "fullName",
        u.phone AS "phone"
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE LOWER(u.email) = LOWER($1)
      LIMIT 1;
    `,
    [email]
  );
  return result.rowCount ? mapUser(result.rows[0]) : null;
}

export async function findUserByUid(uid: string) {
  const result = await pool.query(
    `
      SELECT
        u.id,
        u.uid,
        u.email,
        u.password,
        u.role,
        u.company_id AS "companyId",
        c.name AS "companyName",
        u.failed_attempts AS "failedAttempts",
        u.locked_at AS "lockedAt",
        u.full_name AS "fullName",
        u.phone AS "phone"
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE u.uid = $1
      LIMIT 1;
    `,
    [uid]
  );
  return result.rowCount ? mapUser(result.rows[0]) : null;
}

export async function incrementFailedAttempts(email: string) {
  const result = await pool.query(
    `
      UPDATE users
      SET failed_attempts = failed_attempts + 1, updated_date = NOW()
      WHERE LOWER(email) = LOWER($1)
      RETURNING failed_attempts AS attempts;
    `,
    [email]
  );
  return result.rows[0]?.attempts ?? 0;
}

export async function lockUser(email: string) {
  await pool.query(
    `
      UPDATE users
      SET locked_at = NOW(), updated_date = NOW()
      WHERE LOWER(email) = LOWER($1);
    `,
    [email]
  );
}

export async function resetFailedAttempts(email: string) {
  await pool.query(
    `
      UPDATE users
      SET failed_attempts = 0, locked_at = NULL, updated_date = NOW()
      WHERE LOWER(email) = LOWER($1);
    `,
    [email]
  );
}

export async function listTeamMembers(companyId: number) {
  const result = await pool.query(
    `
      SELECT
        uid,
        email,
        role,
        full_name AS "fullName",
        phone,
        created_date AS "createdDate"
      FROM users
      WHERE company_id = $1
      ORDER BY
        CASE role
          WHEN 'admin' THEN 1
          WHEN 'editor' THEN 2
          WHEN 'rider' THEN 3
          ELSE 4
        END,
        email;
    `,
    [companyId]
  );
  return result.rows;
}

export async function createUser(input: CreateUserInput) {
  const passwordHash = await bcrypt.hash(input.password, 10);
  const result = await pool.query(
    `
      INSERT INTO users (uid, email, password, role, company_id, full_name, phone)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING uid, email, role, full_name AS "fullName", phone;
    `,
    [
      uuidv4(),
      input.email,
      passwordHash,
      input.role,
      input.companyId,
      input.fullName ?? null,
      input.phone ?? null,
    ]
  );
  return result.rows[0];
}

export interface UserAddress {
  id: number;
  fullName: string;
  phone: string;
  deliveryAddress: string;
  deliveryNotes: string | null;
  latitude: number | null;
  longitude: number | null;
  useCount: number;
  lastUsedDate: string;
}

export async function listRiders(companyId: number) {
  const result = await pool.query<{
    id: number;
    uid: string;
    email: string;
    fullName: string | null;
    phone: string | null;
  }>(
    `
      SELECT id, uid, email, full_name AS "fullName", phone
      FROM users
      WHERE company_id = $1 AND role = 'rider'
      ORDER BY COALESCE(full_name, email);
    `,
    [companyId]
  );
  return result.rows;
}

export async function listRiderOrders(riderUserId: number) {
  const result = await pool.query(
    `SELECT ${ORDER_SELECT_COLUMNS} ${ORDER_FROM_CLAUSE}
     WHERE o.assigned_rider_user_id = $1
       AND o.status IN ('out_for_delivery', 'packing', 'confirmed')
     ORDER BY o.created_date ASC;`,
    [riderUserId]
  );
  return Promise.all(result.rows.map((row: OrderRow) => mapOrder(row)));
}

export async function listUserAddresses(userId: number): Promise<UserAddress[]> {
  const result = await pool.query<UserAddress>(
    `
      SELECT
        id,
        full_name AS "fullName",
        phone,
        delivery_address AS "deliveryAddress",
        delivery_notes AS "deliveryNotes",
        latitude,
        longitude,
        use_count AS "useCount",
        last_used_date AS "lastUsedDate"
      FROM user_addresses
      WHERE user_id = $1
      ORDER BY last_used_date DESC;
    `,
    [userId]
  );
  return result.rows;
}

export async function upsertUserAddress(
  userId: number,
  input: {
    fullName: string;
    phone: string;
    deliveryAddress: string;
    deliveryNotes?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  }
) {
  await pool.query(
    `
      INSERT INTO user_addresses (
        user_id, full_name, phone, delivery_address, delivery_notes, latitude, longitude
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, full_name, phone, delivery_address)
      DO UPDATE SET
        delivery_notes = EXCLUDED.delivery_notes,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        use_count = user_addresses.use_count + 1,
        last_used_date = NOW(),
        updated_date = NOW();
    `,
    [
      userId,
      input.fullName,
      input.phone,
      input.deliveryAddress,
      input.deliveryNotes ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
    ]
  );
}

export async function updateUserProfileIfEmpty(
  userId: number,
  fullName: string,
  phone: string
) {
  await pool.query(
    `
      UPDATE users
      SET
        full_name = COALESCE(full_name, $2),
        phone = COALESCE(phone, $3),
        updated_date = NOW()
      WHERE id = $1;
    `,
    [userId, fullName, phone]
  );
}

const PRODUCT_SELECT_COLUMNS = `
  p.id,
  p.unique_id AS "uniqueId",
  p.company_id AS "companyId",
  p.name,
  p.slug,
  p.category_id AS "categoryId",
  c.name AS "category",
  c.image_url AS "categoryImageUrl",
  p.description,
  p.unit_label AS "unitLabel",
  p.price_cents AS "priceCents",
  p.original_price_cents AS "originalPriceCents",
  p.stock_quantity AS "stockQuantity",
  p.badge,
  p.image_url AS "imageUrl",
  p.is_active AS "isActive",
  p.is_on_offer AS "isOnOffer",
  p.offer_price_cents AS "offerPriceCents",
  p.offer_type AS "offerType",
  p.bogo_buy_qty AS "bogoBuyQty",
  p.bogo_get_qty AS "bogoGetQty",
  p.brand_id AS "brandId",
  b.name AS "brand",
  p.created_date AS "createdDate",
  p.updated_date AS "updatedDate"
`;

export async function listProducts(companyId: number, includeInactive = false) {
  const result = await pool.query(
    `
      SELECT ${PRODUCT_SELECT_COLUMNS}
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE p.company_id = $1
        AND ($2::boolean = TRUE OR p.is_active = TRUE)
      ORDER BY
        p.is_active DESC,
        p.is_on_offer DESC,
        c.name,
        p.name;
    `,
    [companyId, includeInactive]
  );
  return result.rows.map(mapProduct);
}

export interface SlowMoverSuggestion {
  uniqueId: string;
  name: string;
  category: string | null;
  unitLabel: string;
  priceCents: number;
  stockQuantity: number;
  imageUrl: string | null;
  unitsSold30d: number;
  unitsSoldAllTime: number;
  daysSinceCreated: number;
  daysSinceLastSold: number | null;
  reason: 'no_sales_ever' | 'no_sales_30d' | 'low_sales_30d' | 'overstocked';
  reasonLabel: string;
  score: number;
  suggestedOfferPriceCents: number;
  suggestedDiscountPercent: number;
}

export async function listSlowMovers(companyId: number): Promise<SlowMoverSuggestion[]> {
  const result = await pool.query<{
    uniqueId: string;
    name: string;
    category: string | null;
    unitLabel: string;
    priceCents: number;
    stockQuantity: number;
    imageUrl: string | null;
    createdDate: string;
    unitsSold30d: string;
    unitsSoldAllTime: string;
    lastSoldAt: string | null;
  }>(
    `
      SELECT
        p.unique_id AS "uniqueId",
        p.name,
        c.name AS "category",
        p.unit_label AS "unitLabel",
        p.price_cents AS "priceCents",
        p.stock_quantity AS "stockQuantity",
        p.image_url AS "imageUrl",
        p.created_date AS "createdDate",
        COALESCE(SUM(CASE
          WHEN o.created_date >= NOW() - INTERVAL '30 days'
            AND o.status <> 'cancelled'
          THEN oi.quantity ELSE 0
        END), 0)::text AS "unitsSold30d",
        COALESCE(SUM(CASE
          WHEN o.status <> 'cancelled'
          THEN oi.quantity ELSE 0
        END), 0)::text AS "unitsSoldAllTime",
        MAX(CASE WHEN o.status <> 'cancelled' THEN o.created_date END) AS "lastSoldAt"
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.company_id = p.company_id
      WHERE p.company_id = $1
        AND p.is_active = TRUE
        AND p.is_on_offer = FALSE
        AND p.stock_quantity > 0
        AND p.created_date <= NOW() - INTERVAL '3 days'
      GROUP BY p.id, c.name
      ORDER BY p.created_date ASC;
    `,
    [companyId]
  );

  const now = Date.now();

  const suggestions: SlowMoverSuggestion[] = [];
  for (const row of result.rows) {
    const unitsSold30d = Number(row.unitsSold30d);
    const unitsSoldAllTime = Number(row.unitsSoldAllTime);
    const createdMs = new Date(row.createdDate).getTime();
    const daysSinceCreated = Math.floor((now - createdMs) / (1000 * 60 * 60 * 24));
    const daysSinceLastSold = row.lastSoldAt
      ? Math.floor((now - new Date(row.lastSoldAt).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    let reason: SlowMoverSuggestion['reason'] | null = null;
    let reasonLabel = '';
    let suggestedDiscountPercent = 10;

    if (unitsSoldAllTime === 0 && daysSinceCreated >= 14) {
      reason = 'no_sales_ever';
      reasonLabel = `Never sold in ${daysSinceCreated} days`;
      suggestedDiscountPercent = 20;
    } else if (unitsSoldAllTime === 0) {
      reason = 'no_sales_ever';
      reasonLabel = `No sales yet`;
      suggestedDiscountPercent = 15;
    } else if (unitsSold30d === 0 && daysSinceLastSold !== null && daysSinceLastSold >= 14) {
      reason = 'no_sales_30d';
      reasonLabel = `No sales in last ${daysSinceLastSold} days`;
      suggestedDiscountPercent = 15;
    } else if (unitsSold30d <= 2 && row.stockQuantity >= 20) {
      reason = 'overstocked';
      reasonLabel = `Only ${unitsSold30d} sold, ${row.stockQuantity} in stock`;
      suggestedDiscountPercent = 10;
    } else if (unitsSold30d <= 2 && daysSinceCreated >= 14) {
      reason = 'low_sales_30d';
      reasonLabel = `Only ${unitsSold30d} sold in 30 days`;
      suggestedDiscountPercent = 10;
    } else {
      continue;
    }

    // Higher score = more urgent. Weighs recency of sales, stock, and age.
    const stockFactor = 1 + row.stockQuantity / 30;
    const ageFactor = Math.min(daysSinceCreated / 30, 4);
    const salesFactor = 1 / (unitsSold30d + 1);
    const score = Math.round(stockFactor * ageFactor * salesFactor * 100);

    const suggestedOfferPriceCents = Math.max(
      100,
      Math.round((row.priceCents * (100 - suggestedDiscountPercent)) / 100 / 100) * 100,
    );

    suggestions.push({
      uniqueId: row.uniqueId,
      name: row.name,
      category: row.category,
      unitLabel: row.unitLabel,
      priceCents: row.priceCents,
      stockQuantity: row.stockQuantity,
      imageUrl: row.imageUrl,
      unitsSold30d,
      unitsSoldAllTime,
      daysSinceCreated,
      daysSinceLastSold,
      reason,
      reasonLabel,
      score,
      suggestedOfferPriceCents,
      suggestedDiscountPercent,
    });
  }

  suggestions.sort((a, b) => b.score - a.score);
  return suggestions.slice(0, 20);
}

export async function getProductByUniqueId(uniqueId: string, companyId: number) {
  const result = await pool.query(
    `
      SELECT ${PRODUCT_SELECT_COLUMNS}
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE p.unique_id = $1 AND p.company_id = $2
      LIMIT 1;
    `,
    [uniqueId, companyId]
  );
  return result.rowCount ? mapProduct(result.rows[0]) : null;
}

async function readProductWithCategory(
  client: { query: typeof pool.query },
  productId: number
) {
  const result = await client.query(
    `
      SELECT ${PRODUCT_SELECT_COLUMNS}
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE p.id = $1
      LIMIT 1;
    `,
    [productId]
  );
  return result.rowCount ? mapProduct(result.rows[0]) : null;
}

export async function createProduct(input: CreateProductInput) {
  const inserted = await pool.query<{ id: number }>(
    `
      INSERT INTO products (
        unique_id,
        company_id,
        name,
        slug,
        category_id,
        description,
        unit_label,
        price_cents,
        original_price_cents,
        stock_quantity,
        badge,
        image_url,
        is_active,
        is_on_offer,
        brand_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id;
    `,
    [
      uuidv4(),
      input.companyId,
      input.name,
      input.slug || toSlug(input.name),
      input.categoryId,
      input.description,
      input.unitLabel,
      input.priceCents,
      input.originalPriceCents ?? null,
      input.stockQuantity,
      input.badge ?? null,
      input.imageUrl ?? null,
      input.isActive ?? true,
      input.isOnOffer ?? false,
      input.brandId ?? null,
    ]
  );
  const product = await readProductWithCategory(pool, inserted.rows[0].id);
  if (!product) throw new Error('Failed to read created product');
  return product;
}

export async function updateProduct(input: UpdateProductInput) {
  const updated = await pool.query<{ id: number }>(
    `
      UPDATE products
      SET
        name = $3,
        slug = $4,
        category_id = $5,
        description = $6,
        unit_label = $7,
        price_cents = $8,
        original_price_cents = $9,
        stock_quantity = $10,
        badge = $11,
        image_url = $12,
        is_active = $13,
        is_on_offer = $14,
        brand_id = $15,
        updated_date = NOW()
      WHERE unique_id = $1 AND company_id = $2
      RETURNING id;
    `,
    [
      input.uniqueId,
      input.companyId,
      input.name,
      input.slug || toSlug(input.name),
      input.categoryId,
      input.description,
      input.unitLabel,
      input.priceCents,
      input.originalPriceCents ?? null,
      input.stockQuantity,
      input.badge ?? null,
      input.imageUrl ?? null,
      input.isActive ?? true,
      input.isOnOffer ?? false,
      input.brandId ?? null,
    ]
  );
  return updated.rowCount ? readProductWithCategory(pool, updated.rows[0].id) : null;
}

export async function setProductOffer(
  uniqueId: string,
  companyId: number,
  isOnOffer: boolean,
  offerPriceCents: number | null,
  offerType: 'price' | 'bogo' = 'price',
  bogoBuyQty: number = 1,
  bogoGetQty: number = 1,
) {
  const resolvedType = isOnOffer ? offerType : 'price';
  const resolvedPrice =
    isOnOffer && resolvedType === 'price' ? offerPriceCents : null;
  const resolvedBuy = resolvedType === 'bogo' ? Math.max(1, Math.round(bogoBuyQty || 1)) : 1;
  const resolvedGet = resolvedType === 'bogo' ? Math.max(1, Math.round(bogoGetQty || 1)) : 1;
  const result = await pool.query<{ id: number }>(
    `
      UPDATE products
      SET
        is_on_offer = $3,
        offer_price_cents = $4,
        offer_type = $5,
        bogo_buy_qty = $6,
        bogo_get_qty = $7,
        updated_date = NOW()
      WHERE unique_id = $1 AND company_id = $2
      RETURNING id;
    `,
    [uniqueId, companyId, isOnOffer, resolvedPrice, resolvedType, resolvedBuy, resolvedGet]
  );
  return result.rowCount ? readProductWithCategory(pool, result.rows[0].id) : null;
}

export async function deactivateProduct(uniqueId: string, companyId: number) {
  const result = await pool.query(
    `
      UPDATE products
      SET is_active = FALSE, updated_date = NOW()
      WHERE unique_id = $1 AND company_id = $2
      RETURNING id;
    `,
    [uniqueId, companyId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateProductImage(
  uniqueId: string,
  companyId: number,
  imageUrl: string
) {
  const result = await pool.query<{ id: number }>(
    `
      UPDATE products
      SET image_url = $3, updated_date = NOW()
      WHERE unique_id = $1 AND company_id = $2
      RETURNING id;
    `,
    [uniqueId, companyId, imageUrl]
  );
  return result.rowCount ? readProductWithCategory(pool, result.rows[0].id) : null;
}

// ─── Category helpers ───

const CATEGORY_SELECT_COLUMNS = `
  id,
  company_id AS "companyId",
  name,
  slug,
  image_url AS "imageUrl",
  created_date AS "createdDate",
  updated_date AS "updatedDate"
`;

export async function listCategories(companyId: number) {
  const result = await pool.query(
    `
      SELECT ${CATEGORY_SELECT_COLUMNS}
      FROM categories
      WHERE company_id = $1
      ORDER BY name ASC;
    `,
    [companyId]
  );
  return result.rows.map(mapCategory);
}

// ── Brands ───────────────────────────────────────────────────────────
export interface BrandRecord {
  id: number;
  companyId: number;
  name: string;
  slug: string;
  productCount: number;
  createdDate: string;
  updatedDate: string;
}

const BRAND_SELECT = `
  b.id,
  b.company_id AS "companyId",
  b.name,
  b.slug,
  COALESCE((SELECT COUNT(*)::int FROM products p WHERE p.brand_id = b.id), 0) AS "productCount",
  b.created_date AS "createdDate",
  b.updated_date AS "updatedDate"
`;

export async function listBrands(companyId: number): Promise<BrandRecord[]> {
  const result = await pool.query<BrandRecord>(
    `SELECT ${BRAND_SELECT} FROM brands b WHERE b.company_id = $1 ORDER BY b.name ASC;`,
    [companyId]
  );
  return result.rows;
}

export async function createBrand(companyId: number, name: string): Promise<BrandRecord> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Brand name is required');
  const slug = toSlug(trimmed);
  const inserted = await pool.query<{ id: number }>(
    `
      INSERT INTO brands (company_id, name, slug)
      VALUES ($1, $2, $3)
      RETURNING id;
    `,
    [companyId, trimmed, slug]
  );
  const result = await pool.query<BrandRecord>(
    `SELECT ${BRAND_SELECT} FROM brands b WHERE b.id = $1;`,
    [inserted.rows[0].id]
  );
  return result.rows[0];
}

export async function updateBrand(
  companyId: number,
  id: number,
  name: string,
): Promise<BrandRecord | null> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Brand name is required');
  const slug = toSlug(trimmed);
  await pool.query(
    `
      UPDATE brands
      SET name = $3, slug = $4, updated_date = NOW()
      WHERE id = $1 AND company_id = $2;
    `,
    [id, companyId, trimmed, slug]
  );
  const result = await pool.query<BrandRecord>(
    `SELECT ${BRAND_SELECT} FROM brands b WHERE b.id = $1 AND b.company_id = $2;`,
    [id, companyId]
  );
  return result.rows[0] ?? null;
}

export async function deleteBrand(companyId: number, id: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM brands WHERE id = $1 AND company_id = $2;`,
    [id, companyId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getCategoryById(id: number, companyId: number) {
  const result = await pool.query(
    `
      SELECT ${CATEGORY_SELECT_COLUMNS}
      FROM categories
      WHERE id = $1 AND company_id = $2
      LIMIT 1;
    `,
    [id, companyId]
  );
  return result.rowCount ? mapCategory(result.rows[0]) : null;
}

export async function createCategory(companyId: number, name: string) {
  const slug = toSlug(name);
  if (!slug) throw new Error('Category name is invalid');
  const result = await pool.query(
    `
      INSERT INTO categories (company_id, name, slug)
      VALUES ($1, $2, $3)
      RETURNING ${CATEGORY_SELECT_COLUMNS};
    `,
    [companyId, name.trim(), slug]
  );
  return mapCategory(result.rows[0]);
}

export async function updateCategory(id: number, companyId: number, name: string) {
  const slug = toSlug(name);
  if (!slug) throw new Error('Category name is invalid');
  const result = await pool.query(
    `
      UPDATE categories
      SET name = $3, slug = $4, updated_date = NOW()
      WHERE id = $1 AND company_id = $2
      RETURNING ${CATEGORY_SELECT_COLUMNS};
    `,
    [id, companyId, name.trim(), slug]
  );
  return result.rowCount ? mapCategory(result.rows[0]) : null;
}

export async function deleteCategory(id: number, companyId: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Products with existing order history can't be hard-deleted because
    // order_items.product_id references them (ON DELETE SET NULL). That's safe,
    // but we also want to stop showing those products — archive them first, then
    // hard-delete the rest so the delete is clean.
    const productsInCategory = await client.query<{ id: number; hasOrders: boolean }>(
      `
        SELECT p.id,
          EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.id) AS "hasOrders"
        FROM products p
        WHERE p.category_id = $1 AND p.company_id = $2;
      `,
      [id, companyId]
    );

    let archivedCount = 0;
    let deletedCount = 0;
    for (const row of productsInCategory.rows) {
      if (row.hasOrders) {
        await client.query(
          `UPDATE products SET is_active = FALSE, category_id = NULL, updated_date = NOW() WHERE id = $1;`,
          [row.id]
        );
        archivedCount += 1;
      } else {
        await client.query(`DELETE FROM products WHERE id = $1;`, [row.id]);
        deletedCount += 1;
      }
    }

    const result = await client.query(
      `DELETE FROM categories WHERE id = $1 AND company_id = $2;`,
      [id, companyId]
    );

    await client.query('COMMIT');
    return {
      deleted: (result.rowCount ?? 0) > 0,
      productsDeleted: deletedCount,
      productsArchived: archivedCount,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateCategoryImage(
  id: number,
  companyId: number,
  imageUrl: string
) {
  const result = await pool.query(
    `
      UPDATE categories
      SET image_url = $3, updated_date = NOW()
      WHERE id = $1 AND company_id = $2
      RETURNING ${CATEGORY_SELECT_COLUMNS};
    `,
    [id, companyId, imageUrl]
  );
  return result.rowCount ? mapCategory(result.rows[0]) : null;
}


async function mapOrder(orderRow: OrderRow) {
  const itemsResult = await pool.query<OrderItemRow>(
    `
      SELECT
        id,
        product_id AS "productId",
        product_name AS "productName",
        unit_label AS "unitLabel",
        quantity,
        unit_price_cents AS "unitPriceCents",
        line_total_cents AS "lineTotalCents"
      FROM order_items
      WHERE order_id = $1
      ORDER BY id;
    `,
    [orderRow.id]
  );

  return {
    id: orderRow.id,
    publicId: orderRow.publicId,
    companyId: orderRow.companyId,
    customerName: orderRow.customerName,
    customerPhone: orderRow.customerPhone,
    customerEmail: orderRow.customerEmail,
    deliveryAddress: orderRow.deliveryAddress,
    deliveryNotes: orderRow.deliveryNotes,
    deliverySlot: orderRow.deliverySlot,
    paymentMethod: orderRow.paymentMethod,
    subtotalCents: orderRow.subtotalCents,
    deliveryFeeCents: orderRow.deliveryFeeCents,
    discountCents: orderRow.discountCents ?? 0,
    totalCents: orderRow.totalCents,
    status: orderRow.status,
    assignedRider: orderRow.assignedRider,
    assignedRiderUserId: orderRow.assignedRiderUserId ?? null,
    assignedRiderPhone: orderRow.assignedRiderPhone ?? null,
    geoLabel: orderRow.geoLabel,
    deliveryLatitude: orderRow.deliveryLatitude,
    deliveryLongitude: orderRow.deliveryLongitude,
    createdDate: orderRow.createdDate,
    updatedDate: orderRow.updatedDate,
    items: itemsResult.rows,
  } satisfies OrderRecord;
}

export async function createOrder(input: CreateOrderInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ids = input.items.map((item) => item.productId);
    const productsResult = await client.query<OrderLookupProductRow>(
      `
        SELECT
          id,
          unique_id AS "uniqueId",
          name,
          unit_label AS "unitLabel",
          CASE
            WHEN is_on_offer = TRUE AND offer_type = 'price' AND offer_price_cents IS NOT NULL
              THEN offer_price_cents
            ELSE price_cents
          END AS "priceCents",
          price_cents AS "regularPriceCents",
          offer_price_cents AS "offerPriceCents",
          is_on_offer AS "isOnOffer",
          offer_type AS "offerType",
          bogo_buy_qty AS "bogoBuyQty",
          bogo_get_qty AS "bogoGetQty",
          stock_quantity AS "stockQuantity",
          is_active AS "isActive"
        FROM products
        WHERE company_id = $1
          AND unique_id = ANY($2::uuid[]);
      `,
      [input.companyId, ids]
    );

    if (productsResult.rowCount !== ids.length) {
      throw new Error('One or more items are no longer available.');
    }

    const productMap = new Map<string, OrderLookupProductRow>(
      productsResult.rows.map((row) => [row.uniqueId, row])
    );

    let subtotalCents = 0;
    const lineItems = input.items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product || !product.isActive) {
        throw new Error('One or more items are no longer available.');
      }
      if (product.stockQuantity < item.quantity) {
        throw new Error(`${product.name} is low on stock.`);
      }
      const isBogo = product.isOnOffer && product.offerType === 'bogo';
      const unitPriceCents = isBogo ? product.regularPriceCents : product.priceCents;
      // Generalised BOGO: for every (buy + get) units in the cart, `get` are free.
      // e.g. buy=2, get=1 => every 3rd is free. buy=1, get=3 => every 4 units, 3 are free.
      const buyQty = Math.max(1, product.bogoBuyQty ?? 1);
      const getQty = Math.max(1, product.bogoGetQty ?? 1);
      const freeUnits = isBogo
        ? Math.floor(item.quantity / (buyQty + getQty)) * getQty
        : 0;
      const billableQty = Math.max(item.quantity - freeUnits, 0);
      const lineTotalCents = unitPriceCents * billableQty;
      subtotalCents += lineTotalCents;
      return {
        productId: product.id as number,
        productName: product.name as string,
        unitLabel: product.unitLabel as string,
        quantity: item.quantity,
        unitPriceCents,
        lineTotalCents,
      };
    });

    const settings = await getAppSettings(input.companyId);
    const deliveryFeeCents =
      subtotalCents >= settings.freeDeliveryThresholdCents ? 0 : settings.deliveryFeeCents;
    // Promo: 50% off up to ₹200 on orders above ₹500 (50000 cents subtotal threshold).
    const promoDiscountCents =
      subtotalCents >= 50000 ? Math.min(Math.floor(subtotalCents / 2), 20000) : 0;

    let couponDiscountCents = 0;
    let appliedCoupon: CouponRecord | null = null;
    if (input.couponCode && input.couponCode.trim()) {
      const validation = await validateCoupon(
        input.companyId,
        input.createdByUserId ?? null,
        input.couponCode,
        subtotalCents,
      );
      if (!validation.ok) {
        // Tagged so the route handler can distinguish coupon failures
        // and surface them in the coupon UI rather than as a generic order error.
        throw new Error(`COUPON_INVALID:${validation.error}`);
      }
      appliedCoupon = validation.coupon;
      couponDiscountCents = validation.discountCents;
    }

    const discountCents = Math.min(promoDiscountCents + couponDiscountCents, subtotalCents);
    const totalCents = Math.max(subtotalCents + deliveryFeeCents - discountCents, 0);
    const publicId = makeTrackingCode();

    const orderResult = await client.query(
      `
        INSERT INTO orders (
          public_id,
          company_id,
          customer_name,
          customer_phone,
          customer_email,
          delivery_address,
          delivery_notes,
          delivery_slot,
          payment_method,
          subtotal_cents,
          delivery_fee_cents,
          discount_cents,
          total_cents,
          status,
          assigned_rider,
          geo_label,
          delivery_latitude,
          delivery_longitude,
          created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'placed', NULL, $14, $15, $16, $17)
        RETURNING
          id,
          public_id AS "publicId",
          company_id AS "companyId",
          customer_name AS "customerName",
          customer_phone AS "customerPhone",
          customer_email AS "customerEmail",
          delivery_address AS "deliveryAddress",
          delivery_notes AS "deliveryNotes",
          delivery_slot AS "deliverySlot",
          payment_method AS "paymentMethod",
          subtotal_cents AS "subtotalCents",
          delivery_fee_cents AS "deliveryFeeCents",
          discount_cents AS "discountCents",
          total_cents AS "totalCents",
          status,
          assigned_rider AS "assignedRider",
          geo_label AS "geoLabel",
          delivery_latitude AS "deliveryLatitude",
          delivery_longitude AS "deliveryLongitude",
          created_date AS "createdDate",
          updated_date AS "updatedDate";
      `,
      [
        publicId,
        input.companyId,
        input.customerName,
        input.customerPhone,
        input.customerEmail ?? null,
        input.deliveryAddress,
        input.deliveryNotes ?? null,
        input.deliverySlot ?? null,
        input.paymentMethod,
        subtotalCents,
        deliveryFeeCents,
        discountCents,
        totalCents,
        input.geoLabel ?? null,
        input.deliveryLatitude ?? null,
        input.deliveryLongitude ?? null,
        input.createdByUserId ?? null,
      ]
    );

    const order = orderResult.rows[0];

    for (const item of lineItems) {
      await client.query(
        `
          INSERT INTO order_items (
            order_id,
            product_id,
            product_name,
            unit_label,
            quantity,
            unit_price_cents,
            line_total_cents
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7);
        `,
        [
          order.id,
          item.productId,
          item.productName,
          item.unitLabel,
          item.quantity,
          item.unitPriceCents,
          item.lineTotalCents,
        ]
      );
      await client.query(
        `
          UPDATE products
          SET stock_quantity = stock_quantity - $2, updated_date = NOW()
          WHERE id = $1;
        `,
        [item.productId, item.quantity]
      );
    }

    if (appliedCoupon && couponDiscountCents > 0) {
      await recordCouponRedemption(
        client,
        appliedCoupon.id,
        input.createdByUserId ?? null,
        order.id,
        couponDiscountCents,
      );
    }

    await client.query('COMMIT');
    // Re-read via the joined query to get consistent shape (incl. rider phone).
    const full = await getOrderByPublicId(order.publicId);
    return full ?? mapOrder(order);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const ORDER_SELECT_COLUMNS = `
  o.id,
  o.public_id AS "publicId",
  o.company_id AS "companyId",
  o.customer_name AS "customerName",
  o.customer_phone AS "customerPhone",
  o.customer_email AS "customerEmail",
  o.delivery_address AS "deliveryAddress",
  o.delivery_notes AS "deliveryNotes",
  o.delivery_slot AS "deliverySlot",
  o.payment_method AS "paymentMethod",
  o.subtotal_cents AS "subtotalCents",
  o.delivery_fee_cents AS "deliveryFeeCents",
  o.discount_cents AS "discountCents",
  o.total_cents AS "totalCents",
  o.status,
  o.assigned_rider AS "assignedRider",
  o.assigned_rider_user_id AS "assignedRiderUserId",
  r.phone AS "assignedRiderPhone",
  o.geo_label AS "geoLabel",
  o.delivery_latitude AS "deliveryLatitude",
  o.delivery_longitude AS "deliveryLongitude",
  o.created_date AS "createdDate",
  o.updated_date AS "updatedDate"
`;

const ORDER_FROM_CLAUSE = `
  FROM orders o
  LEFT JOIN users r ON r.id = o.assigned_rider_user_id
`;

export async function getOrderByPublicId(publicId: string) {
  const result = await pool.query(
    `SELECT ${ORDER_SELECT_COLUMNS} ${ORDER_FROM_CLAUSE} WHERE o.public_id = $1 LIMIT 1;`,
    [publicId]
  );
  return result.rowCount ? mapOrder(result.rows[0]) : null;
}

export async function listOrders(companyId: number) {
  const result = await pool.query(
    `SELECT ${ORDER_SELECT_COLUMNS} ${ORDER_FROM_CLAUSE} WHERE o.company_id = $1 ORDER BY o.created_date ASC;`,
    [companyId]
  );
  return Promise.all(result.rows.map((row: OrderRow) => mapOrder(row)));
}

export async function listOrdersForUser(userId: number, companyId: number) {
  const result = await pool.query(
    `
      SELECT ${ORDER_SELECT_COLUMNS}
      ${ORDER_FROM_CLAUSE}
      WHERE o.company_id = $1 AND o.created_by_user_id = $2
      ORDER BY o.created_date DESC;
    `,
    [companyId, userId]
  );
  return Promise.all(result.rows.map((row: OrderRow) => mapOrder(row)));
}

export interface SalesReport {
  periodDays: number;
  totalRevenueCents: number;
  totalOrders: number;
  totalItemsSold: number;
  averageOrderCents: number;
  dailyRevenue: Array<{ date: string; revenueCents: number; orders: number }>;
  topProducts: Array<{
    uniqueId: string | null;
    name: string;
    unitsSold: number;
    revenueCents: number;
  }>;
  paymentBreakdown: Array<{ method: string; orders: number; revenueCents: number }>;
}

export async function getSalesReport(companyId: number, days: number): Promise<SalesReport> {
  const totals = await pool.query<{
    totalRevenueCents: string;
    totalOrders: string;
  }>(
    `
      SELECT
        COALESCE(SUM(total_cents), 0)::text AS "totalRevenueCents",
        COUNT(*)::text AS "totalOrders"
      FROM orders
      WHERE company_id = $1
        AND status <> 'cancelled'
        AND created_date >= NOW() - ($2 || ' days')::INTERVAL;
    `,
    [companyId, days]
  );

  const totalItems = await pool.query<{ totalItemsSold: string }>(
    `
      SELECT COALESCE(SUM(oi.quantity), 0)::text AS "totalItemsSold"
      FROM order_items oi
      INNER JOIN orders o ON o.id = oi.order_id
      WHERE o.company_id = $1
        AND o.status <> 'cancelled'
        AND o.created_date >= NOW() - ($2 || ' days')::INTERVAL;
    `,
    [companyId, days]
  );

  const daily = await pool.query<{ date: string; revenueCents: string; orders: string }>(
    `
      SELECT
        to_char(date_trunc('day', created_date AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
        COALESCE(SUM(total_cents), 0)::text AS "revenueCents",
        COUNT(*)::text AS orders
      FROM orders
      WHERE company_id = $1
        AND status <> 'cancelled'
        AND created_date >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY 1
      ORDER BY 1 ASC;
    `,
    [companyId, days]
  );

  const topProducts = await pool.query<{
    uniqueId: string | null;
    name: string;
    unitsSold: string;
    revenueCents: string;
  }>(
    `
      SELECT
        p.unique_id AS "uniqueId",
        oi.product_name AS "name",
        SUM(oi.quantity)::text AS "unitsSold",
        SUM(oi.line_total_cents)::text AS "revenueCents"
      FROM order_items oi
      INNER JOIN orders o ON o.id = oi.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.company_id = $1
        AND o.status <> 'cancelled'
        AND o.created_date >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY p.unique_id, oi.product_name
      ORDER BY SUM(oi.quantity) DESC
      LIMIT 10;
    `,
    [companyId, days]
  );

  const payments = await pool.query<{ method: string; orders: string; revenueCents: string }>(
    `
      SELECT
        payment_method AS method,
        COUNT(*)::text AS orders,
        COALESCE(SUM(total_cents), 0)::text AS "revenueCents"
      FROM orders
      WHERE company_id = $1
        AND status <> 'cancelled'
        AND created_date >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY payment_method
      ORDER BY SUM(total_cents) DESC;
    `,
    [companyId, days]
  );

  const totalRevenueCents = Number(totals.rows[0]?.totalRevenueCents ?? '0');
  const totalOrders = Number(totals.rows[0]?.totalOrders ?? '0');
  const totalItemsSold = Number(totalItems.rows[0]?.totalItemsSold ?? '0');

  return {
    periodDays: days,
    totalRevenueCents,
    totalOrders,
    totalItemsSold,
    averageOrderCents: totalOrders > 0 ? Math.round(totalRevenueCents / totalOrders) : 0,
    dailyRevenue: daily.rows.map((r) => ({
      date: r.date,
      revenueCents: Number(r.revenueCents),
      orders: Number(r.orders),
    })),
    topProducts: topProducts.rows.map((r) => ({
      uniqueId: r.uniqueId,
      name: r.name,
      unitsSold: Number(r.unitsSold),
      revenueCents: Number(r.revenueCents),
    })),
    paymentBreakdown: payments.rows.map((r) => ({
      method: r.method,
      orders: Number(r.orders),
      revenueCents: Number(r.revenueCents),
    })),
  };
}

export async function updateOrderStatus(
  publicId: string,
  companyId: number,
  status: OrderStatus,
  assignedRiderUserId?: number | null
) {
  // Resolve rider snapshot so orders keep name even if rider user is deleted.
  let riderName: string | null = null;
  if (assignedRiderUserId != null) {
    const rider = await pool.query<{ fullName: string | null; email: string }>(
      `SELECT full_name AS "fullName", email FROM users WHERE id = $1 AND role = 'rider' LIMIT 1;`,
      [assignedRiderUserId]
    );
    if (!rider.rowCount) {
      throw new Error('Selected rider is invalid');
    }
    riderName = rider.rows[0].fullName || rider.rows[0].email;
  }

  const updated = await pool.query<{ id: number }>(
    `
      UPDATE orders
      SET
        status = $3,
        assigned_rider_user_id = $4,
        assigned_rider = $5,
        updated_date = NOW()
      WHERE public_id = $1 AND company_id = $2
      RETURNING id;
    `,
    [publicId, companyId, status, assignedRiderUserId ?? null, riderName]
  );
  if (!updated.rowCount) return null;
  return getOrderByPublicId(publicId);
}

export async function getDashboardSummary(companyId: number) {
  const [totals, active, stock, regions] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*)::int AS "totalOrders",
          COALESCE(SUM(total_cents), 0)::int AS "revenueCents"
        FROM orders
        WHERE company_id = $1;
      `,
      [companyId]
    ),
    pool.query(
      `
        SELECT COUNT(*)::int AS "activeDeliveries"
        FROM orders
        WHERE company_id = $1
          AND status IN ('confirmed', 'packing', 'out_for_delivery');
      `,
      [companyId]
    ),
    pool.query(
      `
        SELECT COUNT(*)::int AS "lowStock"
        FROM products
        WHERE company_id = $1
          AND is_active = TRUE
          AND stock_quantity <= 10;
      `,
      [companyId]
    ),
    pool.query(
      `
        SELECT
          COALESCE(geo_label, 'Unknown') AS label,
          COUNT(*)::int AS count
        FROM orders
        WHERE company_id = $1
        GROUP BY COALESCE(geo_label, 'Unknown')
        ORDER BY count DESC, label ASC
        LIMIT 4;
      `,
      [companyId]
    ),
  ]);

  return {
    totalOrders: totals.rows[0].totalOrders,
    revenueCents: totals.rows[0].revenueCents,
    activeDeliveries: active.rows[0].activeDeliveries,
    lowStock: stock.rows[0].lowStock,
    topRegions: regions.rows,
  };
}
