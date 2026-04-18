import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { formatCurrency, formatDateTime, formatRelativeTime, labelizeStatus } from '../lib/format';
import { fuzzyRank } from '../lib/fuzzySearch';
import { playOrderAlert, unlockAudio } from '../lib/sound';
import { useOrderSocket } from '../hooks/useOrderSocket';
import type { RiderLocation } from '../hooks/useOrderSocket';
import { confirm, pickRider } from '../components/ConfirmDialog';
import { withBusy } from '../components/BusyOverlay';
import LazyMount from '../components/LazyMount';
import {
  describeWeatherCode,
  fetchOpenMeteoSnapshot,
  type WeatherSnapshot,
} from '../lib/weatherPicks';
import {
  apiAddProduct,
  apiCreateCategory,
  apiCreateUser,
  apiDeleteCategory,
  apiDeleteProduct,
  apiGetProducts,
  apiGetSummary,
  apiListCategories,
  apiListOrders,
  apiListRiders,
  apiListTeam,
  apiToggleProductOffer,
  apiGetCompanyPublic,
  apiSetStoreLocation,
  apiUpdateCategory,
  apiUpdateOrderStatus,
  apiUpdateProduct,
  apiUploadCategoryImage,
  apiUploadProductImage,
  apiBulkUploadProductImages,
  apiListSlowMovers,
  apiSalesReport,
  apiUpdateAppSettings,
  apiListCoupons,
  apiCreateCoupon,
  apiUpdateCoupon,
  apiDeleteCoupon,
  apiListBrands,
  apiCreateBrand,
  apiUpdateBrand,
  apiDeleteBrand,
} from '../services/api';
import type { Brand, BulkImageUploadResult, Coupon, SalesReport, SlowMoverSuggestion } from '../services/api';
import type {
  Category,
  CompanyInfo,
  DashboardSummary,
  Order,
  OrderStatus,
  Product,
  Rider,
  TeamMember,
  User,
  UserRole,
} from '../services/api';

function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

interface DashboardProps {
  user: User;
  onLogout: () => void;
  onOpenStore: () => void;
}

interface BulkProductRow {
  rowNum: number;
  name: string;
  categoryName: string;
  categoryId: number | null;
  unitLabel: string;
  description: string;
  priceCents: number;
  originalPriceCents: number | null;
  stockQuantity: number;
  badge: string | null;
  imageUrl: string | null;
  isActive: boolean;
  errors: string[];
}

interface ProductFormState {
  name: string;
  categoryId: string;
  brandId: string;
  unitLabel: string;
  description: string;
  price: string;
  originalPrice: string;
  stockQuantity: string;
  badge: string;
  imageUrl: string;
  isActive: boolean;
}

const defaultProductForm: ProductFormState = {
  name: '',
  categoryId: '',
  brandId: '',
  unitLabel: '',
  description: '',
  price: '',
  originalPrice: '',
  stockQuantity: '0',
  badge: '',
  imageUrl: '',
  isActive: true,
};

type DashTab = 'overview' | 'orders' | 'history' | 'sales' | 'inventory' | 'categories' | 'offers' | 'coupons' | 'team';

