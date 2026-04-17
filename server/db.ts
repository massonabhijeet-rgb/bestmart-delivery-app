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
    createdDate: row.createdDate,
    updatedDate: row.updatedDate,
  };
}

function mapCategory(row: {
  id: number;
  companyId: number;
  name: string;
  slug: string;
  hasImage: boolean;
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
      UNIQUE (user_id, full_name, phone, delivery_address)
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
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      product_name VARCHAR(255) NOT NULL,
      unit_label VARCHAR(120) NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL
    );
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
  return result.rows[0] ?? null;
}

export async function updateStoreLocation(companyId: number, latitude: number, longitude: number) {
  await pool.query(
    `UPDATE companies SET store_latitude = $1, store_longitude = $2, updated_date = NOW() WHERE id = $3`,
    [latitude, longitude, companyId]
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
        last_used_date = NOW();
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
  p.created_date AS "createdDate",
  p.updated_date AS "updatedDate"
`;

export async function listProducts(companyId: number, includeInactive = false) {
  const result = await pool.query(
    `
      SELECT ${PRODUCT_SELECT_COLUMNS}
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
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
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.company_id = p.company_id
      WHERE p.company_id = $1
        AND p.is_active = TRUE
        AND p.is_on_offer = FALSE
        AND p.stock_quantity > 0
        AND p.created_date <= NOW() - INTERVAL '14 days'
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

    if (unitsSoldAllTime === 0 && daysSinceCreated >= 30) {
      reason = 'no_sales_ever';
      reasonLabel = `Never sold in ${daysSinceCreated} days`;
      suggestedDiscountPercent = 20;
    } else if (unitsSold30d === 0 && daysSinceLastSold !== null && daysSinceLastSold >= 30) {
      reason = 'no_sales_30d';
      reasonLabel = `No sales in last ${daysSinceLastSold} days`;
      suggestedDiscountPercent = 15;
    } else if (unitsSold30d === 0 && daysSinceCreated >= 14) {
      reason = 'no_sales_30d';
      reasonLabel = `No sales in last 30 days`;
      suggestedDiscountPercent = 15;
    } else if (unitsSold30d <= 2 && row.stockQuantity >= 20) {
      reason = 'overstocked';
      reasonLabel = `Only ${unitsSold30d} sold, ${row.stockQuantity} in stock`;
      suggestedDiscountPercent = 10;
    } else if (unitsSold30d <= 2 && daysSinceCreated >= 30) {
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
        is_on_offer
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
    ]
  );
  return updated.rowCount ? readProductWithCategory(pool, updated.rows[0].id) : null;
}

export async function setProductOffer(
  uniqueId: string,
  companyId: number,
  isOnOffer: boolean,
  offerPriceCents: number | null,
  offerType: 'price' | 'bogo' = 'price'
) {
  const resolvedType = isOnOffer ? offerType : 'price';
  const resolvedPrice =
    isOnOffer && resolvedType === 'price' ? offerPriceCents : null;
  const result = await pool.query<{ id: number }>(
    `
      UPDATE products
      SET
        is_on_offer = $3,
        offer_price_cents = $4,
        offer_type = $5,
        updated_date = NOW()
      WHERE unique_id = $1 AND company_id = $2
      RETURNING id;
    `,
    [uniqueId, companyId, isOnOffer, resolvedPrice, resolvedType]
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
      // Buy 1 Get 1: customer pays for ceil(qty/2), gets floor(qty/2) free.
      const billableQty = isBogo ? Math.ceil(item.quantity / 2) : item.quantity;
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

    const deliveryFeeCents = subtotalCents >= 150000 ? 0 : 4900;
    // Promo: 50% off up to ₹200 on orders above ₹500 (50000 cents subtotal threshold).
    const discountCents =
      subtotalCents >= 50000 ? Math.min(Math.floor(subtotalCents / 2), 20000) : 0;
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
