import { Router } from 'express';
import { getCompanyPublic } from '../db.js';
import {
  DELIVERY_SLOT_VALUES,
  MOBILE_FEATURE_FLAGS,
  ORDER_STATUS_VALUES,
  PAYMENT_METHOD_VALUES,
} from '../constants.js';
import { TTL, cacheGet, cacheSet, key } from '../cache.js';

const router = Router();

router.get('/bootstrap', async (_req, res) => {
  const cacheKey = key.mobileBootstrap();
  const cached = await cacheGet<object>(cacheKey);
  if (cached) return res.json(cached);

  const company = await getCompanyPublic();
  if (!company) {
    return res.status(404).json({ error: 'Company not found' });
  }

  const result = {
    app: {
      name: 'BestMart',
      mobileReady: true,
      recommendedFramework: 'Flutter',
      supportedPlatforms: ['ios', 'android'],
      authStrategy: 'jwt',
      apiBasePath: '/api',
      minSupportedVersion: '1.0.0',
    },
    company,
    ordering: {
      trackingStatuses: ORDER_STATUS_VALUES,
      paymentMethods: PAYMENT_METHOD_VALUES,
      deliverySlots: DELIVERY_SLOT_VALUES,
      freeDeliveryThresholdCents: 150000,
      defaultDeliveryFeeCents: 4900,
    },
    features: MOBILE_FEATURE_FLAGS,
  };
  await cacheSet(cacheKey, result, TTL.COMPANY);
  return res.json(result);
});

export default router;
