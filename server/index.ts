import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import brandRoutes from './routes/brands.js';
import categoryRoutes from './routes/categories.js';
import companyRoutes from './routes/company.js';
import couponRoutes from './routes/coupons.js';
import deviceRoutes from './routes/devices.js';
import mobileRoutes from './routes/mobile.js';
import productRoutes from './routes/products.js';
import orderRoutes from './routes/orders.js';
import riderRoutes from './routes/rider.js';
import { initDatabase } from './db.js';
import { attachWebSocket } from './ws.js';

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
app.use(express.json({ limit: '20mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/brands', brandRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/company', companyRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/mobile', mobileRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/rider', riderRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function start() {
  try {
    await initDatabase();

    const server = http.createServer(app);
    attachWebSocket(server);

    server.listen(PORT, () => {
      console.log(`BestMart API running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start BestMart API:', error);
    process.exit(1);
  }
}

start();
