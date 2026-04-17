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
  bogoBuyQty?: number;
  bogoGetQty?: number;
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

export function bogoBuy(product: PricedProduct): number {
  return Math.max(1, Number(product.bogoBuyQty ?? 1));
}
export function bogoGet(product: PricedProduct): number {
  return Math.max(1, Number(product.bogoGetQty ?? 1));
}

export function bogoBillableQty(product: PricedProduct, quantity: number): number {
  const buy = bogoBuy(product);
  const get = bogoGet(product);
  const freeUnits = Math.floor(quantity / (buy + get)) * get;
  return Math.max(quantity - freeUnits, 0);
}

// Line total applying BOGO (pay for billable qty) or discounted unit price.
export function lineTotalCents(product: PricedProduct, quantity: number) {
  if (product.isOnOffer && product.offerType === 'bogo') {
    return product.priceCents * bogoBillableQty(product, quantity);
  }
  return effectivePriceCents(product) * quantity;
}

export function isBogoProduct(product: PricedProduct) {
  return Boolean(product.isOnOffer && product.offerType === 'bogo');
}

export function bogoLabel(product: PricedProduct): string {
  const buy = bogoBuy(product);
  const get = bogoGet(product);
  return `Buy ${buy} Get ${get} FREE`;
}
