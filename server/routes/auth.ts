import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  createPhoneUser,
  createUser,
  deleteUserById,
  findUserByEmail,
  findUserByPhoneE164,
  getDefaultCompanyId,
  incrementFailedAttempts,
  listRiders,
  listTeamMembers,
  listUserAddresses,
  lockUser,
  resetFailedAttempts,
  rotateUserSession,
} from '../db.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { getConnectedRiderIds } from '../ws.js';
import { normalizePhoneIN, sendOtp, verifyOtp } from '../otp.js';
import type { AuthenticatedRequest, UserRole } from '../types.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'bestmart-secret-key-2026';

router.post('/login', async (req, res) => {
  try {
    const { email, password, client } = req.body as {
      email?: string;
      password?: string;
      client?: string;
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

    // Each client app pins its own expected role. Staff using the
    // wrong app gets a generic "wrong account" message instead of
    // leaking which role their email actually carries.
    const clientRole: Record<string, UserRole> = {
      customer: 'viewer',
      picker: 'picker',
    };
    const expectedRole = client ? clientRole[client] : undefined;
    if (expectedRole && user.role !== expectedRole) {
      return res.status(403).json({
        error: `This account is not a ${expectedRole} account. Please use your assigned app.`,
      });
    }

    await resetFailedAttempts(email);

    const sid = await rotateUserSession(user.id);
    const token = jwt.sign(
      {
        uid: user.uid,
        email: user.email,
        sid,
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

    const sid = await rotateUserSession(user.id);
    const token = jwt.sign(
      { uid: user.uid, email: user.email, sid },
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

// Phone-OTP login. Two-step flow:
//   1) POST /otp/send { phone } → MSG91 dispatches a 6-digit code, returns
//      { requestId, expiresIn }. Rate-limited per phone and per IP.
//   2) POST /otp/verify { phone, otp, requestId } → on success, find-or-create
//      a customer keyed by E.164 phone and return { token, user } in the same
//      shape as /login.
router.post('/otp/send', async (req, res) => {
  try {
    const { phone } = req.body as { phone?: string };
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    const phoneE164 = normalizePhoneIN(phone);
    if (!phoneE164) {
      return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });
    }
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';

    const result = await sendOtp(phoneE164, ip);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json({
      requestId: result.requestId,
      expiresIn: result.expiresIn,
      ...(result.devOtp ? { devOtp: result.devOtp } : {}),
    });
  } catch (error) {
    console.error('OTP send error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const { phone, otp, requestId, client } = req.body as {
      phone?: string;
      otp?: string;
      requestId?: string;
      client?: string;
    };
    if (!phone || !otp || !requestId) {
      return res.status(400).json({ error: 'Phone, OTP, and requestId are required' });
    }
    const phoneE164 = normalizePhoneIN(phone);
    if (!phoneE164) {
      return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });
    }
    const cleanOtp = otp.trim();
    if (!/^\d{4,8}$/.test(cleanOtp)) {
      return res.status(400).json({ error: 'Invalid OTP format' });
    }

    const verify = await verifyOtp(phoneE164, cleanOtp, requestId);
    if (!verify.ok) {
      return res.status(verify.status).json({ error: verify.error });
    }

    let user = await findUserByPhoneE164(phoneE164);
    if (!user) {
      const companyId = await getDefaultCompanyId();
      if (!companyId) {
        return res.status(500).json({ error: 'Store is not available right now' });
      }
      user = await createPhoneUser({ phoneE164, companyId });
      if (!user) {
        return res.status(500).json({ error: 'Failed to create account' });
      }
    }

    if (user.lockedAt) {
      return res.status(423).json({
        error: 'Account locked. Contact the administrator.',
      });
    }

    // Same per-client role guard as /login: a phone number tied to a
    // staff account must not be able to back-door into another app via
    // OTP. Customer is the only OTP-using client today; the picker /
    // rider apps don't expose OTP login.
    const otpClientRole: Record<string, UserRole> = {
      customer: 'viewer',
      picker: 'picker',
    };
    const expectedRole = client ? otpClientRole[client] : undefined;
    if (expectedRole && user.role !== expectedRole) {
      return res.status(403).json({
        error: `This account is not a ${expectedRole} account. Please use your assigned app.`,
      });
    }

    const sid = await rotateUserSession(user.id);
    const token = jwt.sign({ uid: user.uid, email: user.email, sid }, JWT_SECRET, {
      expiresIn: '7d',
    });

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
    console.error('OTP verify error:', error);
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
    const onlyAvailable = req.query.available === 'true';
    const raw = await listRiders(req.user.companyId, { onlyAvailable });
    const connected = getConnectedRiderIds();
    const riders = raw.map((r) => ({ ...r, isOnline: connected.has(r.id) }));
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
      // Superuser is the platform owner — provisioned out-of-band, never
      // creatable from the admin panel. Admin endpoint must reject it
      // even if the UI somehow surfaces it.
      if (!['admin', 'editor', 'viewer', 'rider', 'picker'].includes(role)) {
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
