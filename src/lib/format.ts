import { format, formatDistanceToNow } from 'date-fns';

export function formatCurrency(cents: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function formatDateTime(value: string) {
  return format(new Date(value), 'dd MMM yyyy, h:mm a');
}

export function formatRelativeTime(value: string) {
  return formatDistanceToNow(new Date(value), { addSuffix: true });
}

export function labelizeStatus(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

interface PricedProduct {
  priceCents: number;
  isOnOffer: boolean;
  offerPriceCents: number | null;
  offerType?: 'price' | 'bogo';
}

// Per-unit display price. BOGO does not change unit price; the discount comes from free units.
export function effectivePriceCents(product: PricedProduct) {
  if (product.isOnOffer && product.offerType === 'bogo') {
    return product.priceCents;
  }
  return product.isOnOffer && product.offerPriceCents != null
    ? product.offerPriceCents
    : product.priceCents;
}

// Line total applying BOGO (pay for ceil(qty/2) units) or discounted unit price.
export function lineTotalCents(product: PricedProduct, quantity: number) {
  if (product.isOnOffer && product.offerType === 'bogo') {
    return product.priceCents * Math.ceil(quantity / 2);
  }
  return effectivePriceCents(product) * quantity;
}

export function isBogoProduct(product: PricedProduct) {
  return Boolean(product.isOnOffer && product.offerType === 'bogo');
}
