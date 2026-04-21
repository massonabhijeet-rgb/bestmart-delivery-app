import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apiListRiderOrders,
  apiRiderCollectUpi,
  apiRiderDeliver,
  apiUpdateRiderLocation,
} from '../services/api';
import type { Order, User } from '../services/api';
import { formatCurrency, formatRelativeTime, labelizeStatus } from '../lib/format';
import { useOrderSocket } from '../hooks/useOrderSocket';
import { isAudioUnlocked, playOrderAlert, unlockAudio } from '../lib/sound';
import { confirm, promptOtp } from '../components/ConfirmDialog';

interface RiderHomeProps {
  user: User;
  onLogout: () => void;
}

const DELIVER_RADIUS_METERS = 50;

function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function RiderHome({ user, onLogout }: RiderHomeProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [riderPos, setRiderPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'pending' | 'active' | 'denied' | 'unavailable'>('pending');
  const [deliveringId, setDeliveringId] = useState<string | null>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [collectState, setCollectState] = useState<
    { publicId: string; qrImageUrl: string; amountCents: number } | null
  >(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Request browser notification permission once on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, []);

  function pushNotification(title: string, body: string) {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/bestmart-logo.svg' });
    }
  }

  function showToast(message: string, notifTitle?: string, notifBody?: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), 6000);
    if (isAudioUnlocked()) playOrderAlert();
    if (notifTitle) pushNotification(notifTitle, notifBody ?? message);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiListRiderOrders();
      setOrders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load your orders');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(load, 20000);
    return () => window.clearInterval(interval);
  }, [load]);

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

  useOrderSocket({
    onNewOrder: () => {
      // A brand-new order isn't assigned yet — ignore on the rider page.
    },
    onOrderUpdated: (updated) => {
      if (updated.assignedRiderUserId !== user.id) return;
      const existing = orders.find((o) => o.publicId === updated.publicId);
      if (
        collectState &&
        collectState.publicId === updated.publicId &&
        updated.paymentStatus === 'paid'
      ) {
        setCollectState(null);
        showToast(
          `✅ UPI payment received for ${updated.publicId}`,
          'Payment received',
          `Order ${updated.publicId} marked paid.`,
        );
        if (updated.status === 'delivered') {
          void load();
        }
      }
      if (!existing) {
        showToast(
          `🛵 New delivery assigned: ${updated.publicId} · ${updated.customerName}`,
          '🛵 New order assigned!',
          `${updated.publicId} — ${updated.customerName}\n${updated.deliveryAddress}`,
        );
        setOrders((prev) => [...prev, updated]);
      } else if (existing.status !== updated.status) {
        showToast(
          `Order ${updated.publicId} is now ${labelizeStatus(updated.status)}`,
          `Order ${updated.publicId} updated`,
          `Status changed to: ${labelizeStatus(updated.status)}`,
        );
        setOrders((prev) =>
          prev.map((o) => (o.publicId === updated.publicId ? updated : o)),
        );
      } else {
        setOrders((prev) =>
          prev.map((o) => (o.publicId === updated.publicId ? updated : o)),
        );
      }
    },
  });

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsStatus('unavailable');
      return;
    }
    let lastSentAt = 0;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setRiderPos({ latitude, longitude });
        setGpsStatus('active');
        const now = Date.now();
        if (now - lastSentAt > 10_000) {
          lastSentAt = now;
          void apiUpdateRiderLocation(latitude, longitude).catch(() => {});
        }
      },
      (err) => {
        setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  async function handleDeliver(order: Order, distanceMeters: number | null) {
    const hasCoords = order.deliveryLatitude != null && order.deliveryLongitude != null;
    const tooFar =
      hasCoords && distanceMeters != null && distanceMeters > DELIVER_RADIUS_METERS;
    const isCOD = order.paymentMethod === 'cash_on_delivery';

    // Step 1: COD cash collection confirmation
    if (isCOD) {
      const cashConfirmed = await confirm({
        title: '💵 Collect cash before marking delivered',
        message: `This is a Cash on Delivery order. Collect ${formatCurrency(order.totalCents)} from ${order.customerName} before proceeding.`,
        confirmLabel: 'Cash collected — continue',
        cancelLabel: 'Go back',
        tone: 'caution',
      });
      if (!cashConfirmed) return;
    }

    // Step 2: Distance / standard delivery confirmation
    const confirmed = await confirm({
      title: tooFar ? 'You are far from the drop point' : 'Mark as delivered?',
      message: tooFar
        ? `You are ${Math.round(distanceMeters!)} m from the drop point (more than ${DELIVER_RADIUS_METERS} m). Deliver order ${order.publicId} anyway?`
        : `Confirm delivery of order ${order.publicId} for ${order.customerName}.`,
      confirmLabel: tooFar ? 'Deliver anyway' : 'Mark Delivered',
      tone: tooFar ? 'caution' : 'default',
    });
    if (!confirmed) return;

    // Step 3: customer shares the 4-digit OTP shown on their track page/app.
    const otp = await promptOtp({
      title: 'Ask customer for delivery OTP',
      message: `Customer ${order.customerName} will see a 4-digit OTP on their order page. Enter it to complete delivery.`,
      confirmLabel: 'Confirm & Deliver',
    });
    if (!otp) return;

    setDeliveringId(order.publicId);
    setError('');
    setNotice('');
    try {
      await apiRiderDeliver(order.publicId, otp);
      setNotice(`Order ${order.publicId} marked delivered.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to mark delivered');
    } finally {
      setDeliveringId(null);
    }
  }

  async function handleCollectUpi(order: Order) {
    setCollectingId(order.publicId);
    setError('');
    setNotice('');
    try {
      const result = await apiRiderCollectUpi(order.publicId);
      setCollectState({
        publicId: order.publicId,
        qrImageUrl: result.qrImageUrl,
        amountCents: result.amountCents,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate UPI QR');
    } finally {
      setCollectingId(null);
    }
  }

  const activeOrders = useMemo(() => orders, [orders]);

  return (
    <main className="rider-shell">
      <header className="rider-topbar">
        <div>
          <p className="eyebrow">Rider</p>
          <h1>{user.fullName || user.email}</h1>
          {user.phone ? <p className="rider-topbar__phone">{user.phone}</p> : null}
        </div>
        <button type="button" className="ghost-button" onClick={onLogout}>
          Log Out
        </button>
      </header>

      {gpsStatus === 'denied' && (
        <div className="rider-gps-banner rider-gps-banner--denied">
          <span>📵</span>
          <div>
            <strong>GPS access denied</strong>
            <p>Enable location in your browser settings so customers can track you live.</p>
          </div>
        </div>
      )}
      {gpsStatus === 'unavailable' && (
        <div className="rider-gps-banner rider-gps-banner--denied">
          <span>📵</span>
          <div>
            <strong>GPS not available</strong>
            <p>This device or browser does not support location. Customers won't see your live position.</p>
          </div>
        </div>
      )}
      {gpsStatus === 'active' && (
        <div className="rider-gps-banner rider-gps-banner--active">
          <span className="rider-gps-banner__dot" />
          <strong>GPS active — customers can see your live location</strong>
        </div>
      )}

      <section className="rider-summary">
        <div>
          <strong>{activeOrders.length}</strong>
          <span>assigned to you</span>
        </div>
        <div>
          <strong>
            {activeOrders.filter((o) => o.status === 'out_for_delivery').length}
          </strong>
          <span>out for delivery</span>
        </div>
        <div>
          <strong>
            {riderPos ? `${riderPos.latitude.toFixed(4)}, ${riderPos.longitude.toFixed(4)}` : '—'}
          </strong>
          <span>your location</span>
        </div>
      </section>

      {toast ? (
        <div className="rider-toast" role="status">{toast}</div>
      ) : null}

      {loading ? <div className="message">Loading…</div> : null}
      {error ? <div className="message message--error">{error}</div> : null}
      {notice ? <div className="message">{notice}</div> : null}

      {!loading && activeOrders.length === 0 ? (
        <p className="empty-state">No orders assigned right now. Pull up when you get one.</p>
      ) : null}

      <div className="rider-order-list">
        {activeOrders.map((order) => {
          const hasCoords =
            order.deliveryLatitude != null && order.deliveryLongitude != null;
          const distanceMeters =
            riderPos && hasCoords
              ? haversineMeters(riderPos, {
                  latitude: order.deliveryLatitude as number,
                  longitude: order.deliveryLongitude as number,
                })
              : null;
          const withinRange =
            distanceMeters != null && distanceMeters <= DELIVER_RADIUS_METERS;

          return (
            <article key={order.publicId} className="rider-order-card">
              <header className="rider-order-card__head">
                <div>
                  <p className="eyebrow">{order.publicId}</p>
                  <h2>{order.customerName}</h2>
                  <p className="rider-order-card__phone">
                    <a href={`tel:${order.customerPhone}`}>{order.customerPhone}</a>
                  </p>
                </div>
                <span className={`status-pill status-pill--${order.status}`}>
                  {labelizeStatus(order.status)}
                </span>
              </header>

              <div className="rider-order-card__meta">
                <span>Placed {formatRelativeTime(order.createdDate)}</span>
                <strong>{formatCurrency(order.totalCents)}</strong>
                <span>{labelizeStatus(order.paymentMethod)}</span>
              </div>

              <div className="rider-order-card__address">
                <strong>Delivery address</strong>
                <p>{order.deliveryAddress}</p>
                {order.deliveryNotes ? <p>Note: {order.deliveryNotes}</p> : null}
                {order.deliverySlot ? <p>Slot: {order.deliverySlot}</p> : null}
                <a
                  className="rider-order-card__maps-btn"
                  href={
                    hasCoords
                      ? `https://www.google.com/maps/dir/?api=1&destination=${order.deliveryLatitude},${order.deliveryLongitude}&travelmode=driving`
                      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.deliveryAddress)}`
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  📍 Open in Google Maps
                </a>
              </div>

              {hasCoords ? (
                <div className="rider-order-card__map-block">
                  <div className="rider-order-card__distance">
                    {distanceMeters == null
                      ? 'Waiting for your location…'
                      : distanceMeters < 1000
                        ? `${Math.round(distanceMeters)} m away`
                        : `${(distanceMeters / 1000).toFixed(1)} km away`}
                    {' · '}
                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${order.deliveryLatitude},${order.deliveryLongitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Navigate
                    </a>
                  </div>
                  <iframe
                    className="rider-order-card__map"
                    title={`Map for ${order.publicId}`}
                    loading="lazy"
                    src={`https://www.openstreetmap.org/export/embed.html?bbox=${(order.deliveryLongitude as number) - 0.004},${(order.deliveryLatitude as number) - 0.003},${(order.deliveryLongitude as number) + 0.004},${(order.deliveryLatitude as number) + 0.003}&layer=mapnik&marker=${order.deliveryLatitude},${order.deliveryLongitude}`}
                  />
                </div>
              ) : (
                <p className="rider-order-card__no-map">
                  Customer didn't share live location. Use the address above.
                </p>
              )}

              <details className="rider-order-card__items">
                <summary>{order.items.length} item{order.items.length === 1 ? '' : 's'}</summary>
                <ul>
                  {order.items.map((item) => (
                    <li key={item.id}>
                      {item.quantity} × {item.productName} ({item.unitLabel})
                    </li>
                  ))}
                </ul>
              </details>

              {hasCoords && !withinRange && distanceMeters != null ? (
                <div className="rider-order-card__far-warning">
                  You're <strong>{Math.round(distanceMeters)} m</strong> from the drop point
                  (outside the {DELIVER_RADIUS_METERS} m zone). Confirm again to deliver from here.
                </div>
              ) : null}
              <div className="rider-order-card__actions">
                {order.paymentStatus !== 'paid' ? (
                  <button
                    type="button"
                    className="ghost-button rider-order-card__upi-btn"
                    disabled={collectingId === order.publicId}
                    onClick={() => handleCollectUpi(order)}
                  >
                    {collectingId === order.publicId ? 'Generating…' : '📱 Collect via UPI'}
                  </button>
                ) : (
                  <span className="rider-order-card__paid-tag">✅ Paid</span>
                )}
                <button
                  type="button"
                  className={`primary-button primary-button--wide${hasCoords && !withinRange ? ' primary-button--caution' : ''}`}
                  disabled={deliveringId === order.publicId}
                  onClick={() => handleDeliver(order, distanceMeters)}
                >
                  {deliveringId === order.publicId ? 'Marking…' : 'Mark Delivered'}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {collectState ? (
        <div
          className="rider-upi-modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setCollectState(null)}
        >
          <div
            className="rider-upi-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="rider-upi-modal__head">
              <div>
                <p className="eyebrow">UPI Collection</p>
                <h2>Order {collectState.publicId}</h2>
              </div>
              <button
                type="button"
                className="rider-upi-modal__close"
                onClick={() => setCollectState(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </header>
            <p className="rider-upi-modal__amount">
              {formatCurrency(collectState.amountCents)}
            </p>
            <div className="rider-upi-modal__qr-wrap">
              <img
                src={collectState.qrImageUrl}
                alt={`UPI QR for order ${collectState.publicId}`}
                className="rider-upi-modal__qr"
              />
            </div>
            <p className="rider-upi-modal__hint">
              Ask the customer to scan with any UPI app (PhonePe, GPay, Paytm, BHIM).
              Amount is locked — they can't change it.
            </p>
            <div className="rider-upi-modal__status">
              <span className="rider-upi-modal__dot" />
              Waiting for payment…
            </div>
            <button
              type="button"
              className="ghost-button rider-upi-modal__cancel"
              onClick={() => setCollectState(null)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default RiderHome;
