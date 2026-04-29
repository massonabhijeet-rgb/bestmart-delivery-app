import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import { findUserByUid } from '../db.js';
import type { AuthenticatedRequest, UserRole } from '../types.js';

const JWT_SECRET = process.env.JWT_SECRET || 'bestmart-secret-key-2026';

interface JwtPayload {
  uid: string;
  email: string;
  sid?: string;
}

async function loadUserFromToken(req: AuthenticatedRequest, strict: boolean, res: Response) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    if (strict) {
      res.status(401).json({ error: 'Authentication required' });
    }
    return false;
  }

  try {
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const user = await findUserByUid(payload.uid);
    if (!user) {
      if (strict) {
        res.status(401).json({ error: 'User not found' });
      }
      return false;
    }
    // Single-sign-on: every login mints a fresh session_id, so any
    // older JWT (issued for a previous device) won't match the user's
    // current session and is rejected here. The mobile app catches
    // this 401 and bounces to login.
    if (user.sessionId && payload.sid !== user.sessionId) {
      if (strict) {
        res.status(401).json({ error: 'Session ended — signed in elsewhere' });
      }
      return false;
    }
    req.user = {
      id: user.id,
      uid: user.uid,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      companyName: user.companyName,
      fullName: user.fullName ?? null,
    };
    return true;
  } catch {
    if (strict) {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
    return false;
  }
}

export async function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const ok = await loadUserFromToken(req, true, res);
  if (ok) {
    next();
  }
}

export async function attachUserIfPresent(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  await loadUserFromToken(req, false, res);
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // Superuser is the platform-owner role and implicitly satisfies
    // every per-route check — that way callers never have to remember
    // to include 'superuser' in their allow-list, and adding new admin
    // endpoints later is automatically reachable by superuser.
    if (req.user.role === 'superuser') {
      return next();
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    return next();
  };
}
