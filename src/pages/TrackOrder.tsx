import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { formatCurrency, formatDateTime, formatRelativeTime, labelizeStatus } from '../lib/format';
import { apiCancelOrder, apiTrackOrder } from '../services/api';
import { confirm } from '../components/ConfirmDialog';
import { useOrderSocket } from '../hooks/useOrderSocket';
import type { RiderLocation } from '../hooks/useOrderSocket';
import type { Order, OrderStatus } from '../services/api';

interface TrackOrderProps {
  trackingCode: string;
  onBackToStore: () => void;
  onTrack: (code: string) => void;
}

const timeline: OrderStatus[] = [
  'placed',
  'confirmed',
  'packing',
  'out_for_delivery',
  'delivered',
];

function TrackOrder({ trackingCode, onBackToStore, onTrack }: TrackOrderProps) {
  const [lookupCode, setLookupCode] = useState(trackingCode);
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState('');
  const [deliveryBanner, setDeliveryBanner] = useState<{ time: string } | null>(null);
  const [riderLocation, setRiderLocation] = useState<RiderLocation | null>(null);
  const prevStatusRef = useRef<OrderStatus | null>(null);

  // Request notification permission once when tracking a live order
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default' && trackingCode) {
      void Notification.requestPermission();
    }
  }, [trackingCode]);

  // Real-time updates via WebSocket
  useOrderSocket({
    onNewOrder: () => {},
    onRiderLocation: (loc) => {
      setOrder((current) => {
        if (current?.assignedRiderUserId === loc.riderId) {
          setRiderLocation(loc);
        }
        return current;
      });
    },
    onOrderUpdated: (updated) => {
      if (updated.publicId !== trackingCode) return;
      const prev = prevStatusRef.current;
      prevStatusRef.current = updated.status;
      setOrder(updated);
      if (prev !== 'delivered' && updated.status === 'delivered') {
        const deliveredAt = formatDateTime(updated.updatedDate);
        setDeliveryBanner({ time: deliveredAt });
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('Your order has been delivered! 🎉', {
            body: `Order ${updated.publicId} was delivered at ${deliveredAt}.`,
            icon: '/bestmart-logo.svg',
          });
        }
      }
    },
  });

  async function handleCancel() {
    if (!order) return;
    const confirmed = await confirm({
      title: 'Cancel this order?',
      message: `Order ${order.publicId} will be cancelled. This cannot be undone.`,
      confirmLabel: 'Cancel Order',
      cancelLabel: 'Keep Order',
      tone: 'danger',
    });
    if (!confirmed) return;
    setCancelling(true);
    setError('');
    try {
      const updated = await apiCancelOrder(order.publicId);
      setOrder(updated);
      setNotice('Your order has been cancelled.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to cancel order');
    } finally {
      setCancelling(false);
    }
  }

  const canCancel = Boolean(
    order && ['placed', 'confirmed', 'packing'].includes(order.status),
  );

  useEffect(() => {
    setLookupCode(trackingCode);
  }, [trackingCode]);

  useEffect(() => {
    let cancelled = false;

    async function loadOrder() {
      if (!trackingCode) {
        setLoading(false);
        setOrder(null);
        return;
      }
      setLoading(true);
      try {
        const data = await apiTrackOrder(trackingCode);
        if (!cancelled) {
          prevStatusRef.current = data.status;
          setOrder(data);
          if (data.status === 'delivered') {
            setDeliveryBanner({ time: formatDateTime(data.updatedDate) });
          }
          setError('');
        }
      } catch (err) {
        if (!cancelled) {
          setOrder(null);
          setError(err instanceof Error ? err.message : 'Order not found');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadOrder();
    const poll = window.setInterval(loadOrder, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [trackingCode]);

  const currentTimelineIndex = useMemo(() => {
    if (!order || order.status === 'cancelled') {
      return -1;
    }
    return timeline.indexOf(order.status);
  }, [order]);

  return (
    <main className="tracking-shell">
      <section className="tracking-header">
        <div>
          <p className="eyebrow">BestMart Order Tracking</p>
          <h1>Track your grocery order from store to doorstep.</h1>
        </div>
        <div className="hero-actions">
          <button className="ghost-button" onClick={onBackToStore}>
            Back to Store
          </button>
        </div>
      </section>

      <section className="tracking-search">
        <label htmlFor="lookup-code">Tracking code</label>
        <div className="track-inline__row">
          <input
            id="lookup-code"
            value={lookupCode}
            onChange={(event) => setLookupCode(event.target.value.toUpperCase())}
            placeholder="BM-XXXXXX"
          />
          <button
            type="button"
            className="primary-button"
            onClick={() => lookupCode.trim() && onTrack(lookupCode.trim())}
          >
            Search
          </button>
        </div>
      </section>

      {loading ? <div className="message">Fetching live delivery details...</div> : null}
      {error ? <div className="message message--error">{error}</div> : null}
      {notice ? <div className="message">{notice}</div> : null}

      {deliveryBanner && (
        <div className="delivery-banner" role="status">
          <span className="delivery-banner__icon">🎉</span>
          <div className="delivery-banner__text">
            <strong>Your order has been delivered!</strong>
            <span>Delivered at {deliveryBanner.time}</span>
          </div>
          <button
            type="button"
            className="delivery-banner__close"
            aria-label="Dismiss"
            onClick={() => setDeliveryBanner(null)}
          >
            ×
          </button>
        </div>
      )}

      {order ? (
        <section className="tracking-layout">
          <div className="tracking-card">
            <div className="tracking-card__header">
              <div>
                <p className="eyebrow">Order {order.publicId}</p>
                <h2>{labelizeStatus(order.status)}</h2>
              </div>
              <span className="status-pill">{labelizeStatus(order.status)}</span>
            </div>

            {order.status === 'cancelled' ? (
              <div className="message message--error">
                This order has been cancelled. If you didn't cancel it yourself, the store may
                have cancelled it — please contact support if you need help.
                {order.cancellationReason ? (
                  <>
                    <br />
                    <strong>Reason:</strong> {order.cancellationReason}
                  </>
                ) : null}
              </div>
            ) : null}

            {order.status === 'out_for_delivery' && order.deliveryOtp ? (
              <div
                className="message"
                style={{
                  background: 'linear-gradient(135deg, #065f46 0%, #10b981 100%)',
                  color: '#fff',
                  textAlign: 'center',
                  padding: '1.1rem 1rem',
                }}
              >
                <div style={{ fontSize: '0.85rem', opacity: 0.85, letterSpacing: '0.1em' }}>
                  DELIVERY OTP
                </div>
                <div
                  style={{
                    fontSize: '2.4rem',
                    fontWeight: 700,
                    letterSpacing: '0.6rem',
                    margin: '0.25rem 0',
                  }}
                >
                  {order.deliveryOtp}
                </div>
                <div style={{ fontSize: '0.85rem', opacity: 0.9 }}>
                  Share this with your rider to complete delivery.
                </div>
              </div>
            ) : null}

            {canCancel ? (
              <div className="cancel-row">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={cancelling}
                  onClick={handleCancel}
                >
                  {cancelling ? 'Cancelling...' : 'Cancel Order'}
                </button>
                <span>You can cancel while the order hasn't been dispatched.</span>
              </div>
            ) : null}

            <div className="timeline">
              {timeline.map((status, index) => {
                const active = currentTimelineIndex >= index;
                const isDelivered = status === 'delivered' && order?.status === 'delivered';
                return (
                  <div key={status} className={active ? 'timeline-step timeline-step--active' : 'timeline-step'}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{labelizeStatus(status)}</strong>
                      <p>
                        {isDelivered
                          ? `Delivered at ${formatDateTime(order!.updatedDate)}`
                          : active
                          ? 'Completed or in progress'
                          : 'Waiting in queue'}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="tracking-grid">
              <article className="info-card">
                <p className="eyebrow">Delivery details</p>
                <strong>{order.customerName}</strong>
                <p>{order.customerPhone}</p>
                <p>{order.deliveryAddress}</p>
                <p>Slot: {order.deliverySlot ?? 'Express'}</p>
                <p>Placed {formatRelativeTime(order.createdDate)}</p>
                <p>
                  <a
                    className="map-link"
                    href={
                      order.deliveryLatitude != null && order.deliveryLongitude != null
                        ? `https://www.google.com/maps/search/?api=1&query=${order.deliveryLatitude},${order.deliveryLongitude}`
                        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.deliveryAddress)}`
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    📍 Open in Google Maps
                  </a>
                </p>
              </article>

              <article className="info-card">
                <p className="eyebrow">Dispatch</p>
                <strong>{order.assignedRider || 'Rider assignment pending'}</strong>
                {order.assignedRider && order.assignedRiderPhone ? (
                  <p>
                    Rider phone:{' '}
                    <a href={`tel:${order.assignedRiderPhone}`}>{order.assignedRiderPhone}</a>
                  </p>
                ) : null}
                <p>Payment: {labelizeStatus(order.paymentMethod)}</p>
                <p>Region: {order.geoLabel || 'Unavailable'}</p>
                <p>Updated {formatDateTime(order.updatedDate)}</p>

                {/* Live rider location — only shown while out for delivery */}
                {order.status === 'out_for_delivery' && riderLocation && (
                  <div className="rider-live-card">
                    <div className="rider-live-card__header">
                      <span className="rider-live-card__dot" />
                      <span className="rider-live-card__title">Rider is on the way</span>
                      <span className="rider-live-card__age">
                        {(() => {
                          const secs = Math.round((Date.now() - new Date(riderLocation.updatedAt).getTime()) / 1000);
                          return secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
                        })()}
                      </span>
                    </div>
                    <iframe
                      className="rider-live-card__map"
                      title="Rider live location"
                      loading="lazy"
                      src={`https://www.openstreetmap.org/export/embed.html?bbox=${riderLocation.longitude - 0.006},${riderLocation.latitude - 0.004},${riderLocation.longitude + 0.006},${riderLocation.latitude + 0.004}&layer=mapnik&marker=${riderLocation.latitude},${riderLocation.longitude}`}
                    />
                    <a
                      className="rider-live-card__maps-link"
                      href={`https://www.google.com/maps/search/?api=1&query=${riderLocation.latitude},${riderLocation.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      📍 Open rider location in Google Maps
                    </a>
                  </div>
                )}
              </article>
            </div>
          </div>

          <aside className="tracking-summary">
            <div className="qr-card qr-card--compact">
              <QRCodeSVG value={window.location.href} size={140} includeMargin />
              <span>Scan to reopen this tracking page.</span>
            </div>

            <div className="info-card">
              <p className="eyebrow">Order items</p>
              {order.items.map((item) => {
                const isRejected = !!item.rejectedAt;
                return (
                  <div
                    key={item.id}
                    className={`line-item${isRejected ? ' line-item--rejected' : ''}`}
                  >
                    <span>
                      <span className={isRejected ? 'items-table__strike' : undefined}>
                        {item.quantity} x {item.productName}
                      </span>
                      {isRejected ? (
                        <>
                          <div>
                            <span className="line-item__removed-chip">
                              Removed by store
                            </span>
                          </div>
                          {item.rejectionReason ? (
                            <div className="line-item__removed-reason">
                              Reason: {item.rejectionReason}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </span>
                    <strong className={isRejected ? 'items-table__strike' : undefined}>
                      {formatCurrency(item.lineTotalCents)}
                    </strong>
                  </div>
                );
              })}
              <div className="line-item">
                <span>Delivery</span>
                <strong>
                  {order.deliveryFeeCents ? formatCurrency(order.deliveryFeeCents) : 'Free'}
                </strong>
              </div>
              <div className="line-item line-item--grand">
                <span>Total</span>
                <strong>{formatCurrency(order.totalCents)}</strong>
              </div>
            </div>
          </aside>
        </section>
      ) : null}
    </main>
  );
}

export default TrackOrder;
