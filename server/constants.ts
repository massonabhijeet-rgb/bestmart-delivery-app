import type { OrderStatus } from './types.js';

export const ORDER_STATUS_VALUES: OrderStatus[] = [
  'placed',
  'confirmed',
  'packing',
  'packed',
  'out_for_delivery',
  'delivered',
  'cancelled',
];

export const PAYMENT_METHOD_VALUES = [
  'cash_on_delivery',
  'upi',
  'card_on_delivery',
  'razorpay',
] as const;

export const PAYMENT_STATUS_VALUES = ['pending', 'paid', 'refunded', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS_VALUES)[number];

export const DELIVERY_SLOT_VALUES = [
  '20-30 min express',
  '30-45 min standard',
  '60 min scheduled',
] as const;

export const MOBILE_FEATURE_FLAGS = {
  auth: true,
  catalog: true,
  cart: true,
  checkout: true,
  orderTracking: true,
  dashboardReadOnly: true,
  dashboardEditing: true,
  pushNotificationsPlanned: true,
};
