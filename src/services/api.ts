import { popBusy, pushBusy } from '../components/BusyOverlay';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function busyLabelFor(method: string, endpoint: string): string {
  const ep = endpoint.toLowerCase();
  if (ep.includes('upload') || ep.includes('image')) return 'Uploading…';
  if (ep.includes('bulk-upload-images') || ep.includes('bulk-upload')) return 'Uploading images…';
  if (ep.includes('login')) return 'Signing in…';
  if (ep.includes('signup') || ep.includes('register')) return 'Creating account…';
  if (ep.includes('orders') && method === 'POST') return 'Placing order…';
  if (ep.includes('cancel')) return 'Cancelling…';
  if (ep.includes('status')) return 'Updating status…';
  if (ep.includes('offer')) return 'Updating offer…';
  if (ep.includes('settings')) return 'Saving settings…';
  if (method === 'DELETE') return 'Deleting…';
  if (method === 'POST') return 'Saving…';
  if (method === 'PATCH' || method === 'PUT') return 'Saving…';
  return 'Working…';
}

export type UserRole = 'admin' | 'editor' | 'viewer' | 'rider';
export type OrderStatus =
  | 'placed'
  | 'confirmed'
  | 'packing'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

export interface User {
  id: number;
  uid: string;
  email: string;
  companyId: number;
  companyName: string;
  role: UserRole;
  fullName: string | null;
  phone: string | null;
}

export interface SavedAddress {
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

export interface AppSettings {
  freeDeliveryThresholdCents: number;
  deliveryFeeCents: number;
}

export interface CompanyInfo {
  id: number;
  name: string;
  slug: string;
  description: string;
  supportPhone: string;
  supportEmail: string;
  promises: string[];
  storeLatitude: number | null;
  storeLongitude: number | null;
  settings: AppSettings;
}

export interface Product {
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
  variantGroupId: number | null;
  createdDate: string;
  updatedDate: string;
}

export interface Category {
  id: number;
  companyId: number;
  name: string;
  slug: string;
  imageUrl: string | null;
  isHidden: boolean;
  createdDate: string;
  updatedDate: string;
}

export interface OrderItem {
  id: number;
  productId: number | null;
  productName: string;
  unitLabel: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  rejectedAt: string | null;
  rejectionReason: string | null;
}

export interface Order {
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
  cancellationReason: string | null;
  deliveryOtp: string | null;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  paymentStatus: string;
  createdDate: string;
  updatedDate: string;
  items: OrderItem[];
}

export interface DashboardSummary {
  totalOrders: number;
  revenueCents: number;
  activeDeliveries: number;
  lowStock: number;
  topRegions: Array<{ label: string; count: number }>;
}

export interface TeamMember {
  uid: string;
  email: string;
  role: UserRole;
  fullName: string | null;
  phone: string | null;
  createdDate: string;
}

export interface Rider {
  id: number;
  uid: string;
  email: string;
  fullName: string | null;
  phone: string | null;
  isAvailable: boolean;
}

function getToken() {
  return localStorage.getItem('token');
}

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  const token = getToken();

  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const method = (options.method ?? 'GET').toUpperCase();
  const showBusy = method !== 'GET';
  if (showBusy) pushBusy(busyLabelFor(method, endpoint));

  let response: Response;
  let text: string;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    });
    text = await response.text();
  } finally {
    if (showBusy) popBusy();
  }

  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);

  if (!response.ok) {
    const message = (data as { error?: string }).error || `Request failed (${response.status})`;
    throw new ApiError(message, response.status, data as Record<string, unknown>);
  }

  return data as T;
}

export async function apiGetCompanyPublic() {
  const data = await request<{ company: CompanyInfo }>('/company/public');
  return data.company;
}

export async function apiGetAppSettings() {
  const data = await request<{ settings: AppSettings }>('/company/settings');
  return data.settings;
}

