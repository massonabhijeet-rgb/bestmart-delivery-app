import type { Request } from 'express';

export type UserRole = 'admin' | 'editor' | 'viewer' | 'rider' | 'picker';

export type OrderStatus =
  | 'placed'
  | 'confirmed'
  | 'packing'
  | 'packed'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

export interface RequestUser {
  id: number;
  uid: string;
  email: string;
  role: UserRole;
  companyId: number;
  companyName: string;
  fullName: string | null;
}

export interface AuthenticatedRequest extends Request {
  user?: RequestUser;
}
