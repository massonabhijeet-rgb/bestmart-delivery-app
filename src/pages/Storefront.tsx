import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  apiCancelOrder,
  apiCreateOrder,
  apiCreatePaymentIntent,
  apiCreateUpiIntent,
  apiGetActiveCampaign,
  apiGetCompanyPublic,
  apiGetHomeRails,
  apiGetProductsPage,
  apiGetProductVariants,
  apiGetStorefrontSpotlight,
  apiListAddresses,
  apiListBrands,
  apiListCategories,
  apiListPublicCoupons,
  apiListTempCategories,
  apiLogClick,
  apiLogSearch,
  apiPreviewCoupon,
  ApiError,
} from '../services/api';
import type { Brand, Campaign, CouponPreview, HomeRails, PublicCoupon, StorefrontSpotlight, TempCategory } from '../services/api';
import { bogoBillableQty, bogoGet, bogoLabel, effectivePriceCents, formatCurrency, isBogoProduct, lineTotalCents } from '../lib/format';
import { confirm } from '../components/ConfirmDialog';
import { withBusy } from '../components/BusyOverlay';
import LazyMount from '../components/LazyMount';
import { AddressPickerModal, type PickedAddress as PickedMapAddress } from '../components/AddressPickerModal';
import {
  MOOD_COPY,
  fetchOpenMeteoMood,
  moodFromIndiaCalendar,
  type WeatherMood,
} from '../lib/weatherPicks';
import {
  CHECKOUT_MOOD_COPY,
  moodFromHour,
  pickCheckoutTreats,
} from '../lib/checkoutPicks';
import type { Category, CompanyInfo, Order, Product, SavedAddress, User } from '../services/api';

interface StorefrontProps {
  user: User | null;
  onOpenLogin: () => void;
  onOpenDashboard: () => void;
  onOpenMyOrders: () => void;
  onTrack: (code: string) => void;
  onLogout: () => void;
}

interface CheckoutForm {
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  deliveryNotes: string;
  paymentMethod: string;
}

const CART_STORAGE_KEY = 'bestmart:cart';

// Parse a unit label into a normalized base quantity:
//   "1 L bottle" → { value: 1000, unit: 'ml' }
//   "500g" → { value: 500, unit: 'g' }
//   "12 pcs" → { value: 12, unit: 'pcs' }
// Returns null when nothing parseable is found, so callers can skip ₹/unit display.
function parseQuantityFromUnitLabel(label: string): { value: number; unit: 'ml' | 'g' | 'pcs' } | null {
  const m = label.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ml|l|ltr|litre|litres|g|gm|gms|gram|grams|kg|kgs|pcs?|pieces?|pack)\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[2];
  if (u === 'ml') return { value: n, unit: 'ml' };
  if (u === 'l' || u === 'ltr' || u === 'litre' || u === 'litres') return { value: n * 1000, unit: 'ml' };
  if (u === 'g' || u === 'gm' || u === 'gms' || u === 'gram' || u === 'grams') return { value: n, unit: 'g' };
  if (u === 'kg' || u === 'kgs') return { value: n * 1000, unit: 'g' };
  return { value: n, unit: 'pcs' };
}

// ₹ per litre / kg / piece, in paise per base unit, for ranking variants.
function unitPriceCentsPerBase(product: Product): { centsPer: number; unit: 'ml' | 'g' | 'pcs' } | null {
  const q = parseQuantityFromUnitLabel(product.unitLabel);
  if (!q) return null;
  const eff = effectivePriceCents(product);
  return { centsPer: eff / q.value, unit: q.unit };
}

function formatUnitPrice(p: Product): string | null {
  const u = unitPriceCentsPerBase(p);
  if (!u) return null;
  if (u.unit === 'ml') return `${formatCurrency(Math.round(u.centsPer * 1000))} / L`;
  if (u.unit === 'g') return `${formatCurrency(Math.round(u.centsPer * 1000))} / kg`;
  return `${formatCurrency(Math.round(u.centsPer))} / pc`;
}

const FOOTER_USEFUL_LINKS = ['Blog', 'Partner', 'Recipes'];

interface RazorpaySuccess {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

type PreferredUpiApp = 'phonepe' | 'google_pay' | 'paytm';

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  phonepe: 'PhonePe (UPI)',
  gpay: 'Google Pay (UPI)',
  paytm: 'Paytm (UPI)',
  razorpay: 'Card / Netbanking / Other UPI',
  upi: 'UPI on delivery',
  card_on_delivery: 'Card on delivery',
  cash_on_delivery: 'Cash on delivery',
};

interface PaymentMethodEntry {
  value: string;
  label: string;
  sub: string;
  icon: string;
  iconUrl?: string;
}

const PAYMENT_ICON_BASE = 'https://bestmart-images-prod.s3.eu-north-1.amazonaws.com';

const PAYMENT_GROUPS: Array<{ title: string; methods: PaymentMethodEntry[] }> = [
  {
    title: 'Pay online',
    methods: [
      { value: 'phonepe', label: 'PhonePe', sub: 'Opens PhonePe via UPI', icon: '📱', iconUrl: `${PAYMENT_ICON_BASE}/payment-icons/phonepay.png` },
      { value: 'gpay', label: 'Google Pay', sub: 'Opens GPay via UPI', icon: '🟢', iconUrl: `${PAYMENT_ICON_BASE}/payment-icons/googlepay.png` },
      { value: 'paytm', label: 'Paytm', sub: 'Opens Paytm via UPI', icon: '🔵', iconUrl: `${PAYMENT_ICON_BASE}/payment-icons/paytm.png` },
      { value: 'razorpay', label: 'Card / Netbanking / Other UPI', sub: 'Pay securely via Razorpay', icon: '💳' },
    ],
  },
  {
    title: 'Pay on delivery',
    methods: [
      { value: 'upi', label: 'UPI on delivery', sub: 'Pay the rider via UPI QR', icon: '🧾' },
      { value: 'card_on_delivery', label: 'Card on delivery', sub: 'Swipe on arrival', icon: '💳' },
      { value: 'cash_on_delivery', label: 'Cash on delivery', sub: 'Pay when the order arrives', icon: '💵' },
    ],
  },
];

interface RazorpayCheckoutPayload {
  keyId: string;
  razorpayOrderId: string;
  amount: number;
  currency: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  // When set, Razorpay checkout is configured to launch ONLY this UPI app
  // via intent flow — no card / netbanking tabs are shown.
  preferredUpiApp?: PreferredUpiApp;
}

function labelForUpiApp(app: PreferredUpiApp): string {
  if (app === 'phonepe') return 'PhonePe';
  if (app === 'google_pay') return 'Google Pay';
  return 'Paytm';
}

// Opens the Razorpay checkout widget loaded via <script> in index.html and
// resolves when the user completes (or dismisses) payment. Rejects if
// checkout.js isn't on the page (e.g. offline / CSP).
function openRazorpayCheckout(payload: RazorpayCheckoutPayload): Promise<RazorpaySuccess> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Razorpay = (window as any).Razorpay;
    if (!Razorpay) {
      reject(new Error('Online payment is unavailable right now. Please choose another method.'));
      return;
    }
    let settled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rzpOptions: any = {
      key: payload.keyId,
      amount: payload.amount,
      currency: payload.currency,
      order_id: payload.razorpayOrderId,
      name: 'BestMart',
      description: 'Order payment',
      prefill: {
        name: payload.customerName,
        contact: payload.customerPhone,
        email: payload.customerEmail ?? '',
      },
      theme: { color: '#10b981' },
      modal: {
        ondismiss: () => {
          if (settled) return;
          settled = true;
          reject(new Error('Payment cancelled'));
        },
      },
      handler: (response: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      }) => {
        settled = true;
        resolve({
          razorpayOrderId: response.razorpay_order_id,
          razorpayPaymentId: response.razorpay_payment_id,
          razorpaySignature: response.razorpay_signature,
        });
      },
    };

    if (payload.preferredUpiApp) {
      rzpOptions.method = {
        upi: true,
        card: false,
        netbanking: false,
        wallet: false,
        emi: false,
        paylater: false,
      };
      rzpOptions.config = {
        display: {
          blocks: {
            upi_preferred: {
              name: `Pay via ${labelForUpiApp(payload.preferredUpiApp)}`,
              instruments: [
                { method: 'upi', flows: ['intent'], apps: [payload.preferredUpiApp] },
              ],
            },
          },
          sequence: ['block.upi_preferred'],
          preferences: { show_default_blocks: false },
        },
      };
    }

    const rzp = new Razorpay(rzpOptions);
    rzp.open();
  });
}