function Dashboard({ user, onLogout, onOpenStore }: DashboardProps) {
  const [activeTab, setActiveTab] = useState<DashTab>('overview');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [productForm, setProductForm] = useState<ProductFormState>(defaultProductForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [productImage, setProductImage] = useState<File | null>(null);
  const [productImagePreview, setProductImagePreview] = useState<string | null>(null);
  const [staffEmail, setStaffEmail] = useState('');
  const [staffPassword, setStaffPassword] = useState('BestMart123!');
  const [staffRole, setStaffRole] = useState<UserRole>('editor');
  const [staffFullName, setStaffFullName] = useState('');
  const [staffPhone, setStaffPhone] = useState('');
  const [inventorySearch, setInventorySearch] = useState('');
  const [showBulkPanel, setShowBulkPanel] = useState(false);
  const [bulkRows, setBulkRows] = useState<BulkProductRow[]>([]);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(0);
  const [bulkResult, setBulkResult] = useState<{ done: number; failed: number; errors: string[] } | null>(null);
  const [showBulkImagePanel, setShowBulkImagePanel] = useState(false);
  const [bulkImageFiles, setBulkImageFiles] = useState<File[]>([]);
  const [bulkImageUploading, setBulkImageUploading] = useState(false);
  const [bulkImageResult, setBulkImageResult] = useState<BulkImageUploadResult | null>(null);
  const [bulkImageDragging, setBulkImageDragging] = useState(false);
  const [savingProduct, setSavingProduct] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null);
  const [statusChangingId, setStatusChangingId] = useState<string | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [savingCategoryId, setSavingCategoryId] = useState<number | null>(null);
  const [deletingCategoryId, setDeletingCategoryId] = useState<number | null>(null);
  const [togglingOfferId, setTogglingOfferId] = useState<string | null>(null);
  const [uploadingCategoryImageId, setUploadingCategoryImageId] = useState<number | null>(null);
  const [creatingUser, setCreatingUser] = useState(false);
  const [showProductEditor, setShowProductEditor] = useState(false);
  const [inlineCategoryName, setInlineCategoryName] = useState('');
  const [creatingInlineCategory, setCreatingInlineCategory] = useState(false);
  const [showInlineCategoryInput, setShowInlineCategoryInput] = useState(false);
  const [slowMovers, setSlowMovers] = useState<SlowMoverSuggestion[]>([]);
  const [slowMoversLoading, setSlowMoversLoading] = useState(false);
  const [dismissedSlowMovers, setDismissedSlowMovers] = useState<Set<string>>(new Set());
  const [slowMoversCollapsed, setSlowMoversCollapsed] = useState(false);
  const [salesReport, setSalesReport] = useState<SalesReport | null>(null);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesRange, setSalesRange] = useState<7 | 30 | 90>(30);
  const [freeDeliveryRupees, setFreeDeliveryRupees] = useState('');
  const [deliveryFeeRupees, setDeliveryFeeRupees] = useState('');
  const [savingDeliverySettings, setSavingDeliverySettings] = useState(false);
  const [historyStart, setHistoryStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  });
  const [historyEnd, setHistoryEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [historyStatus, setHistoryStatus] = useState<'all' | OrderStatus>('all');
  const [historySearch, setHistorySearch] = useState('');
  const [historySort, setHistorySort] = useState<'date_desc' | 'date_asc' | 'total_desc' | 'total_asc'>('date_desc');
  const [historyExpanded, setHistoryExpanded] = useState<string | null>(null);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [couponsLoading, setCouponsLoading] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState<Coupon | null>(null);
  const [showCouponForm, setShowCouponForm] = useState(false);
  const [couponForm, setCouponForm] = useState<{
    code: string;
    description: string;
    discountType: 'percent' | 'flat';
    discountValueRupees: string;
    maxDiscountRupees: string;
    minSubtotalRupees: string;
    maxUsesPerUser: string;
    maxTotalUses: string;
    isActive: boolean;
    validUntil: string;
  }>({
    code: '',
    description: '',
    discountType: 'percent',
    discountValueRupees: '10',
    maxDiscountRupees: '',
    minSubtotalRupees: '0',
    maxUsesPerUser: '1',
    maxTotalUses: '',
    isActive: true,
    validUntil: '',
  });
  const [savingCoupon, setSavingCoupon] = useState(false);
  const [inventoryCategoryFilter, setInventoryCategoryFilter] = useState<number | 'all'>('all');
  const [inventoryStatusFilter, setInventoryStatusFilter] = useState<'all' | 'active' | 'archived' | 'low_stock'>('all');
  const [inventorySort, setInventorySort] = useState<'default' | 'price_asc' | 'price_desc' | 'stock_asc' | 'stock_desc'>('default');
  const inventorySearchRef = useRef<HTMLInputElement>(null);
  const [offerSearch, setOfferSearch] = useState('');
  const offerSearchRef = useRef<HTMLInputElement>(null);
  const [riderDrafts, setRiderDrafts] = useState<Record<string, number | ''>>({});
  const [riders, setRiders] = useState<Rider[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [showInlineBrandInput, setShowInlineBrandInput] = useState(false);
  const [inlineBrandName, setInlineBrandName] = useState('');
  const [creatingInlineBrand, setCreatingInlineBrand] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [categoryImages, setCategoryImages] = useState<Record<number, File | null>>({});
  const [orderSearch, setOrderSearch] = useState('');
  const [orderFilter, setOrderFilter] = useState<'all' | 'active' | OrderStatus>('active');

  const [companyInfo, setCompanyInfo] = useState<CompanyInfo | null>(null);
  const [savingStoreLocation, setSavingStoreLocation] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [weatherSnap, setWeatherSnap] = useState<WeatherSnapshot | null>(null);
  const [riderLocations, setRiderLocations] = useState<Record<number, RiderLocation>>({});

  // Real-time WebSocket state
  const [toast, setToast] = useState<{ id: string; customerName: string; totalCents: number; distanceKm: number | null } | null>(null);
  const [newOrderIds, setNewOrderIds] = useState<Set<string>>(new Set());
  const [unseenCount, setUnseenCount] = useState(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canManageCatalog = user.role === 'admin' || user.role === 'editor';
  const canManageTeam = user.role === 'admin';

  // Wire WebSocket — new orders appear instantly, no reload needed
  useOrderSocket({
    onNewOrder: (order) => {
      playOrderAlert();
      // Append to order list (FIFO — oldest first)
      setOrders((prev) => [...prev, order]);
      setRiderDrafts((prev) => ({ ...prev, [order.publicId]: '' }));
      // Update summary counters
      setSummary((s) => s ? { ...s, totalOrders: s.totalOrders + 1 } : s);
      // Mark as new (for highlight)
      setNewOrderIds((prev) => new Set([...prev, order.publicId]));
      // Badge on tab when not already on orders tab
      setUnseenCount((c) => c + 1);
      // Compute distance from store
      let distanceKm: number | null = null;
      setCompanyInfo((info) => {
        if (
          info?.storeLatitude != null && info?.storeLongitude != null &&
          order.deliveryLatitude != null && order.deliveryLongitude != null
        ) {
          distanceKm = haversineKm(
            { lat: info.storeLatitude, lng: info.storeLongitude },
            { lat: order.deliveryLatitude, lng: order.deliveryLongitude }
          );
        }
        return info;
      });
      // Show toast
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      setToast({ id: order.publicId, customerName: order.customerName, totalCents: order.totalCents, distanceKm });
      toastTimerRef.current = setTimeout(() => setToast(null), 6000);
    },
    onOrderUpdated: (updated) => {
      setOrders((prev) =>
        prev.map((o) => (o.publicId === updated.publicId ? updated : o))
      );
    },
    onRiderLocation: (loc) => {
      setRiderLocations((prev) => ({ ...prev, [loc.riderId]: loc }));
    },
  });

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [summaryData, productData, orderData, teamData, categoryData, riderData, brandData] =
        await Promise.all([
          apiGetSummary(),
          apiGetProducts(true),
          apiListOrders(),
          canManageTeam ? apiListTeam() : Promise.resolve([]),
          apiListCategories(),
          canManageCatalog ? apiListRiders() : Promise.resolve([]),
          apiListBrands(),
        ]);
      setSummary(summaryData);
      setProducts(productData);
      setOrders(orderData);
      setTeam(teamData);
      setCategories(categoryData);
      setRiders(riderData);
      setBrands(brandData);
      setRiderDrafts(
        Object.fromEntries(
          orderData.map((order) => [order.publicId, order.assignedRiderUserId ?? ''] as const)
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [canManageTeam, canManageCatalog]);

  useEffect(() => {
    void loadDashboard();
    void apiGetCompanyPublic().then(setCompanyInfo).catch(() => {});
  }, [loadDashboard]);

  // Live clock — ticks every minute on the Overview tab.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Fetch local weather using the company store coords (admin-set).
  useEffect(() => {
    const lat = companyInfo?.storeLatitude;
    const lng = companyInfo?.storeLongitude;
    if (lat == null || lng == null) return;
    const controller = new AbortController();
    fetchOpenMeteoSnapshot(lat, lng, controller.signal).then((snap) => {
      if (snap) setWeatherSnap(snap);
    });
    return () => controller.abort();
  }, [companyInfo?.storeLatitude, companyInfo?.storeLongitude]);

  const loadSlowMovers = useCallback(async () => {
    if (!canManageCatalog) return;
    setSlowMoversLoading(true);
    try {
      const data = await apiListSlowMovers();
      setSlowMovers(data);
    } catch (err) {
      console.warn('Failed to load slow-mover suggestions', err);
    } finally {
      setSlowMoversLoading(false);
    }
  }, [canManageCatalog]);

  useEffect(() => {
    if ((activeTab === 'offers' || activeTab === 'overview') && canManageCatalog) {
      void loadSlowMovers();
    }
  }, [activeTab, canManageCatalog, loadSlowMovers, products.length]);

  const loadSalesReport = useCallback(async (days: 7 | 30 | 90) => {
    if (!canManageTeam) return;
    setSalesLoading(true);
    try {
      const data = await apiSalesReport(days);
      setSalesReport(data);
    } catch (err) {
      console.warn('Failed to load sales report', err);
    } finally {
      setSalesLoading(false);
    }
  }, [canManageTeam]);

  useEffect(() => {
    if ((activeTab === 'sales' || activeTab === 'overview') && canManageTeam) {
      void loadSalesReport(salesRange);
    }
  }, [activeTab, canManageTeam, loadSalesReport, salesRange]);

  useEffect(() => {
    const s = companyInfo?.settings;
    if (!s) return;
    setFreeDeliveryRupees(String(s.freeDeliveryThresholdCents / 100));
    setDeliveryFeeRupees(String(s.deliveryFeeCents / 100));
  }, [companyInfo?.settings]);

  async function handleSaveDeliverySettings() {
    const threshold = Number(freeDeliveryRupees);
    const fee = Number(deliveryFeeRupees);
    if (!Number.isFinite(threshold) || threshold < 0) {
      setError('Free delivery threshold must be a non-negative number.');
      return;
    }
    if (!Number.isFinite(fee) || fee < 0) {
      setError('Delivery fee must be a non-negative number.');
      return;
    }
    setSavingDeliverySettings(true);
    try {
      await apiUpdateAppSettings({
        freeDeliveryThresholdCents: Math.round(threshold * 100),
        deliveryFeeCents: Math.round(fee * 100),
      });
      const updated = await apiGetCompanyPublic();
      setCompanyInfo(updated);
      setNotice('Delivery settings updated.');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setSavingDeliverySettings(false);
    }
  }

  useEffect(() => {
    const handler = () => {
      unlockAudio();
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
    };
    window.addEventListener('pointerdown', handler);
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA' &&
        document.activeElement?.tagName !== 'SELECT'
      ) {
        if (activeTab === 'inventory') { e.preventDefault(); inventorySearchRef.current?.focus(); }
        if (activeTab === 'offers') { e.preventDefault(); offerSearchRef.current?.focus(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTab]);

  const filteredOffers = useMemo(() => {
    const term = offerSearch.trim();
    const onOffer = products.filter((p) => p.isOnOffer);
    const notOnOffer = products.filter((p) => !p.isOnOffer);
    if (!term) return { onOffer, notOnOffer };
    const rank = (list: typeof products) =>
      fuzzyRank(term, list, (p) => [p.name, p.category, p.unitLabel, p.badge]);
    return { onOffer: rank(onOffer), notOnOffer: rank(notOnOffer) };
  }, [products, offerSearch]);

  const orderCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: orders.length,
      active: 0,
      placed: 0,
      confirmed: 0,
      packing: 0,
      out_for_delivery: 0,
      delivered: 0,
      cancelled: 0,
    };
    for (const order of orders) {
      counts[order.status] = (counts[order.status] ?? 0) + 1;
      if (order.status !== 'delivered' && order.status !== 'cancelled') {
        counts.active += 1;
      }
    }
    return counts;
  }, [orders]);

  const filteredOrders = useMemo(() => {
    const term = orderSearch.trim().toLowerCase();
    return orders.filter((order) => {
      const matchesFilter =
        orderFilter === 'all'
          ? true
          : orderFilter === 'active'
            ? order.status !== 'delivered' && order.status !== 'cancelled'
            : order.status === orderFilter;
      if (!matchesFilter) return false;
      if (!term) return true;
      return (
        order.publicId.toLowerCase().includes(term) ||
        order.customerName.toLowerCase().includes(term) ||
        order.customerPhone.toLowerCase().includes(term) ||
        (order.customerEmail ?? '').toLowerCase().includes(term) ||
        (order.assignedRider ?? '').toLowerCase().includes(term)
      );
    });
  }, [orders, orderFilter, orderSearch]);

  const filteredProducts = useMemo(() => {
    let result = products;

    if (inventoryStatusFilter === 'active') result = result.filter((p) => p.isActive);
    else if (inventoryStatusFilter === 'archived') result = result.filter((p) => !p.isActive);
    else if (inventoryStatusFilter === 'low_stock') result = result.filter((p) => p.stockQuantity <= 5);

    if (inventoryCategoryFilter !== 'all') {
      result = result.filter((p) => p.categoryId === inventoryCategoryFilter);
    }

    const term = inventorySearch.trim();
    if (term) {
      result = fuzzyRank(term, result, (p) => [p.name, p.category, p.description, p.badge, p.unitLabel]);
    } else if (inventorySort !== 'default') {
      result = [...result].sort((a, b) => {
        if (inventorySort === 'price_asc') return a.priceCents - b.priceCents;
        if (inventorySort === 'price_desc') return b.priceCents - a.priceCents;
        if (inventorySort === 'stock_asc') return a.stockQuantity - b.stockQuantity;
        if (inventorySort === 'stock_desc') return b.stockQuantity - a.stockQuantity;
        return 0;
      });
    }

    return result;
  }, [products, inventorySearch, inventoryCategoryFilter, inventoryStatusFilter, inventorySort]);

  function resetProductEditor() {
    setEditingId(null);
    setProductForm(defaultProductForm);
    setProductImage(null);
    setProductImagePreview(null);
    setShowInlineCategoryInput(false);
    setInlineCategoryName('');
    setShowInlineBrandInput(false);
    setInlineBrandName('');
  }

  function closeProductEditor() {
    setShowProductEditor(false);
    resetProductEditor();
  }

  function openNewProductEditor() {
    resetProductEditor();
    setShowProductEditor(true);
  }

  async function handleCreateCategoryInline() {
    const name = inlineCategoryName.trim();
    if (!name) return;
    setCreatingInlineCategory(true);
    try {
      const created = await apiCreateCategory(name);
      setCategories((prev) => [...prev, created]);
      setProductForm((c) => ({ ...c, categoryId: String(created.id) }));
      setInlineCategoryName('');
      setShowInlineCategoryInput(false);
      setNotice(`Category "${name}" created.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create category');
    } finally {
      setCreatingInlineCategory(false);
    }
  }

  async function handleCreateBrandInline() {
    const name = inlineBrandName.trim();
    if (!name) return;
    setCreatingInlineBrand(true);
    try {
      const created = await apiCreateBrand(name);
      setBrands((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setProductForm((c) => ({ ...c, brandId: String(created.id) }));
      setInlineBrandName('');
      setShowInlineBrandInput(false);
      setNotice(`Brand "${name}" created.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create brand');
    } finally {
      setCreatingInlineBrand(false);
    }
  }

  function toggleOrder(publicId: string) {
    setExpandedOrderId((current) => (current === publicId ? null : publicId));
  }

  async function handleSaveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageCatalog) return;
    setNotice('');
    setError('');
    setSavingProduct(true);
    try {
      if (!productForm.categoryId) {
        setError('Please select a category.');
        return;
      }
      const payload = {
        name: productForm.name,
        categoryId: Number(productForm.categoryId),
        brandId: productForm.brandId ? Number(productForm.brandId) : null,
        unitLabel: productForm.unitLabel,
        description: productForm.description,
        priceCents: Math.round(Number(productForm.price) * 100),
        originalPriceCents: productForm.originalPrice
          ? Math.round(Number(productForm.originalPrice) * 100)
          : null,
        stockQuantity: Number(productForm.stockQuantity),
        badge: productForm.badge || null,
        imageUrl: productForm.imageUrl || null,
        isActive: productForm.isActive,
      };
      const savedProduct = await withBusy(
        editingId ? 'Saving product…' : 'Creating product…',
        async () => {
          const result = editingId
            ? await apiUpdateProduct(editingId, payload)
            : await apiAddProduct(payload);
          if (productImage) {
            await apiUploadProductImage(result.uniqueId, productImage);
          }
          return result;
        },
      );
      void savedProduct;
      setNotice(editingId ? 'Product updated.' : 'Product created.');
      closeProductEditor();
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save product');
    } finally {
      setSavingProduct(false);
    }
  }

  async function handleArchive(uniqueId: string) {
    setArchivingId(uniqueId);
    try {
      await apiDeleteProduct(uniqueId);
      setNotice('Product archived.');
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to archive product');
    } finally {
      setArchivingId(null);
    }
  }

  async function handleAdminCancel(publicId: string) {
    const confirmed = await confirm({
      title: 'Cancel this order?',
      message: `Order ${publicId} will be marked cancelled. The customer will see the cancellation on their tracking page.`,
      confirmLabel: 'Cancel Order',
      cancelLabel: 'Keep Order',
      tone: 'danger',
    });
    if (!confirmed) return;
    setCancellingOrderId(publicId);
    try {
      await apiUpdateOrderStatus(publicId, 'cancelled', riderDrafts[publicId] || null);
      setNotice(`Order ${publicId} cancelled. Customer has been notified.`);
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to cancel order');
    } finally {
      setCancellingOrderId(null);
    }
  }

  async function handleAssignRider(publicId: string, status: OrderStatus, riderUserId: number | null) {
    setAssigningOrderId(publicId);
    try {
      await apiUpdateOrderStatus(publicId, status, riderUserId);
      setNotice(
        riderUserId
          ? `Rider assigned to ${publicId}.`
          : `Rider cleared on ${publicId}.`,
      );
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to assign rider');
    } finally {
      setAssigningOrderId(null);
    }
  }

  async function handleStatusChange(publicId: string, status: OrderStatus) {
    let riderIdForUpdate: number | null = riderDrafts[publicId] || null;

    if (status === 'out_for_delivery') {
      if (riders.length === 0) {
        setError('No riders available. Add a team member with role "rider" first.');
        return;
      }

      // Riders currently delivering another order are unavailable.
      const busyRiderIds = new Set(
        orders
          .filter(
            (o) =>
              o.publicId !== publicId &&
              o.status === 'out_for_delivery' &&
              o.assignedRiderUserId != null,
          )
          .map((o) => o.assignedRiderUserId as number),
      );
      const availableRiders = riders.filter((r) => !busyRiderIds.has(r.id));

      if (availableRiders.length === 0) {
        setError('All riders are currently delivering. Wait until one is free.');
        return;
      }

      const order = orders.find((o) => o.publicId === publicId);
      const currentRiderId =
        riderIdForUpdate ?? order?.assignedRiderUserId ?? null;
      const chosen = await pickRider({
        title: `Dispatch order ${publicId}`,
        message: 'Select an available rider who will deliver this order.',
        confirmLabel: 'Dispatch',
        cancelLabel: 'Cancel',
        initialRiderId:
          currentRiderId != null && !busyRiderIds.has(currentRiderId)
            ? currentRiderId
            : null,
        riders: availableRiders.map((r) => ({
          id: r.id,
          label: r.fullName || r.email,
          sublabel: r.phone || undefined,
        })),
      });
      if (chosen == null) return;
      riderIdForUpdate = chosen;
      setRiderDrafts((c) => ({ ...c, [publicId]: chosen }));
    }

    setStatusChangingId(publicId);
    try {
      await apiUpdateOrderStatus(publicId, status, riderIdForUpdate);
      setNotice(`Order ${publicId} updated.`);
      await loadDashboard();
      if (status === 'out_for_delivery') {
        const nextOrder = orders.find(
          (o) =>
            o.publicId !== publicId &&
            o.status !== 'delivered' &&
            o.status !== 'cancelled' &&
            o.status !== 'out_for_delivery',
        );
        setExpandedOrderId(nextOrder ? nextOrder.publicId : null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update order');
    } finally {
      setStatusChangingId(null);
    }
  }

  async function handleCreateCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageCatalog) return;
    const name = newCategoryName.trim();
    if (!name) return;
    setCreatingCategory(true);
    try {
      await apiCreateCategory(name);
      setNotice(`Category "${name}" created.`);
      setNewCategoryName('');
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create category');
    } finally {
      setCreatingCategory(false);
    }
  }

  async function handleSaveCategoryName(id: number) {
    const name = editingCategoryName.trim();
    if (!name) return;
    setSavingCategoryId(id);
    try {
      await apiUpdateCategory(id, name);
      setNotice('Category updated.');
      setEditingCategoryId(null);
      setEditingCategoryName('');
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update category');
    } finally {
      setSavingCategoryId(null);
    }
  }

  async function handleDeleteCategory(category: Category) {
    const inCategory = products.filter((p) => p.categoryId === category.id);
    const preview = inCategory.slice(0, 5).map((p) => `• ${p.name}`).join('\n');
    const more = inCategory.length > 5 ? `\n…and ${inCategory.length - 5} more` : '';
    const productsLine =
      inCategory.length > 0
        ? `This will also REMOVE ${inCategory.length} product(s) under this category:\n${preview}${more}\n\n(Products that appear on past orders will be archived instead of deleted so order history stays intact.)\n\n`
        : '';

    const confirmed = await confirm({
      title: `Delete category "${category.name}"?`,
      message: `${productsLine}This action cannot be undone.`,
      confirmLabel: 'Delete Category',
      cancelLabel: 'Keep Category',
      tone: 'danger',
    });
    if (!confirmed) return;

    setDeletingCategoryId(category.id);
    try {
      const result = await apiDeleteCategory(category.id);
      const parts: string[] = [`Category "${category.name}" deleted.`];
      if (result.productsDeleted) parts.push(`${result.productsDeleted} product(s) deleted.`);
      if (result.productsArchived) parts.push(`${result.productsArchived} archived.`);
      setNotice(parts.join(' '));
      setError('');
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete category');
    } finally {
      setDeletingCategoryId(null);
    }
  }

  async function handleToggleOffer(
    product: Product,
    isOnOffer: boolean,
    offerPriceCents: number | null = null,
    offerType: 'price' | 'bogo' = 'price',
    bogoBuyQty: number = 1,
    bogoGetQty: number = 1,
  ) {
    if (isOnOffer && offerType === 'price') {
      if (offerPriceCents == null || !Number.isFinite(offerPriceCents) || offerPriceCents < 0) {
        setError('Enter a valid offer price in rupees.');
        return;
      }
      if (offerPriceCents >= product.priceCents) {
        setError('Offer price must be lower than the current price.');
        return;
      }
    }
    if (isOnOffer && offerType === 'bogo') {
      if (!Number.isInteger(bogoBuyQty) || bogoBuyQty < 1 || !Number.isInteger(bogoGetQty) || bogoGetQty < 1) {
        setError('Buy and Get quantities must be positive integers.');
        return;
      }
    }
    setTogglingOfferId(product.uniqueId);
    try {
      const updated = await apiToggleProductOffer(
        product.uniqueId,
        isOnOffer,
        isOnOffer && offerType === 'price' ? offerPriceCents : null,
        offerType,
        bogoBuyQty,
        bogoGetQty,
      );
      setProducts((prev) => prev.map((p) => (p.uniqueId === product.uniqueId ? updated : p)));
      setNotice(
        !isOnOffer
          ? `"${product.name}" removed from Today's Offers.`
          : offerType === 'bogo'
            ? `"${product.name}" set to Buy ${bogoBuyQty} Get ${bogoGetQty} Free.`
            : `"${product.name}" on offer at ${formatCurrency(offerPriceCents ?? 0)}.`,
      );
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update offer');
    } finally {
      setTogglingOfferId(null);
    }
  }

  const [offerPriceDrafts, setOfferPriceDrafts] = useState<Record<string, string>>({});
  const [switchingToPrice, setSwitchingToPrice] = useState<Set<string>>(new Set());
  // BOGO draft editor state: per-product { buy, get } strings so admins can edit freely.
  const [bogoDrafts, setBogoDrafts] = useState<Record<string, { buy: string; get: string }>>({});
  const [editingBogoFor, setEditingBogoFor] = useState<string | null>(null);

  function setBogoDraft(uniqueId: string, patch: Partial<{ buy: string; get: string }>) {
    setBogoDrafts((c) => ({
      ...c,
      [uniqueId]: { buy: c[uniqueId]?.buy ?? '1', get: c[uniqueId]?.get ?? '1', ...patch },
    }));
  }
  function openBogoEditor(product: Product) {
    setBogoDraft(product.uniqueId, {
      buy: String(product.bogoBuyQty ?? 1),
      get: String(product.bogoGetQty ?? 1),
    });
    setEditingBogoFor(product.uniqueId);
  }
  async function applyBogo(product: Product) {
    const draft = bogoDrafts[product.uniqueId] ?? { buy: '1', get: '1' };
    const buy = Math.round(Number(draft.buy));
    const get = Math.round(Number(draft.get));
    if (!Number.isInteger(buy) || buy < 1 || !Number.isInteger(get) || get < 1) {
      setError('Buy and Get quantities must be positive integers.');
      return;
    }
    await handleToggleOffer(product, true, null, 'bogo', buy, get);
    setEditingBogoFor(null);
  }

  function setOfferPriceDraft(uniqueId: string, value: string) {
    setOfferPriceDrafts((c) => ({ ...c, [uniqueId]: value }));
  }

  async function handleUploadCategoryImage(id: number) {
    const file = categoryImages[id];
    if (!file) return;
    setUploadingCategoryImageId(id);
    try {
      await apiUploadCategoryImage(id, file);
      setNotice('Category image uploaded.');
      setCategoryImages((c) => ({ ...c, [id]: null }));
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to upload image');
    } finally {
      setUploadingCategoryImageId(null);
    }
  }

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageTeam) return;
    setCreatingUser(true);
    try {
      await apiCreateUser(staffEmail, staffPassword, staffRole, {
        fullName: staffFullName.trim() || undefined,
        phone: staffPhone.trim() || undefined,
      });
      setNotice('Team member created.');
      setStaffEmail('');
      setStaffPassword('BestMart123!');
      setStaffRole('editor');
      setStaffFullName('');
      setStaffPhone('');
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create user');
    } finally {
      setCreatingUser(false);
    }
  }

  // ── Bulk image upload helpers ────────────────────────────────────────────

  function handleBulkImageFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'));
    setBulkImageFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...arr.filter((f) => !existing.has(f.name))];
    });
    setBulkImageResult(null);
  }

  async function handleBulkImageUpload() {
    if (bulkImageFiles.length === 0) return;
    setBulkImageUploading(true);
    setBulkImageResult(null);
    try {
      const result = await apiBulkUploadProductImages(bulkImageFiles);
      setBulkImageResult(result);
      if (result.matched > 0) await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk image upload failed');
    } finally {
      setBulkImageUploading(false);
    }
  }

  // ── Bulk import helpers ──────────────────────────────────────────────────

  async function downloadBulkTemplate() {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Inventory');

    const headers = ['name', 'category', 'unitLabel', 'description', 'price', 'originalPrice', 'stockQuantity', 'badge'];
    ws.addRow(headers);

    // Header styling
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F7F5' } };
      cell.alignment = { vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFB0B8C4' } } };
    });

    // Column widths
    ws.columns = [
      { width: 28 }, // name
      { width: 22 }, // category
      { width: 16 }, // unitLabel
      { width: 42 }, // description
      { width: 10 }, // price
      { width: 14 }, // originalPrice
      { width: 14 }, // stockQuantity
      { width: 14 }, // badge
    ];

    // Dropdown for category — rows 2 to 1000
    const categoryNames = categories.map((c) => c.name);
    const listFormula = `"${categoryNames.join(',')}"`;
    for (let r = 2; r <= 1000; r++) {
      ws.getCell(`B${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [listFormula],
        showErrorMessage: true,
        errorStyle: 'error',
        errorTitle: 'Invalid category',
        error: 'Pick a category from the dropdown list.',
      };
    }

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bestmart-inventory-template.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  }

  function parseCSV(text: string): string[][] {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
    const lines = normalized.split('\n').filter((l) => l.trim());
    return lines.map((line) => {
      const cells: string[] = [];
      let cell = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { cell += '"'; i++; }
          else inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
          cells.push(cell.trim());
          cell = '';
        } else {
          cell += ch;
        }
      }
      cells.push(cell.trim());
      return cells;
    });
  }

  function buildParsedRows(allRows: string[][]): BulkProductRow[] {
    const dataRows = allRows.filter((r) => !(r[0] ?? '').startsWith('#'));
    if (dataRows.length < 2) return [];
    const [headerRow, ...bodyRows] = dataRows;
    const col = (name: string) => headerRow.findIndex((h) => h.toLowerCase().trim() === name.toLowerCase());
    const iName = col('name'), iCat = col('category'), iUnit = col('unitlabel'),
      iDesc = col('description'), iPrice = col('price'), iOriginal = col('originalprice'),
      iStock = col('stockquantity'), iBadge = col('badge');

    if ([iName, iCat, iUnit, iDesc, iPrice, iStock].some((i) => i === -1)) {
      setError('File is missing required columns. Please download and use the latest template.');
      return [];
    }

    return bodyRows.map((row, idx) => {
      const errs: string[] = [];
      const name = (row[iName] ?? '').trim();
      const categoryName = (row[iCat] ?? '').trim();
      const unitLabel = (row[iUnit] ?? '').trim();
      const description = (row[iDesc] ?? '').trim();
      const priceRaw = parseFloat(row[iPrice] ?? '');
      const originalRaw = row[iOriginal] ? parseFloat(row[iOriginal]) : null;
      const stockRaw = parseInt(row[iStock] ?? '', 10);
      const badge = (row[iBadge] ?? '').trim() || null;

      if (!name) errs.push('Name is required');
      if (!categoryName) errs.push('Category is required');
      if (!unitLabel) errs.push('Unit label is required');
      if (!description) errs.push('Description is required');
      if (!Number.isFinite(priceRaw) || priceRaw < 0) errs.push('Price must be a positive number');
      if (originalRaw !== null && (!Number.isFinite(originalRaw) || originalRaw < 0)) errs.push('Original price must be a positive number');
      if (!Number.isFinite(stockRaw) || stockRaw < 0) errs.push('Stock quantity must be a non-negative integer');

      const matchedCat = categories.find((c) => c.name.toLowerCase() === categoryName.toLowerCase());
      if (categoryName && !matchedCat) errs.push(`Category "${categoryName}" not found`);

      return {
        rowNum: idx + 2,
        name,
        categoryName,
        categoryId: matchedCat?.id ?? null,
        unitLabel,
        description,
        priceCents: Math.round((priceRaw || 0) * 100),
        originalPriceCents: originalRaw !== null ? Math.round(originalRaw * 100) : null,
        stockQuantity: stockRaw || 0,
        badge,
        imageUrl: null,
        isActive: true,
        errors: errs,
      };
    }).filter((r) => r.name || r.categoryName || r.unitLabel);
  }

  async function handleBulkFile(file: File) {
    setBulkResult(null);
    try {
      const isXlsx = /\.xlsx$/i.test(file.name) || file.type.includes('spreadsheet');
      let allRows: string[][] = [];

      if (isXlsx) {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await file.arrayBuffer());
        const ws = wb.worksheets[0];
        if (!ws) {
          setError('Excel file has no worksheets.');
          return;
        }
        ws.eachRow({ includeEmpty: false }, (row) => {
          const cells: string[] = [];
          const rowValues = row.values as Array<unknown>;
          for (let i = 1; i < rowValues.length; i++) {
            const v = rowValues[i];
            if (v == null) cells.push('');
            else if (typeof v === 'object' && v !== null && 'text' in v) cells.push(String((v as { text: string }).text ?? ''));
            else if (typeof v === 'object' && v !== null && 'result' in v) cells.push(String((v as { result: unknown }).result ?? ''));
            else cells.push(String(v));
          }
          allRows.push(cells);
        });
      } else {
        const text = await file.text();
        allRows = parseCSV(text);
      }

      const parsed = buildParsedRows(allRows);
      if (parsed.length === 0) {
        setError('No data rows found. Download the template and fill it in.');
        return;
      }
      setBulkRows(parsed);
    } catch (err) {
      setError(err instanceof Error ? `Could not read file: ${err.message}` : 'Could not read file');
    }
  }

  async function handleBulkImport() {
    const valid = bulkRows.filter((r) => r.errors.length === 0);
    if (valid.length === 0) return;
    setBulkImporting(true);
    setBulkProgress(0);
    const errors: string[] = [];
    let done = 0;
    await withBusy(`Importing ${valid.length} products…`, async () => {
      for (const row of valid) {
        try {
          await apiAddProduct({
            name: row.name,
            categoryId: row.categoryId!,
            unitLabel: row.unitLabel,
            description: row.description,
            priceCents: row.priceCents,
            originalPriceCents: row.originalPriceCents,
            stockQuantity: row.stockQuantity,
            badge: row.badge,
            imageUrl: row.imageUrl,
            isActive: row.isActive,
          });
          done++;
        } catch (err) {
          errors.push(`Row ${row.rowNum} (${row.name}): ${err instanceof Error ? err.message : 'Failed'}`);
        }
        setBulkProgress(Math.round(((done + errors.length) / valid.length) * 100));
      }
    });
    setBulkResult({ done, failed: errors.length, errors });
    setBulkImporting(false);
    setBulkRows([]);
    await loadDashboard();
  }

  const tabs: Array<{ key: DashTab; label: string; badge?: number }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'orders', label: orders.length > 0 ? `Orders (${orders.length})` : 'Orders', badge: unseenCount },
    ...(canManageCatalog ? [{ key: 'history' as DashTab, label: 'History' }] : []),
    ...(canManageTeam ? [{ key: 'sales' as DashTab, label: 'Sales' }] : []),
    { key: 'inventory', label: 'Inventory' },
    ...(canManageCatalog ? [{ key: 'categories' as DashTab, label: 'Categories' }] : []),
    ...(canManageCatalog ? [{ key: 'offers' as DashTab, label: "Today's Offers" }] : []),
    ...(canManageTeam ? [{ key: 'coupons' as DashTab, label: 'Coupons' }] : []),
    ...(canManageTeam ? [{ key: 'team' as DashTab, label: 'Team' }] : []),
  ];

  function handleTabClick(key: DashTab) {
    setActiveTab(key);
    if (key === 'orders') {
      setUnseenCount(0);
      // Remove highlight from all new orders after a brief moment
      setTimeout(() => setNewOrderIds(new Set()), 8000);
    }
  }

  return (
    <div className="dash-root">
      {/* ── Sticky Navbar ── */}
      <header className="dash-nav">
        <div className="dash-nav__brand">
          <img src="/bestmart-logo.svg" alt="BestMart" className="dash-nav__logo" loading="lazy" />
        </div>

        <nav className="dash-nav__tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`dash-tab${activeTab === tab.key ? ' dash-tab--active' : ''}`}
              onClick={() => handleTabClick(tab.key)}
            >
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className="tab-badge">{tab.badge}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="dash-nav__end">
          <span className={`role-badge role-badge--${user.role}`}>{user.role}</span>
          <span className="dash-nav__email">{user.email}</span>

          <button type="button" className="dash-nav__btn" onClick={onOpenStore}>
            Storefront
          </button>
          <button type="button" className="dash-nav__btn dash-nav__btn--accent" onClick={onLogout}>
            Log Out
          </button>
        </div>
      </header>

      {/* ── Messages ── */}
      {(loading || error || notice) && (
        <div className="dash-messages">
          {loading && <div className="message">Loading operations data…</div>}
          {error && <div className="message message--error">{error}</div>}
          {notice && <div className="message message--success">{notice}</div>}
        </div>
      )}

      {/* ── Page Content ── */}
      <main className="dash-content">
        {activeTab === 'overview' && renderOverview()}
        {activeTab === 'orders' && renderOrders()}
        {activeTab === 'history' && renderHistory()}
        {activeTab === 'sales' && renderSales()}
        {activeTab === 'inventory' && renderInventory()}
        {activeTab === 'categories' && renderCategories()}
        {activeTab === 'offers' && renderOffers()}
        {activeTab === 'coupons' && renderCoupons()}
        {activeTab === 'team' && renderTeam()}
      </main>

      {/* ── New Order Toast ── */}
      {toast && (
        <div className="order-toast" role="alert">
          <div className="order-toast__header">
            <span className="order-toast__dot" />
            <span className="order-toast__label">New Order</span>
            <button
              type="button"
              className="order-toast__close"
              onClick={() => setToast(null)}
            >
              ✕
            </button>
          </div>
          <div className="order-toast__id">{toast.id}</div>
          <div className="order-toast__customer">{toast.customerName}</div>
          <div className="order-toast__amount">{formatCurrency(toast.totalCents)}</div>
          {toast.distanceKm != null && (
            <div className="order-toast__distance">
              📍 {toast.distanceKm < 1
                ? `${Math.round(toast.distanceKm * 1000)} m from store`
                : `${toast.distanceKm.toFixed(1)} km from store`}
            </div>
          )}
          {toast.distanceKm == null && !companyInfo?.storeLatitude && (
            <div className="order-toast__distance order-toast__distance--hint">
              Set store location to see distance
            </div>
          )}
          <button
            type="button"
            className="order-toast__cta"
            onClick={() => { handleTabClick('orders'); setToast(null); }}
          >
            View in queue →
          </button>
        </div>
      )}
    </div>
  );

  /* ────────────────────────────────────────
     OVERVIEW
  ──────────────────────────────────────── */
  function renderOverview() {
    const totalProducts = products.length;
    const activeProducts = products.filter((p) => p.isActive).length;
    const archivedProducts = totalProducts - activeProducts;
    const outOfStock = products.filter((p) => p.isActive && p.stockQuantity <= 0).length;
    const lowStock = products.filter((p) => p.isActive && p.stockQuantity > 0 && p.stockQuantity <= 5).length;
    const onOfferCount = products.filter((p) => p.isActive && p.isOnOffer).length;
    const totalUnits = products
      .filter((p) => p.isActive)
      .reduce((sum, p) => sum + (p.stockQuantity ?? 0), 0);
    const inventoryValueCents = products
      .filter((p) => p.isActive)
      .reduce((sum, p) => sum + (p.priceCents ?? 0) * (p.stockQuantity ?? 0), 0);
    const lowStockList = products
      .filter((p) => p.isActive && p.stockQuantity <= 5)
      .sort((a, b) => a.stockQuantity - b.stockQuantity)
      .slice(0, 3);

    const weatherInfo = weatherSnap ? describeWeatherCode(weatherSnap.weatherCode) : null;
    const dayLabel = now.toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const timeLabel = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    return (
      <>
        {/* Live tile: time + weather + quick inventory snapshot */}
        <div className="live-tile">
          <div className="live-tile__time">
            <span className="live-tile__time-day">{dayLabel}</span>
            <strong className="live-tile__time-clock">{timeLabel}</strong>
            <span className="live-tile__time-greet">
              {(() => {
                const h = now.getHours();
                if (h < 5) return 'Late night shift';
                if (h < 12) return 'Good morning';
                if (h < 17) return 'Good afternoon';
                if (h < 21) return 'Good evening';
                return 'Closing in';
              })()}
              {user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}
            </span>
          </div>

          <div className="live-tile__weather">
            {weatherSnap && weatherInfo ? (
              <>
                <span className="live-tile__weather-emoji" aria-hidden>{weatherInfo.emoji}</span>
                <div>
                  <strong className="live-tile__weather-temp">
                    {Math.round(weatherSnap.temperatureC)}°C
                  </strong>
                  <span className="live-tile__weather-label">{weatherInfo.label}</span>
                </div>
              </>
            ) : (
              <div className="live-tile__weather-empty">
                <span aria-hidden>🌡️</span>
                <span>
                  {companyInfo?.storeLatitude == null
                    ? 'Set the store location below to see local weather.'
                    : 'Loading weather…'}
                </span>
              </div>
            )}
          </div>

          <div className="live-tile__metric">
            <span className="live-tile__metric-label">Products in catalog</span>
            <strong className="live-tile__metric-value">{totalProducts}</strong>
            <span className="live-tile__metric-sub">{activeProducts} live · {archivedProducts} archived</span>
          </div>

          <div className="live-tile__metric">
            <span className="live-tile__metric-label">Stock on shelf</span>
            <strong className="live-tile__metric-value">{totalUnits.toLocaleString()}</strong>
            <span className="live-tile__metric-sub">units across {activeProducts} live SKUs</span>
          </div>

          <div className="live-tile__metric">
            <span className="live-tile__metric-label">Inventory value</span>
            <strong className="live-tile__metric-value">{formatCurrency(inventoryValueCents)}</strong>
            <span className="live-tile__metric-sub">at current sell prices</span>
          </div>
        </div>

        {/* Inventory snapshot */}
        <div className="section-box">
          <div className="section-box__head">
            <div>
              <h2>Inventory snapshot</h2>
              <p>Live counts pulled from your active catalog.</p>
            </div>
            <button type="button" className="ghost-button" onClick={() => setActiveTab('inventory')}>
              Manage inventory →
            </button>
          </div>
          <div className="inv-snapshot">
            <button
              type="button"
              className="inv-snapshot__cell"
              onClick={() => { setActiveTab('inventory'); setInventoryStatusFilter('active'); }}
            >
              <span className="inv-snapshot__label">Live</span>
              <strong className="inv-snapshot__value">{activeProducts}</strong>
            </button>
            <button
              type="button"
              className={`inv-snapshot__cell${lowStock > 0 ? ' inv-snapshot__cell--warn' : ''}`}
              onClick={() => { setActiveTab('inventory'); setInventoryStatusFilter('low_stock'); }}
            >
              <span className="inv-snapshot__label">Low stock</span>
              <strong className="inv-snapshot__value">{lowStock}</strong>
            </button>
            <button
              type="button"
              className={`inv-snapshot__cell${outOfStock > 0 ? ' inv-snapshot__cell--danger' : ''}`}
              onClick={() => { setActiveTab('inventory'); setInventoryStatusFilter('low_stock'); }}
            >
              <span className="inv-snapshot__label">Out of stock</span>
              <strong className="inv-snapshot__value">{outOfStock}</strong>
            </button>
            <button
              type="button"
              className="inv-snapshot__cell"
              onClick={() => { if (canManageCatalog) setActiveTab('offers'); }}
            >
              <span className="inv-snapshot__label">On offer</span>
              <strong className="inv-snapshot__value">{onOfferCount}</strong>
            </button>
            <button
              type="button"
              className="inv-snapshot__cell"
              onClick={() => { setActiveTab('inventory'); setInventoryStatusFilter('archived'); }}
            >
              <span className="inv-snapshot__label">Archived</span>
              <strong className="inv-snapshot__value">{archivedProducts}</strong>
            </button>
            <button
              type="button"
              className="inv-snapshot__cell"
              onClick={() => { if (canManageCatalog) setActiveTab('categories'); }}
            >
              <span className="inv-snapshot__label">Categories</span>
              <strong className="inv-snapshot__value">{categories.length}</strong>
            </button>
          </div>

          {lowStockList.length > 0 && (
            <div className="inv-snapshot__list">
              <h3 className="inv-snapshot__list-title">Needs restock soon</h3>
              <ul>
                {lowStockList.map((p) => (
                  <li key={p.uniqueId}>
                    <span className="inv-snapshot__list-name">{p.name}</span>
                    <span className="inv-snapshot__list-meta">{p.unitLabel} · {p.category ?? 'Uncategorised'}</span>
                    <span className={`inv-snapshot__list-stock${p.stockQuantity <= 0 ? ' inv-snapshot__list-stock--out' : ''}`}>
                      {p.stockQuantity <= 0 ? 'Out of stock' : `${p.stockQuantity} left`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Lazy-mounted insight grid (two columns on desktop, one on mobile) */}
        <LazyMount placeholderHeight={400}>
          {(() => {
            const byCat = new Map<string, { name: string; valueCents: number; units: number; count: number }>();
            for (const p of products) {
              if (!p.isActive) continue;
              const key = p.category ?? 'Uncategorised';
              const entry = byCat.get(key) ?? { name: key, valueCents: 0, units: 0, count: 0 };
              entry.valueCents += (p.priceCents ?? 0) * (p.stockQuantity ?? 0);
              entry.units += p.stockQuantity ?? 0;
              entry.count += 1;
              byCat.set(key, entry);
            }
            const catRows = Array.from(byCat.values())
              .sort((a, b) => b.valueCents - a.valueCents)
              .slice(0, 5);
            const catMax = Math.max(1, ...catRows.map((r) => r.valueCents));

            const recent = [...products]
              .filter((p) => p.isActive)
              .sort((a, b) => new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime())
              .slice(0, 4);

            const topSellers = salesReport?.topProducts.slice(0, 5) ?? [];
            const sellersMax = Math.max(1, ...topSellers.map((x) => x.unitsSold));
            const attention = slowMovers.slice(0, 3);

            return (
              <div className="insight-grid">
                {/* Stock value by category */}
                <div className="section-box insight-card">
                  <div className="section-box__head">
                    <div>
                      <h2>Stock value by category</h2>
                      <p>Where your inventory rupees are sitting.</p>
                    </div>
                  </div>
                  {catRows.length === 0 ? (
                    <div className="empty-state">No active products yet.</div>
                  ) : (
                    <div className="cat-value-list">
                      {catRows.map((r) => (
                        <div key={r.name} className="cat-value-row">
                          <span className="cat-value-row__name">{r.name}</span>
                          <div className="cat-value-row__bar">
                            <div
                              className="cat-value-row__fill"
                              style={{ width: `${Math.round((r.valueCents / catMax) * 100)}%` }}
                            />
                          </div>
                          <span className="cat-value-row__value">{formatCurrency(r.valueCents)}</span>
                          <span className="cat-value-row__sub">{r.count} SKUs · {r.units.toLocaleString()} units</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Top sellers */}
                <div className="section-box insight-card">
                  <div className="section-box__head">
                    <div>
                      <h2>Top sellers · 30d</h2>
                      <p>Fastest-moving products.</p>
                    </div>
                    <button type="button" className="ghost-button" onClick={() => setActiveTab('sales')}>
                      Sales →
                    </button>
                  </div>
                  {topSellers.length > 0 ? (
                    <div className="best-sellers">
                      {topSellers.map((p, i) => (
                        <div key={`${p.uniqueId ?? 'anon'}-${i}`} className="best-seller">
                          <span className="best-seller__rank">#{i + 1}</span>
                          <div className="best-seller__main">
                            <span className="best-seller__name">{p.name}</span>
                            <div className="best-seller__bar">
                              <div
                                className="best-seller__fill"
                                style={{ width: `${Math.round((p.unitsSold / sellersMax) * 100)}%` }}
                              />
                            </div>
                          </div>
                          <div className="best-seller__stats">
                            <strong>{p.unitsSold.toLocaleString()}</strong>
                            <span>units</span>
                            <em>{formatCurrency(p.revenueCents)}</em>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">
                      {salesLoading ? 'Loading…' : 'No sales yet.'}
                    </div>
                  )}
                </div>

                {/* Needs attention */}
                {canManageCatalog && (
                  <div className="section-box insight-card">
                    <div className="section-box__head">
                      <div>
                        <h2>💡 Needs attention</h2>
                        <p>Slow movers — consider an offer.</p>
                      </div>
                      <button type="button" className="ghost-button" onClick={() => setActiveTab('offers')}>
                        Offers →
                      </button>
                    </div>
                    {attention.length > 0 ? (
                      <ul className="attention-list">
                        {attention.map((s) => (
                          <li key={s.uniqueId} className="attention-row">
                            <div className="attention-row__main">
                              <span className="attention-row__name">{s.name}</span>
                              <span className="attention-row__meta">{s.reasonLabel}</span>
                            </div>
                            <div className="attention-row__price">
                              <span className="attention-row__strike">{formatCurrency(s.priceCents)}</span>
                              <strong>{formatCurrency(s.suggestedOfferPriceCents)}</strong>
                              <em>−{s.suggestedDiscountPercent}%</em>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="empty-state">
                        {slowMoversLoading ? 'Analysing sales…' : 'Everything is selling well.'}
                      </div>
                    )}
                  </div>
                )}

                {/* Recently added */}
                <div className="section-box insight-card">
                  <div className="section-box__head">
                    <div>
                      <h2>Recently added</h2>
                      <p>The newest items in your catalog.</p>
                    </div>
                  </div>
                  {recent.length === 0 ? (
                    <div className="empty-state">No products yet.</div>
                  ) : (
                    <ul className="recent-products-compact">
                      {recent.map((p) => (
                        <li key={p.uniqueId}>
                          <div className="recent-products-compact__thumb">
                            {p.imageUrl && <img src={p.imageUrl} alt={p.name} loading="lazy" />}
                          </div>
                          <div className="recent-products-compact__body">
                            <strong>{p.name}</strong>
                            <span>{p.category ?? 'Uncategorised'}</span>
                          </div>
                          <div className="recent-products-compact__right">
                            <strong>{formatCurrency(p.priceCents)}</strong>
                            <span>{formatRelativeTime(p.createdDate)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          })()}
        </LazyMount>

        {/* Stat Cards */}
        <div className="stats-row">
          <div className="stat-card">
            <span className="stat-card__label">Total Orders</span>
            <strong className="stat-card__value">{summary?.totalOrders ?? '—'}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Revenue</span>
            <strong className="stat-card__value">
              {summary ? formatCurrency(summary.revenueCents) : '—'}
            </strong>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Active Deliveries</span>
            <strong className="stat-card__value">{summary?.activeDeliveries ?? '—'}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Low Stock Items</span>
            <strong
              className={`stat-card__value${summary && summary.lowStock > 0 ? ' stat-card__value--warn' : ''}`}
            >
              {summary?.lowStock ?? '—'}
            </strong>
          </div>
        </div>

        {/* Top Regions */}
        <div className="section-box">
          <div className="section-box__head">
            <div>
              <h2>Delivery Regions</h2>
              <p>Where your grocery orders are being delivered</p>
            </div>
          </div>
          <div className="region-bars">
            {summary?.topRegions.length ? (
              summary.topRegions.map((region) => (
                <div key={region.label} className="region-bar">
                  <span className="region-bar__label">{region.label}</span>
                  <div className="region-bar__track">
                    <div
                      className="region-bar__fill"
                      style={{
                        width: `${Math.round((region.count / Math.max(summary.totalOrders, 1)) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="region-bar__count">{region.count}</span>
                </div>
              ))
            ) : (
              <p className="empty-state">No region data yet. Orders will populate this section.</p>
            )}
          </div>
        </div>

        {/* Store Location */}
        {canManageTeam && (
          <div className="section-box">
            <div className="section-box__head">
              <div>
                <h2>Store Location</h2>
                <p>
                  {companyInfo?.storeLatitude != null
                    ? `Set — ${companyInfo.storeLatitude.toFixed(5)}, ${companyInfo.storeLongitude!.toFixed(5)}`
                    : 'Not set — used to show delivery distance on new orders'}
                </p>
              </div>
              <button
                type="button"
                className="ghost-button"
                disabled={savingStoreLocation}
                onClick={async () => {
                  if (!('geolocation' in navigator)) {
                    setNotice('Geolocation is not supported by this browser.');
                    return;
                  }
                  setSavingStoreLocation(true);
                  navigator.geolocation.getCurrentPosition(
                    async (pos) => {
                      try {
                        await apiSetStoreLocation(pos.coords.latitude, pos.coords.longitude);
                        const updated = await apiGetCompanyPublic();
                        setCompanyInfo(updated);
                        setNotice('Store location updated.');
                      } catch {
                        setNotice('Failed to save store location.');
                      } finally {
                        setSavingStoreLocation(false);
                      }
                    },
                    () => {
                      setNotice('Location permission denied.');
                      setSavingStoreLocation(false);
                    },
                    { enableHighAccuracy: true, timeout: 10000 }
                  );
                }}
              >
                {savingStoreLocation ? 'Detecting…' : companyInfo?.storeLatitude != null ? '📍 Update location' : '📍 Set current location'}
              </button>
            </div>
          </div>
        )}

        {/* Delivery Settings */}
        {canManageTeam && (
          <div className="section-box">
            <div className="section-box__head">
              <div>
                <h2>Delivery Settings</h2>
                <p>
                  Free delivery threshold and base delivery fee. Applied to every new order.
                </p>
              </div>
            </div>
            <div className="delivery-settings">
              <label className="delivery-settings__field">
                <span className="delivery-settings__label">Free delivery above (₹)</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={freeDeliveryRupees}
                  onChange={(e) => setFreeDeliveryRupees(e.target.value)}
                  placeholder="200"
                />
                <span className="delivery-settings__hint">
                  Orders at or above this subtotal ship free.
                </span>
              </label>
              <label className="delivery-settings__field">
                <span className="delivery-settings__label">Delivery fee (₹)</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={deliveryFeeRupees}
                  onChange={(e) => setDeliveryFeeRupees(e.target.value)}
                  placeholder="49"
                />
                <span className="delivery-settings__hint">
                  Charged on orders below the free threshold.
                </span>
              </label>
              <div className="delivery-settings__actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void handleSaveDeliverySettings()}
                  disabled={savingDeliverySettings}
                >
                  {savingDeliverySettings ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Recent Orders */}
        <div className="section-box">
          <div className="section-box__head">
            <div>
              <h2>Recent Orders</h2>
              <p>Latest {Math.min(orders.length, 5)} of {orders.length} total</p>
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setActiveTab('orders')}
            >
              View all →
            </button>
          </div>

          {orders.length === 0 ? (
            <p className="empty-state">No orders yet. They'll appear here after checkout.</p>
          ) : (
            orders.slice(0, 5).map((order) => (
              <div key={order.publicId} className="order-summary-row">
                <strong>{order.publicId}</strong>
                <span>{order.customerName}</span>
                <span>{formatCurrency(order.totalCents)}</span>
                <span className={`status-pill status-pill--${order.status}`}>
                  {labelizeStatus(order.status)}
                </span>
                <span>{formatDateTime(order.createdDate)}</span>
              </div>
            ))
          )}
        </div>
      </>
    );
  }

  /* ────────────────────────────────────────
     ORDERS
  ──────────────────────────────────────── */
  function renderOrders() {
    const FILTER_CHIPS: Array<{ key: typeof orderFilter; label: string }> = [
      { key: 'active', label: 'Active' },
      { key: 'placed', label: 'New' },
      { key: 'confirmed', label: 'Confirmed' },
      { key: 'packing', label: 'Packing' },
      { key: 'out_for_delivery', label: 'Out for Delivery' },
      { key: 'delivered', label: 'Delivered' },
      { key: 'cancelled', label: 'Cancelled' },
      { key: 'all', label: 'All' },
    ];

    const NEXT_STATUS: Partial<Record<OrderStatus, { next: OrderStatus; label: string }>> = {
      placed: { next: 'confirmed', label: 'Accept' },
      confirmed: { next: 'packing', label: 'Start Packing' },
      packing: { next: 'out_for_delivery', label: 'Dispatch' },
      out_for_delivery: { next: 'delivered', label: 'Mark Delivered' },
    };

    return (
      <div className="section-box">
        <div className="section-box__head">
          <div>
            <h2>Customer Orders</h2>
            <p>
              {orderCounts.active} active · {orderCounts.placed} waiting acceptance ·{' '}
              {orderCounts.out_for_delivery} on the way
            </p>
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={exportOrdersCsv}
            disabled={orders.length === 0}
            title="Export all orders to CSV"
          >
            ⬇ Export CSV
          </button>
        </div>

        <div className="order-toolbar">
          <input
            className="order-search"
            value={orderSearch}
            onChange={(e) => setOrderSearch(e.target.value)}
            placeholder="Search by order ID, name, phone, or rider…"
          />
          <div className="chip-row">
            {FILTER_CHIPS.map((chip) => {
              const count = orderCounts[chip.key] ?? 0;
              return (
                <button
                  type="button"
                  key={chip.key}
                  className={chip.key === orderFilter ? 'chip chip--active' : 'chip'}
                  onClick={() => setOrderFilter(chip.key)}
                >
                  {chip.label}
                  {count > 0 ? <span className="chip__count">{count}</span> : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="order-table">
          {filteredOrders.length === 0 ? (
            <p className="empty-state">
              {orders.length === 0
                ? "No orders yet. They'll appear here after customers checkout."
                : 'No orders match this filter.'}
            </p>
          ) : (
            filteredOrders.map((order) => {
              const nextAction = NEXT_STATUS[order.status];
              const orderDistanceKm =
                companyInfo?.storeLatitude != null &&
                companyInfo?.storeLongitude != null &&
                order.deliveryLatitude != null &&
                order.deliveryLongitude != null
                  ? haversineKm(
                      { lat: companyInfo.storeLatitude, lng: companyInfo.storeLongitude },
                      { lat: order.deliveryLatitude, lng: order.deliveryLongitude }
                    )
                  : null;
              return (
              <article
                key={order.publicId}
                className={`order-row${newOrderIds.has(order.publicId) ? ' order-row--new' : ''}`}
              >
                {/* ── Summary bar ── */}
                <div className={`order-row__bar${expandedOrderId === order.publicId ? ' order-row__bar--expanded' : ''}`}>
                  <button
                    type="button"
                    className="order-row__bar-main"
                    onClick={() => toggleOrder(order.publicId)}
                  >
                    <div className="order-row__id">{order.publicId}</div>
                    <div className="order-row__customer">
                      <span>{order.customerName}</span>
                      <span>{order.customerPhone}</span>
                    </div>
                    <span className="order-row__amount">{formatCurrency(order.totalCents)}</span>
                    <span className={`status-pill status-pill--${order.status}`}>
                      {labelizeStatus(order.status)}
                    </span>
                    <span className="order-row__date" title={formatDateTime(order.createdDate)}>
                      {formatRelativeTime(order.createdDate)}
                    </span>
                    <span className="order-row__chevron">
                      {expandedOrderId === order.publicId ? '▲' : '▼'}
                    </span>
                  </button>
                  {order.deliveryLatitude != null && order.deliveryLongitude != null ? (
                    <a
                      className="order-row__map"
                      href={`https://www.google.com/maps/search/?api=1&query=${order.deliveryLatitude},${order.deliveryLongitude}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="Open customer's shared location in Google Maps"
                    >
                      🗺 Map
                    </a>
                  ) : null}
                  {canManageCatalog && nextAction ? (
                    <div className="order-row__action-group" onClick={(e) => e.stopPropagation()}>
                      {orderDistanceKm != null && (
                        <span className="order-row__distance">
                          📍 {orderDistanceKm < 1
                            ? `${Math.round(orderDistanceKm * 1000)} m`
                            : `${orderDistanceKm.toFixed(1)} km`}
                        </span>
                      )}
                      <button
                        type="button"
                        className="order-row__advance"
                        onClick={() => handleStatusChange(order.publicId, nextAction.next)}
                        disabled={statusChangingId === order.publicId}
                      >
                        {statusChangingId === order.publicId ? 'Updating…' : nextAction.label}
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* ── Expanded detail ── */}
                {expandedOrderId === order.publicId && (
                  <div className="order-row__detail">
                    {/* Info blocks */}
                    <div className="order-detail-cols">
                      <div className="order-detail-block">
                        <h4>Customer</h4>
                        <strong>{order.customerName}</strong>
                        <p>{order.customerPhone}</p>
                        {order.customerEmail && <p>{order.customerEmail}</p>}
                      </div>
                      <div className="order-detail-block">
                        <h4>Delivery</h4>
                        <p>{order.deliveryAddress}</p>
                        <p>Slot: {order.deliverySlot ?? 'Express'}</p>
                        {order.deliveryNotes && <p>Note: {order.deliveryNotes}</p>}
                        {order.deliveryLatitude != null && order.deliveryLongitude != null ? (
                          <>
                            <p>
                              Live location:{' '}
                              <a
                                href={`https://www.google.com/maps/search/?api=1&query=${order.deliveryLatitude},${order.deliveryLongitude}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open in Google Maps
                              </a>
                            </p>
                            <iframe
                              className="order-map"
                              title={`Location for order ${order.publicId}`}
                              loading="lazy"
                              src={`https://www.openstreetmap.org/export/embed.html?bbox=${order.deliveryLongitude - 0.004},${order.deliveryLatitude - 0.003},${order.deliveryLongitude + 0.004},${order.deliveryLatitude + 0.003}&layer=mapnik&marker=${order.deliveryLatitude},${order.deliveryLongitude}`}
                            />
                          </>
                        ) : (
                          <p style={{ color: 'var(--c-ink-3)' }}>Live location not shared</p>
                        )}
                      </div>
                      <div className="order-detail-block">
                        <h4>Payment &amp; Region</h4>
                        <p>{labelizeStatus(order.paymentMethod)}</p>
                        <p>Region: {order.geoLabel ?? '—'}</p>
                        <p>
                          Rider:{' '}
                          {order.assignedRider ? (
                            <strong>{order.assignedRider}</strong>
                          ) : (
                            <span style={{ color: 'var(--c-ink-3)' }}>Unassigned</span>
                          )}
                        </p>
                        {(() => {
                          const loc = order.assignedRiderUserId != null
                            ? riderLocations[order.assignedRiderUserId]
                            : null;
                          if (!loc) return null;
                          const secsAgo = Math.round((Date.now() - new Date(loc.updatedAt).getTime()) / 1000);
                          const ageLabel = secsAgo < 60 ? `${secsAgo}s ago` : `${Math.round(secsAgo / 60)}m ago`;
                          const distKm = order.deliveryLatitude != null && order.deliveryLongitude != null
                            ? haversineKm(
                                { lat: loc.latitude, lng: loc.longitude },
                                { lat: order.deliveryLatitude, lng: order.deliveryLongitude }
                              )
                            : null;
                          return (
                            <div className="rider-live-loc">
                              <span className="rider-live-loc__dot" />
                              <span className="rider-live-loc__label">Live</span>
                              <a
                                href={`https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`}
                                target="_blank"
                                rel="noreferrer"
                                className="rider-live-loc__link"
                              >
                                Open map
                              </a>
                              <span className="rider-live-loc__meta">
                                {distKm != null
                                  ? `${distKm < 1 ? `${Math.round(distKm * 1000)} m` : `${distKm.toFixed(1)} km`} from drop · `
                                  : ''}
                                updated {ageLabel}
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Items table */}
                    <table className="items-table">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Unit</th>
                          <th className="num">Qty</th>
                          <th className="num">Unit Price</th>
                          <th className="num">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {order.items.map((item) => (
                          <tr key={item.id}>
                            <td>{item.productName}</td>
                            <td>{item.unitLabel}</td>
                            <td className="num">{item.quantity}</td>
                            <td className="num">{formatCurrency(item.unitPriceCents)}</td>
                            <td className="num">{formatCurrency(item.lineTotalCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={4}>Subtotal</td>
                          <td className="num">{formatCurrency(order.subtotalCents)}</td>
                        </tr>
                        <tr>
                          <td colSpan={4}>Delivery fee</td>
                          <td className="num">
                            {order.deliveryFeeCents
                              ? formatCurrency(order.deliveryFeeCents)
                              : 'Free'}
                          </td>
                        </tr>
                        <tr className="table-grand">
                          <td colSpan={4}>
                            <strong>Order Total</strong>
                          </td>
                          <td className="num">
                            <strong>{formatCurrency(order.totalCents)}</strong>
                          </td>
                        </tr>
                      </tfoot>
                    </table>

                    {/* Dispatch controls */}
                    {canManageCatalog && (
                      <div className="order-controls">
                        <label>
                          <span>Assign rider</span>
                          <select
                            value={String(riderDrafts[order.publicId] ?? '')}
                            onChange={(e) => {
                              const raw = e.target.value;
                              const next: number | '' = raw ? Number(raw) : '';
                              setRiderDrafts((c) => ({ ...c, [order.publicId]: next }));
                              void handleAssignRider(order.publicId, order.status, next || null);
                            }}
                          >
                            <option value="">Unassigned</option>
                            {riders.map((rider) => (
                              <option key={rider.id} value={String(rider.id)}>
                                {rider.fullName || rider.email}
                                {rider.phone ? ` · ${rider.phone}` : ''}
                              </option>
                            ))}
                          </select>
                          {riders.length === 0 ? (
                            <small style={{ color: 'var(--c-ink-3)', display: 'block', marginTop: '0.25rem' }}>
                              No riders yet. Add one under Team with role "rider".
                            </small>
                          ) : null}
                        </label>
                        <label>
                          <span>Order status</span>
                          <select
                            value={order.status}
                            onChange={(e) =>
                              handleStatusChange(order.publicId, e.target.value as OrderStatus)
                            }
                          >
                            <option value="placed">Placed</option>
                            <option value="confirmed">Confirmed</option>
                            <option value="packing">Packing</option>
                            <option value="out_for_delivery">Out for Delivery</option>
                            <option value="delivered">Delivered</option>
                            <option value="cancelled">Cancelled</option>
                          </select>
                        </label>
                        {order.status !== 'cancelled' &&
                          order.status !== 'delivered' && (
                            <button
                              type="button"
                              className="danger-button"
                              onClick={() => handleAdminCancel(order.publicId)}
                              disabled={cancellingOrderId === order.publicId}
                            >
                              {cancellingOrderId === order.publicId ? 'Cancelling…' : 'Cancel Order'}
                            </button>
                          )}
                      </div>
                    )}
                  </div>
                )}
              </article>
              );
            })
          )}
        </div>
      </div>
    );
  }

  /* ────────────────────────────────────────
     INVENTORY
  ──────────────────────────────────────── */
  function renderInventory() {
    return (
      <div className="section-box">
        <div className="section-box__head">
          <div>
            <h2>{canManageCatalog ? 'Inventory Editor' : 'Inventory'}</h2>
            <p>{products.length} products · {products.filter((p) => p.isActive).length} active</p>
          </div>
          {canManageCatalog ? (
            <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
              <button
                type="button"
                className={`ghost-button${showBulkPanel ? ' ghost-button--active' : ''}`}
                onClick={() => { setShowBulkPanel((v) => !v); setBulkRows([]); setBulkResult(null); setShowBulkImagePanel(false); }}
              >
                {showBulkPanel ? '✕ Close bulk import' : '⬆ Bulk import'}
              </button>
              <button
                type="button"
                className={`ghost-button${showBulkImagePanel ? ' ghost-button--active' : ''}`}
                onClick={() => { setShowBulkImagePanel((v) => !v); setBulkImageFiles([]); setBulkImageResult(null); setShowBulkPanel(false); }}
              >
                {showBulkImagePanel ? '✕ Close' : '🖼 Bulk images'}
              </button>
              <button type="button" className="primary-button" onClick={openNewProductEditor}>
                + New Product
              </button>
            </div>
          ) : null}
        </div>

        {/* ── Bulk Image Upload Panel ── */}
        {showBulkImagePanel && canManageCatalog && (
          <div className="bulk-panel">
            <div style={{ marginBottom: 12 }}>
              <strong>Bulk Image Upload</strong>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
                Name each image file exactly as the product name (e.g. <em>Aashirvaad Atta.jpg</em>). The match is case-insensitive.
              </p>
            </div>

            {/* Drop zone */}
            <div
              className={`bulk-image-dropzone${bulkImageDragging ? ' bulk-image-dropzone--active' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setBulkImageDragging(true); }}
              onDragLeave={() => setBulkImageDragging(false)}
              onDrop={(e) => { e.preventDefault(); setBulkImageDragging(false); handleBulkImageFiles(e.dataTransfer.files); }}
              onClick={() => document.getElementById('bulk-image-input')?.click()}
            >
              <input
                id="bulk-image-input"
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => e.target.files && handleBulkImageFiles(e.target.files)}
              />
              {bulkImageFiles.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🖼</div>
                  <div>Drop images here or <span style={{ color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}>browse</span></div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>PNG, JPG, WebP — up to 100 files</div>
                </div>
              ) : (
                <div style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong>{bulkImageFiles.length} image{bulkImageFiles.length !== 1 ? 's' : ''} selected</strong>
                    <button type="button" className="ghost-button" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setBulkImageFiles([]); setBulkImageResult(null); }}>Clear all</button>
                  </div>
                  <div className="bulk-image-file-list">
                    {bulkImageFiles.map((f) => {
                      const matchedName = f.name.replace(/\.[^.]+$/, '');
                      const matched = products.some((p) => p.name.toLowerCase().trim() === matchedName.toLowerCase().trim());
                      return (
                        <div key={f.name} className={`bulk-image-file-row${matched ? ' bulk-image-file-row--matched' : ' bulk-image-file-row--unmatched'}`}>
                          <span className="bulk-image-file-row__dot">{matched ? '✓' : '?'}</span>
                          <span className="bulk-image-file-row__name">{f.name}</span>
                          <span className="bulk-image-file-row__status">{matched ? `→ ${matchedName}` : 'No match'}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>Click to add more images</div>
                </div>
              )}
            </div>

            {/* Result */}
            {bulkImageResult && (
              <div className="bulk-image-result">
                <div className="bulk-image-result__stat bulk-image-result__stat--ok">✓ {bulkImageResult.matched} uploaded</div>
                {bulkImageResult.unmatched > 0 && <div className="bulk-image-result__stat bulk-image-result__stat--warn">? {bulkImageResult.unmatched} unmatched</div>}
                {bulkImageResult.failed > 0 && <div className="bulk-image-result__stat bulk-image-result__stat--err">✕ {bulkImageResult.failed} failed</div>}
                <div className="bulk-image-result__rows">
                  {bulkImageResult.results.filter((r) => r.status !== 'ok').map((r) => (
                    <div key={r.filename} style={{ fontSize: 12, color: r.status === 'unmatched' ? 'var(--text-muted)' : 'red' }}>
                      {r.filename} — {r.status === 'unmatched' ? 'No matching product found' : r.error}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="primary-button"
                disabled={bulkImageFiles.length === 0 || bulkImageUploading}
                onClick={handleBulkImageUpload}
              >
                {bulkImageUploading ? 'Uploading…' : `Upload ${bulkImageFiles.length > 0 ? bulkImageFiles.length + ' image' + (bulkImageFiles.length !== 1 ? 's' : '') : 'images'}`}
              </button>
            </div>
          </div>
        )}

        {/* ── Bulk Import Panel ── */}
        {showBulkPanel && canManageCatalog && (
          <div className="bulk-panel">
            {/* Step cards */}
            {bulkRows.length === 0 && !bulkResult && (
              <div className="bulk-steps">
                {/* Step 1 – download */}
                <div className="bulk-step">
                  <div className="bulk-step__num">1</div>
                  <div className="bulk-step__body">
                    <span className="bulk-step__title">Download blank template</span>
                    <span className="bulk-step__desc">
                      An Excel file with headers and a dropdown list of your categories. Open in Excel, Google Sheets, or Numbers.
                    </span>
                    <button type="button" className="bulk-step__btn" onClick={() => { void downloadBulkTemplate(); }}>
                      <svg viewBox="0 0 20 20" fill="none">
                        <path d="M10 3v10M6 13l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M3 17h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                      </svg>
                      Download template.xlsx
                    </button>
                  </div>
                </div>

                {/* Step 2 – upload */}
                <div className="bulk-step">
                  <div className="bulk-step__num">2</div>
                  <div className="bulk-step__body">
                    <span className="bulk-step__title">Upload filled template</span>
                    <span className="bulk-step__desc">
                      Select your completed Excel (.xlsx) or CSV file. We'll validate every row before importing.
                    </span>
                    <label className="bulk-drop-zone">
                      <svg viewBox="0 0 24 24" fill="none">
                        <path d="M12 4v12M8 12l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M4 17v1a2 2 0 002 2h12a2 2 0 002-2v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                      </svg>
                      <span className="bulk-drop-zone__label">Click to choose a file</span>
                      <span className="bulk-drop-zone__sub">or drag and drop — .xlsx or .csv</span>
                      <input
                        type="file"
                        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleBulkFile(file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* Preview table */}
            {bulkRows.length > 0 && !bulkResult && (
              <div className="bulk-preview">
                <div className="bulk-preview__header">
                  <div>
                    <span className="bulk-preview__title">Preview — {bulkRows.length} rows detected</span>
                    <span className="bulk-preview__sub">
                      <span className="bulk-preview__ok">{bulkRows.filter((r) => r.errors.length === 0).length} valid</span>
                      {bulkRows.some((r) => r.errors.length > 0) && (
                        <span className="bulk-preview__err">{bulkRows.filter((r) => r.errors.length > 0).length} with errors (will be skipped)</span>
                      )}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setBulkRows([])}
                    >
                      ← Re-upload
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={bulkImporting || bulkRows.filter((r) => r.errors.length === 0).length === 0}
                      onClick={handleBulkImport}
                    >
                      {bulkImporting
                        ? `Importing… ${bulkProgress}%`
                        : `Import ${bulkRows.filter((r) => r.errors.length === 0).length} products`}
                    </button>
                  </div>
                </div>
                {bulkImporting && (
                  <div className="bulk-progress-bar">
                    <div className="bulk-progress-bar__fill" style={{ width: `${bulkProgress}%` }} />
                  </div>
                )}
                <div className="bulk-table-wrap">
                  <table className="bulk-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Name</th>
                        <th>Category</th>
                        <th>Unit</th>
                        <th>Price</th>
                        <th>Stock</th>
                        <th>Active</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkRows.map((row) => (
                        <tr key={row.rowNum} className={row.errors.length > 0 ? 'bulk-table__row--error' : 'bulk-table__row--ok'}>
                          <td className="bulk-table__num">{row.rowNum}</td>
                          <td>{row.name || <em className="bulk-empty">—</em>}</td>
                          <td>{row.categoryName || <em className="bulk-empty">—</em>}</td>
                          <td>{row.unitLabel || <em className="bulk-empty">—</em>}</td>
                          <td>₹{(row.priceCents / 100).toFixed(2)}</td>
                          <td>{row.stockQuantity}</td>
                          <td>{row.isActive ? 'Yes' : 'No'}</td>
                          <td>
                            {row.errors.length === 0
                              ? <span className="bulk-badge bulk-badge--ok">Ready</span>
                              : <span className="bulk-badge bulk-badge--err" title={row.errors.join('\n')}>
                                  {row.errors.length} error{row.errors.length > 1 ? 's' : ''}
                                </span>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Result */}
            {bulkResult && (
              <div className="bulk-result">
                <div className={`bulk-result__banner${bulkResult.failed === 0 ? ' bulk-result__banner--success' : ' bulk-result__banner--partial'}`}>
                  <strong>{bulkResult.done} product{bulkResult.done !== 1 ? 's' : ''} imported successfully</strong>
                  {bulkResult.failed > 0 && <span>{bulkResult.failed} rows failed</span>}
                </div>
                {bulkResult.errors.length > 0 && (
                  <ul className="bulk-result__errors">
                    {bulkResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => { setBulkResult(null); setBulkRows([]); }}
                >
                  Import another file
                </button>
              </div>
            )}
          </div>
        )}

        {canManageCatalog && showProductEditor ? (
          <div
            className="pe-modal-overlay"
            onClick={(e) => { if (e.target === e.currentTarget) closeProductEditor(); }}
            role="dialog"
            aria-modal="true"
          >
          <form className="pe-form pe-form--modal" onSubmit={handleSaveProduct}>
            <div className="pe-form__header">
              <div className="pe-form__title-wrap">
                <span className="pe-form__eyebrow">{editingId ? 'Editing product' : 'New product'}</span>
                <h3 className="pe-form__title">{editingId ? (productForm.name || 'Untitled') : 'Add to inventory'}</h3>
              </div>
              <button
                type="button"
                className="pe-form__discard"
                onClick={closeProductEditor}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="pe-form__body">
              {/* ── Left: basic info ── */}
              <div className="pe-col">
                <div className="pe-section">
                  <span className="pe-section__label">Basic info</span>
                  <label className="pe-field">
                    <span className="pe-field__label">Product name <em>*</em></span>
                    <input
                      className="pe-field__input"
                      value={productForm.name}
                      onChange={(e) => setProductForm((c) => ({ ...c, name: e.target.value }))}
                      placeholder="e.g. Amul Fresh Milk"
                      required
                    />
                  </label>
                  <div className="pe-row">
                    <label className="pe-field">
                      <span className="pe-field__label">
                        Category <em>*</em>
                        {!showInlineCategoryInput && (
                          <button
                            type="button"
                            className="pe-field__link"
                            onClick={() => setShowInlineCategoryInput(true)}
                          >
                            + New category
                          </button>
                        )}
                      </span>
                      {showInlineCategoryInput ? (
                        <div className="pe-inline-create">
                          <input
                            className="pe-field__input"
                            value={inlineCategoryName}
                            onChange={(e) => setInlineCategoryName(e.target.value)}
                            placeholder="New category name"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); void handleCreateCategoryInline(); }
                              if (e.key === 'Escape') { setShowInlineCategoryInput(false); setInlineCategoryName(''); }
                            }}
                          />
                          <button
                            type="button"
                            className="primary-button pe-inline-create__btn"
                            disabled={!inlineCategoryName.trim() || creatingInlineCategory}
                            onClick={() => void handleCreateCategoryInline()}
                          >
                            {creatingInlineCategory ? '…' : 'Add'}
                          </button>
                          <button
                            type="button"
                            className="ghost-button pe-inline-create__btn"
                            onClick={() => { setShowInlineCategoryInput(false); setInlineCategoryName(''); }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <select
                          className="pe-field__input"
                          value={productForm.categoryId}
                          onChange={(e) => setProductForm((c) => ({ ...c, categoryId: e.target.value }))}
                          required
                        >
                          <option value="">Select category</option>
                          {categories.map((cat) => (
                            <option key={cat.id} value={String(cat.id)}>{cat.name}</option>
                          ))}
                        </select>
                      )}
                    </label>
                    <label className="pe-field">
                      <span className="pe-field__label">Unit label <em>*</em></span>
                      <input
                        className="pe-field__input"
                        value={productForm.unitLabel}
                        onChange={(e) => setProductForm((c) => ({ ...c, unitLabel: e.target.value }))}
                        placeholder="e.g. 1 L pouch"
                        required
                      />
                    </label>
                  </div>
                  <label className="pe-field">
                    <span className="pe-field__label">
                      Brand
                      {!showInlineBrandInput && (
                        <button
                          type="button"
                          className="pe-field__link"
                          onClick={() => setShowInlineBrandInput(true)}
                        >
                          + New brand
                        </button>
                      )}
                    </span>
                    {showInlineBrandInput ? (
                      <div className="pe-inline-create">
                        <input
                          className="pe-field__input"
                          value={inlineBrandName}
                          onChange={(e) => setInlineBrandName(e.target.value)}
                          placeholder="New brand name"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); void handleCreateBrandInline(); }
                            if (e.key === 'Escape') { setShowInlineBrandInput(false); setInlineBrandName(''); }
                          }}
                        />
                        <button
                          type="button"
                          className="primary-button pe-inline-create__btn"
                          disabled={!inlineBrandName.trim() || creatingInlineBrand}
                          onClick={() => void handleCreateBrandInline()}
                        >
                          {creatingInlineBrand ? '…' : 'Add'}
                        </button>
                        <button
                          type="button"
                          className="ghost-button pe-inline-create__btn"
                          onClick={() => { setShowInlineBrandInput(false); setInlineBrandName(''); }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <select
                        className="pe-field__input"
                        value={productForm.brandId}
                        onChange={(e) => setProductForm((c) => ({ ...c, brandId: e.target.value }))}
                      >
                        <option value="">No brand</option>
                        {brands.map((b) => (
                          <option key={b.id} value={String(b.id)}>{b.name}</option>
                        ))}
                      </select>
                    )}
                  </label>
                  <label className="pe-field">
                    <span className="pe-field__label">
                      Badge
                      <span className="pe-field__hint">shown on storefront card</span>
                    </span>
                    <div className="pe-badge-wrap">
                      <input
                        className="pe-field__input"
                        value={productForm.badge}
                        onChange={(e) => setProductForm((c) => ({ ...c, badge: e.target.value }))}
                        placeholder="e.g. Fresh Pick, Popular"
                      />
                      {productForm.badge && (
                        <span className="pe-badge-preview">{productForm.badge}</span>
                      )}
                    </div>
                  </label>
                  <label className="pe-field">
                    <span className="pe-field__label">Description <em>*</em></span>
                    <textarea
                      className="pe-field__input pe-field__input--textarea"
                      value={productForm.description}
                      onChange={(e) => setProductForm((c) => ({ ...c, description: e.target.value }))}
                      placeholder="Short product description shown to customers…"
                      required
                    />
                  </label>
                </div>
              </div>

              {/* ── Right: media + pricing ── */}
              <div className="pe-col pe-col--side">
                <div className="pe-section">
                  <span className="pe-section__label">Media</span>
                  <div className="pe-image-preview">
                    <img
                      className="pe-image-preview__img"
                      src={productImagePreview || productForm.imageUrl || ''}
                      alt=""
                      loading="lazy"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      onLoad={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'block'; }}
                      style={{ display: 'none' }}
                    />
                    {!productImagePreview && !productForm.imageUrl && (
                      <div className="pe-image-preview__placeholder">
                        <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.4"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M3 15l5-4 4 3 3-2.5L21 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        <span>No image</span>
                      </div>
                    )}
                  </div>
                  <label className="pe-field">
                    <span className="pe-field__label">Image URL</span>
                    <input
                      className="pe-field__input"
                      value={productForm.imageUrl}
                      onChange={(e) => setProductForm((c) => ({ ...c, imageUrl: e.target.value }))}
                      placeholder="https://…"
                    />
                  </label>
                  <label className="pe-field">
                    <span className="pe-field__label">Upload file</span>
                    <label className="pe-upload-btn">
                      <svg viewBox="0 0 20 20" fill="none"><path d="M10 3v10M6 7l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><path d="M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
                      {productImage ? productImage.name : 'Choose image…'}
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const file = e.target.files?.[0] ?? null;
                          setProductImage(file);
                          setProductImagePreview(file ? URL.createObjectURL(file) : null);
                        }}
                      />
                    </label>
                  </label>
                </div>

                <div className="pe-section">
                  <span className="pe-section__label">Pricing &amp; stock</span>
                  <div className="pe-row">
                    <label className="pe-field">
                      <span className="pe-field__label">Price <em>*</em></span>
                      <div className="pe-currency">
                        <span className="pe-currency__symbol">₹</span>
                        <input
                          className="pe-field__input pe-currency__input"
                          type="number"
                          min="0"
                          step="0.01"
                          value={productForm.price}
                          onChange={(e) => setProductForm((c) => ({ ...c, price: e.target.value }))}
                          placeholder="0.00"
                          required
                        />
                      </div>
                    </label>
                    <label className="pe-field">
                      <span className="pe-field__label">
                        Original price
                        <span className="pe-field__hint">for strikethrough</span>
                      </span>
                      <div className="pe-currency">
                        <span className="pe-currency__symbol">₹</span>
                        <input
                          className="pe-field__input pe-currency__input"
                          type="number"
                          min="0"
                          step="0.01"
                          value={productForm.originalPrice}
                          onChange={(e) => setProductForm((c) => ({ ...c, originalPrice: e.target.value }))}
                          placeholder="0.00"
                        />
                      </div>
                    </label>
                  </div>
                  <label className="pe-field">
                    <span className="pe-field__label">Stock quantity <em>*</em></span>
                    <input
                      className="pe-field__input"
                      type="number"
                      min="0"
                      value={productForm.stockQuantity}
                      onChange={(e) => setProductForm((c) => ({ ...c, stockQuantity: e.target.value }))}
                      required
                    />
                    {Number(productForm.stockQuantity) <= 5 && Number(productForm.stockQuantity) >= 0 && (
                      <span className="pe-field__warn">Low stock warning will appear on storefront</span>
                    )}
                  </label>

                  <div className="pe-toggle-row">
                    <div>
                      <span className="pe-toggle-row__label">Visible in storefront</span>
                      <span className="pe-toggle-row__sub">Hidden products won't appear to customers</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={productForm.isActive}
                      className={`pe-toggle${productForm.isActive ? ' pe-toggle--on' : ''}`}
                      onClick={() => setProductForm((c) => ({ ...c, isActive: !c.isActive }))}
                    >
                      <span className="pe-toggle__thumb" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="pe-form__footer">
              <button type="button" className="ghost-button" onClick={closeProductEditor}>
                Cancel
              </button>
              <button type="submit" className="primary-button pe-form__submit" disabled={savingProduct}>
                {savingProduct ? 'Saving…' : editingId ? 'Save changes' : 'Create product'}
              </button>
            </div>
          </form>
          </div>
        ) : !canManageCatalog ? (
          <div className="empty-state">
            Viewer accounts can inspect inventory but cannot edit products.
          </div>
        ) : null}

        <div className="inventory-toolbar">
          {/* Search row */}
          <div className="inv-search-row">
            <div className="inv-search-wrap">
              <svg className="inv-search-icon" viewBox="0 0 20 20" fill="none">
                <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.6"/>
                <path d="M13 13l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
              <input
                ref={inventorySearchRef}
                className="inv-search"
                value={inventorySearch}
                onChange={(e) => setInventorySearch(e.target.value)}
                placeholder="Search by name, category, description… (press / to focus)"
              />
              {inventorySearch && (
                <button
                  type="button"
                  className="inv-search-clear"
                  onClick={() => { setInventorySearch(''); inventorySearchRef.current?.focus(); }}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
              {!inventorySearch && <kbd className="inv-search-kbd">/</kbd>}
            </div>
            <select
              className="inv-sort"
              value={inventorySort}
              onChange={(e) => setInventorySort(e.target.value as typeof inventorySort)}
              disabled={!!inventorySearch}
              title={inventorySearch ? 'Sort disabled while searching (sorted by relevance)' : 'Sort products'}
            >
              <option value="default">Sort: Default</option>
              <option value="price_asc">Price: Low → High</option>
              <option value="price_desc">Price: High → Low</option>
              <option value="stock_asc">Stock: Low → High</option>
              <option value="stock_desc">Stock: High → Low</option>
            </select>
          </div>

          {/* Status filter chips */}
          <div className="inv-filters">
            {(
              [
                { key: 'all', label: 'All', count: products.length },
                { key: 'active', label: 'Active', count: products.filter((p) => p.isActive).length },
                { key: 'archived', label: 'Archived', count: products.filter((p) => !p.isActive).length },
                { key: 'low_stock', label: 'Low Stock', count: products.filter((p) => p.stockQuantity <= 5).length },
              ] as Array<{ key: typeof inventoryStatusFilter; label: string; count: number }>
            ).map((f) => (
              <button
                key={f.key}
                type="button"
                className={`chip${inventoryStatusFilter === f.key ? ' chip--active' : ''}`}
                onClick={() => setInventoryStatusFilter(f.key)}
              >
                {f.label}
                {f.count > 0 && <span className="chip__count">{f.count}</span>}
              </button>
            ))}

            <div className="inv-filter-divider" />

            {/* Category chips — only categories present in current products */}
            <button
              type="button"
              className={`chip${inventoryCategoryFilter === 'all' ? ' chip--active' : ''}`}
              onClick={() => setInventoryCategoryFilter('all')}
            >
              All categories
            </button>
            {categories
              .filter((cat) => products.some((p) => p.categoryId === cat.id))
              .map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className={`chip${inventoryCategoryFilter === cat.id ? ' chip--active' : ''}`}
                  onClick={() => setInventoryCategoryFilter(cat.id)}
                >
                  {cat.name}
                  <span className="chip__count">
                    {products.filter((p) => p.categoryId === cat.id).length}
                  </span>
                </button>
              ))}
          </div>

          {/* Result count */}
          <div className="inv-results-meta">
            {inventorySearch
              ? <>Showing <strong>{filteredProducts.length}</strong> result{filteredProducts.length !== 1 ? 's' : ''} for "<em>{inventorySearch}</em>"</>
              : <><strong>{filteredProducts.length}</strong> of {products.length} products</>
            }
            {(inventorySearch || inventoryStatusFilter !== 'all' || inventoryCategoryFilter !== 'all') && (
              <button
                type="button"
                className="inv-clear-filters"
                onClick={() => {
                  setInventorySearch('');
                  setInventoryStatusFilter('all');
                  setInventoryCategoryFilter('all');
                  setInventorySort('default');
                }}
              >
                Clear all filters
              </button>
            )}
          </div>
        </div>

        <div className="inventory-list">
          {filteredProducts.length === 0 && (
            <p className="empty-state">No products match your search.</p>
          )}
          {filteredProducts.map((product) => {
            const stockPct = Math.min(100, Math.round((product.stockQuantity / 100) * 100));
            const isLow = product.stockQuantity <= 5;
            return (
              <article key={product.uniqueId} className={`inv-card${!product.isActive ? ' inv-card--archived' : ''}`}>
                <div className="inv-card__thumb">
                  <img
                    src={product.imageUrl || ''}
                    alt={product.name}
                    loading="lazy"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; (e.currentTarget.parentElement!.querySelector('.inv-card__thumb-fallback') as HTMLElement).style.display = 'flex'; }}
                  />
                  <div className="inv-card__thumb-fallback" style={{ display: 'none' }}>
                    {product.name.charAt(0)}
                  </div>
                </div>

                <div className="inv-card__info">
                  <div className="inv-card__name">
                    {product.name}
                    {product.badge && <span className="inv-card__badge">{product.badge}</span>}
                  </div>
                  <div className="inv-card__meta">
                    {product.brand && (
                      <>
                        <span className="inv-card__brand">{product.brand}</span>
                        <span className="inv-card__dot">·</span>
                      </>
                    )}
                    <span>{product.category ?? 'Uncategorised'}</span>
                    <span className="inv-card__dot">·</span>
                    <span>{product.unitLabel}</span>
                  </div>
                </div>

                <div className="inv-card__pricing">
                  <span className="inv-card__price">{formatCurrency(product.priceCents)}</span>
                  {product.originalPriceCents && (
                    <span className="inv-card__original">{formatCurrency(product.originalPriceCents)}</span>
                  )}
                </div>

                <div className="inv-card__stock-col">
                  <span className={`inv-card__stock-num${isLow ? ' inv-card__stock-num--low' : ''}`}>
                    {product.stockQuantity} in stock
                  </span>
                  <div className="inv-card__stock-bar">
                    <div
                      className={`inv-card__stock-fill${isLow ? ' inv-card__stock-fill--low' : ''}`}
                      style={{ width: `${stockPct}%` }}
                    />
                  </div>
                </div>

                <div className="inv-card__status-col">
                  <span className={`inv-card__status${product.isActive ? ' inv-card__status--live' : ''}`}>
                    {product.isActive ? 'Live' : 'Archived'}
                  </span>
                  {product.isOnOffer && <span className="inv-card__offer-tag">On offer</span>}
                </div>

                {canManageCatalog && (
                  <div className="inv-card__actions">
                    <button
                      type="button"
                      className="inv-card__btn"
                      onClick={() => {
                        setEditingId(product.uniqueId);
                        setProductImagePreview(null);
                        setProductForm({
                          name: product.name,
                          categoryId: product.categoryId ? String(product.categoryId) : '',
                          brandId: product.brandId ? String(product.brandId) : '',
                          unitLabel: product.unitLabel,
                          description: product.description,
                          price: String(product.priceCents / 100),
                          originalPrice: product.originalPriceCents ? String(product.originalPriceCents / 100) : '',
                          stockQuantity: String(product.stockQuantity),
                          badge: product.badge ?? '',
                          imageUrl: product.imageUrl ?? '',
                          isActive: product.isActive,
                        });
                        setProductImage(null);
                        setShowProductEditor(true);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="inv-card__btn inv-card__btn--danger"
                      onClick={() => handleArchive(product.uniqueId)}
                      disabled={archivingId === product.uniqueId}
                    >
                      {archivingId === product.uniqueId ? 'Archiving…' : 'Archive'}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    );
  }

  /* ────────────────────────────────────────
     TEAM
  ──────────────────────────────────────── */
  function renderCategories() {
    return (
      <div className="section-box">
        <div className="section-box__head">
          <div>
            <h2>Categories</h2>
            <p>{categories.length} categories · {products.length} products total</p>
          </div>
        </div>

        {/* Add category bar */}
        {canManageCatalog && (
          <form className="cat-create-bar" onSubmit={handleCreateCategory}>
            <div className="cat-create-bar__inner">
              <svg className="cat-create-bar__icon" viewBox="0 0 20 20" fill="none">
                <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.6"/>
                <path d="M10 7v6M7 10h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
              <input
                className="cat-create-bar__input"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="New category name…"
              />
            </div>
            <button
              type="submit"
              className="primary-button"
              disabled={!newCategoryName.trim() || creatingCategory}
            >
              {creatingCategory ? 'Adding…' : 'Add Category'}
            </button>
          </form>
        )}

        {/* Grid */}
        <div className="cat-grid">
          {categories.length === 0 && (
            <p className="empty-state" style={{ gridColumn: '1/-1' }}>No categories yet. Add one above.</p>
          )}
          {categories.map((cat) => {
            const productCount = products.filter((p) => p.categoryId === cat.id).length;
            const isEditing = editingCategoryId === cat.id;
            const pendingImage = categoryImages[cat.id] ?? null;
            const initials = cat.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

            return (
              <article key={cat.id} className={`cat-card${isEditing ? ' cat-card--editing' : ''}`}>
                {/* Cover image */}
                <div className="cat-card__cover">
                  {cat.imageUrl
                    ? <img src={cat.imageUrl} alt={cat.name} className="cat-card__cover-img" loading="lazy" />
                    : <div className="cat-card__cover-placeholder">{initials}</div>
                  }
                  {canManageCatalog && (
                    <label className="cat-card__cover-upload" title="Change image">
                      <svg viewBox="0 0 20 20" fill="none">
                        <path d="M3 13l4-4 3 3 3-3.5L17 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M13 3l2 2-8 8H5v-2L13 3z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) =>
                          setCategoryImages((c) => ({ ...c, [cat.id]: e.target.files?.[0] ?? null }))
                        }
                      />
                    </label>
                  )}
                  {pendingImage && (
                    <div className="cat-card__pending-badge">
                      <span>New image ready</span>
                      <button
                        type="button"
                        className="cat-card__upload-btn"
                        onClick={() => handleUploadCategoryImage(cat.id)}
                        disabled={uploadingCategoryImageId === cat.id}
                      >
                        {uploadingCategoryImageId === cat.id ? 'Uploading…' : 'Upload'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Body */}
                <div className="cat-card__body">
                  {isEditing ? (
                    <div className="cat-card__rename">
                      <input
                        className="cat-card__rename-input"
                        value={editingCategoryName}
                        onChange={(e) => setEditingCategoryName(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleSaveCategoryName(cat.id); }
                          if (e.key === 'Escape') { setEditingCategoryId(null); setEditingCategoryName(''); }
                        }}
                      />
                      <div className="cat-card__rename-actions">
                        <button
                          type="button"
                          className="cat-card__btn cat-card__btn--primary"
                          onClick={() => handleSaveCategoryName(cat.id)}
                          disabled={!editingCategoryName.trim() || savingCategoryId === cat.id}
                        >
                          {savingCategoryId === cat.id ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          className="cat-card__btn"
                          onClick={() => { setEditingCategoryId(null); setEditingCategoryName(''); }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="cat-card__info">
                      <span className="cat-card__name">{cat.name}</span>
                      <span className="cat-card__count">
                        {productCount} product{productCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                  )}

                  {canManageCatalog && !isEditing && (
                    <div className="cat-card__actions">
                      <button
                        type="button"
                        className="cat-card__btn"
                        onClick={() => { setEditingCategoryId(cat.id); setEditingCategoryName(cat.name); }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="cat-card__btn cat-card__btn--danger"
                        title={productCount > 0 ? `${productCount} product(s) will be affected` : 'Delete category'}
                        onClick={() => handleDeleteCategory(cat)}
                        disabled={deletingCategoryId === cat.id}
                      >
                        {deletingCategoryId === cat.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    );
  }

  async function applySlowMoverSuggestion(s: SlowMoverSuggestion) {
    const product = products.find((p) => p.uniqueId === s.uniqueId);
    if (!product) return;
    await handleToggleOffer(product, true, s.suggestedOfferPriceCents, 'price');
    setDismissedSlowMovers((prev) => new Set(prev).add(s.uniqueId));
  }

  function dismissSlowMover(uniqueId: string) {
    setDismissedSlowMovers((prev) => new Set(prev).add(uniqueId));
  }

  function renderOffers() {
    const { onOffer, notOnOffer } = filteredOffers;
    const totalOnOffer = products.filter((p) => p.isOnOffer).length;
    const totalNotOnOffer = products.filter((p) => !p.isOnOffer).length;
    const visibleSuggestions = slowMovers.filter((s) => !dismissedSlowMovers.has(s.uniqueId));

    return (
      <div className="section-box">
        <div className="section-box__head">
          <div>
            <h2>Today's Offers</h2>
            <p>
              Pick the products you want to feature. Selected items show first on the storefront
              under a <strong>Today's Offer</strong> card.
            </p>
          </div>
        </div>

        {/* Slow-mover suggestions */}
        {canManageCatalog && (
          <div className="slow-movers">
            <div className="slow-movers__head">
              <div className="slow-movers__title-wrap">
                <span className="slow-movers__icon" aria-hidden>💡</span>
                <div>
                  <h3 className="slow-movers__title">Needs attention</h3>
                  <p className="slow-movers__sub">
                    {slowMoversLoading
                      ? 'Analysing sales…'
                      : visibleSuggestions.length === 0
                        ? 'No slow movers right now — everything is selling well.'
                        : `${visibleSuggestions.length} product${visibleSuggestions.length === 1 ? '' : 's'} selling slowly — consider putting them on offer.`}
                  </p>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void loadSlowMovers()}
                  disabled={slowMoversLoading}
                  title="Recalculate suggestions"
                >
                  {slowMoversLoading ? '…' : '↻ Refresh'}
                </button>
                <button
                  type="button"
                  className="ghost-button slow-movers__toggle"
                  onClick={() => setSlowMoversCollapsed((v) => !v)}
                >
                  {slowMoversCollapsed ? 'Show' : 'Hide'}
                </button>
              </div>
            </div>
            {!slowMoversCollapsed && visibleSuggestions.length > 0 && (
              <div className="slow-movers__grid">
                {visibleSuggestions.map((s) => {
                  const applying = togglingOfferId === s.uniqueId;
                  return (
                    <article key={s.uniqueId} className="slow-mover-card">
                      <div className="slow-mover-card__thumb">
                        {s.imageUrl ? (
                          <img src={s.imageUrl} alt={s.name} loading="lazy" />
                        ) : (
                          <div className="slow-mover-card__thumb-ph" />
                        )}
                      </div>
                      <div className="slow-mover-card__body">
                        <div className="slow-mover-card__head">
                          <span className="slow-mover-card__name">{s.name}</span>
                          <span className="slow-mover-card__meta">
                            {s.category ?? 'Uncategorised'} · {s.unitLabel}
                          </span>
                        </div>
                        <div className="slow-mover-card__stats">
                          <span className={`slow-mover-card__tag slow-mover-card__tag--${s.reason}`}>
                            {s.reasonLabel}
                          </span>
                          <span className="slow-mover-card__stat">
                            <strong>{s.stockQuantity}</strong> in stock
                          </span>
                          <span className="slow-mover-card__stat">
                            <strong>{s.unitsSold30d}</strong> sold / 30d
                          </span>
                        </div>
                        <div className="slow-mover-card__cta">
                          <div className="slow-mover-card__price">
                            <span className="slow-mover-card__price-old">
                              {formatCurrency(s.priceCents)}
                            </span>
                            <span className="slow-mover-card__arrow">→</span>
                            <span className="slow-mover-card__price-new">
                              {formatCurrency(s.suggestedOfferPriceCents)}
                            </span>
                            <span className="slow-mover-card__discount">
                              −{s.suggestedDiscountPercent}%
                            </span>
                          </div>
                          <div className="slow-mover-card__actions">
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => dismissSlowMover(s.uniqueId)}
                              disabled={applying}
                            >
                              Dismiss
                            </button>
                            <button
                              type="button"
                              className="primary-button"
                              onClick={() => void applySlowMoverSuggestion(s)}
                              disabled={applying}
                            >
                              {applying ? 'Applying…' : `Apply ${s.suggestedDiscountPercent}% off`}
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Search bar */}
        <div className="offers-search-bar">
          <div className="inv-search-wrap" style={{ maxWidth: 480 }}>
            <svg className="inv-search-icon" viewBox="0 0 20 20" fill="none">
              <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.6"/>
              <path d="M13 13l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            <input
              ref={offerSearchRef}
              className="inv-search"
              value={offerSearch}
              onChange={(e) => setOfferSearch(e.target.value)}
              placeholder="Search products by name, category… (press / to focus)"
            />
            {offerSearch && (
              <button
                type="button"
                className="inv-search-clear"
                onClick={() => { setOfferSearch(''); offerSearchRef.current?.focus(); }}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
            {!offerSearch && <kbd className="inv-search-kbd">/</kbd>}
          </div>
          {offerSearch && (
            <span className="offers-search-meta">
              {onOffer.length + notOnOffer.length} result{onOffer.length + notOnOffer.length !== 1 ? 's' : ''} for "<em>{offerSearch}</em>"
            </span>
          )}
        </div>

        <div className="offers-section">
          <h3 className="offers-section__title">
            On offer
            <span className="offers-section__count">
              {offerSearch ? `${onOffer.length} of ${totalOnOffer}` : totalOnOffer}
            </span>
          </h3>
          {onOffer.length === 0 ? (
            <p className="empty-state">
              {offerSearch ? `No offers match "${offerSearch}".` : 'No offers picked yet.'}
            </p>
          ) : (
            <div className="offers-grid">
              {onOffer.map((product) => {
                const currentOfferRupees =
                  product.offerPriceCents != null
                    ? String(product.offerPriceCents / 100)
                    : '';
                const draft = offerPriceDrafts[product.uniqueId];
                const priceInput = draft !== undefined ? draft : currentOfferRupees;
                const dirty = draft !== undefined && draft !== currentOfferRupees;
                const isBogoOnServer = product.offerType === 'bogo';
                const isEditingBogo = editingBogoFor === product.uniqueId;
                const isSwitchingToPrice = switchingToPrice.has(product.uniqueId);
                const bogoDraft = bogoDrafts[product.uniqueId] ?? {
                  buy: String(product.bogoBuyQty ?? 1),
                  get: String(product.bogoGetQty ?? 1),
                };
                // Price edit form shows when not BOGO, OR when switching from BOGO -> price
                const showPriceForm =
                  (!isBogoOnServer && !isEditingBogo) || isSwitchingToPrice;
                return (
                  <article key={product.uniqueId} className="offer-card offer-card--active">
                    <div className="offer-card__thumb">
                      {product.imageUrl && <img src={product.imageUrl} alt={product.name} loading="lazy" className="offer-card__thumb-img" />}
                    </div>
                    <div className="offer-card__body">
                      <strong>{product.name}</strong>
                      <span>{product.category ?? 'Uncategorised'} · {product.unitLabel}</span>
                      <span className="offer-card__price">
                        Current: <strong>{formatCurrency(product.priceCents)}</strong>
                        {isBogoOnServer ? (
                          <span className="offer-card__tag offer-card__tag--bogo">
                            Buy {product.bogoBuyQty} Get {product.bogoGetQty} Free
                          </span>
                        ) : product.offerPriceCents != null ? (
                          <span className="offer-card__tag">
                            Offer: {formatCurrency(product.offerPriceCents)}
                          </span>
                        ) : null}
                      </span>
                      {showPriceForm ? (
                        <label className="offer-price-input">
                          <span>Offer price (₹)</span>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={priceInput}
                            onChange={(e) => setOfferPriceDraft(product.uniqueId, e.target.value)}
                            placeholder={`Less than ${product.priceCents / 100}`}
                            autoFocus={isSwitchingToPrice}
                          />
                        </label>
                      ) : null}
                      {isEditingBogo ? (
                        <div className="bogo-editor">
                          <label className="bogo-editor__field">
                            <span>Buy</span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={bogoDraft.buy}
                              onChange={(e) => setBogoDraft(product.uniqueId, { buy: e.target.value })}
                              autoFocus
                            />
                          </label>
                          <span className="bogo-editor__sep">Get</span>
                          <label className="bogo-editor__field">
                            <span>Free</span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={bogoDraft.get}
                              onChange={(e) => setBogoDraft(product.uniqueId, { get: e.target.value })}
                            />
                          </label>
                          <span className="bogo-editor__preview">
                            = Buy {bogoDraft.buy || '1'}, get {bogoDraft.get || '1'} free
                          </span>
                        </div>
                      ) : null}
                    </div>
                    <div className="offer-card__actions">
                      {isEditingBogo ? (
                        <>
                          <button
                            type="button"
                            className="primary-button"
                            disabled={togglingOfferId === product.uniqueId}
                            onClick={() => void applyBogo(product)}
                          >
                            {togglingOfferId === product.uniqueId ? 'Saving…' : 'Save BOGO'}
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setEditingBogoFor(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : showPriceForm ? (
                        <>
                          <button
                            type="button"
                            className="primary-button"
                            disabled={
                              !priceInput ||
                              (!dirty && !isSwitchingToPrice)
                            }
                            onClick={async () => {
                              const rupees = Number(priceInput);
                              if (!Number.isFinite(rupees) || rupees < 0) {
                                setError('Enter a valid offer price.');
                                return;
                              }
                              await handleToggleOffer(
                                product,
                                true,
                                Math.round(rupees * 100),
                                'price',
                              );
                              setOfferPriceDraft(product.uniqueId, '');
                              setSwitchingToPrice((s) => {
                                const next = new Set(s);
                                next.delete(product.uniqueId);
                                return next;
                              });
                            }}
                          >
                            {isSwitchingToPrice ? 'Save offer price' : 'Update price'}
                          </button>
                          {isSwitchingToPrice ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => {
                                setSwitchingToPrice((s) => {
                                  const next = new Set(s);
                                  next.delete(product.uniqueId);
                                  return next;
                                });
                                setOfferPriceDraft(product.uniqueId, '');
                              }}
                            >
                              Cancel
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => openBogoEditor(product)}
                              disabled={togglingOfferId === product.uniqueId}
                            >
                              Switch to Buy-Get offer
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => openBogoEditor(product)}
                          >
                            Edit BOGO
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() =>
                              setSwitchingToPrice((s) => {
                                const next = new Set(s);
                                next.add(product.uniqueId);
                                return next;
                              })
                            }
                          >
                            Switch to price offer
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="ghost-button ghost-button--danger"
                        onClick={() => handleToggleOffer(product, false)}
                        disabled={togglingOfferId === product.uniqueId}
                      >
                        {togglingOfferId === product.uniqueId ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <div className="offers-section">
          <h3 className="offers-section__title">
            Available products
            <span className="offers-section__count">
              {offerSearch ? `${notOnOffer.length} of ${totalNotOnOffer}` : totalNotOnOffer}
            </span>
          </h3>
          {notOnOffer.length === 0 && !offerSearch ? (
            <p className="empty-state">All products are already on offer.</p>
          ) : notOnOffer.length === 0 ? (
            <p className="empty-state">No available products match "<em>{offerSearch}</em>".</p>
          ) : (
            <div className="offers-grid">
              {notOnOffer.map((product) => {
                const draft = offerPriceDrafts[product.uniqueId] ?? '';
                const isEditingBogo = editingBogoFor === product.uniqueId;
                const bogoDraft = bogoDrafts[product.uniqueId] ?? { buy: '1', get: '1' };
                return (
                  <article key={product.uniqueId} className="offer-card">
                    <div className="offer-card__thumb">
                      {product.imageUrl && <img src={product.imageUrl} alt={product.name} loading="lazy" className="offer-card__thumb-img" />}
                    </div>
                    <div className="offer-card__body">
                      <strong>{product.name}</strong>
                      <span>{product.category ?? 'Uncategorised'} · {product.unitLabel}</span>
                      <span className="offer-card__price">
                        {formatCurrency(product.priceCents)}
                      </span>
                      {isEditingBogo ? (
                        <div className="bogo-editor">
                          <label className="bogo-editor__field">
                            <span>Buy</span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={bogoDraft.buy}
                              onChange={(e) => setBogoDraft(product.uniqueId, { buy: e.target.value })}
                              autoFocus
                            />
                          </label>
                          <span className="bogo-editor__sep">Get</span>
                          <label className="bogo-editor__field">
                            <span>Free</span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={bogoDraft.get}
                              onChange={(e) => setBogoDraft(product.uniqueId, { get: e.target.value })}
                            />
                          </label>
                          <span className="bogo-editor__preview">
                            = Buy {bogoDraft.buy || '1'}, get {bogoDraft.get || '1'} free
                          </span>
                        </div>
                      ) : (
                        <label className="offer-price-input">
                          <span>Offer price (₹)</span>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={draft}
                            onChange={(e) => setOfferPriceDraft(product.uniqueId, e.target.value)}
                            placeholder={`Less than ${product.priceCents / 100}`}
                          />
                        </label>
                      )}
                    </div>
                    <div className="offer-card__actions">
                      {isEditingBogo ? (
                        <>
                          <button
                            type="button"
                            className="primary-button"
                            disabled={togglingOfferId === product.uniqueId}
                            onClick={() => void applyBogo(product)}
                          >
                            {togglingOfferId === product.uniqueId ? 'Adding…' : 'Add BOGO offer'}
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setEditingBogoFor(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="primary-button"
                            disabled={!draft || togglingOfferId === product.uniqueId}
                            onClick={() => {
                              const rupees = Number(draft);
                              if (!Number.isFinite(rupees) || rupees < 0) {
                                setError('Enter a valid offer price.');
                                return;
                              }
                              handleToggleOffer(product, true, Math.round(rupees * 100), 'price');
                              setOfferPriceDraft(product.uniqueId, '');
                            }}
                          >
                            {togglingOfferId === product.uniqueId ? 'Adding…' : 'Add at offer price'}
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => openBogoEditor(product)}
                            disabled={togglingOfferId === product.uniqueId}
                          >
                            Buy-Get offer
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── CSV export helpers ─────────────────────────────────────────────
  function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
    const esc = (v: string | number | null | undefined) => {
      const s = v == null ? '' : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportOrdersCsv() {
    const headers = [
      'Order ID', 'Status', 'Customer', 'Phone', 'Address', 'Payment',
      'Subtotal', 'Delivery Fee', 'Discount', 'Total', 'Rider',
      'Placed at', 'Last updated', 'Items',
    ];
    const rows: Array<Array<string | number | null>> = [headers];
    for (const o of orders) {
      const items = o.items?.map((it) => `${it.quantity}× ${it.productName}`).join(' | ') ?? '';
      rows.push([
        o.publicId,
        o.status,
        o.customerName,
        o.customerPhone,
        o.deliveryAddress,
        o.paymentMethod,
        (o.subtotalCents / 100).toFixed(2),
        (o.deliveryFeeCents / 100).toFixed(2),
        (o.discountCents / 100).toFixed(2),
        (o.totalCents / 100).toFixed(2),
        o.assignedRider ?? '',
        o.createdDate,
        o.updatedDate,
        items,
      ]);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`bestmart-orders-${stamp}.csv`, rows);
  }

  function exportSalesCsv() {
    if (!salesReport) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const summary: Array<Array<string | number>> = [
      ['Period (days)', salesReport.periodDays],
      ['Total revenue (₹)', (salesReport.totalRevenueCents / 100).toFixed(2)],
      ['Total orders', salesReport.totalOrders],
      ['Total items sold', salesReport.totalItemsSold],
      ['Average order value (₹)', (salesReport.averageOrderCents / 100).toFixed(2)],
      [],
      ['Daily revenue'],
      ['Date', 'Orders', 'Revenue (₹)'],
      ...salesReport.dailyRevenue.map((d) => [d.date, d.orders, (d.revenueCents / 100).toFixed(2)]),
      [],
      ['Top products'],
      ['Rank', 'Product', 'Units sold', 'Revenue (₹)'],
      ...salesReport.topProducts.map((p, i) => [i + 1, p.name, p.unitsSold, (p.revenueCents / 100).toFixed(2)]),
      [],
      ['Payment breakdown'],
      ['Method', 'Orders', 'Revenue (₹)'],
      ...salesReport.paymentBreakdown.map((p) => [p.method, p.orders, (p.revenueCents / 100).toFixed(2)]),
    ];
    downloadCsv(`bestmart-sales-${salesReport.periodDays}d-${stamp}.csv`, summary);
  }

  function setHistoryPreset(days: number) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (days - 1));
    setHistoryStart(start.toISOString().slice(0, 10));
    setHistoryEnd(end.toISOString().slice(0, 10));
  }

  function renderHistory() {
    if (!canManageCatalog) {
      return <div className="section-box"><div className="empty-state">Sign in as admin or editor to view order history.</div></div>;
    }

    const startMs = new Date(`${historyStart}T00:00:00`).getTime();
    const endMs = new Date(`${historyEnd}T23:59:59.999`).getTime();
    const term = historySearch.trim().toLowerCase();

    const filtered = orders.filter((o) => {
      const t = new Date(o.createdDate).getTime();
      if (Number.isFinite(startMs) && t < startMs) return false;
      if (Number.isFinite(endMs) && t > endMs) return false;
      if (historyStatus !== 'all' && o.status !== historyStatus) return false;
      if (term) {
        const hay = [
          o.publicId, o.customerName, o.customerPhone, o.deliveryAddress,
          o.assignedRider ?? '', o.paymentMethod,
        ].join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      switch (historySort) {
        case 'date_asc':
          return new Date(a.createdDate).getTime() - new Date(b.createdDate).getTime();
        case 'total_desc':
          return b.totalCents - a.totalCents;
        case 'total_asc':
          return a.totalCents - b.totalCents;
        case 'date_desc':
        default:
          return new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime();
      }
    });

    const totalRevenue = sorted
      .filter((o) => o.status !== 'cancelled')
      .reduce((sum, o) => sum + o.totalCents, 0);
    const totalItems = sorted
      .filter((o) => o.status !== 'cancelled')
      .reduce((sum, o) => sum + (o.items?.reduce((s, it) => s + it.quantity, 0) ?? 0), 0);
    const cancelledCount = sorted.filter((o) => o.status === 'cancelled').length;

    function exportFiltered() {
      const headers = [
        'Date', 'Order ID', 'Status', 'Customer', 'Phone', 'Address',
        'Payment', 'Items', 'Subtotal', 'Delivery Fee', 'Discount', 'Total', 'Rider',
      ];
      const rows: Array<Array<string | number>> = [headers];
      for (const o of sorted) {
        const items = o.items?.map((it) => `${it.quantity}× ${it.productName}`).join(' | ') ?? '';
        rows.push([
          new Date(o.createdDate).toISOString(),
          o.publicId,
          o.status,
          o.customerName,
          o.customerPhone,
          o.deliveryAddress,
          o.paymentMethod,
          items,
          (o.subtotalCents / 100).toFixed(2),
          (o.deliveryFeeCents / 100).toFixed(2),
          (o.discountCents / 100).toFixed(2),
          (o.totalCents / 100).toFixed(2),
          o.assignedRider ?? '',
        ]);
      }
      downloadCsv(`bestmart-history-${historyStart}_to_${historyEnd}.csv`, rows);
    }

    const STATUS_OPTIONS: Array<{ value: 'all' | OrderStatus; label: string }> = [
      { value: 'all', label: 'All statuses' },
      { value: 'placed', label: 'Placed' },
      { value: 'confirmed', label: 'Confirmed' },
      { value: 'packing', label: 'Packing' },
      { value: 'out_for_delivery', label: 'Out for delivery' },
      { value: 'delivered', label: 'Delivered' },
      { value: 'cancelled', label: 'Cancelled' },
    ];

    return (
      <div className="section-box">
        <div className="section-box__head">
          <div>
            <h2>Order History</h2>
            <p>Browse, filter, and export every order placed in any date range.</p>
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={exportFiltered}
            disabled={sorted.length === 0}
          >
            ⬇ Export CSV
          </button>
        </div>

        {/* Filter bar */}
        <div className="history-toolbar">
          <div className="history-toolbar__row">
            <label className="history-field">
              <span>From</span>
              <input
                type="date"
                value={historyStart}
                onChange={(e) => setHistoryStart(e.target.value)}
                max={historyEnd}
              />
            </label>
            <label className="history-field">
              <span>To</span>
              <input
                type="date"
                value={historyEnd}
                onChange={(e) => setHistoryEnd(e.target.value)}
                min={historyStart}
                max={new Date().toISOString().slice(0, 10)}
              />
            </label>
            <div className="history-presets">
              <button type="button" className="chip" onClick={() => setHistoryPreset(1)}>Today</button>
              <button type="button" className="chip" onClick={() => setHistoryPreset(7)}>7 days</button>
              <button type="button" className="chip" onClick={() => setHistoryPreset(30)}>30 days</button>
              <button type="button" className="chip" onClick={() => setHistoryPreset(90)}>90 days</button>
            </div>
          </div>

          <div className="history-toolbar__row">
            <input
              className="history-search"
              type="search"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder="Search by order ID, customer, phone, address, rider…"
            />
            <select
              className="history-select"
              value={historyStatus}
              onChange={(e) => setHistoryStatus(e.target.value as 'all' | OrderStatus)}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <select
              className="history-select"
              value={historySort}
              onChange={(e) => setHistorySort(e.target.value as typeof historySort)}
            >
              <option value="date_desc">Newest first</option>
              <option value="date_asc">Oldest first</option>
              <option value="total_desc">Highest total</option>
              <option value="total_asc">Lowest total</option>
            </select>
          </div>
        </div>

        {/* Summary strip */}
        <div className="history-summary">
          <div className="history-summary__cell">
            <span className="history-summary__label">Orders</span>
            <span className="history-summary__value">{sorted.length}</span>
          </div>
          <div className="history-summary__cell">
            <span className="history-summary__label">Revenue</span>
            <span className="history-summary__value">{formatCurrency(totalRevenue)}</span>
          </div>
          <div className="history-summary__cell">
            <span className="history-summary__label">Items sold</span>
            <span className="history-summary__value">{totalItems}</span>
          </div>
          <div className="history-summary__cell">
            <span className="history-summary__label">Cancelled</span>
            <span className="history-summary__value">{cancelledCount}</span>
          </div>
        </div>

        {/* Table */}
        {sorted.length === 0 ? (
          <div className="empty-state" style={{ margin: 'var(--sp-5) var(--sp-6)' }}>
            No orders match the selected filters.
          </div>
        ) : (
          <div className="history-table-wrap">
            <table className="history-table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th>Date</th>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Items</th>
                  <th>Payment</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((o) => {
                  const expanded = historyExpanded === o.publicId;
                  const itemCount = o.items?.reduce((s, it) => s + it.quantity, 0) ?? 0;
                  return (
                    <Fragment key={o.publicId}>
                      <tr
                        className={`history-row${expanded ? ' history-row--expanded' : ''}`}
                        onClick={() => setHistoryExpanded(expanded ? null : o.publicId)}
                      >
                        <td className="history-row__chev">{expanded ? '▾' : '▸'}</td>
                        <td>
                          <span className="history-row__date">{formatDateTime(o.createdDate)}</span>
                        </td>
                        <td>
                          <span className="history-row__id">#{o.publicId}</span>
                        </td>
                        <td>
                          <div className="history-row__customer">
                            <strong>{o.customerName}</strong>
                            <span>{o.customerPhone}</span>
                          </div>
                        </td>
                        <td>{itemCount}</td>
                        <td>{labelizeStatus(o.paymentMethod)}</td>
                        <td>
                          <span className={`history-status history-status--${o.status}`}>
                            {labelizeStatus(o.status)}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <strong>{formatCurrency(o.totalCents)}</strong>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="history-row__detail">
                          <td colSpan={8}>
                            <div className="history-detail">
                              <div className="history-detail__col">
                                <h4>Delivery</h4>
                                <p>{o.deliveryAddress}</p>
                                {o.deliveryNotes && <p className="muted">Notes: {o.deliveryNotes}</p>}
                                {o.assignedRider && <p className="muted">Rider: {o.assignedRider}</p>}
                              </div>
                              <div className="history-detail__col">
                                <h4>Items</h4>
                                <ul>
                                  {o.items?.map((it, i) => (
                                    <li key={`${o.publicId}-${i}`}>
                                      {it.quantity}× {it.productName}
                                      <span className="muted"> · {formatCurrency(it.lineTotalCents)}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                              <div className="history-detail__col">
                                <h4>Totals</h4>
                                <div className="history-totals">
                                  <span>Subtotal</span><strong>{formatCurrency(o.subtotalCents)}</strong>
                                  <span>Delivery</span><strong>{o.deliveryFeeCents ? formatCurrency(o.deliveryFeeCents) : 'Free'}</strong>
                                  {o.discountCents > 0 && (
                                    <>
                                      <span>Discount</span><strong>− {formatCurrency(o.discountCents)}</strong>
                                    </>
                                  )}
                                  <span className="strong">Total</span><strong className="strong">{formatCurrency(o.totalCents)}</strong>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  function renderSales() {
    if (!canManageTeam) {
      return <div className="section-box"><div className="empty-state">Only admins can view sales reports.</div></div>;
    }
    const report = salesReport;
    const maxDaily = report
      ? Math.max(1, ...report.dailyRevenue.map((d) => d.revenueCents))
      : 1;

    return (
      <div className="section-box">
        <div className="section-box__head">
          <div>
            <h2>Sales</h2>
            <p>Revenue, volume, and top products over the selected period.</p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
            <div className="sales-range">
              {([7, 30, 90] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`chip${salesRange === d ? ' chip--active' : ''}`}
                  onClick={() => setSalesRange(d)}
                  disabled={salesLoading}
                >
                  Last {d} days
                </button>
              ))}
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={() => void loadSalesReport(salesRange)}
              disabled={salesLoading}
            >
              {salesLoading ? '…' : '↻ Refresh'}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={exportSalesCsv}
              disabled={!report || salesLoading}
            >
              ⬇ Export CSV
            </button>
          </div>
        </div>

        {!report && salesLoading && (
          <div className="empty-state">Loading sales report…</div>
        )}

        {report && (
          <>
            <div className="sales-kpis">
              <div className="sales-kpi">
                <span className="sales-kpi__label">Revenue</span>
                <span className="sales-kpi__value">{formatCurrency(report.totalRevenueCents)}</span>
              </div>
              <div className="sales-kpi">
                <span className="sales-kpi__label">Orders</span>
                <span className="sales-kpi__value">{report.totalOrders}</span>
              </div>
              <div className="sales-kpi">
                <span className="sales-kpi__label">Items sold</span>
                <span className="sales-kpi__value">{report.totalItemsSold}</span>
              </div>
              <div className="sales-kpi">
                <span className="sales-kpi__label">Avg order</span>
                <span className="sales-kpi__value">{formatCurrency(report.averageOrderCents)}</span>
              </div>
            </div>

            <div className="sales-section">
              <h3 className="sales-section__title">Daily revenue</h3>
              {report.dailyRevenue.length === 0 ? (
                <p className="empty-state">No sales in this period.</p>
              ) : (
                <div className="sales-chart">
                  {report.dailyRevenue.map((d) => (
                    <div key={d.date} className="sales-chart__col" title={`${d.date}: ${formatCurrency(d.revenueCents)} (${d.orders} orders)`}>
                      <div
                        className="sales-chart__bar"
                        style={{ height: `${(d.revenueCents / maxDaily) * 100}%` }}
                      />
                      <span className="sales-chart__date">{d.date.slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="sales-section">
              <h3 className="sales-section__title">Top products</h3>
              {report.topProducts.length === 0 ? (
                <p className="empty-state">No products sold in this period.</p>
              ) : (
                <table className="sales-table">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>#</th>
                      <th>Product</th>
                      <th style={{ width: 120 }}>Units sold</th>
                      <th style={{ width: 160 }}>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.topProducts.map((p, i) => (
                      <tr key={`${p.uniqueId ?? 'anon'}-${i}`}>
                        <td>{i + 1}</td>
                        <td>{p.name}</td>
                        <td>{p.unitsSold}</td>
                        <td>{formatCurrency(p.revenueCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="sales-section">
              <h3 className="sales-section__title">Payment mix</h3>
              {report.paymentBreakdown.length === 0 ? (
                <p className="empty-state">No payments recorded.</p>
              ) : (
                <table className="sales-table">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th style={{ width: 120 }}>Orders</th>
                      <th style={{ width: 160 }}>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.paymentBreakdown.map((p) => (
                      <tr key={p.method}>
                        <td>{labelizeStatus(p.method)}</td>
                        <td>{p.orders}</td>
                        <td>{formatCurrency(p.revenueCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Coupons ────────────────────────────────────────────────────────
  async function loadCoupons() {
    if (!canManageTeam) return;
    setCouponsLoading(true);
    try {
      const list = await apiListCoupons();
      setCoupons(list);
    } catch (err) {
      console.warn('Failed to load coupons', err);
    } finally {
      setCouponsLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab === 'coupons' && canManageTeam) {
      loadCoupons();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, canManageTeam]);

  function openNewCouponForm() {
    setEditingCoupon(null);
    setCouponForm({
      code: '',
      description: '',
      discountType: 'percent',
      discountValueRupees: '10',
      maxDiscountRupees: '',
      minSubtotalRupees: '0',
      maxUsesPerUser: '1',
      maxTotalUses: '',
      isActive: true,
      validUntil: '',
    });
    setShowCouponForm(true);
  }

  function openEditCouponForm(c: Coupon) {
    setEditingCoupon(c);
    setCouponForm({
      code: c.code,
      description: c.description,
      discountType: c.discountType,
      discountValueRupees:
        c.discountType === 'flat' ? String(c.discountValue / 100) : String(c.discountValue),
      maxDiscountRupees: c.maxDiscountCents != null ? String(c.maxDiscountCents / 100) : '',
      minSubtotalRupees: String(c.minSubtotalCents / 100),
      maxUsesPerUser: String(c.maxUsesPerUser),
      maxTotalUses: c.maxTotalUses != null ? String(c.maxTotalUses) : '',
      isActive: c.isActive,
      validUntil: c.validUntil ? c.validUntil.slice(0, 10) : '',
    });
    setShowCouponForm(true);
  }

  async function handleSaveCoupon() {
    const code = couponForm.code.trim().toUpperCase();
    const value = Number(couponForm.discountValueRupees);
    const maxUsesPerUser = Number(couponForm.maxUsesPerUser);
    if (!code) { setError('Coupon code is required.'); return; }
    if (!Number.isFinite(value) || value <= 0) { setError('Discount value must be > 0.'); return; }
    if (couponForm.discountType === 'percent' && value > 100) { setError('Percent discount can\'t exceed 100.'); return; }
    if (!Number.isInteger(maxUsesPerUser) || maxUsesPerUser < 1) {
      setError('Per-user usage limit (N) must be at least 1.');
      return;
    }
    setSavingCoupon(true);
    try {
      const payload: Partial<Coupon> = {
        code,
        description: couponForm.description.trim(),
        discountType: couponForm.discountType,
        discountValue: couponForm.discountType === 'flat' ? Math.round(value * 100) : Math.round(value),
        maxDiscountCents: couponForm.maxDiscountRupees
          ? Math.round(Number(couponForm.maxDiscountRupees) * 100)
          : null,
        minSubtotalCents: Math.round(Number(couponForm.minSubtotalRupees || '0') * 100),
        maxUsesPerUser,
        maxTotalUses: couponForm.maxTotalUses ? Math.round(Number(couponForm.maxTotalUses)) : null,
        isActive: couponForm.isActive,
        validUntil: couponForm.validUntil
          ? new Date(`${couponForm.validUntil}T23:59:59`).toISOString()
          : null,
      };
      if (editingCoupon) {
        await apiUpdateCoupon(editingCoupon.id, payload);
        setNotice(`Coupon ${code} updated.`);
      } else {
        await apiCreateCoupon(payload);
        setNotice(`Coupon ${code} created.`);
      }
      setError('');
      setShowCouponForm(false);
      setEditingCoupon(null);
      await loadCoupons();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save coupon');
    } finally {
      setSavingCoupon(false);
    }
  }

  async function handleDeleteCoupon(c: Coupon) {
    const ok = await confirm({
      title: `Delete coupon "${c.code}"?`,
      message: c.totalRedemptions > 0
        ? `This coupon has been used ${c.totalRedemptions} time(s). Deleting it will not affect existing orders, but no one will be able to use it again.`
        : 'This action cannot be undone.',
      confirmLabel: 'Delete coupon',
      cancelLabel: 'Keep',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await apiDeleteCoupon(c.id);
      setNotice(`Coupon ${c.code} deleted.`);
      setError('');
      await loadCoupons();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete coupon');
    }
  }

  function renderCoupons() {
    if (!canManageTeam) {
      return <div className="section-box"><div className="empty-state">Only admins can manage coupons.</div></div>;
    }
    return (
      <div className="section-box">
        <div className="section-box__head">
          <div>
            <h2>Coupons</h2>
            <p>Create promo codes that customers can redeem at checkout.</p>
          </div>
          <button type="button" className="primary-button" onClick={openNewCouponForm}>
            + New Coupon
          </button>
        </div>

        {showCouponForm && (
          <div className="coupon-form">
            <div className="coupon-form__field">
              <span>Code</span>
              <input
                value={couponForm.code}
                onChange={(e) => setCouponForm((c) => ({ ...c, code: e.target.value.toUpperCase() }))}
                placeholder="WELCOME10"
                maxLength={40}
                style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}
              />
            </div>
            <div className="coupon-form__field">
              <span>Discount type</span>
              <select
                value={couponForm.discountType}
                onChange={(e) => setCouponForm((c) => ({ ...c, discountType: e.target.value as 'percent' | 'flat' }))}
              >
                <option value="percent">Percent (%)</option>
                <option value="flat">Flat amount (₹)</option>
              </select>
            </div>
            <div className="coupon-form__field">
              <span>{couponForm.discountType === 'percent' ? 'Discount %' : 'Discount ₹'}</span>
              <input
                type="number"
                min="1"
                step="1"
                value={couponForm.discountValueRupees}
                onChange={(e) => setCouponForm((c) => ({ ...c, discountValueRupees: e.target.value }))}
              />
            </div>
            {couponForm.discountType === 'percent' && (
              <div className="coupon-form__field">
                <span>Max discount cap (₹)</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={couponForm.maxDiscountRupees}
                  onChange={(e) => setCouponForm((c) => ({ ...c, maxDiscountRupees: e.target.value }))}
                  placeholder="No cap"
                />
                <span className="coupon-form__hint">Leave blank for no cap</span>
              </div>
            )}
            <div className="coupon-form__field">
              <span>Min order subtotal (₹)</span>
              <input
                type="number"
                min="0"
                step="1"
                value={couponForm.minSubtotalRupees}
                onChange={(e) => setCouponForm((c) => ({ ...c, minSubtotalRupees: e.target.value }))}
              />
            </div>
            <div className="coupon-form__field">
              <span>Per-user uses (N)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={couponForm.maxUsesPerUser}
                onChange={(e) => setCouponForm((c) => ({ ...c, maxUsesPerUser: e.target.value }))}
              />
              <span className="coupon-form__hint">How many times each user can redeem</span>
            </div>
            <div className="coupon-form__field">
              <span>Total uses cap</span>
              <input
                type="number"
                min="1"
                step="1"
                value={couponForm.maxTotalUses}
                onChange={(e) => setCouponForm((c) => ({ ...c, maxTotalUses: e.target.value }))}
                placeholder="Unlimited"
              />
              <span className="coupon-form__hint">Across all users — leave blank for unlimited</span>
            </div>
            <div className="coupon-form__field">
              <span>Valid until</span>
              <input
                type="date"
                value={couponForm.validUntil}
                onChange={(e) => setCouponForm((c) => ({ ...c, validUntil: e.target.value }))}
                min={new Date().toISOString().slice(0, 10)}
              />
              <span className="coupon-form__hint">Leave blank for no expiry</span>
            </div>
            <div className="coupon-form__field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                id="coupon-active"
                checked={couponForm.isActive}
                onChange={(e) => setCouponForm((c) => ({ ...c, isActive: e.target.checked }))}
              />
              <label htmlFor="coupon-active" style={{ fontSize: '0.9rem', color: 'var(--c-ink)' }}>
                Active (customers can redeem)
              </label>
            </div>
            <div className="coupon-form__field coupon-form__field--full">
              <span>Description (optional)</span>
              <textarea
                value={couponForm.description}
                onChange={(e) => setCouponForm((c) => ({ ...c, description: e.target.value }))}
                placeholder="Internal note — shown to customers when applied"
              />
            </div>
            <div className="coupon-form__actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => { setShowCouponForm(false); setEditingCoupon(null); }}
                disabled={savingCoupon}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleSaveCoupon()}
                disabled={savingCoupon}
              >
                {savingCoupon ? 'Saving…' : editingCoupon ? 'Save changes' : 'Create coupon'}
              </button>
            </div>
          </div>
        )}

        {couponsLoading && coupons.length === 0 && (
          <div className="empty-state" style={{ margin: 'var(--sp-5) var(--sp-6)' }}>Loading coupons…</div>
        )}
        {!couponsLoading && coupons.length === 0 && (
          <div className="empty-state" style={{ margin: 'var(--sp-5) var(--sp-6)' }}>
            No coupons yet. Click "+ New Coupon" to create one.
          </div>
        )}

        {coupons.length > 0 && (
          <div className="coupons-grid">
            {coupons.map((c) => {
              const expiresLabel = c.validUntil
                ? `Expires ${new Date(c.validUntil).toLocaleDateString()}`
                : 'No expiry';
              const totalLabel = c.maxTotalUses != null
                ? `${c.totalRedemptions} / ${c.maxTotalUses}`
                : `${c.totalRedemptions}`;
              const discountLabel = c.discountType === 'percent'
                ? `${c.discountValue}%${c.maxDiscountCents != null ? ` (max ${formatCurrency(c.maxDiscountCents)})` : ''}`
                : formatCurrency(c.discountValue);
              return (
                <article key={c.id} className={`coupon-card${c.isActive ? '' : ' coupon-card--inactive'}`}>
                  <div className="coupon-card__head">
                    <span className="coupon-card__code">{c.code}</span>
                    <span className="coupon-card__discount">{discountLabel} off</span>
                  </div>
                  {c.description && <p className="coupon-card__desc">{c.description}</p>}
                  <div className="coupon-card__meta">
                    <span>Min order: <strong>{formatCurrency(c.minSubtotalCents)}</strong></span>
                    <span>Per-user: <strong>{c.maxUsesPerUser}×</strong></span>
                    <span>Total used: <strong>{totalLabel}</strong></span>
                    <span>{expiresLabel}</span>
                  </div>
                  <div className="coupon-card__actions">
                    <button type="button" className="ghost-button" onClick={() => openEditCouponForm(c)}>Edit</button>
                    <button type="button" className="ghost-button ghost-button--danger" onClick={() => void handleDeleteCoupon(c)}>Delete</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function renderTeam() {
    return (
      <div className="section-box">
        <div className="section-box__head">
          <div>
            <h2>Staff Accounts</h2>
            <p>{team.length} active member{team.length !== 1 ? 's' : ''}</p>
          </div>
        </div>

        <form className="team-form" onSubmit={handleCreateUser}>
          <p style={{ fontWeight: 600, color: 'var(--c-ink)' }}>Add team member</p>
          <div className="inline-field-group">
            <label>
              <span>Email</span>
              <input
                type="email"
                value={staffEmail}
                onChange={(e) => setStaffEmail(e.target.value)}
                placeholder="staff@bestmart.local"
                required
              />
            </label>
            <label>
              <span>Password</span>
              <input
                value={staffPassword}
                onChange={(e) => setStaffPassword(e.target.value)}
                required
              />
            </label>
            <label>
              <span>Role</span>
              <select
                value={staffRole}
                onChange={(e) => setStaffRole(e.target.value as UserRole)}
              >
                <option value="admin">Admin</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
                <option value="rider">Rider</option>
              </select>
            </label>
            <label>
              <span>Full name{staffRole === 'rider' ? ' (shown to customer)' : ''}</span>
              <input
                value={staffFullName}
                onChange={(e) => setStaffFullName(e.target.value)}
                placeholder="Rider / staff name"
              />
            </label>
            <label>
              <span>Phone{staffRole === 'rider' ? ' (shown to customer)' : ''}</span>
              <input
                value={staffPhone}
                onChange={(e) => setStaffPhone(e.target.value)}
                placeholder="+91 98xxx xxxxx"
              />
            </label>
          </div>
          <div>
            <button type="submit" className="primary-button" disabled={creatingUser}>
              {creatingUser ? 'Creating…' : 'Create Member'}
            </button>
          </div>
        </form>

        <div className="team-list">
          {team.map((member) => (
            <div key={member.uid} className="member-row">
              <div>
                <div className="member-email">{member.email}</div>
              </div>
              <span className={`role-badge role-badge--${member.role}`}>{member.role}</span>
              <span className="member-date">Joined {formatDateTime(member.createdDate)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
}

export default Dashboard;
