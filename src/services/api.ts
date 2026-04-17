const API_BASE = import.meta.env.VITE_API_URL || '/api';

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
  createdDate: string;
  updatedDate: string;
}

export interface Category {
  id: number;
  companyId: number;
  name: string;
  slug: string;
  imageUrl: string | null;
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
}

function getToken() {
  return localStorage.getItem('token');
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

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  const text = await response.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);

  if (!response.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${response.status})`);
  }

  return data as T;
}

export async function apiGetCompanyPublic() {
  const data = await request<{ company: CompanyInfo }>('/company/public');
  return data.company;
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

export async function apiUpdateCategory(id: number, name: string) {
  const data = await request<{ category: Category }>(`/categories/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  });
  return data.category;
}

export async function apiDeleteCategory(id: number) {
  return request<{ message: string; productsDeleted: number; productsArchived: number }>(
    `/categories/${id}`,
    { method: 'DELETE' }
  );
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

export async function apiToggleProductOffer(
  uniqueId: string,
  isOnOffer: boolean,
  offerPriceCents: number | null = null,
  offerType: 'price' | 'bogo' = 'price'
) {
  const data = await request<{ product: Product }>(`/products/${uniqueId}/offer`, {
    method: 'PATCH',
    body: JSON.stringify({ isOnOffer, offerPriceCents, offerType }),
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
}) {
  const data = await request<{ order: Order }>('/orders', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data.order;
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
  assignedRiderUserId?: number | null
) {
  const data = await request<{ order: Order }>(`/orders/${publicId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, assignedRiderUserId: assignedRiderUserId ?? null }),
  });
  return data.order;
}

export async function apiListRiders() {
  const data = await request<{ riders: Rider[] }>('/auth/riders');
  return data.riders;
}

export async function apiListRiderOrders() {
  const data = await request<{ orders: Order[] }>('/rider/orders');
  return data.orders;
}

export async function apiRiderDeliver(publicId: string) {
  const data = await request<{ order: Order }>(`/rider/orders/${publicId}/deliver`, {
    method: 'POST',
  });
  return data.order;
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
