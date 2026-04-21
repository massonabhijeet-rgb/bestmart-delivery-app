import { useEffect, useState } from 'react';
import { apiListMyOrders } from '../services/api';
import type { Order } from '../services/api';
import { formatCurrency, formatDateTime, labelizeStatus } from '../lib/format';

interface MyOrdersProps {
  onBackToStore: () => void;
  onTrack: (code: string) => void;
}

function ribbonCopy(status: string): { label: string; icon: string } {
  switch (status) {
    case 'placed':
      return { label: 'Waiting for store confirmation', icon: '⏳' };
    case 'confirmed':
      return { label: 'Order confirmed', icon: '✓' };
    case 'packing':
      return { label: 'Packing your order', icon: '📦' };
    case 'out_for_delivery':
      return { label: 'On the way', icon: '🛵' };
    default:
      return { label: status, icon: 'ℹ' };
  }
}

function MyOrders({ onBackToStore, onTrack }: MyOrdersProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiListMyOrders()
      .then((list) => {
        if (!cancelled) setOrders(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load your orders');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = [...orders]
    .filter((o) => o.status !== 'cancelled')
    .sort(
      (a, b) => new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime(),
    );

  return (
    <div className="my-orders">
      <header className="my-orders__header">
        <button type="button" className="ghost-button" onClick={onBackToStore}>
          ← Back to store
        </button>
        <h1>My Orders</h1>
        <p className="my-orders__subtitle">
          {sorted.length > 0
            ? `You've placed ${sorted.length} order${sorted.length === 1 ? '' : 's'}.`
            : 'No orders yet.'}
        </p>
      </header>

      {loading && (
        <div className="my-orders__loading">
          <div className="app-loading__orb" />
          <p>Loading your orders…</p>
        </div>
      )}

      {error && !loading && (
        <div className="my-orders__error">{error}</div>
      )}

      {!loading && !error && sorted.length === 0 && (
        <div className="my-orders__empty">
          <p>Your order history will appear here once you place your first order.</p>
          <button type="button" className="primary-button" onClick={onBackToStore}>
            Start shopping
          </button>
        </div>
      )}

      {!loading && !error && sorted.length > 0 && (
        <ul className="my-orders__list">
          {sorted.map((order) => {
            const itemCount = order.items?.reduce((sum, it) => sum + it.quantity, 0) ?? 0;
            const firstItems = order.items?.slice(0, 3).map((it) => it.productName).join(', ') ?? '';
            const more = (order.items?.length ?? 0) > 3 ? ` +${(order.items?.length ?? 0) - 3} more` : '';
            const inProgress =
              order.status !== 'delivered' && order.status !== 'cancelled';
            const ribbon = inProgress ? ribbonCopy(order.status) : null;
            return (
              <li
                key={order.publicId}
                className={`my-orders__card${inProgress ? ' my-orders__card--active' : ''}`}
              >
                {ribbon && (
                  <div className={`my-orders__ribbon my-orders__ribbon--${order.status}`}>
                    <span className="my-orders__ribbon-dot" aria-hidden />
                    <span className="my-orders__ribbon-icon" aria-hidden>{ribbon.icon}</span>
                    <span className="my-orders__ribbon-label">{ribbon.label}</span>
                    <span className="my-orders__ribbon-tag">IN PROGRESS</span>
                  </div>
                )}
                <div className="my-orders__card-body">
                  <div className="my-orders__card-row">
                    <div className="my-orders__card-main">
                      <span className="my-orders__id">#{order.publicId}</span>
                      <span className="my-orders__date">
                        {formatDateTime(order.createdDate)}
                      </span>
                    </div>
                    {!inProgress && (
                      <span className={`my-orders__status my-orders__status--${order.status}`}>
                        {labelizeStatus(order.status)}
                      </span>
                    )}
                  </div>
                  <div className="my-orders__items">
                    {itemCount} item{itemCount === 1 ? '' : 's'} · {firstItems}{more}
                  </div>
                  <div className="my-orders__card-foot">
                    <span className="my-orders__total">{formatCurrency(order.totalCents)}</span>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => onTrack(order.publicId)}
                    >
                      View details
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default MyOrders;