export async function apiUpdateAppSettings(patch: Partial<AppSettings>) {
  const data = await request<{ settings: AppSettings }>('/company/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return data.settings;
}

export async function apiSetStoreLocation(latitude: number, longitude: number) {
  await request<{ ok: boolean }>('/company/store-location', {
    method: 'PATCH',
    body: JSON.stringify({ latitude, longitude }),
  });
}

export async function apiLogin(email: string, password: string) {
  const data = await request<{ token: string; user: User }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  localStorage.setItem('token', data.token);
  return data;
}

export async function apiSignup(email: string, password: string) {
  const data = await request<{ token: string; user: User }>('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  localStorage.setItem('token', data.token);
  return data;
}

export async function apiGetMe() {
  return request<{ user: User }>('/auth/me');
}

export async function apiListAddresses() {
  const data = await request<{ addresses: SavedAddress[] }>('/auth/addresses');
  return data.addresses;
}

export function apiLogout() {
  localStorage.removeItem('token');
}

export async function apiGetProducts(includeInactive = false) {
  const suffix = includeInactive ? '?includeInactive=true' : '';
  const data = await request<{ products: Product[] }>(`/products${suffix}`);
  return data.products;
}

export interface ProductsPage {
  products: Product[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ProductsPageQuery {
  page?: number;
  pageSize?: number;
  category?: string | null;
  categoryId?: number | null;
  brand?: string | null;
  q?: string | null;
  ids?: string[] | null;
  admin?: boolean;
  status?: 'all' | 'active' | 'archived' | 'low_stock' | null;
  onOffer?: boolean | null;
  sort?: 'default' | 'price_asc' | 'price_desc' | 'stock_asc' | 'stock_desc' | 'created_desc' | null;
}

export async function apiGetProductsPage(opts: ProductsPageQuery = {}): Promise<ProductsPage> {
  const params = new URLSearchParams();
  if (opts.page) params.set('page', String(opts.page));
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
  if (opts.category && opts.category !== 'All') params.set('category', opts.category);
  if (opts.categoryId != null) params.set('categoryId', String(opts.categoryId));
  if (opts.brand) params.set('brand', opts.brand);
  if (opts.q && opts.q.trim()) params.set('q', opts.q.trim());
  if (opts.ids && opts.ids.length > 0) params.set('ids', opts.ids.join(','));
  if (opts.admin) params.set('admin', '1');
  if (opts.status) params.set('status', opts.status);
  if (typeof opts.onOffer === 'boolean') params.set('onOffer', opts.onOffer ? '1' : '0');
  if (opts.sort) params.set('sort', opts.sort);
  const qs = params.toString();
  return request<ProductsPage>(`/products/page${qs ? `?${qs}` : ''}`);
}

export interface InventorySummaryByCategory {
  categoryId: number;
  category: string;
  count: number;
  activeCount: number;
  units: number;
  valueCents: number;
}

export interface InventorySummary {
  totalProducts: number;
  activeProducts: number;
  archivedProducts: number;
  outOfStock: number;
  lowStock: number;
  onOfferCount: number;
  notOnOfferCount: number;
  totalUnits: number;
  inventoryValueCents: number;
  byCategory: InventorySummaryByCategory[];
  lowStockList: Product[];
  recentProducts: Product[];
}

export async function apiGetInventorySummary(): Promise<InventorySummary> {
  return request<InventorySummary>(`/products/admin-summary`);
}

export interface ProductNameIndexEntry {
  id: number;
  uniqueId: string;
  name: string;
  imageUrl: string | null;
  unitLabel: string;
  brandId: number | null;
  variantGroupId: number | null;
}

export async function apiGetProductNameIndex(): Promise<ProductNameIndexEntry[]> {
  const data = await request<{ products: ProductNameIndexEntry[] }>(`/products/name-index`);
  return data.products;
}

export interface StorefrontSpotlight {
  offerProducts: Product[];
  dailyEssentials: Product[];
  moodPicks: Product[];
}

export async function apiGetStorefrontSpotlight(mood: string | null): Promise<StorefrontSpotlight> {
  const qs = mood ? `?mood=${encodeURIComponent(mood)}` : '';
  return request<StorefrontSpotlight>(`/products/spotlight${qs}`);
}

export interface HomeRailsCategory {
  id: number;
  name: string;
  imageUrl: string | null;
  products: Product[];
  score: number;
  signals: string[];
}

export interface HomeRails {
  bestsellers: Product[];
  categoryRails: HomeRailsCategory[];
}

export async function apiGetHomeRails(): Promise<HomeRails> {
  return request<HomeRails>('/products/home-rails');
}

export async function apiLogSearch(query: string, categoryId?: number | null): Promise<void> {
  const q = query.trim();
  if (q.length < 2) return;
  try {
    await request<void>('/products/search/log', {
      method: 'POST',
      body: JSON.stringify({ query: q, categoryId: categoryId ?? undefined }),
    });
  } catch {
    // best-effort; do not surface to UI
  }
}

export async function apiLogClick(opts: {
  productId?: number | null;
  categoryId?: number | null;
  source: string;
}): Promise<void> {
  if (!opts.source) return;
  try {
    await request<void>('/products/click/log', {
      method: 'POST',
      body: JSON.stringify({
        productId: opts.productId ?? undefined,
        categoryId: opts.categoryId ?? undefined,
        source: opts.source,
      }),
    });
  } catch {
    // best-effort
  }
}

export interface BulkImportRowInput {
  rowNum: number;
  name: string;
  categoryName: string;
  brandName: string | null;
  unitLabel: string;
  description: string;
  priceCents: number;
  originalPriceCents: number | null;
  stockQuantity: number;
  badge: string | null;
  imageUrl: string | null;
  isActive: boolean;
}

export interface BulkImportResponse {
  created: number;
  brandsCreated: number;
  skippedExisting: Array<{ rowNum: number; name: string }>;
  skippedNoCategory: Array<{ rowNum: number; name: string; categoryName: string }>;
}

export async function apiBulkImportProducts(products: BulkImportRowInput[]) {
  return request<BulkImportResponse>('/products/bulk-import', {
    method: 'POST',
    body: JSON.stringify({ products }),
  });
}

export async function apiAddProduct(product: Partial<Product>) {
  const data = await request<{ product: Product }>('/products', {
    method: 'POST',
    body: JSON.stringify(product),
  });
  return data.product;
}

export async function apiUpdateProduct(uniqueId: string, updates: Partial<Product>) {
  const data = await request<{ product: Product }>(`/products/${uniqueId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  return data.product;
}

export async function apiDeleteProduct(uniqueId: string) {
  return request<{ message: string }>(`/products/${uniqueId}`, {
    method: 'DELETE',
  });
}

export async function apiRestoreProduct(uniqueId: string) {
  return request<{ message: string }>(`/products/${uniqueId}/restore`, {
    method: 'POST',
  });
}

export async function apiHardDeleteProduct(uniqueId: string) {
  return request<{ message: string }>(`/products/${uniqueId}/permanent`, {
    method: 'DELETE',
  });
}

export async function apiGetProductVariants(uniqueId: string) {
  const data = await request<{ variants: Product[] }>(`/products/${uniqueId}/variants`);
  return data.variants;
}

export async function apiListCategories() {
  const data = await request<{ categories: Category[] }>('/categories');
  return data.categories;
}

export async function apiCreateCategory(name: string) {
  const data = await request<{ category: Category }>('/categories', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return data.category;
}

export async function apiUpdateCategory(id: number, name: string, isHidden?: boolean) {
  const payload: { name: string; isHidden?: boolean } = { name };
  if (typeof isHidden === 'boolean') payload.isHidden = isHidden;
  const data = await request<{ category: Category }>(`/categories/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return data.category;
}

export async function apiDeleteCategory(id: number) {
  return request<{ message: string; productsDeleted: number; productsArchived: number }>(
    `/categories/${id}`,
    { method: 'DELETE' }
  );
}

export type WeatherMoodTag = 'hot' | 'warm' | 'cool' | 'cold' | 'rainy';

export type TempCategoryTheme =
  | 'summer'
  | 'winter'
  | 'monsoon'
  | 'holi'
  | 'rakhi'
  | 'independence'
  | 'republic'
  | 'ganesh'
  | 'navratri'
  | 'diwali'
  | 'christmas'
  | 'newyear';

export interface TempCategory {
  id: number;
  autoKey: string;
  name: string;
  theme: TempCategoryTheme;
  keywords: string[];
  priority: number;
  expiresAt: string;
  productIds: string[];
  products: Product[];
}

export async function apiListTempCategories(mood: WeatherMoodTag | null) {
  const qs = mood ? `?mood=${encodeURIComponent(mood)}` : '';
  const data = await request<{ tempCategories: TempCategory[] }>(`/categories/temporary${qs}`);
  return data.tempCategories;
}

export async function apiUploadCategoryImage(id: number, file: File) {
  const formData = new FormData();
  formData.append('categoryImage', file);
  const data = await request<{ message: string; category: Category }>(
    `/categories/${id}/upload-image`,
    { method: 'POST', body: formData }
  );
  return data.category;
}

// ── Campaign overlay (festivals / special days) ──
export interface CampaignCategoryRef {
  id: number;
  slug: string;
  name: string;
}

export interface Campaign {
  id: number;
  companyId: number;
  title: string;
  imageUrl: string | null;
  categoryIds: number[];
  categories: CampaignCategoryRef[];
  isActive: boolean;
  validFrom: string | null;
  validUntil: string | null;
  createdDate: string;
  updatedDate: string;
}

export interface CampaignInput {
  title: string;
  categoryIds: number[];
  isActive: boolean;
  validFrom: string | null;
  validUntil: string | null;
}

export async function apiListCampaigns() {
  const data = await request<{ campaigns: Campaign[] }>('/campaigns');
  return data.campaigns;
}

export async function apiGetActiveCampaign() {
  const data = await request<{ campaign: Campaign | null }>('/campaigns/active');
  return data.campaign;
}

export async function apiCreateCampaign(input: CampaignInput) {
  const data = await request<{ campaign: Campaign }>('/campaigns', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.campaign;
}

export async function apiUpdateCampaign(id: number, input: Partial<CampaignInput>) {
  const data = await request<{ campaign: Campaign }>(`/campaigns/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return data.campaign;
}

export async function apiDeleteCampaign(id: number) {
  return request<{ message: string }>(`/campaigns/${id}`, { method: 'DELETE' });
}

export async function apiUploadCampaignImage(id: number, file: File) {
  const formData = new FormData();
  formData.append('campaignImage', file);
  const data = await request<{ message: string; campaign: Campaign }>(
    `/campaigns/${id}/upload-image`,
    { method: 'POST', body: formData }
  );
  return data.campaign;
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

export async function apiListSlowMovers() {
  const data = await request<{ suggestions: SlowMoverSuggestion[] }>('/products/slow-movers');
  return data.suggestions;
}

export interface Brand {
  id: number;
  companyId: number;
  name: string;
  slug: string;
  productCount: number;
  createdDate: string;
  updatedDate: string;
}

export async function apiListBrands() {
  const data = await request<{ brands: Brand[] }>('/brands');
  return data.brands;
}

export async function apiCreateBrand(name: string) {
  const data = await request<{ brand: Brand }>('/brands', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return data.brand;
}

export async function apiUpdateBrand(id: number, name: string) {
  const data = await request<{ brand: Brand }>(`/brands/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
  return data.brand;
}

export interface BrandDeletionImpact {
  totalProducts: number;
  withOrders: number;
  withoutOrders: number;
}

export async function apiGetBrandDeletionImpact(id: number) {
  const data = await request<{ impact: BrandDeletionImpact }>(
    `/brands/${id}/deletion-impact`,
  );
  return data.impact;
}

export async function apiDeleteBrand(id: number) {
  return request<{ ok: boolean; productsDeleted: number; productsArchived: number }>(
    `/brands/${id}`,
    { method: 'DELETE' },
  );
}

export async function apiToggleProductOffer(
  uniqueId: string,
  isOnOffer: boolean,
  offerPriceCents: number | null = null,
  offerType: 'price' | 'bogo' = 'price',
  bogoBuyQty: number = 1,
  bogoGetQty: number = 1,
) {
  const data = await request<{ product: Product }>(`/products/${uniqueId}/offer`, {
    method: 'PATCH',
    body: JSON.stringify({ isOnOffer, offerPriceCents, offerType, bogoBuyQty, bogoGetQty }),
  });
  return data.product;
}

export async function apiUploadProductImage(uniqueId: string, file: File) {
  const formData = new FormData();
  formData.append('productImage', file);
  const data = await request<{ message: string; product: Product }>(
    `/products/${uniqueId}/upload-image`,
    {
      method: 'POST',
      body: formData,
    }
  );
  return data.product;
}

export interface BulkImageUploadResult {
  total: number;
  matched: number;
  unmatched: number;
  failed: number;
  results: { filename: string; matched: string | null; status: 'ok' | 'unmatched' | 'error'; error?: string }[];
}

export async function apiBulkUploadProductImages(files: File[]): Promise<BulkImageUploadResult> {
  const formData = new FormData();
  files.forEach((f) => formData.append('images', f));
  return request<BulkImageUploadResult>('/products/bulk-upload-images', { method: 'POST', body: formData });
}

export async function apiCreateOrder(payload: {
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  deliveryNotes?: string;
  paymentMethod: string;
  items: Array<{ productId: string; quantity: number }>;
  deliveryLatitude: number;
  deliveryLongitude: number;
  couponCode?: string | null;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
}) {
  const data = await request<{ order: Order }>('/orders', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data.order;
}

export interface PaymentConfig {
  enabled: boolean;
  keyId: string | null;
}

export async function apiGetPaymentConfig() {
  return request<PaymentConfig>('/payments/config');
}

export interface PaymentIntent {
  razorpayOrderId: string;
  amount: number;
  currency: string;
  keyId: string;
}

export async function apiCreatePaymentIntent(amountCents: number) {
  return request<PaymentIntent>('/payments/create-order', {
    method: 'POST',
    body: JSON.stringify({ amountCents }),
  });
}

export type UpiIntentApp = 'phonepe' | 'google_pay' | 'paytm';

export interface UpiIntentResult {
  intentUrl: string;
  paymentId: string | null;
}

export async function apiCreateUpiIntent(params: {
  razorpayOrderId: string;
  amountCents: number;
  upiApp: UpiIntentApp;
  email?: string;
  contact?: string;
}) {
  return request<UpiIntentResult>('/payments/upi-intent', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export type CouponDiscountType = 'percent' | 'flat';

export interface Coupon {
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

export interface CouponPreview {
  code: string;
  description: string;
  discountCents: number;
  discountType: CouponDiscountType;
  discountValue: number;
}

export async function apiListCoupons() {
  const data = await request<{ coupons: Coupon[] }>('/coupons');
  return data.coupons;
}

export async function apiCreateCoupon(payload: Partial<Coupon>) {
  const data = await request<{ coupon: Coupon }>('/coupons', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data.coupon;
}

export async function apiUpdateCoupon(id: number, payload: Partial<Coupon>) {
  const data = await request<{ coupon: Coupon }>(`/coupons/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return data.coupon;
}

export async function apiDeleteCoupon(id: number) {
  await request<{ ok: boolean }>(`/coupons/${id}`, { method: 'DELETE' });
}

export interface PublicCoupon {
  code: string;
  description: string;
  discountType: CouponDiscountType;
  discountValue: number;
  maxDiscountCents: number | null;
  minSubtotalCents: number;
  validUntil: string | null;
}

export async function apiListPublicCoupons() {
  const data = await request<{ coupons: PublicCoupon[] }>('/coupons/public');
  return data.coupons;
}

export async function apiListAvailableCoupons() {
  const data = await request<{ coupons: PublicCoupon[] }>('/coupons/available');
  return data.coupons;
}

export async function apiPreviewCoupon(code: string, subtotalCents: number) {
  const data = await request<CouponPreview>('/coupons/preview', {
    method: 'POST',
    body: JSON.stringify({ code, subtotalCents }),
  });
  return data;
}

export async function apiListMyOrders() {
  const data = await request<{ orders: Order[] }>('/orders/my-orders');
  return data.orders;
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

export async function apiSalesReport(days = 30) {
  const data = await request<{ report: SalesReport }>(`/orders/sales-report?days=${days}`);
  return data.report;
}

export async function apiTrackOrder(publicId: string) {
  const data = await request<{ order: Order }>(`/orders/track/${publicId}`);
  return data.order;
}

export async function apiCancelOrder(publicId: string) {
  const data = await request<{ order: Order }>(`/orders/${publicId}/cancel`, {
    method: 'POST',
  });
  return data.order;
}

export async function apiListOrders() {
  const data = await request<{ orders: Order[] }>('/orders');
  return data.orders;
}

export async function apiUpdateOrderStatus(
  publicId: string,
  status: OrderStatus,
  assignedRiderUserId?: number | null,
  cancellationReason?: string | null
) {
  const data = await request<{ order: Order }>(`/orders/${publicId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      status,
      assignedRiderUserId: assignedRiderUserId ?? null,
      cancellationReason: cancellationReason ?? null,
    }),
  });
  return data.order;
}

export async function apiRejectOrderItem(
  publicId: string,
  itemId: number,
  reason: string
) {
  const data = await request<{ order: Order }>(
    `/orders/${publicId}/items/${itemId}/reject`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }
  );
  return data.order;
}

export async function apiListRiders(opts: { availableOnly?: boolean } = {}) {
  const path = opts.availableOnly
    ? '/auth/riders?available=true'
    : '/auth/riders';
  const data = await request<{ riders: Rider[] }>(path);
  return data.riders;
}

export async function apiListRiderOrders() {
  const data = await request<{ orders: Order[] }>('/rider/orders');
  return data.orders;
}

export async function apiRiderDeliver(publicId: string, otp: string) {
  const data = await request<{ order: Order }>(`/rider/orders/${publicId}/deliver`, {
    method: 'POST',
    body: JSON.stringify({ otp }),
  });
  return data.order;
}

export async function apiRiderCollectUpi(publicId: string) {
  return request<{ qrId: string; qrImageUrl: string; amountCents: number }>(
    `/rider/orders/${publicId}/collect-upi`,
    { method: 'POST' }
  );
}

export async function apiUpdateRiderLocation(latitude: number, longitude: number) {
  await request<{ ok: boolean }>('/rider/location', {
    method: 'PATCH',
    body: JSON.stringify({ latitude, longitude }),
  });
}

export async function apiGetSummary() {
  const data = await request<{ summary: DashboardSummary }>('/orders/summary');
  return data.summary;
}

export async function apiListTeam() {
  const data = await request<{ team: TeamMember[] }>('/auth/team');
  return data.team;
}

export async function apiCreateUser(
  email: string,
  password: string,
  role: UserRole,
  extras: { fullName?: string; phone?: string } = {}
) {
  const data = await request<{ message: string; user: TeamMember }>('/auth/create-user', {
    method: 'POST',
    body: JSON.stringify({ email, password, role, ...extras }),
  });
  return data;
}
