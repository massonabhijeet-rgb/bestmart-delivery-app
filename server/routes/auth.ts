import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  createUser,
  deleteUserById,
  findUserByEmail,
  getDefaultCompanyId,
  incrementFailedAttempts,
  listRiders,
  listTeamMembers,
  listUserAddresses,
  lockUser,
  resetFailedAttempts,
} from '../db.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import type { AuthenticatedRequest, UserRole } from '../types.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'bestmart-secret-key-2026';

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body as {
      email?: string;
      password?: string;
    };

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.lockedAt) {
      return res.status(423).json({
        error: 'Account locked due to too many failed login attempts. Contact the administrator.',
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const attempts = await incrementFailedAttempts(email);
      if (attempts >= 5) {
        await lockUser(email);
        return res.status(423).json({
          error: 'Account locked due to too many failed login attempts. Contact the administrator.',
        });
      }
      return res.status(401).json({
        error: `Invalid email or password. ${5 - attempts} attempt(s) remaining.`,
      });
    }

    await resetFailedAttempts(email);

    const token = jwt.sign(
      {
        uid: user.uid,
        email: user.email,
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        uid: user.uid,
        email: user.email,
        companyId: user.companyId,
        companyName: user.companyName,
        role: user.role,
        fullName: user.fullName,
        phone: user.phone,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body as {
      email?: string;
      password?: string;
    };

    const normalizedEmail = email?.trim().toLowerCase() ?? '';
    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const companyId = await getDefaultCompanyId();
    if (!companyId) {
      return res.status(500).json({ error: 'Store is not available right now' });
    }

    const existing = await findUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const created = await createUser({
      email: normalizedEmail,
      password,
      role: 'viewer',
      companyId,
    });

    const user = await findUserByEmail(normalizedEmail);
    if (!user) {
      return res.status(500).json({ error: 'Failed to create account' });
    }

    const token = jwt.sign(
      { uid: user.uid, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        uid: user.uid,
        email: user.email,
        companyId: user.companyId,
        companyName: user.companyName,
        role: user.role,
        fullName: user.fullName,
        phone: user.phone,
      },
      created,
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', authenticateToken, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const details = await findUserByEmail(req.user.email);

  return res.json({
    user: {
      id: req.user.id,
      uid: req.user.uid,
      email: req.user.email,
      companyId: req.user.companyId,
      companyName: req.user.companyName,
      role: req.user.role,
      fullName: details?.fullName ?? null,
      phone: details?.phone ?? null,
    },
  });
});

// Self-service account deletion. Admin accounts are not deletable from the
// mobile app — if the only admin deletes themselves the storefront becomes
// unmanageable. Admins must be removed by another admin from the web console.
router.delete('/me', authenticateToken, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role === 'admin') {
    return res.status(403).json({
      error: 'Admin accounts cannot be deleted from the app. Contact support.',
    });
  }
  try {
    const deleted = await deleteUserById(req.user.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Account not found' });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error('Delete account error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/addresses', authenticateToken, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const addresses = await listUserAddresses(req.user.id);
  return res.json({ addresses });
});

router.get(
  '/team',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const team = await listTeamMembers(req.user.companyId);
    return res.json({ team });
  }
);

router.get(
  '/riders',
  authenticateToken,
  requireRole('admin', 'editor'),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const riders = await listRiders(req.user.companyId);
    return res.json({ riders });
  }
);

router.post(
  '/create-user',
  authenticateToken,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { email, password, role, fullName, phone } = req.body as {
        email?: string;
        password?: string;
        role?: UserRole;
        fullName?: string;
        phone?: string;
      };

      if (!email || !password || !role) {
        return res.status(400).json({ error: 'Email, password, and role are required' });
      }
      if (!['admin', 'editor', 'viewer', 'rider'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      const existing = await findUserByEmail(email);
      if (existing) {
        return res.status(409).json({ error: 'A user with that email already exists' });
      }

      const user = await createUser({
        email,
        password,
        role,
        companyId: req.user.companyId,
        fullName: fullName?.trim() || null,
        phone: phone?.trim() || null,
      });

      return res.status(201).json({
        message: 'Team member created',
        user,
      });
    } catch (error) {
      console.error('Create user error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
