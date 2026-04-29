import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import brandRoutes from './routes/brands.js';
import campaignRoutes from './routes/campaigns.js';
import categoryRoutes from './routes/categories.js';
import companyRoutes from './routes/company.js';
import couponRoutes from './routes/coupons.js';
import deviceRoutes from './routes/devices.js';
import mobileRoutes from './routes/mobile.js';
import productRoutes from './routes/products.js';
import orderRoutes from './routes/orders.js';
import paymentRoutes from './routes/payments.js';
import pickerRoutes from './routes/picker.js';
import riderRoutes from './routes/rider.js';
import themedPageRoutes from './routes/themedPages.js';
import {
  expireAndReassignStaleAssignments,
  getOrderByPublicId,
  initDatabase,
} from './db.js';
import { notifyRiderAssigned } from './push.js';
import {
  attachWebSocket,
  broadcast,
  getConnectedRiderIds,
  getRiderLocations,
} from './ws.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  'https://www.bestmart.co.in',
  'https://bestmart.co.in',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        origin.endsWith('.vercel.app') ||
        /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(origin) ||
        /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/.test(origin) ||
        /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/.test(origin)
      ) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
// Razorpay webhook signatures are computed over the raw request body, so we
// must register the raw parser BEFORE express.json() — otherwise JSON parsing
// normalises the bytes and the HMAC no longer matches.
app.use(
  '/api/payments/webhook',
  express.raw({ type: 'application/json', limit: '1mb' })
);
app.use(express.json({ limit: '20mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/brands', brandRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/company', companyRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/mobile', mobileRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/picker', pickerRoutes);
app.use('/api/rider', riderRoutes);
app.use('/api/themed-pages', themedPageRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Polls every second for rider assignments where the rider didn't accept
// in time. The DB-side helper handles the actual reassignment + skip-list
// bookkeeping atomically; this loop just hydrates the resulting order
// snapshots, broadcasts them, and pushes to the new rider.
function startRiderAssignmentSweep() {
  let inFlight = false;
  setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const presence = {
        connectedRiderIds: getConnectedRiderIds(),
        locations: new Map(
          getRiderLocations().map((l) => [
            l.riderId,
            { latitude: l.latitude, longitude: l.longitude },
          ]),
        ),
      };
      const handled = await expireAndReassignStaleAssignments(presence);
      for (const ev of handled) {
        const order = await getOrderByPublicId(ev.publicId);
        if (!order) continue;
        broadcast({ type: 'order_updated', payload: order });
        if (ev.newRiderUserId) {
          void notifyRiderAssigned({
            riderUserId: ev.newRiderUserId,
            publicId: order.publicId,
            customerName: order.customerName ?? 'Customer',
            deliveryAddress: order.deliveryAddress ?? '',
          });
        }
      }
    } catch (error) {
      console.error('[rider-sweep] failed:', error);
    } finally {
      inFlight = false;
    }
  }, 1000);
}

async function start() {
  try {
    await initDatabase();

    const server = http.createServer(app);
    attachWebSocket(server);

    server.listen(PORT, () => {
      console.log(`BestMart API running on http://localhost:${PORT}`);
    });

    startRiderAssignmentSweep();
  } catch (error) {
    console.error('Failed to start BestMart API:', error);
    process.exit(1);
  }
}

start();