function Storefront({ user, onOpenLogin, onOpenDashboard, onOpenMyOrders, onTrack, onLogout }: StorefrontProps) {
  // Cache of every product we've seen across spotlight / temp categories /
  // paged catalog / cart hydration. Lets cards, cart and pickers read product
  // details without re-fetching the whole catalog up front.
  const [productCache, setProductCache] = useState<Record<string, Product>>({});
  const [spotlight, setSpotlight] = useState<StorefrontSpotlight | null>(null);
  const [homeRails, setHomeRails] = useState<HomeRails | null>(null);
  // Incremental "load more rails on scroll": start with a small batch and
  // reveal more as the sentinel at the end of the rendered rails enters view.
  const RAILS_PER_BATCH = 4;
  const [visibleRailCount, setVisibleRailCount] = useState(RAILS_PER_BATCH);
  const railSentinelRef = useRef<HTMLDivElement | null>(null);
  const [categoryRows, setCategoryRows] = useState<Category[]>([]);
  // Festival / special-day popup overlay — shown once per browser session.
  const [activeCampaign, setActiveCampaign] = useState<Campaign | null>(null);
  const [campaignDismissed, setCampaignDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem('bm:campaign:dismissed') === '1'; } catch { return false; }
  });
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [brandFilter, setBrandFilter] = useState<string | null>(null);
  const [brandsList, setBrandsList] = useState<Brand[]>([]);
  const [cart, setCart] = useState<Record<string, number>>(() => {
    const stored = localStorage.getItem(CART_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as Record<string, number>) : {};
  });
  // Quick-view: lets shoppers compare other sizes/packs before adding to cart.
  const [quickView, setQuickView] = useState<Product | null>(null);
  const [quickViewVariants, setQuickViewVariants] = useState<Product[]>([]);
  const [quickViewLoading, setQuickViewLoading] = useState(false);
  const [trackingCode, setTrackingCode] = useState('');
  const [placingOrder, setPlacingOrder] = useState(false);
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false);
  const [couponSheetOpen, setCouponSheetOpen] = useState(false);
  const [addressPickerOpen, setAddressPickerOpen] = useState(false);
  const [addressPickerAutoLocate, setAddressPickerAutoLocate] = useState(false);
  const paymentIconsReadyRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const urls = PAYMENT_GROUPS.flatMap((g) =>
      g.methods.map((m) => m.iconUrl).filter((u): u is string => !!u),
    );
    if (urls.length === 0) return;
    paymentIconsReadyRef.current = Promise.all(
      urls.map(
        (u) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => resolve();
            img.src = u;
          }),
      ),
    ).then(() => undefined);
  }, []);
  const openPaymentSheet = useCallback(async () => {
    // Wait up to 3s for S3 icons to finish loading so the modal doesn't pop in
    // with half-painted brand logos. 3s is a safety cap — on a warm cache this
    // resolves synchronously.
    await Promise.race([
      paymentIconsReadyRef.current,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    setPaymentSheetOpen(true);
  }, []);
  const [cancellingOrder, setCancellingOrder] = useState(false);
  const [latestOrder, setLatestOrder] = useState<Order | null>(null);
  const [checkoutForm, setCheckoutForm] = useState<CheckoutForm>({
    customerName: '',
    customerPhone: '',
    deliveryAddress: '',
    deliveryNotes: '',
    paymentMethod: 'phonepe',
  });
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<'new' | number>('new');
  const [forceCartView, setForceCartView] = useState(false);
  const [cartPopoverOpen, setCartPopoverOpen] = useState(false);
  const [error, setError] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [liveLocation, setLiveLocation] = useState<{
    latitude: number;
    longitude: number;
    capturedAt: number;
  } | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'capturing' | 'error'>('idle');
  const [locationError, setLocationError] = useState('');
  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<CouponPreview | null>(null);
  const [couponStatus, setCouponStatus] = useState<'idle' | 'applying' | 'error'>('idle');
  const [couponError, setCouponError] = useState('');
  const [publicCoupons, setPublicCoupons] = useState<PublicCoupon[]>([]);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [mood, setMood] = useState<WeatherMood>(() => moodFromIndiaCalendar());
  const [tempCategories, setTempCategories] = useState<TempCategory[]>([]);
  const [tempCategoryKey, setTempCategoryKey] = useState<string | null>(null);

  // Server-paginated catalog state — only fetched while the user is browsing
  // (category / brand / search / temp-category drilldown). Replaces the old
  // "fetch all products on mount" approach so cold load stays cheap.
  const [pageProducts, setPageProducts] = useState<Product[]>([]);
  const [pageNum, setPageNum] = useState(1);
  const [pageTotal, setPageTotal] = useState(0);
  const [pageHasMore, setPageHasMore] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);

  // Fetch sibling variants whenever quick-view opens. Cleared on close.
  useEffect(() => {
    if (!quickView) {
      setQuickViewVariants([]);
      return;
    }
    let cancelled = false;
    setQuickViewLoading(true);
    apiGetProductVariants(quickView.uniqueId)
      .then((variants) => {
        if (!cancelled) setQuickViewVariants(variants);
      })
      .catch(() => {
        if (!cancelled) setQuickViewVariants([]);
      })
      .finally(() => {
        if (!cancelled) setQuickViewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [quickView]);

  // Merge any product list into the cache so it's available everywhere.
  function ingestProducts(list: Product[]) {
    if (list.length === 0) return;
    setProductCache((current) => {
      let changed = false;
      const next = { ...current };
      for (const p of list) {
        if (next[p.uniqueId] !== p) {
          next[p.uniqueId] = p;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }

  function captureLocation(): Promise<{ latitude: number; longitude: number } | null> {
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      setLocationStatus('error');
      setLocationError(
        !window.isSecureContext
          ? 'Location requires HTTPS or localhost. Your browser blocked it.'
          : 'Your browser does not support location sharing.',
      );
      return Promise.resolve(null);
    }
    setLocationStatus('capturing');
    setLocationError('');
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
          setLiveLocation({ ...coords, capturedAt: Date.now() });
          setLocationStatus('idle');
          resolve(coords);
        },
        (err) => {
          setLocationStatus('error');
          setLocationError(
            err.code === err.PERMISSION_DENIED
              ? 'Location permission denied. The rider will use your address only.'
              : 'Unable to get your location. The rider will use your address only.',
          );
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      );
    });
  }

  function openAddressPicker(useCurrent: boolean) {
    setAddressPickerAutoLocate(useCurrent);
    setAddressPickerOpen(true);
  }

  function handleAddressPicked(picked: PickedMapAddress) {
    setCheckoutForm((current) => ({ ...current, deliveryAddress: picked.addressLine }));
    setLiveLocation({
      latitude: picked.latitude,
      longitude: picked.longitude,
      capturedAt: Date.now(),
    });
    setLocationStatus('idle');
    setLocationError('');
    setSelectedAddressId('new');
    setAddressPickerOpen(false);
  }

  useEffect(() => {
    Promise.all([apiGetCompanyPublic(), apiListCategories()])
      .then(([companyData, categoryData]) => {
        setCompany(companyData);
        setCategoryRows(categoryData);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Unable to load BestMart');
      })
      .finally(() => setInitialLoading(false));
    apiListPublicCoupons().then(setPublicCoupons).catch(() => {});
    apiListBrands().then(setBrandsList).catch(() => {});
    apiGetActiveCampaign().then(setActiveCampaign).catch(() => {});
  }, []);

  function dismissCampaign() {
    setCampaignDismissed(true);
    try { sessionStorage.setItem('bm:campaign:dismissed', '1'); } catch {}
  }

  function handleCampaignCategoryTap(categoryId: number) {
    const match = categoryRows.find((c) => c.id === categoryId);
    if (match) {
      setCategory(match.name);
      setSearch('');
      setBrandFilter(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    dismissCampaign();
  }

  // Fetch live weather to tailor the "perfect for today" picks. Prefers
  // the delivery location if the user already shared it, then falls back
  // to the company's store location if set. No extra geolocation prompt.
  useEffect(() => {
    const controller = new AbortController();
    const lat =
      liveLocation?.latitude ??
      (company?.storeLatitude != null ? company.storeLatitude : null);
    const lng =
      liveLocation?.longitude ??
      (company?.storeLongitude != null ? company.storeLongitude : null);
    if (lat == null || lng == null) return () => controller.abort();
    fetchOpenMeteoMood(lat, lng, controller.signal).then((next) => {
      if (next) setMood(next);
    });
    return () => controller.abort();
  }, [liveLocation?.latitude, liveLocation?.longitude, company?.storeLatitude, company?.storeLongitude]);

  // Auto-curated weekly buckets (Diwali Specials, Summer Coolers, …). The
  // backend prunes expired ones and upserts the active set on each call, so
  // re-fetching whenever mood changes keeps the storefront in sync.
  useEffect(() => {
    let cancelled = false;
    apiListTempCategories(mood)
      .then((rows) => {
        if (cancelled) return;
        setTempCategories(rows);
        for (const tc of rows) ingestProducts(tc.products);
      })
      .catch(() => {
        if (!cancelled) setTempCategories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mood]);

  // Homepage strips (offers / daily essentials / mood picks) come from one
  // bundled spotlight call instead of the full catalog. Re-fetched per mood
  // so the mood-picks row tracks the current weather.
  useEffect(() => {
    let cancelled = false;
    apiGetStorefrontSpotlight(mood)
      .then((data) => {
        if (cancelled) return;
        setSpotlight(data);
        ingestProducts([...data.offerProducts, ...data.dailyEssentials, ...data.moodPicks]);
      })
      .catch(() => {
        if (!cancelled) setSpotlight({ offerProducts: [], dailyEssentials: [], moodPicks: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [mood]);

  // Bestsellers + per-category rails. Cached server-side for 10 min; the
  // result also seeds productCache so cart and quick-view work immediately.
  useEffect(() => {
    let cancelled = false;
    apiGetHomeRails()
      .then((data) => {
        if (cancelled) return;
        setHomeRails(data);
        setVisibleRailCount(RAILS_PER_BATCH);
        const all = [...data.bestsellers, ...data.categoryRails.flatMap((r) => r.products)];
        ingestProducts(all);
      })
      .catch(() => {
        if (!cancelled) setHomeRails({ bestsellers: [], categoryRails: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reveal more category rails when the sentinel scrolls into view. Uses
  // rootMargin so we start loading a screen ahead of where the user is.
  useEffect(() => {
    if (!homeRails) return;
    const total = homeRails.categoryRails.length;
    if (visibleRailCount >= total) return;
    const node = railSentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisibleRailCount((n) => Math.min(total, n + RAILS_PER_BATCH));
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [homeRails, visibleRailCount]);

  // Fire-and-forget: log settled search queries to the backend so popular
  // searches can bias category ranking on the home page (Phase 2). Debounced
  // via useDeferredValue + a 700ms idle window to avoid logging every keystroke.
  useEffect(() => {
    const q = deferredSearch.trim();
    if (q.length < 2) return;
    const handle = window.setTimeout(() => {
      void apiLogSearch(q);
    }, 700);
    return () => window.clearTimeout(handle);
  }, [deferredSearch]);

  useEffect(() => {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    if (!user) {
      setSavedAddresses([]);
      setSelectedAddressId('new');
      return;
    }
    let cancelled = false;
    apiListAddresses()
      .then((addresses) => {
        if (cancelled) return;
        setSavedAddresses(addresses);
        if (addresses.length > 0) {
          const mostRecent = addresses[0];
          setSelectedAddressId(mostRecent.id);
          setCheckoutForm((current) => ({
            ...current,
            customerName: current.customerName || mostRecent.fullName,
            customerPhone: current.customerPhone || mostRecent.phone,
            deliveryAddress: current.deliveryAddress || mostRecent.deliveryAddress,
            deliveryNotes: current.deliveryNotes || mostRecent.deliveryNotes || '',
          }));
        } else {
          setCheckoutForm((current) => ({
            ...current,
            customerName: current.customerName || user.fullName || '',
            customerPhone: current.customerPhone || user.phone || '',
          }));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setCheckoutForm((current) => ({
          ...current,
          customerName: current.customerName || user.fullName || '',
          customerPhone: current.customerPhone || user.phone || '',
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  function handleSavedAddressPick(value: string) {
    if (value === 'new') {
      setSelectedAddressId('new');
      setCheckoutForm((current) => ({
        ...current,
        customerName: user?.fullName ?? '',
        customerPhone: user?.phone ?? '',
        deliveryAddress: '',
        deliveryNotes: '',
      }));
      return;
    }
    const id = Number(value);
    const picked = savedAddresses.find((a) => a.id === id);
    if (!picked) return;
    setSelectedAddressId(id);
    setCheckoutForm((current) => ({
      ...current,
      customerName: picked.fullName,
      customerPhone: picked.phone,
      deliveryAddress: picked.deliveryAddress,
      deliveryNotes: picked.deliveryNotes ?? '',
    }));
  }

  const productLookup = useMemo(() => {
    return new Map(Object.entries(productCache));
  }, [productCache]);

  // Hydrate cart items that aren't in the cache yet — happens on cold load
  // when localStorage holds uniqueIds we haven't seen since spotlight only
  // returns a subset of the catalog. Pull just the missing ones server-side.
  useEffect(() => {
    const missing = Object.keys(cart).filter((id) => !productCache[id]);
    if (missing.length === 0) return;
    apiGetProductsPage({ ids: missing, pageSize: missing.length })
      .then((res) => ingestProducts(res.products))
      .catch(() => {});
  }, [cart, productCache]);

  // Drop cart entries whose product is sold out or no longer exists. We can
  // only judge entries we have product data for — missing entries are left
  // alone until the hydration effect above resolves them.
  useEffect(() => {
    setCart((current) => {
      let changed = false;
      const next: Record<string, number> = {};

      for (const [uniqueId, quantity] of Object.entries(current)) {
        const product = productLookup.get(uniqueId);
        if (!product) {
          next[uniqueId] = quantity;
          continue;
        }
        if (!product.isActive || product.stockQuantity <= 0) {
          changed = true;
          continue;
        }

        const clampedQuantity = Math.min(quantity, product.stockQuantity);
        if (clampedQuantity !== quantity) {
          changed = true;
        }
        if (clampedQuantity > 0) {
          next[uniqueId] = clampedQuantity;
        }
      }

      return changed ? next : current;
    });
  }, [productLookup]);

  const categoryTiles = useMemo(() => {
    return categoryRows.map((row) => ({
      name: row.name,
      imageUrl: row.imageUrl,
    }));
  }, [categoryRows]);

  // Brand tiles: every active brand the company has registered. We no longer
  // know per-brand product counts up front (catalog isn't loaded), so we just
  // sort alphabetically and skip the count badge.
  const brandTiles = useMemo(() => {
    return [...brandsList]
      .map((b) => ({ name: b.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [brandsList]);

  const offerProducts = spotlight?.offerProducts ?? [];
  const moodPicks = spotlight?.moodPicks ?? [];
  const dailyEssentials = spotlight?.dailyEssentials ?? [];

  const checkoutMood = useMemo(() => moodFromHour(new Date().getHours()), []);
  const cachedProductsList = useMemo(() => Object.values(productCache), [productCache]);
  const checkoutPicks = useMemo(
    () => pickCheckoutTreats(cachedProductsList, checkoutMood, cart, 8),
    [cachedProductsList, checkoutMood, cart],
  );

  // Discounted items to surface at checkout — pulls from spotlight offers
  // first, falls back to any in-cache product with a markdown. Skips items
  // already in cart so we don't nag.
  const checkoutDeals = useMemo(() => {
    const seen = new Set<string>();
    const picks: Product[] = [];
    const isDiscount = (p: Product) =>
      p.isOnOffer ||
      (p.originalPriceCents != null && p.originalPriceCents > effectivePriceCents(p));
    const pool: Product[] = [
      ...(spotlight?.offerProducts ?? []),
      ...cachedProductsList,
    ];
    for (const p of pool) {
      if (seen.has(p.uniqueId)) continue;
      if (!p.isActive || p.stockQuantity <= 0) continue;
      if (cart[p.uniqueId]) continue;
      if (!isDiscount(p)) continue;
      seen.add(p.uniqueId);
      picks.push(p);
      if (picks.length >= 12) break;
    }
    return picks;
  }, [spotlight, cachedProductsList, cart]);

  const activeTempCategory = useMemo(
    () => (tempCategoryKey ? tempCategories.find((t) => t.autoKey === tempCategoryKey) ?? null : null),
    [tempCategoryKey, tempCategories],
  );

  // ── Server-paginated catalog ──────────────────────────────────────────
  // Only fetched while the user is browsing (category/brand/search/temp).
  // Replaces the old "load full catalog and slice client-side" approach.
  const PAGE_SIZE = 24;
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  // Temp categories already arrive with their product summaries, so when
  // a temp filter is active we render those directly (no /products/page hit).
  const visibleProducts = activeTempCategory ? activeTempCategory.products : pageProducts;
  const visibleTotal = activeTempCategory ? activeTempCategory.products.length : pageTotal;
  const visibleHasMore = activeTempCategory ? false : pageHasMore;
  const browsingMode =
    category !== 'All' ||
    Boolean(deferredSearch.trim()) ||
    Boolean(brandFilter);

  // Reset paging whenever the active filter changes.
  useEffect(() => {
    setPageNum(1);
  }, [category, deferredSearch, brandFilter]);

  // Fetch the requested page of catalog products from the server.
  useEffect(() => {
    if (!browsingMode || activeTempCategory) {
      // Nothing server-paged to load — clear so a stale list doesn't flash
      // when the user backs out of a filter.
      setPageProducts([]);
      setPageTotal(0);
      setPageHasMore(false);
      return;
    }
    let cancelled = false;
    setPageLoading(true);
    apiGetProductsPage({
      page: pageNum,
      pageSize: PAGE_SIZE,
      category,
      brand: brandFilter,
      q: deferredSearch.trim() || null,
    })
      .then((res) => {
        if (cancelled) return;
        ingestProducts(res.products);
        setPageProducts((current) => (pageNum === 1 ? res.products : [...current, ...res.products]));
        setPageTotal(res.total);
        setPageHasMore(res.hasMore);
      })
      .catch(() => {
        if (cancelled) return;
        if (pageNum === 1) {
          setPageProducts([]);
          setPageTotal(0);
        }
        setPageHasMore(false);
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [browsingMode, activeTempCategory, pageNum, category, brandFilter, deferredSearch]);

  // Sentinel: when the bottom-marker scrolls into view, ask for the next page.
  useEffect(() => {
    if (!visibleHasMore || pageLoading) return;
    const node = loadMoreRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setPageNum((n) => n + 1);
            break;
          }
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visibleHasMore, pageLoading]);

  const cartItems = useMemo(() => {
    return Object.entries(cart)
      .map(([uniqueId, quantity]) => {
        const product = productLookup.get(uniqueId);
        return product ? { product, quantity } : null;
      })
      .filter((entry): entry is { product: Product; quantity: number } => entry !== null);
  }, [cart, productLookup]);

  const subtotalCents = cartItems.reduce(
    (sum, item) => sum + lineTotalCents(item.product, item.quantity),
    0
  );
  const freeDeliveryThresholdCents = company?.settings?.freeDeliveryThresholdCents ?? 20000;
  const baseDeliveryFeeCents = company?.settings?.deliveryFeeCents ?? 4900;
  const deliveryFeeCents =
    subtotalCents >= freeDeliveryThresholdCents
      ? 0
      : cartItems.length > 0
        ? baseDeliveryFeeCents
        : 0;
  // Promo: 50% off up to ₹200 on orders above ₹500 (50000 cents).
  const promoDiscountCents =
    subtotalCents >= 50000 ? Math.min(Math.floor(subtotalCents / 2), 20000) : 0;
  const couponDiscountCents = appliedCoupon ? Math.min(appliedCoupon.discountCents, subtotalCents - promoDiscountCents) : 0;
  const discountCents = Math.min(promoDiscountCents + Math.max(couponDiscountCents, 0), subtotalCents);
  const totalCents = Math.max(subtotalCents + deliveryFeeCents - discountCents, 0);
  const trackUrl = latestOrder
    ? `${window.location.origin}${window.location.pathname}#track/${latestOrder.publicId}`
    : '';

  function updateQuantity(uniqueId: string, nextQuantity: number) {
    const product = productLookup.get(uniqueId);
    setCart((current) => {
      const next = { ...current };
      if (!product || product.stockQuantity <= 0 || nextQuantity <= 0) {
        delete next[uniqueId];
      } else {
        next[uniqueId] = Math.min(nextQuantity, product.stockQuantity);
      }
      return next;
    });
  }

  async function handlePlaceOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) {
      onOpenLogin();
      return;
    }
    if (!cartItems.length) {
      setError('Your cart is empty.');
      return;
    }

    setPlacingOrder(true);
    setError('');
    setCouponError('');

    try {
      // Location + coupon revalidation run without the busy overlay so it
      // doesn't cover the browser geolocation prompt.
      let coords = liveLocation
        ? { latitude: liveLocation.latitude, longitude: liveLocation.longitude }
        : null;
      if (!coords) {
        try {
          coords = await captureLocation();
        } catch {
          coords = null;
        }
      }
      if (!coords) {
        throw new Error(
          'Please share your delivery location (tap "Use my current location" above) — riders need it to find you.',
        );
      }

      if (appliedCoupon) {
        try {
          const fresh = await apiPreviewCoupon(appliedCoupon.code, subtotalCents);
          setAppliedCoupon(fresh);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Coupon is no longer valid.';
          setAppliedCoupon(null);
          setCouponError(msg);
          setCouponStatus('error');
          throw new Error('coupon_revalidation_failed');
        }
      }

      // phonepe / gpay / paytm: try the Razorpay S2S UPI Intent API first
      // (direct app launch, Blinkit-style). If Razorpay rejects it (e.g. S2S
      // not enabled on this account), fall back to Standard Checkout with
      // the chosen app pre-selected so the customer still only sees one tap.
      //
      // `razorpay` always uses Standard Checkout (cards / netbanking / other
      // UPI apps). It must run OUTSIDE withBusy — the BusyOverlay sits on
      // top of the Razorpay iframe otherwise and blocks card entry.
      //
      // Either way, the BestMart order is only committed AFTER payment (or
      // an accepted pending intent), so a failed payment never leaves a
      // stale unpaid order behind.
      const uiMethod = checkoutForm.paymentMethod;
      const UPI_APP_MAP: Record<string, PreferredUpiApp> = {
        phonepe: 'phonepe',
        gpay: 'google_pay',
        paytm: 'paytm',
      };
      const preferredUpiApp = UPI_APP_MAP[uiMethod];
      const isIntentPayment = Boolean(preferredUpiApp);
      const isWidgetPayment = uiMethod === 'razorpay';
      const isOnlinePayment = isIntentPayment || isWidgetPayment;
      const wirePaymentMethod = isOnlinePayment ? 'razorpay' : uiMethod;

      let razorpayPayload: RazorpaySuccess | null = null;
      let intentLaunchUrl: string | null = null;
      let pendingRazorpayOrderId: string | null = null;
      if (isWidgetPayment) {
        const intent = await apiCreatePaymentIntent(totalCents);
        razorpayPayload = await openRazorpayCheckout({
          keyId: intent.keyId,
          razorpayOrderId: intent.razorpayOrderId,
          amount: intent.amount,
          currency: intent.currency,
          customerName: checkoutForm.customerName,
          customerPhone: checkoutForm.customerPhone,
        });
      } else if (isIntentPayment && preferredUpiApp) {
        const intent = await apiCreatePaymentIntent(totalCents);
        try {
          const launch = await apiCreateUpiIntent({
            razorpayOrderId: intent.razorpayOrderId,
            amountCents: intent.amount,
            upiApp: preferredUpiApp,
            contact: checkoutForm.customerPhone,
          });
          intentLaunchUrl = launch.intentUrl;
          pendingRazorpayOrderId = intent.razorpayOrderId;
        } catch (intentErr) {
          // Fall back to Standard Checkout with the chosen UPI app
          // pre-selected. This reuses the SAME Razorpay order so we don't
          // double-charge if the user retries.
          console.warn('[checkout] UPI intent fallback to widget:', intentErr);
          razorpayPayload = await openRazorpayCheckout({
            keyId: intent.keyId,
            razorpayOrderId: intent.razorpayOrderId,
            amount: intent.amount,
            currency: intent.currency,
            customerName: checkoutForm.customerName,
            customerPhone: checkoutForm.customerPhone,
            preferredUpiApp,
          });
        }
      }

      const finalCoords = coords;
      const order = await withBusy('Placing your order…', async () =>
        apiCreateOrder({
          customerName: checkoutForm.customerName,
          customerPhone: checkoutForm.customerPhone,
          deliveryAddress: checkoutForm.deliveryAddress,
          deliveryNotes: checkoutForm.deliveryNotes,
          paymentMethod: wirePaymentMethod,
          items: cartItems.map((item) => ({
            productId: item.product.uniqueId,
            quantity: item.quantity,
          })),
          deliveryLatitude: finalCoords.latitude,
          deliveryLongitude: finalCoords.longitude,
          couponCode: appliedCoupon?.code ?? null,
          razorpayOrderId:
            razorpayPayload?.razorpayOrderId ?? pendingRazorpayOrderId ?? undefined,
          razorpayPaymentId: razorpayPayload?.razorpayPaymentId,
          razorpaySignature: razorpayPayload?.razorpaySignature,
        }),
      );

      if (intentLaunchUrl) {
        setLatestOrder(order);
        setCart({});
        setAppliedCoupon(null);
        setCouponInput('');
        window.location.href = intentLaunchUrl;
        return;
      }

      setLatestOrder(order);
      setCart({});
      setAppliedCoupon(null);
      setCouponInput('');
      setCheckoutForm((current) => ({
        ...current,
        deliveryNotes: '',
      }));
    } catch (err) {
      // Re-validation failed — already surfaced in coupon UI; don't double-show.
      if (err instanceof Error && err.message === 'coupon_revalidation_failed') {
        setError('Your coupon is no longer valid. Update or remove it and try again.');
      } else if (err instanceof ApiError && err.data?.couponError) {
        setAppliedCoupon(null);
        setCouponError(err.message);
        setCouponStatus('error');
        setError('Your coupon is no longer valid. Update or remove it and try again.');
      } else {
        setError(err instanceof Error ? err.message : 'Unable to place your order');
      }
    } finally {
      setPlacingOrder(false);
    }
  }

  async function handleCancelLatest() {
    if (!latestOrder) return;
    const confirmed = await confirm({
      title: 'Cancel this order?',
      message: `Order ${latestOrder.publicId} will be cancelled. This cannot be undone.`,
      confirmLabel: 'Cancel Order',
      cancelLabel: 'Keep Order',
      tone: 'danger',
    });
    if (!confirmed) return;
    setCancellingOrder(true);
    setError('');
    try {
      const updated = await apiCancelOrder(latestOrder.publicId);
      setLatestOrder(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to cancel order');
    } finally {
      setCancellingOrder(false);
    }
  }

  async function handleApplyCoupon() {
    const code = couponInput.trim();
    if (!code) return;
    if (subtotalCents <= 0) {
      setCouponError('Add items to your cart first.');
      setCouponStatus('error');
      return;
    }
    setCouponStatus('applying');
    setCouponError('');
    try {
      const preview = await apiPreviewCoupon(code, subtotalCents);
      setAppliedCoupon(preview);
      setCouponStatus('idle');
    } catch (err) {
      setAppliedCoupon(null);
      setCouponError(err instanceof Error ? err.message : 'Could not apply coupon');
      setCouponStatus('error');
    }
  }

  function handleRemoveCoupon() {
    setAppliedCoupon(null);
    setCouponInput('');
    setCouponError('');
    setCouponStatus('idle');
  }

  function handleCopyCoupon(code: string) {
    setCouponInput(code);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(code).catch(() => {});
    }
    setCopiedCode(code);
    window.setTimeout(() => setCopiedCode((c) => (c === code ? null : c)), 1800);
  }

  // Re-validate the coupon when subtotal changes so users see live feedback.
  useEffect(() => {
    if (!appliedCoupon) return;
    if (subtotalCents <= 0) {
      setAppliedCoupon(null);
      return;
    }
    apiPreviewCoupon(appliedCoupon.code, subtotalCents)
      .then((p) => setAppliedCoupon(p))
      .catch(() => {
        setAppliedCoupon(null);
        setCouponError('Coupon no longer applies to this cart.');
        setCouponStatus('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtotalCents]);

  const latestCancellable = Boolean(
    latestOrder && ['placed', 'confirmed', 'packing'].includes(latestOrder.status),
  );

  const canTrackFromHero = Boolean(trackingCode.trim() || latestOrder?.publicId);
  const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const isBrowsing =
    category !== 'All' ||
    Boolean(deferredSearch.trim()) ||
    Boolean(brandFilter) ||
    Boolean(tempCategoryKey) ||
    forceCartView;

  function renderRailCard(product: Product, source: string, railCategoryId?: number | null) {
    const inCart = cart[product.uniqueId];
    const logClick = () => {
      void apiLogClick({
        productId: product.id,
        categoryId: railCategoryId ?? product.categoryId ?? null,
        source,
      });
    };
    return (
      <article key={product.uniqueId} className="daily-essential-card">
        <div className="daily-essential-card__thumb">
          {product.imageUrl && (
            <img
              src={product.imageUrl}
              alt={product.name}
              loading="lazy"
              className="daily-essential-card__thumb-img"
            />
          )}
        </div>
        <div className="daily-essential-card__body">
          <strong className="daily-essential-card__name">{product.name}</strong>
          <span className="daily-essential-card__meta">{product.unitLabel}</span>
          <div className="daily-essential-card__price-row">
            <strong>{formatCurrency(effectivePriceCents(product))}</strong>
            {product.originalPriceCents && product.originalPriceCents > effectivePriceCents(product) ? (
              <span className="daily-essential-card__strike">
                {formatCurrency(product.originalPriceCents)}
              </span>
            ) : null}
          </div>
          {inCart ? (
            <div className="qty-stepper">
              <button type="button" onClick={() => updateQuantity(product.uniqueId, inCart - 1)}>−</button>
              <span>{inCart}</span>
              <button
                type="button"
                disabled={inCart >= product.stockQuantity}
                onClick={() => updateQuantity(product.uniqueId, inCart + 1)}
              >+</button>
            </div>
          ) : (
            <button
              type="button"
              className="daily-essential-card__add"
              disabled={product.stockQuantity <= 0}
              onClick={() => {
                logClick();
                updateQuantity(product.uniqueId, 1);
              }}
            >
              {product.stockQuantity <= 0 ? 'Sold out' : '+ Add'}
            </button>
          )}
        </div>
      </article>
    );
  }

  function handleGoHome() {
    setCategory('All');
    setSearch('');
    setBrandFilter(null);
    setTempCategoryKey(null);
    setForceCartView(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleOpenCart() {
    setForceCartView(true);
    setTimeout(() => {
      const el = document.querySelector('.cart-panel');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }

  return (
    <main className="store-shell">
      {activeCampaign && activeCampaign.imageUrl && !campaignDismissed && (
        <div
          className="campaign-popup__backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={activeCampaign.title || 'Special overlay'}
          onClick={dismissCampaign}
        >
          <div className="campaign-popup__card" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="campaign-popup__close"
              onClick={dismissCampaign}
              aria-label="Close overlay"
            >
              ✕
            </button>
            <img
              src={activeCampaign.imageUrl}
              alt={activeCampaign.title || 'Special offer'}
              className="campaign-popup__image"
              onClick={dismissCampaign}
            />
            {activeCampaign.categories && activeCampaign.categories.length > 0 && (
              <div className="campaign-popup__chips">
                {activeCampaign.categories.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    className="campaign-popup__chip"
                    onClick={() => handleCampaignCategoryTap(cat.id)}
                  >
                    {cat.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Sticky top bar — back | logo | address | search | login | cart */}
      <header className="store-topbar store-topbar--v2">
        {isBrowsing ? (
          <button
            type="button"
            className="store-topbar__back"
            onClick={handleGoHome}
            aria-label="Back to home"
            title="Back"
          >
            ← Back
          </button>
        ) : null}
        <button
          type="button"
          className="store-topbar__brand"
          onClick={handleGoHome}
        >
          <img src="/bestmart-logo.svg" alt="BestMart" className="store-topbar__logo" loading="eager" />
        </button>

        <div className="store-topbar__address" title={savedAddresses[0]?.deliveryAddress ?? ''}>
          <strong>Delivery in 15 minutes</strong>
          <span>
            {savedAddresses[0]?.deliveryAddress ??
              (user ? 'Add a delivery address at checkout' : 'Log in to save an address')}
          </span>
        </div>

        <div className="store-topbar__search">
          <span className="store-topbar__search-icon">⌕</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder='Search "chocolate"'
          />
        </div>

        <div className="store-topbar__actions">
          <button
            type="button"
            className="store-topbar__btn"
            disabled={!canTrackFromHero}
            onClick={() => onTrack((trackingCode.trim() || latestOrder?.publicId || '').trim())}
          >
            Track
          </button>
          {user ? (
            <>
              {(user.role === 'admin' || user.role === 'editor') && (
                <button
                  type="button"
                  className="store-topbar__btn"
                  onClick={onOpenDashboard}
                >
                  Dashboard
                </button>
              )}
              <button
                type="button"
                className="store-topbar__btn"
                onClick={onOpenMyOrders}
              >
                My Orders
              </button>
              <span className="store-topbar__user" title={user.email}>
                {user.fullName || user.email}
              </span>
              <button
                type="button"
                className="store-topbar__btn"
                onClick={onLogout}
              >
                Log Out
              </button>
            </>
          ) : (
            <button
              type="button"
              className="store-topbar__btn"
              onClick={onOpenLogin}
            >
              Login
            </button>
          )}
          <button
            type="button"
            className="store-topbar__cart"
            onClick={handleOpenCart}
            disabled={cartCount === 0}
            title={cartCount === 0 ? 'Your cart is empty' : 'Open cart'}
          >
            <span className="store-topbar__cart-icon">🛒</span>
            {cartCount > 0 ? `My Cart (${cartCount})` : 'My Cart'}
          </button>
        </div>
      </header>

      <div className="store-inner">

      {initialLoading ? (
        <div className="store-loading">
          <div className="store-loading__orb" />
          <p>Loading fresh groceries…</p>
        </div>
      ) : !isBrowsing ? (
        <>
          {offerProducts.length > 0 ? (
            <LazyMount placeholderHeight={360}>
            <section className="todays-offer">
              <div className="todays-offer__head">
                <div>
                  <span className="todays-offer__badge">TODAY'S OFFER</span>
                  <h2>Hand-picked deals, just for today</h2>
                </div>
              </div>
              <div className="todays-offer__grid">
                {offerProducts.map((product) => (
                  <article key={product.uniqueId} className="todays-offer__card">
                    <div className="todays-offer__thumb">
                      {product.imageUrl && <img src={product.imageUrl} alt={product.name} loading="lazy" className="todays-offer__thumb-img" />}
                      <span className="todays-offer__flag">
                        {isBogoProduct(product) ? `Buy ${product.bogoBuyQty} Get ${product.bogoGetQty}` : 'Offer'}
                      </span>
                    </div>
                    <div className="todays-offer__body">
                      <strong>{product.name}</strong>
                      <span className="todays-offer__meta">{product.unitLabel}</span>
                      <div className="todays-offer__price-row">
                        <strong>{formatCurrency(effectivePriceCents(product))}</strong>
                        {isBogoProduct(product) ? (
                          <span className="todays-offer__bogo">+{bogoGet(product)} FREE</span>
                        ) : product.offerPriceCents != null &&
                          product.offerPriceCents < product.priceCents ? (
                          <span className="todays-offer__strike">
                            {formatCurrency(product.priceCents)}
                          </span>
                        ) : product.originalPriceCents ? (
                          <span className="todays-offer__strike">
                            {formatCurrency(product.originalPriceCents)}
                          </span>
                        ) : null}
                      </div>
                      {cart[product.uniqueId] ? (
                        <div className="qty-stepper">
                          <button
                            type="button"
                            onClick={() =>
                              updateQuantity(product.uniqueId, cart[product.uniqueId] - 1)
                            }
                          >
                            -
                          </button>
                          <span>{cart[product.uniqueId]}</span>
                          <button
                            type="button"
                            disabled={cart[product.uniqueId] >= product.stockQuantity}
                            onClick={() =>
                              updateQuantity(product.uniqueId, cart[product.uniqueId] + 1)
                            }
                          >
                            +
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={product.stockQuantity <= 0}
                          onClick={() => updateQuantity(product.uniqueId, 1)}
                        >
                          {product.stockQuantity <= 0 ? 'Sold Out' : 'Add to cart'}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
            </LazyMount>
          ) : null}

          {publicCoupons.length > 0 && (
            <section className="coupon-banners">
              <div className="coupon-banners__head">
                <div>
                  <span className="coupon-banners__eyebrow">🎟  Limited-time offers</span>
                  <h2>Save more with coupon codes</h2>
                  <p>Tap a coupon to copy the code — apply it at checkout to claim the discount.</p>
                </div>
                {user?.role === 'admin' && (
                  <button
                    type="button"
                    className="coupon-banners__manage"
                    onClick={onOpenDashboard}
                  >
                    Manage coupons →
                  </button>
                )}
              </div>
              <div className="coupon-banners__row">
                {publicCoupons.map((c, idx) => {
                  const palettes = [
                    { from: '#0d9488', to: '#0f766e', ink: '#fff' },
                    { from: '#f59e0b', to: '#d97706', ink: '#1f1300' },
                    { from: '#6366f1', to: '#4f46e5', ink: '#fff' },
                    { from: '#ec4899', to: '#db2777', ink: '#fff' },
                    { from: '#0ea5e9', to: '#0369a1', ink: '#fff' },
                  ];
                  const palette = palettes[idx % palettes.length];
                  const discountBig = c.discountType === 'percent'
                    ? `${c.discountValue}%`
                    : `₹${(c.discountValue / 100).toFixed(0)}`;
                  const minLabel = c.minSubtotalCents > 0
                    ? `Min order ₹${(c.minSubtotalCents / 100).toFixed(0)}`
                    : 'No minimum';
                  const capLabel = c.discountType === 'percent' && c.maxDiscountCents != null
                    ? `Up to ₹${(c.maxDiscountCents / 100).toFixed(0)}`
                    : null;
                  const expiryLabel = c.validUntil
                    ? `Valid until ${new Date(c.validUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
                    : 'No expiry';
                  const isCopied = copiedCode === c.code;
                  return (
                    <article
                      key={c.code}
                      className="coupon-banner"
                      style={{
                        background: `linear-gradient(135deg, ${palette.from} 0%, ${palette.to} 100%)`,
                        color: palette.ink,
                      }}
                    >
                      <div className="coupon-banner__decor" aria-hidden />
                      <div className="coupon-banner__main">
                        <div className="coupon-banner__discount">
                          <span className="coupon-banner__discount-num">{discountBig}</span>
                          <span className="coupon-banner__discount-label">
                            {c.discountType === 'percent' ? 'OFF' : 'OFF'}
                          </span>
                        </div>
                        <div className="coupon-banner__info">
                          {c.description ? (
                            <p className="coupon-banner__desc">{c.description}</p>
                          ) : (
                            <p className="coupon-banner__desc">Save big on your next order.</p>
                          )}
                          <div className="coupon-banner__meta">
                            <span>{minLabel}</span>
                            {capLabel && <span>{capLabel}</span>}
                            <span>{expiryLabel}</span>
                          </div>
                        </div>
                      </div>
                      <div className="coupon-banner__foot">
                        <div className="coupon-banner__code-wrap">
                          <span className="coupon-banner__code-label">Code</span>
                          <span className="coupon-banner__code">{c.code}</span>
                        </div>
                        <button
                          type="button"
                          className="coupon-banner__copy"
                          onClick={() => handleCopyCoupon(c.code)}
                        >
                          {isCopied ? '✓ Copied!' : 'Copy code'}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {tempCategories.length > 0 && (
            <section className="temp-categories">
              <div className="temp-categories__head">
                <span className="temp-categories__eyebrow">✨ This week on BestMart</span>
                <h2>Curated for the season</h2>
                <p>Auto-picked based on the weather and the festival calendar — refreshed every week.</p>
              </div>

              {tempCategories.map((tc) => {
                const items = tc.products.slice(0, 12);
                if (items.length === 0) return null;
                return (
                  <article key={tc.autoKey} className={`temp-section temp-section--${tc.theme}`}>
                    <div className="temp-section__head">
                      <div className="temp-section__head-text">
                        <h3 className="temp-section__title">{tc.name}</h3>
                        <span className="temp-section__count">
                          {tc.productIds.length} pick{tc.productIds.length === 1 ? '' : 's'} this week
                        </span>
                      </div>
                      <button
                        type="button"
                        className="temp-section__view-all"
                        onClick={() => {
                          setTempCategoryKey(tc.autoKey);
                          setCategory('All');
                          setBrandFilter(null);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        View all →
                      </button>
                    </div>
                    <div className="daily-essentials__row">
                      {items.map((product) => (
                        <article key={product.uniqueId} className="daily-essential-card">
                          <div className="daily-essential-card__thumb">
                            {product.imageUrl && (
                              <img
                                src={product.imageUrl}
                                alt={product.name}
                                loading="lazy"
                                className="daily-essential-card__thumb-img"
                              />
                            )}
                          </div>
                          <div className="daily-essential-card__body">
                            <strong className="daily-essential-card__name">{product.name}</strong>
                            <span className="daily-essential-card__meta">{product.unitLabel}</span>
                            <div className="daily-essential-card__price-row">
                              <strong>{formatCurrency(effectivePriceCents(product))}</strong>
                              {product.originalPriceCents && product.originalPriceCents > effectivePriceCents(product) ? (
                                <span className="daily-essential-card__strike">
                                  {formatCurrency(product.originalPriceCents)}
                                </span>
                              ) : null}
                            </div>
                            {cart[product.uniqueId] ? (
                              <div className="qty-stepper">
                                <button
                                  type="button"
                                  onClick={() => updateQuantity(product.uniqueId, cart[product.uniqueId] - 1)}
                                >−</button>
                                <span>{cart[product.uniqueId]}</span>
                                <button
                                  type="button"
                                  disabled={cart[product.uniqueId] >= product.stockQuantity}
                                  onClick={() => updateQuantity(product.uniqueId, cart[product.uniqueId] + 1)}
                                >+</button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="daily-essential-card__add"
                                disabled={product.stockQuantity <= 0}
                                onClick={() => updateQuantity(product.uniqueId, 1)}
                              >
                                {product.stockQuantity <= 0 ? 'Sold out' : '+ Add'}
                              </button>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  </article>
                );
              })}
            </section>
          )}

          {moodPicks.length > 0 && (
            <LazyMount placeholderHeight={300}>
            <section className={`weather-picks weather-picks--${mood}`}>
              <div className="weather-picks__head">
                <span className="weather-picks__eyebrow">
                  {MOOD_COPY[mood].emoji} {MOOD_COPY[mood].eyebrow}
                </span>
                <h2>{MOOD_COPY[mood].title}</h2>
                <p>{MOOD_COPY[mood].subtitle}</p>
              </div>
              <div className="daily-essentials__row">
                {moodPicks.map((product) => (
                  <article key={product.uniqueId} className="daily-essential-card">
                    <div className="daily-essential-card__thumb">
                      {product.imageUrl && (
                        <img
                          src={product.imageUrl}
                          alt={product.name}
                          loading="lazy"
                          className="daily-essential-card__thumb-img"
                        />
                      )}
                    </div>
                    <div className="daily-essential-card__body">
                      <strong className="daily-essential-card__name">{product.name}</strong>
                      <span className="daily-essential-card__meta">{product.unitLabel}</span>
                      <div className="daily-essential-card__price-row">
                        <strong>{formatCurrency(effectivePriceCents(product))}</strong>
                        {product.originalPriceCents && product.originalPriceCents > effectivePriceCents(product) ? (
                          <span className="daily-essential-card__strike">
                            {formatCurrency(product.originalPriceCents)}
                          </span>
                        ) : null}
                      </div>
                      {cart[product.uniqueId] ? (
                        <div className="qty-stepper">
                          <button
                            type="button"
                            onClick={() => updateQuantity(product.uniqueId, cart[product.uniqueId] - 1)}
                          >−</button>
                          <span>{cart[product.uniqueId]}</span>
                          <button
                            type="button"
                            disabled={cart[product.uniqueId] >= product.stockQuantity}
                            onClick={() => updateQuantity(product.uniqueId, cart[product.uniqueId] + 1)}
                          >+</button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="daily-essential-card__add"
                          disabled={product.stockQuantity <= 0}
                          onClick={() => updateQuantity(product.uniqueId, 1)}
                        >
                          {product.stockQuantity <= 0 ? 'Sold out' : '+ Add'}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
            </LazyMount>
          )}

          {dailyEssentials.length > 0 && (
            <LazyMount placeholderHeight={320}>
              <section className="daily-essentials">
                <div className="daily-essentials__head">
                  <span className="daily-essentials__eyebrow">🛒 Daily essentials</span>
                  <h2>Buy these on repeat</h2>
                  <p>The staples your kitchen runs on — one tap to add.</p>
                </div>
                <div className="daily-essentials__row">
                  {dailyEssentials.map((product) => (
                    <article key={product.uniqueId} className="daily-essential-card">
                      <div className="daily-essential-card__thumb">
                        {product.imageUrl && (
                          <img
                            src={product.imageUrl}
                            alt={product.name}
                            loading="lazy"
                            className="daily-essential-card__thumb-img"
                          />
                        )}
                      </div>
                      <div className="daily-essential-card__body">
                        <strong className="daily-essential-card__name">{product.name}</strong>
                        <span className="daily-essential-card__meta">{product.unitLabel}</span>
                        <div className="daily-essential-card__price-row">
                          <strong>{formatCurrency(effectivePriceCents(product))}</strong>
                          {product.originalPriceCents && product.originalPriceCents > effectivePriceCents(product) ? (
                            <span className="daily-essential-card__strike">
                              {formatCurrency(product.originalPriceCents)}
                            </span>
                          ) : null}
                        </div>
                        {cart[product.uniqueId] ? (
                          <div className="qty-stepper">
                            <button
                              type="button"
                              onClick={() => updateQuantity(product.uniqueId, cart[product.uniqueId] - 1)}
                            >−</button>
                            <span>{cart[product.uniqueId]}</span>
                            <button
                              type="button"
                              disabled={cart[product.uniqueId] >= product.stockQuantity}
                              onClick={() => updateQuantity(product.uniqueId, cart[product.uniqueId] + 1)}
                            >+</button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="daily-essential-card__add"
                            disabled={product.stockQuantity <= 0}
                            onClick={() => updateQuantity(product.uniqueId, 1)}
                          >
                            {product.stockQuantity <= 0 ? 'Sold out' : '+ Add'}
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </LazyMount>
          )}

          {!isBrowsing && homeRails && homeRails.bestsellers.length > 0 && (
            <LazyMount placeholderHeight={340}>
              <section className="home-rail home-rail--featured">
                <div className="home-rail__head">
                  <div>
                    <span className="home-rail__eyebrow">⭐ Bestsellers</span>
                    <h2>Most popular this month</h2>
                    <p>What other shoppers are loving right now.</p>
                  </div>
                </div>
                <div className="home-rail__row">
                  {homeRails.bestsellers.map((p) => renderRailCard(p, 'home_rail_bestsellers'))}
                </div>
              </section>
            </LazyMount>
          )}

          {!isBrowsing && homeRails?.categoryRails.slice(0, visibleRailCount).map((rail) => (
            rail.products.length > 0 ? (
              <LazyMount key={rail.id} placeholderHeight={320}>
                <section className="home-rail">
                  <div className="home-rail__head">
                    <div>
                      <h2>Top in {rail.name}</h2>
                    </div>
                    <button
                      type="button"
                      className="home-rail__see-all"
                      onClick={() => {
                        setCategory(rail.name);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      See all →
                    </button>
                  </div>
                  <div className="home-rail__row">
                    {rail.products.map((p) => renderRailCard(p, 'home_rail_category', rail.id))}
                  </div>
                </section>
              </LazyMount>
            ) : null
          ))}

          {!isBrowsing && homeRails && visibleRailCount < homeRails.categoryRails.length && (
            <div ref={railSentinelRef} className="home-rail__sentinel" aria-hidden="true" />
          )}

          <LazyMount placeholderHeight={260}>
          <section className="category-grid">
            {categoryTiles.map((tile) => (
              <button
                type="button"
                key={tile.name}
                className="category-tile"
                onClick={() => setCategory(tile.name)}
              >
                <div className="category-tile__thumb">
                  {tile.imageUrl && <img src={tile.imageUrl} alt={tile.name} loading="lazy" className="category-tile__thumb-img" />}
                </div>
                <span>{tile.name}</span>
              </button>
            ))}
          </section>
          </LazyMount>

          {brandTiles.length > 0 && (
            <LazyMount placeholderHeight={220}>
              <section className="brand-strip">
                <div className="brand-strip__head">
                  <span className="brand-strip__eyebrow">🏷️ Shop by brand</span>
                  <h2>Find your favourite brands</h2>
                  <p>Tap a brand to filter the catalog.</p>
                </div>
                <div className="brand-strip__row">
                  {brandTiles.map((b) => {
                    const initials = b.name
                      .split(/\s+/)
                      .map((w) => w[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase();
                    return (
                      <button
                        key={b.name}
                        type="button"
                        className="brand-tile"
                        onClick={() => {
                          setBrandFilter(b.name);
                          setCategory('All');
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        <span className="brand-tile__avatar" aria-hidden>{initials}</span>
                        <span className="brand-tile__name">{b.name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </LazyMount>
          )}

          <LazyMount placeholderHeight={400}>
          <footer className="home-footer">
            <div className="home-footer__top">
              <div className="home-footer__brand">
                <div className="home-footer__logo">
                  <span className="home-footer__logo-mark">B</span>
                  <span className="home-footer__logo-name">
                    {company?.name ?? 'BestMart'}
                  </span>
                </div>
                <p className="home-footer__tagline">
                  Fresh groceries and daily essentials, delivered to your door in minutes.
                </p>
                <div className="home-footer__badges">
                  <span className="home-footer__badge">
                    <span className="home-footer__badge-dot" /> Fresh daily
                  </span>
                  <span className="home-footer__badge">
                    <span className="home-footer__badge-dot" /> Fast delivery
                  </span>
                </div>
              </div>

              <div className="home-footer__col">
                <h3>Shop</h3>
                <ul>
                  {FOOTER_USEFUL_LINKS.map((link) => (
                    <li key={link}>
                      <a href="#" className="home-footer__link">{link}</a>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="home-footer__col">
                <h3>Company</h3>
                <ul>
                  <li><a href="#" className="home-footer__link">About us</a></li>
                  <li><a href="#" className="home-footer__link">Careers</a></li>
                  <li><a href="#" className="home-footer__link">Terms &amp; Privacy</a></li>
                </ul>
              </div>

              <div className="home-footer__col home-footer__col--contact">
                <h3>Get in touch</h3>
                <ul>
                  <li>
                    <a
                      className="home-footer__contact"
                      href={`mailto:${company?.supportEmail ?? 'support@bestmart.local'}`}
                    >
                      <span className="home-footer__contact-icon" aria-hidden>✉</span>
                      <span>{company?.supportEmail ?? 'support@bestmart.local'}</span>
                    </a>
                  </li>
                  <li>
                    <a
                      className="home-footer__contact"
                      href={`tel:${(company?.supportPhone ?? '1800-BESTMART').replace(/\s+/g, '')}`}
                    >
                      <span className="home-footer__contact-icon" aria-hidden>☎</span>
                      <span>{company?.supportPhone ?? '1800-BESTMART'}</span>
                    </a>
                  </li>
                </ul>
              </div>
            </div>

            <div className="home-footer__bottom">
              <span className="home-footer__copyright">
                © {new Date().getFullYear()} {company?.name ?? 'BestMart'}. All rights reserved.
              </span>
              <span className="home-footer__legal">
                <a href="#" className="home-footer__link">Privacy</a>
                <span aria-hidden>·</span>
                <a href="#" className="home-footer__link">Terms</a>
                <span aria-hidden>·</span>
                <a href="#" className="home-footer__link">Help</a>
              </span>
            </div>
          </footer>
          </LazyMount>
        </>
      ) : null}

      {error ? <div className="message message--error">{error}</div> : null}

      {!initialLoading && isBrowsing ? (
      <section className={`store-layout${forceCartView ? '' : ' store-layout--no-cart'}`}>
        <div className="catalog-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Catalog</p>
              <h2>
                {activeTempCategory
                  ? activeTempCategory.name
                  : brandFilter
                  ? `${brandFilter} products`
                  : 'Shop fresh groceries and daily essentials.'}
              </h2>
              {activeTempCategory && (
                <button
                  type="button"
                  className="active-filter"
                  onClick={() => setTempCategoryKey(null)}
                >
                  {activeTempCategory.name} <span aria-hidden>✕</span>
                </button>
              )}
              {brandFilter && (
                <button
                  type="button"
                  className="active-filter"
                  onClick={() => setBrandFilter(null)}
                >
                  Brand: {brandFilter} <span aria-hidden>✕</span>
                </button>
              )}
            </div>
            <p>
              {visibleTotal > 0
                ? `${visibleTotal} item${visibleTotal === 1 ? '' : 's'} ready for checkout`
                : pageLoading
                  ? 'Loading…'
                  : 'No matching items'}
            </p>
          </div>

          <div className="product-grid">
            {visibleProducts.map((product) => (
              <article
                className={
                  product.stockQuantity <= 0 ? 'product-card product-card--sold-out' : 'product-card'
                }
                key={product.uniqueId}
              >
                <div
                  className="product-card__media"
                  role="button"
                  tabIndex={0}
                  onClick={() => setQuickView(product)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setQuickView(product);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  {product.imageUrl && <img src={product.imageUrl} alt={product.name} loading="lazy" className="product-card__media-img" />}
                  {product.stockQuantity <= 5 ? (
                    <div className="badge-stack">
                      {product.stockQuantity <= 0 ? (
                        <span className="badge badge--sold-out">Sold Out</span>
                      ) : (
                        <span className="badge badge--low-stock">
                          Only {product.stockQuantity} Left
                        </span>
                      )}
                    </div>
                  ) : null}
                </div>
                <div className="product-card__body">
                  <div className="product-card__meta">
                    {product.brand && (
                      <span className="product-card__brand">{product.brand}</span>
                    )}
                    <span>{product.category}</span>
                    <span>{product.unitLabel}</span>
                  </div>
                  <h3>{product.name}</h3>
                  <p>{product.description}</p>
                  <p
                    className={
                      product.stockQuantity <= 0
                        ? 'product-card__stock product-card__stock--sold-out'
                        : product.stockQuantity <= 5
                          ? 'product-card__stock product-card__stock--low'
                          : 'product-card__stock'
                    }
                  >
                    {product.stockQuantity <= 0
                      ? 'Currently unavailable'
                      : product.stockQuantity <= 5
                        ? `${product.stockQuantity} units left for fast checkout`
                        : `${product.stockQuantity} units ready to dispatch`}
                  </p>
                </div>
                <div className="product-card__footer">
                  <div>
                    <strong>{formatCurrency(effectivePriceCents(product))}</strong>
                    {isBogoProduct(product) ? (
                      <span className="product-card__bogo">{bogoLabel(product)}</span>
                    ) : product.isOnOffer && product.offerPriceCents != null ? (
                      <span>{formatCurrency(product.priceCents)}</span>
                    ) : product.originalPriceCents ? (
                      <span>{formatCurrency(product.originalPriceCents)}</span>
                    ) : null}
                  </div>
                  {cart[product.uniqueId] ? (
                    <div className="qty-stepper">
                      <button
                        type="button"
                        onClick={() => updateQuantity(product.uniqueId, cart[product.uniqueId] - 1)}
                      >
                        -
                      </button>
                      <span>{cart[product.uniqueId]}</span>
                      <button
                        type="button"
                        disabled={cart[product.uniqueId] >= product.stockQuantity}
                        onClick={() => updateQuantity(product.uniqueId, cart[product.uniqueId] + 1)}
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={product.stockQuantity <= 0}
                      onClick={() => updateQuantity(product.uniqueId, 1)}
                    >
                      {product.stockQuantity <= 0 ? 'Sold Out' : 'Add'}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {visibleHasMore ? (
            <div
              ref={loadMoreRef}
              className="catalog-load-more"
              aria-hidden="true"
              style={{ height: 1 }}
            />
          ) : null}
          {pageLoading && pageProducts.length === 0 ? (
            <div className="empty-state">Loading products…</div>
          ) : null}
        </div>

        {forceCartView ? (
        <aside className="cart-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Checkout</p>
              <h2>Your cart</h2>
            </div>
            <div className="cart-panel__heading-actions">
              <p>{cartItems.length} line items</p>
              <button
                type="button"
                className="cart-panel__close"
                onClick={() => setForceCartView(false)}
                aria-label="Close cart and keep shopping"
              >
                ← Keep shopping
              </button>
            </div>
          </div>

          <div className="cart-list">
            {cartItems.length ? (
              cartItems.map((item) => (
                <article key={item.product.uniqueId} className="cart-row">
                  <div className="cart-row__details">
                    <strong>{item.product.name}</strong>
                    <p>
                      {item.quantity} x {formatCurrency(effectivePriceCents(item.product))}
                      {' = '}
                      <strong>{formatCurrency(lineTotalCents(item.product, item.quantity))}</strong>
                    </p>
                    {isBogoProduct(item.product) ? (
                      <p className="cart-row__bogo">
                        {bogoLabel(item.product)} · paying for {bogoBillableQty(item.product, item.quantity)} of {item.quantity}
                      </p>
                    ) : null}
                    {item.product.stockQuantity <= 5 ? (
                      <p className="cart-row__note">
                        {item.product.stockQuantity <= 0
                          ? 'Item is no longer available'
                          : `Only ${item.product.stockQuantity} left in stock`}
                      </p>
                    ) : null}
                  </div>
                  <div className="qty-stepper">
                    <button
                      type="button"
                      onClick={() => updateQuantity(item.product.uniqueId, item.quantity - 1)}
                    >
                      -
                    </button>
                    <span>{item.quantity}</span>
                    <button
                      type="button"
                      disabled={item.quantity >= item.product.stockQuantity}
                      onClick={() => updateQuantity(item.product.uniqueId, item.quantity + 1)}
                    >
                      +
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <div className="empty-state">
                Your cart is empty. Add groceries to get started. Free delivery on orders above {formatCurrency(freeDeliveryThresholdCents)}.
              </div>
            )}
          </div>

          {cartItems.length > 0 && checkoutDeals.length > 0 && (
            <div className="checkout-deals">
              <div className="checkout-deals__head">
                <span className="checkout-deals__emoji" aria-hidden>🏷️</span>
                <div>
                  <span className="checkout-deals__eyebrow">Hot deals</span>
                  <h3 className="checkout-deals__title">Save more on these</h3>
                  <p className="checkout-deals__subtitle">
                    Active offers and markdowns — add before you check out.
                  </p>
                </div>
              </div>
              <div className="checkout-deals__row">
                {checkoutDeals.map((product) => {
                  const price = effectivePriceCents(product);
                  const original = product.originalPriceCents;
                  const showStrike = original != null && original > price;
                  return (
                    <article key={product.uniqueId} className="checkout-treat">
                      <div className="checkout-treat__thumb">
                        {product.imageUrl && (
                          <img
                            src={product.imageUrl}
                            alt={product.name}
                            loading="lazy"
                            className="checkout-treat__thumb-img"
                          />
                        )}
                        <span className="checkout-deals__badge">DEAL</span>
                      </div>
                      <div className="checkout-treat__body">
                        <span className="checkout-treat__name">{product.name}</span>
                        <span className="checkout-treat__meta">{product.unitLabel}</span>
                        <div className="checkout-treat__foot">
                          <div className="checkout-deals__prices">
                            <strong>{formatCurrency(price)}</strong>
                            {showStrike ? (
                              <span className="checkout-deals__strike">
                                {formatCurrency(original)}
                              </span>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="checkout-treat__add"
                            onClick={() => {
                              void apiLogClick({
                                productId: product.id,
                                categoryId: product.categoryId ?? null,
                                source: 'checkout_deals',
                              });
                              updateQuantity(product.uniqueId, 1);
                            }}
                            aria-label={`Add ${product.name}`}
                          >
                            + Add
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {cartItems.length > 0 && checkoutPicks.length > 0 && (
            <div className={`checkout-treats checkout-treats--${checkoutMood}`}>
              <div className="checkout-treats__head">
                <span className="checkout-treats__emoji" aria-hidden>
                  {CHECKOUT_MOOD_COPY[checkoutMood].emoji}
                </span>
                <div>
                  <span className="checkout-treats__eyebrow">
                    {CHECKOUT_MOOD_COPY[checkoutMood].eyebrow}
                  </span>
                  <h3 className="checkout-treats__title">
                    {CHECKOUT_MOOD_COPY[checkoutMood].title}
                  </h3>
                  <p className="checkout-treats__subtitle">
                    {CHECKOUT_MOOD_COPY[checkoutMood].subtitle}
                  </p>
                </div>
              </div>
              <div className="checkout-treats__row">
                {checkoutPicks.map((product) => (
                  <article key={product.uniqueId} className="checkout-treat">
                    <div className="checkout-treat__thumb">
                      {product.imageUrl && (
                        <img
                          src={product.imageUrl}
                          alt={product.name}
                          loading="lazy"
                          className="checkout-treat__thumb-img"
                        />
                      )}
                    </div>
                    <div className="checkout-treat__body">
                      <span className="checkout-treat__name">{product.name}</span>
                      <span className="checkout-treat__meta">{product.unitLabel}</span>
                      <div className="checkout-treat__foot">
                        <strong>{formatCurrency(effectivePriceCents(product))}</strong>
                        <button
                          type="button"
                          className="checkout-treat__add"
                          onClick={() => updateQuantity(product.uniqueId, 1)}
                          aria-label={`Add ${product.name}`}
                        >
                          + Add
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}

          <form className="checkout-form" onSubmit={handlePlaceOrder}>
            {user && savedAddresses.length > 0 ? (
              <label>
                <span>Saved addresses</span>
                <select
                  value={String(selectedAddressId)}
                  onChange={(e) => handleSavedAddressPick(e.target.value)}
                >
                  {savedAddresses.map((addr) => (
                    <option key={addr.id} value={String(addr.id)}>
                      {addr.fullName} · {addr.phone} · {addr.deliveryAddress.slice(0, 40)}
                      {addr.deliveryAddress.length > 40 ? '…' : ''}
                    </option>
                  ))}
                  <option value="new">+ Use a different name/phone/address</option>
                </select>
              </label>
            ) : null}

            <label>
              <span>Name</span>
              <input
                value={checkoutForm.customerName}
                onChange={(event) =>
                  setCheckoutForm((current) => ({ ...current, customerName: event.target.value }))
                }
                placeholder="Customer name"
                required
              />
            </label>

            <label>
              <span>Phone</span>
              <input
                value={checkoutForm.customerPhone}
                onChange={(event) =>
                  setCheckoutForm((current) => ({ ...current, customerPhone: event.target.value }))
                }
                placeholder="+91 98xxx xxxxx"
                required
              />
            </label>

            {checkoutForm.deliveryAddress.trim() && liveLocation ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '12px 14px',
                  background: 'var(--c-surface, #fff)',
                  border: '1px solid var(--c-border, #e2e8f0)',
                  borderRadius: 12,
                }}
              >
                <span style={{ fontSize: 20, lineHeight: '24px' }}>📍</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--c-text-muted, #64748b)', fontWeight: 600, letterSpacing: 0.3 }}>
                    DELIVERING TO
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text, #0f172a)', wordBreak: 'break-word' }}>
                    {checkoutForm.deliveryAddress.trim()}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--c-text-muted, #64748b)', marginTop: 2 }}>
                    {liveLocation.latitude.toFixed(5)}, {liveLocation.longitude.toFixed(5)}
                  </div>
                </div>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => openAddressPicker(false)}
                  style={{ fontWeight: 700, fontSize: 13 }}
                >
                  Change
                </button>
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: 14,
                  background: 'var(--c-surface, #fff)',
                  border: '1px solid var(--c-border, #e2e8f0)',
                  borderRadius: 12,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text, #0f172a)' }}>
                  Where should we deliver?
                </div>
                <button
                  type="button"
                  onClick={() => openAddressPicker(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    background: '#2563eb',
                    color: '#fff',
                    border: 0,
                    borderRadius: 10,
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: 700,
                  }}
                >
                  <span style={{ fontSize: 18 }}>📡</span>
                  Deliver at my current location
                </button>
                <button
                  type="button"
                  onClick={() => openAddressPicker(false)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    background: '#fff',
                    color: '#2563eb',
                    border: '1px solid #2563eb',
                    borderRadius: 10,
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: 700,
                  }}
                >
                  <span style={{ fontSize: 18 }}>🗺️</span>
                  No, at a different location
                </button>
              </div>
            )}

            <button
              type="button"
              id="checkout-payment-select"
              onClick={() => void openPaymentSheet()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                padding: '12px 14px',
                background: 'var(--c-surface, #fff)',
                border: '1px solid var(--c-border, #e2e8f0)',
                borderRadius: 10,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {(() => {
                const entry = PAYMENT_GROUPS.flatMap((g) => g.methods).find((m) => m.value === checkoutForm.paymentMethod);
                const hasUrl = !!entry?.iconUrl;
                return (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: hasUrl ? '#fff' : 'rgba(59, 130, 246, 0.1)',
                      border: hasUrl ? '1px solid var(--c-border, #e2e8f0)' : 'none',
                      fontSize: 18,
                      overflow: 'hidden',
                      padding: hasUrl ? 4 : 0,
                      boxSizing: 'border-box',
                    }}
                  >
                    {hasUrl ? (
                      <img
                        src={entry!.iconUrl}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    ) : (
                      entry?.icon ?? '💳'
                    )}
                  </span>
                );
              })()}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--c-text-muted, #64748b)', fontWeight: 600, letterSpacing: 0.3 }}>
                  PAYMENT METHOD
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text, #0f172a)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {PAYMENT_METHOD_LABELS[checkoutForm.paymentMethod] ?? checkoutForm.paymentMethod}
                </div>
              </div>
              <span style={{ color: '#3b82f6', fontWeight: 700, fontSize: 14 }}>Change ›</span>
            </button>

            <label>
              <span>Delivery notes</span>
              <textarea
                value={checkoutForm.deliveryNotes}
                onChange={(event) =>
                  setCheckoutForm((current) => ({ ...current, deliveryNotes: event.target.value }))
                }
                placeholder="Gate code, landmark, call before arrival"
              />
            </label>

            {locationStatus === 'error' && locationError ? (
              <span className="location-block__error">{locationError}</span>
            ) : null}

            <button
              type="button"
              onClick={() => setCouponSheetOpen(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                padding: '12px 14px',
                background: 'var(--c-surface, #fff)',
                border: '1px solid var(--c-border, #e2e8f0)',
                borderRadius: 10,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: 'rgba(16, 185, 129, 0.12)',
                  fontSize: 18,
                }}
              >
                🎟️
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--c-text-muted, #64748b)', fontWeight: 600, letterSpacing: 0.3 }}>
                  COUPON
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text, #0f172a)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {appliedCoupon
                    ? `${appliedCoupon.code} applied · saved ${formatCurrency(appliedCoupon.discountCents)}`
                    : 'Apply a coupon'}
                </div>
              </div>
              <span style={{ color: '#3b82f6', fontWeight: 700, fontSize: 14 }}>
                {appliedCoupon ? 'Change ›' : 'View ›'}
              </span>
            </button>

            <div className="totals-card">
              <div>
                <span>Subtotal</span>
                <strong>{formatCurrency(subtotalCents)}</strong>
              </div>
              <div>
                <span>Delivery</span>
                <strong>{deliveryFeeCents ? formatCurrency(deliveryFeeCents) : 'Free'}</strong>
              </div>
              {promoDiscountCents > 0 ? (
                <div className="totals-card__discount">
                  <span>50% off promo</span>
                  <strong>- {formatCurrency(promoDiscountCents)}</strong>
                </div>
              ) : null}
              {couponDiscountCents > 0 && appliedCoupon ? (
                <div className="totals-card__discount">
                  <span>Coupon {appliedCoupon.code}</span>
                  <strong>- {formatCurrency(couponDiscountCents)}</strong>
                </div>
              ) : null}
              <div className="totals-card__grand">
                <span>Total</span>
                <strong>{formatCurrency(totalCents)}</strong>
              </div>
            </div>

            {!user ? (
              <p className="message">
                You need to log in before placing an order.{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={onOpenLogin}
                >
                  Log in now
                </button>
              </p>
            ) : null}
            {checkoutForm.deliveryAddress.trim() ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '10px 14px',
                  marginBottom: 8,
                  background: 'var(--c-surface-muted, #f1f5f9)',
                  border: '1px solid var(--c-border, #e2e8f0)',
                  borderRadius: 10,
                  fontSize: 14,
                }}
              >
                <span style={{ fontSize: 16, lineHeight: '20px' }}>📍</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  Delivering to{' '}
                  <strong style={{ wordBreak: 'break-word' }}>
                    {checkoutForm.deliveryAddress.trim()}
                  </strong>
                </span>
              </div>
            ) : null}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 14px',
                marginBottom: 10,
                background: 'var(--c-surface-muted, #f1f5f9)',
                border: '1px solid var(--c-border, #e2e8f0)',
                borderRadius: 10,
                fontSize: 14,
              }}
            >
              <span>
                Paying via <strong>{PAYMENT_METHOD_LABELS[checkoutForm.paymentMethod] ?? checkoutForm.paymentMethod}</strong>
              </span>
              <button
                type="button"
                className="link-button"
                onClick={() => void openPaymentSheet()}
                style={{ fontWeight: 600 }}
              >
                Change
              </button>
            </div>
            <button
              className="primary-button primary-button--wide"
              disabled={placingOrder || cartItems.length === 0 || !user || !liveLocation}
            >
              {placingOrder
                ? 'Placing order...'
                : !user
                  ? 'Log in to Place Order'
                  : !liveLocation
                    ? 'Share location to continue'
                    : 'Place Order'}
            </button>
          </form>
        </aside>
        ) : null}
      </section>
      ) : null}

      {paymentSheetOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setPaymentSheetOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.5)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 520,
              background: 'var(--c-surface-muted, #f8fafc)',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: '18px 16px calc(env(safe-area-inset-bottom, 0px) + 20px)',
              maxHeight: '85vh',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ flex: 1, margin: 0, fontSize: 18, fontWeight: 900 }}>Select Payment Method</h3>
              <button
                type="button"
                onClick={() => setPaymentSheetOpen(false)}
                aria-label="Close"
                style={{
                  background: 'transparent',
                  border: 0,
                  fontSize: 24,
                  cursor: 'pointer',
                  color: '#64748b',
                  padding: 4,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
            {PAYMENT_GROUPS.map((group) => (
              <div
                key={group.title}
                style={{
                  marginBottom: 12,
                  background: 'var(--c-surface, #fff)',
                  borderRadius: 14,
                  border: '1px solid var(--c-border, #e2e8f0)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '12px 14px 6px',
                    fontSize: 13,
                    fontWeight: 800,
                    color: 'var(--c-text, #0f172a)',
                    letterSpacing: 0.2,
                  }}
                >
                  {group.title}
                </div>
                {group.methods.map((method, idx) => {
                  const selected = checkoutForm.paymentMethod === method.value;
                  return (
                    <button
                      key={method.value}
                      type="button"
                      onClick={() => {
                        setCheckoutForm((current) => ({ ...current, paymentMethod: method.value }));
                        setPaymentSheetOpen(false);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        width: '100%',
                        padding: '12px 14px',
                        background: selected ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
                        border: 0,
                        borderTop: idx === 0 ? 0 : '1px solid var(--c-border, #e2e8f0)',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          background: method.iconUrl ? '#fff' : 'rgba(59, 130, 246, 0.1)',
                          border: method.iconUrl ? '1px solid var(--c-border, #e2e8f0)' : 'none',
                          fontSize: 18,
                          flexShrink: 0,
                          overflow: 'hidden',
                          padding: method.iconUrl ? 4 : 0,
                          boxSizing: 'border-box',
                        }}
                      >
                        {method.iconUrl ? (
                          <img
                            src={method.iconUrl}
                            alt=""
                            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                          />
                        ) : (
                          method.icon
                        )}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text, #0f172a)' }}>
                          {method.label}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--c-text-muted, #64748b)' }}>{method.sub}</div>
                      </div>
                      {selected ? (
                        <span style={{ color: '#3b82f6', fontWeight: 700 }}>✓</span>
                      ) : (
                        <span style={{ color: '#94a3b8', fontWeight: 700 }}>›</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {latestOrder ? (
        <section className="confirmation-card">
          <div>
            <p className="eyebrow">
              {latestOrder.status === 'cancelled' ? 'Order Cancelled' : 'Order Confirmed'}
            </p>
            <h2>Tracking code: {latestOrder.publicId}</h2>
            <p>
              {latestOrder.status === 'cancelled'
                ? 'This order has been cancelled.'
                : 'Your order has been placed. Use the tracking code or QR to follow the delivery timeline.'}
            </p>
            <div className="confirmation-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => onTrack(latestOrder.publicId)}
              >
                Track This Order
              </button>
              {latestCancellable ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={cancellingOrder}
                  onClick={handleCancelLatest}
                >
                  {cancellingOrder ? 'Cancelling...' : 'Cancel Order'}
                </button>
              ) : null}
              <button type="button" className="ghost-button" onClick={() => setLatestOrder(null)}>
                Close
              </button>
            </div>
          </div>
          <div className="qr-card">
            <QRCodeSVG value={trackUrl} size={132} includeMargin />
            <span>{trackUrl}</span>
          </div>
        </section>
      ) : null}
      </div>
      {isBrowsing && !forceCartView && cartCount > 0 ? (
        <div className="cart-fab-wrap">
          {cartPopoverOpen ? (
            <>
              <div
                className="cart-popover__backdrop"
                onClick={() => setCartPopoverOpen(false)}
                aria-hidden
              />
              <div
                className="cart-popover"
                role="dialog"
                aria-label="Cart preview"
              >
                <div className="cart-popover__head">
                  <strong>Your cart</strong>
                  <span>{cartCount} item{cartCount === 1 ? '' : 's'}</span>
                </div>
                <div className="cart-popover__list">
                  {cartItems.map((item) => (
                    <div key={item.product.uniqueId} className="cart-popover__row">
                      <div className="cart-popover__row-info">
                        <span className="cart-popover__row-name">{item.product.name}</span>
                        <span className="cart-popover__row-price">
                          {formatCurrency(lineTotalCents(item.product, item.quantity))}
                        </span>
                      </div>
                      <div className="qty-stepper qty-stepper--compact">
                        <button
                          type="button"
                          onClick={() => updateQuantity(item.product.uniqueId, item.quantity - 1)}
                        >
                          −
                        </button>
                        <span>{item.quantity}</span>
                        <button
                          type="button"
                          disabled={item.quantity >= item.product.stockQuantity}
                          onClick={() => updateQuantity(item.product.uniqueId, item.quantity + 1)}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="cart-popover__foot">
                  <div className="cart-popover__subtotal">
                    <span>Subtotal</span>
                    <strong>{formatCurrency(subtotalCents)}</strong>
                  </div>
                  <button
                    type="button"
                    className="primary-button cart-popover__cta"
                    onClick={() => {
                      setCartPopoverOpen(false);
                      handleOpenCart();
                    }}
                  >
                    Checkout
                  </button>
                </div>
              </div>
            </>
          ) : null}
          <button
            type="button"
            className="cart-fab"
            onClick={() => setCartPopoverOpen((v) => !v)}
            aria-label={`${cartPopoverOpen ? 'Close' : 'Open'} cart, ${cartCount} item${cartCount === 1 ? '' : 's'}`}
            aria-expanded={cartPopoverOpen}
          >
            <span className="cart-fab__icon" aria-hidden>🛒</span>
            <span className="cart-fab__badge">{cartCount}</span>
          </button>
        </div>
      ) : null}
      {quickView ? (
        <QuickViewModal
          anchor={quickView}
          variants={quickViewVariants}
          loading={quickViewLoading}
          cart={cart}
          onClose={() => setQuickView(null)}
          onAdd={(uniqueId, qty) => updateQuantity(uniqueId, qty)}
        />
      ) : null}
      <AddressPickerModal
        open={addressPickerOpen}
        initialLatitude={liveLocation?.latitude ?? null}
        initialLongitude={liveLocation?.longitude ?? null}
        initialAddressLine={checkoutForm.deliveryAddress}
        fetchCurrentLocationOnOpen={addressPickerAutoLocate}
        onConfirm={handleAddressPicked}
        onClose={() => setAddressPickerOpen(false)}
      />
      {couponSheetOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setCouponSheetOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.5)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 520,
              background: 'var(--c-surface-muted, #f8fafc)',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: '18px 16px calc(env(safe-area-inset-bottom, 0px) + 20px)',
              maxHeight: '85vh',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ flex: 1, margin: 0, fontSize: 18, fontWeight: 900 }}>Apply a coupon</h3>
              <button
                type="button"
                onClick={() => setCouponSheetOpen(false)}
                aria-label="Close"
                style={{
                  background: 'transparent',
                  border: 0,
                  fontSize: 24,
                  cursor: 'pointer',
                  color: '#64748b',
                  padding: 4,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
            <div className="coupon-block" style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 14 }}>
              {appliedCoupon ? (
                <div className="coupon-block__applied">
                  <div>
                    <strong>Coupon {appliedCoupon.code} applied</strong>
                    <p>You're saving {formatCurrency(appliedCoupon.discountCents)}.</p>
                  </div>
                  <button type="button" className="ghost-button" onClick={handleRemoveCoupon}>
                    Remove
                  </button>
                </div>
              ) : (
                <>
                  <label className="coupon-block__row">
                    <input
                      type="text"
                      value={couponInput}
                      onChange={(e) => { setCouponInput(e.target.value); if (couponError) setCouponError(''); }}
                      placeholder="Have a coupon code?"
                      autoCapitalize="characters"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleApplyCoupon().then(() => {
                            if (!couponError) setCouponSheetOpen(false);
                          });
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => {
                        void handleApplyCoupon().then(() => {
                          if (!couponError) setCouponSheetOpen(false);
                        });
                      }}
                      disabled={!couponInput.trim() || couponStatus === 'applying' || subtotalCents <= 0}
                    >
                      {couponStatus === 'applying' ? 'Applying…' : 'Apply'}
                    </button>
                  </label>
                  {couponError && <span className="coupon-block__error">{couponError}</span>}
                </>
              )}
            </div>
            {publicCoupons.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-text-muted, #64748b)', letterSpacing: 0.3, textTransform: 'uppercase' }}>
                  Available coupons
                </div>
                {publicCoupons.map((c) => {
                  const discountBig = c.discountType === 'percent'
                    ? `${c.discountValue}% OFF`
                    : `₹${(c.discountValue / 100).toFixed(0)} OFF`;
                  const minLabel = c.minSubtotalCents > 0
                    ? `Min order ₹${(c.minSubtotalCents / 100).toFixed(0)}`
                    : 'No minimum';
                  return (
                    <div
                      key={c.code}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: 12,
                        background: '#fff',
                        borderRadius: 12,
                        border: '1px dashed #cbd5e1',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 800, fontSize: 14, color: '#0f172a' }}>{discountBig}</div>
                        <div style={{ fontSize: 12, color: '#475569' }}>
                          Code <strong>{c.code}</strong> · {minLabel}
                        </div>
                        {c.description ? (
                          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{c.description}</div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => {
                          setCouponInput(c.code);
                          setCouponError('');
                        }}
                      >
                        Use
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}

type QuickViewProps = {
  anchor: Product;
  variants: Product[];
  loading: boolean;
  cart: Record<string, number>;
  onClose: () => void;
  onAdd: (uniqueId: string, qty: number) => void;
};

function QuickViewModal({ anchor, variants, loading, cart, onClose, onAdd }: QuickViewProps) {
  // Show anchor + all siblings, ranked by ₹/base unit so "best value" surfaces first.
  const all = useMemo(() => {
    const seen = new Set<string>();
    const list: Product[] = [];
    for (const p of [anchor, ...variants]) {
      if (seen.has(p.uniqueId)) continue;
      seen.add(p.uniqueId);
      list.push(p);
    }
    return list.sort((a, b) => {
      const ua = unitPriceCentsPerBase(a);
      const ub = unitPriceCentsPerBase(b);
      if (ua && ub && ua.unit === ub.unit) return ua.centsPer - ub.centsPer;
      if (ua && !ub) return -1;
      if (!ua && ub) return 1;
      return effectivePriceCents(a) - effectivePriceCents(b);
    });
  }, [anchor, variants]);

  const bestUniqueId = useMemo(() => {
    const ranked = all
      .map((p) => ({ p, u: unitPriceCentsPerBase(p) }))
      .filter((x) => x.u != null);
    if (ranked.length < 2) return null;
    return ranked[0].p.uniqueId;
  }, [all]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 14,
          width: '100%',
          maxWidth: 520,
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 24px 60px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #eee' }}>
          <strong style={{ fontSize: 15 }}>{anchor.name}</strong>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 16 }}>
          {variants.length === 0 && !loading ? (
            <p style={{ color: '#666', fontSize: 13, margin: '4px 0 14px' }}>
              No other sizes for this product.
            </p>
          ) : (
            <p style={{ color: '#666', fontSize: 12, margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {loading ? 'Loading other sizes…' : 'Other sizes & packs'}
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {all.map((p) => {
              const inCart = cart[p.uniqueId] ?? 0;
              const unitPrice = formatUnitPrice(p);
              const isBest = p.uniqueId === bestUniqueId;
              const isAnchor = p.uniqueId === anchor.uniqueId;
              return (
                <div
                  key={p.uniqueId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: 10,
                    border: isAnchor ? '2px solid #2e7d32' : '1px solid #e2e2e2',
                    borderRadius: 10,
                    background: isAnchor ? '#f5fbf5' : '#fff',
                  }}
                >
                  {p.imageUrl ? (
                    <img src={p.imageUrl} alt="" width={56} height={56}
                         style={{ objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 56, height: 56, borderRadius: 6, background: '#f0f0f0', flexShrink: 0 }} />
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{p.unitLabel}</span>
                      {isBest ? (
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#2e7d32', padding: '2px 6px', borderRadius: 4, letterSpacing: 0.4 }}>
                          BEST VALUE
                        </span>
                      ) : null}
                      {isAnchor ? (
                        <span style={{ fontSize: 10, color: '#2e7d32', fontWeight: 600 }}>VIEWING</span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 13, color: '#333', marginTop: 2 }}>
                      <strong>{formatCurrency(effectivePriceCents(p))}</strong>
                      {unitPrice ? <span style={{ color: '#777', marginLeft: 6, fontSize: 12 }}>· {unitPrice}</span> : null}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0 }}>
                    {inCart > 0 ? (
                      <div className="qty-stepper">
                        <button type="button" onClick={() => onAdd(p.uniqueId, inCart - 1)}>-</button>
                        <span>{inCart}</span>
                        <button
                          type="button"
                          disabled={inCart >= p.stockQuantity}
                          onClick={() => onAdd(p.uniqueId, inCart + 1)}
                        >+</button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={p.stockQuantity <= 0}
                        onClick={() => onAdd(p.uniqueId, 1)}
                      >
                        {p.stockQuantity <= 0 ? 'Sold Out' : 'Add'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Storefront;
