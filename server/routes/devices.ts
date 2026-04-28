import { Router } from 'express';
import { registerUserDevice, unregisterUserDevice } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

router.post('/', authenticateToken, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const { token, platform } = req.body as {
    token?: string;
    platform?: string;
  };
  if (!token || typeof token !== 'string' || token.length > 4096) {
    return res.status(400).json({ error: 'Invalid device token' });
  }
  if (platform !== 'ios' && platform !== 'android') {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  try {
    await registerUserDevice(req.user.id, token, platform);
    console.log(`[devices] registered userId=${req.user.id} email=${req.user.email} platform=${platform} token=${token.slice(0, 20)}...`);
    return res.json({ ok: true, registeredFor: { id: req.user.id, email: req.user.email } });
  } catch (error) {
    console.error('Register device error:', error);
    return res.status(500).json({ error: 'Failed to register device' });
  }
});

router.delete('/:token', authenticateToken, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const raw = req.params.token;
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }
  try {
    await unregisterUserDevice(req.user.id, token);
    return res.json({ ok: true });
  } catch (error) {
    console.error('Unregister device error:', error);
    return res.status(500).json({ error: 'Failed to unregister device' });
  }
});

export default router;
