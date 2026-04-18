import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  apiCancelOrder,
  apiCreateOrder,
  apiGetCompanyPublic,
  apiGetProducts,
  apiListAddresses,
  apiListBrands,
  apiListCategories,
  apiListPublicCoupons,
  apiListTempCategories,
  apiPreviewCoupon,
  ApiError,
} from '../services/api';
import type { Brand, CouponPreview, PublicCoupon, TempCategory } from '../services/api';
import { bogoBillableQty, bogoGet, bogoLabel, effectivePriceCents, formatCurrency, isBogoProduct, lineTotalCents } from '../lib/format';
import { fuzzyRank } from '../lib/fuzzySearch';
import { confirm } from '../components/ConfirmDialog';
import { withBusy } from '../components/BusyOverlay';
import LazyMount from '../components/LazyMount';
import {
  MOOD_COPY,
  fetchOpenMeteoMood,
  moodFromIndiaCalendar,
  pickProductsForMood,
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

const FOOTER_USEFUL_LINKS = ['Blog', 'Partner', 'Recipes'];

function Storefront({ user, onOpenLogin, onOpenDashboard, onOpenMyOrders, onTrack, onLogout }: StorefrontProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [categoryRows, setCategoryRows] = useState<Category[]>([]);
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
  const [trackingCode, setTrackingCode] = useState('');
  const [placingOrder, setPlacingOrder] = useState(false);
  const [cancellingOrder, setCancellingOrder] = useState(false);
  const [latestOrder, setLatestOrder] = useState<Order | null>(null);
  const [checkoutForm, setCheckoutForm] = useState<CheckoutForm>({
    customerName: '',
    customerPhone: '',
    deliveryAddress: '',
    deliveryNotes: '',
    paymentMethod: 'cash_on_delivery',
  });
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<'new' | number>('new');
  const [forceCartView, setForceCartView] = useState(false);
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

  function handleShareLocation() {
    void captureLocation();
  }

  useEffect(() => {
    Promise.all([apiGetCompanyPublic(), apiGetProducts(), apiListCategories()])
      .then(([companyData, productData, categoryData]) => {
        setCompany(companyData);
        setProducts(productData.filter((product) => product.isActive));
        setCategoryRows(categoryData);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Unable to load BestMart');
      })
      .finally(() => setInitialLoading(false));
    apiListPublicCoupons().then(setPublicCoupons).catch(() => {});
    apiListBrands().then(setBrandsList).catch(() => {});
  }, []);

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
        if (!cancelled) setTempCategories(rows);
      })
      .catch(() => {
        if (!cancelled) setTempCategories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mood]);

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
    return new Map(products.map((product) => [product.uniqueId, product]));
  }, [products]);

  useEffect(() => {
    setCart((current) => {
      let changed = false;
      const next: Record<string, number> = {};

      for (const [uniqueId, quantity] of Object.entries(current)) {
        const product = productLookup.get(uniqueId);
        if (!product || !product.isActive || product.stockQuantity <= 0) {
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

  const categories = useMemo(() => {
    return ['All', ...new Set(products.map((product) => product.category))];
  }, [products]);

  const categoryTiles = useMemo(() => {
    return categoryRows.map((row) => ({
      name: row.name,
      imageUrl: row.imageUrl,
    }));
  }, [categoryRows]);

  // Brand tiles: only brands that have at least one in-stock active product.
  const brandTiles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) {
      if (!p.isActive || p.stockQuantity <= 0 || !p.brand) continue;
      counts.set(p.brand, (counts.get(p.brand) ?? 0) + 1);
    }
    return brandsList
      .filter((b) => counts.has(b.name))
      .map((b) => ({ name: b.name, productCount: counts.get(b.name) ?? 0 }))
      .sort((a, b) => b.productCount - a.productCount);
  }, [brandsList, products]);

  const offerProducts = useMemo(
    () => products.filter((p) => p.isOnOffer && p.isActive && p.stockQuantity > 0),
    [products]
  );

  const moodPicks = useMemo(
    () => pickProductsForMood(products.filter((p) => p.isActive && p.stockQuantity > 0), mood, 12),
    [products, mood],
  );

  const checkoutMood = useMemo(() => moodFromHour(new Date().getHours()), []);
  const checkoutPicks = useMemo(
    () => pickCheckoutTreats(products, checkoutMood, cart, 8),
    [products, checkoutMood, cart],
  );

  // Daily essentials: products from the staple-grocery categories.
  const dailyEssentials = useMemo(() => {
    const KEYWORDS = [
      'dairy', 'bread', 'egg', 'milk',
      'fruit', 'vegetable',
      'atta', 'rice', 'dal',
      'tea', 'coffee',
    ];
    return products
      .filter((p) => p.isActive && p.stockQuantity > 0)
      .filter((p) => {
        const cat = (p.category ?? '').toLowerCase();
        const name = p.name.toLowerCase();
        return KEYWORDS.some((k) => cat.includes(k) || name.includes(k));
      })
      .slice(0, 12);
  }, [products]);

  const activeTempCategory = useMemo(
    () => (tempCategoryKey ? tempCategories.find((t) => t.autoKey === tempCategoryKey) ?? null : null),
    [tempCategoryKey, tempCategories],
  );

  const filteredProducts = useMemo(() => {
    const term = deferredSearch.trim();
    const tempIds = activeTempCategory ? new Set(activeTempCategory.productIds) : null;
    const byCategory = products.filter(
      (product) =>
        (category === 'All' || product.category === category) &&
        (!brandFilter || product.brand === brandFilter) &&
        (!tempIds || tempIds.has(product.uniqueId)),
    );
    if (!term) return byCategory;
    return fuzzyRank(term, byCategory, (product) => [
      product.name,
      product.category,
      product.description,
      product.badge,
      product.unitLabel,
    ]);
  }, [products, category, deferredSearch, brandFilter, activeTempCategory]);

  // ── Catalog windowing ────────────────────────────────────────────────
  // Don't render thousands of product cards on first paint. Show the first
  // PAGE_SIZE, then mount more in chunks as the user nears the bottom.
  const PAGE_SIZE = 24;
  const [displayedCount, setDisplayedCount] = useState(PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  // Reset window when filter/search changes so the user sees the new top results.
  useEffect(() => {
    setDisplayedCount(PAGE_SIZE);
  }, [category, deferredSearch, brandFilter, tempCategoryKey]);
  // IntersectionObserver to grow the window when the sentinel scrolls into view.
  useEffect(() => {
    if (displayedCount >= filteredProducts.length) return;
    const node = loadMoreRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setDisplayedCount(filteredProducts.length);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setDisplayedCount((n) => Math.min(n + PAGE_SIZE, filteredProducts.length));
            break;
          }
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [displayedCount, filteredProducts.length]);
  const visibleProducts = useMemo(
    () => filteredProducts.slice(0, displayedCount),
    [filteredProducts, displayedCount],
  );

  const cartItems = useMemo(() => {
    return products
      .filter((product) => cart[product.uniqueId] > 0)
      .map((product) => ({
        product,
        quantity: cart[product.uniqueId],
      }));
  }, [products, cart]);

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
      const order = await withBusy('Placing your order…', async () => {
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

        // Re-validate the applied coupon right before placing the order so the
        // user sees a clear coupon-area message if it's no longer eligible
        // (per-user limit reached, expired, etc) since the apply click.
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

        return apiCreateOrder({
          customerName: checkoutForm.customerName,
          customerPhone: checkoutForm.customerPhone,
          deliveryAddress: checkoutForm.deliveryAddress,
          deliveryNotes: checkoutForm.deliveryNotes,
          paymentMethod: checkoutForm.paymentMethod,
          items: cartItems.map((item) => ({
            productId: item.product.uniqueId,
            quantity: item.quantity,
          })),
          deliveryLatitude: coords.latitude,
          deliveryLongitude: coords.longitude,
          couponCode: appliedCoupon?.code ?? null,
        });
      });

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
                const items = tc.productIds
                  .map((id) => productLookup.get(id))
                  .filter((p): p is Product => Boolean(p))
                  .slice(0, 12);
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
                        <span className="brand-tile__count">
                          {b.productCount} item{b.productCount === 1 ? '' : 's'}
                        </span>
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
      <section className="store-layout">
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
            <p>{filteredProducts.length} items ready for checkout</p>
          </div>

          <div className="product-grid">
            {visibleProducts.map((product) => (
              <article
                className={
                  product.stockQuantity <= 0 ? 'product-card product-card--sold-out' : 'product-card'
                }
                key={product.uniqueId}
              >
                <div className="product-card__media">
                  {product.imageUrl && <img src={product.imageUrl} alt={product.name} loading="lazy" className="product-card__media-img" />}
                  {product.badge || product.stockQuantity <= 5 ? (
                    <div className="badge-stack">
                      {product.badge ? <span className="badge">{product.badge}</span> : null}
                      {product.stockQuantity <= 0 ? (
                        <span className="badge badge--sold-out">Sold Out</span>
                      ) : product.stockQuantity <= 5 ? (
                        <span className="badge badge--low-stock">
                          Only {product.stockQuantity} Left
                        </span>
                      ) : null}
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
          {displayedCount < filteredProducts.length ? (
            <div
              ref={loadMoreRef}
              className="catalog-load-more"
              aria-hidden="true"
              style={{ height: 1 }}
            />
          ) : null}
        </div>

        <aside className="cart-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Checkout</p>
              <h2>Your cart</h2>
            </div>
            <p>{cartItems.length} line items</p>
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

            <label>
              <span>Delivery address</span>
              <textarea
                value={checkoutForm.deliveryAddress}
                onChange={(event) =>
                  setCheckoutForm((current) => ({ ...current, deliveryAddress: event.target.value }))
                }
                placeholder="House / apartment / landmark"
                required
              />
            </label>

            <label>
              <span>Payment</span>
              <select
                value={checkoutForm.paymentMethod}
                onChange={(event) =>
                  setCheckoutForm((current) => ({ ...current, paymentMethod: event.target.value }))
                }
              >
                <option value="cash_on_delivery">Cash on delivery</option>
                <option value="upi">UPI</option>
                <option value="card_on_delivery">Card on delivery</option>
              </select>
            </label>

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

            <div className={`location-block${!liveLocation ? ' location-block--required' : ''}`}>
              <div>
                <strong>Share live location <span style={{ color: 'var(--c-danger, #ef4444)' }}>*</span></strong>
                <p>
                  {liveLocation
                    ? `Captured (~${liveLocation.latitude.toFixed(5)}, ${liveLocation.longitude.toFixed(5)})`
                    : 'Required — riders need your exact location to deliver.'}
                </p>
              </div>
              <button
                type="button"
                className={liveLocation ? 'secondary-button' : 'primary-button'}
                onClick={handleShareLocation}
                disabled={locationStatus === 'capturing'}
              >
                {locationStatus === 'capturing'
                  ? 'Getting location…'
                  : liveLocation
                    ? 'Update location'
                    : 'Use my current location'}
              </button>
              {locationStatus === 'error' && locationError ? (
                <span className="location-block__error">{locationError}</span>
              ) : null}
            </div>

            {/* Coupon */}
            <div className="coupon-block">
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
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleApplyCoupon(); } }}
                    />
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => void handleApplyCoupon()}
                      disabled={!couponInput.trim() || couponStatus === 'applying' || subtotalCents <= 0}
                    >
                      {couponStatus === 'applying' ? 'Applying…' : 'Apply'}
                    </button>
                  </label>
                  {couponError && <span className="coupon-block__error">{couponError}</span>}
                </>
              )}
            </div>

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
      </section>
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
    </main>
  );
}

export default Storefront;
