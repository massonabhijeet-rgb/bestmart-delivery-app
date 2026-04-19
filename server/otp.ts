import crypto from 'node:crypto';
import { getRedis } from './cache.js';

// MSG91 OTP flow with Redis rate-limiting.
//
// Design:
// - We generate the 6-digit OTP server-side, hash it with sha256+salt, and
//   store {hash, attempts, requestId} in Redis with a 5-minute TTL.
// - MSG91 is used as a dumb SMS sender via their template API (we pass the
//   OTP we generated). This lets us own verification + rate limits and swap
//   providers without touching the verify path.
// - Rate limits live in Redis with sliding-window counters keyed by phone
//   and by IP. Limits return false from sendOtp() so the route can respond
//   429 without revealing whether the phone exists.

export const OTP_TTL_SECONDS = 300; // 5 min
const RESEND_COOLDOWN_SECONDS = 60;
const PHONE_HOURLY_CAP = 5;
const IP_HOURLY_CAP = 20;
const MAX_VERIFY_ATTEMPTS = 5;
const HOURLY_WINDOW_SECONDS = 60 * 60;

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY ?? '';
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID ?? '';
const MSG91_SENDER_ID = process.env.MSG91_SENDER_ID ?? '';
const OTP_DEV_MODE =
  process.env.OTP_DEV_MODE === 'true' || !MSG91_AUTH_KEY || !MSG91_TEMPLATE_ID;

const OTP_SECRET = process.env.OTP_HASH_SECRET || process.env.JWT_SECRET || 'bestmart-otp-pepper';

function hashOtp(otp: string, requestId: string): string {
  return crypto
    .createHmac('sha256', OTP_SECRET)
    .update(`${requestId}:${otp}`)
    .digest('hex');
}

function generateOtp(): string {
  // Avoid leading zero so the SMS is always 6 visible digits.
  const n = 100000 + crypto.randomInt(0, 900000);
  return String(n);
}

function otpKey(phoneE164: string): string {
  return `bm:otp:${phoneE164}`;
}

function phoneCountKey(phoneE164: string): string {
  return `bm:otp:cnt:phone:${phoneE164}`;
}

function ipCountKey(ip: string): string {
  return `bm:otp:cnt:ip:${ip}`;
}

function cooldownKey(phoneE164: string): string {
  return `bm:otp:cd:${phoneE164}`;
}

export interface OtpSendResult {
  ok: true;
  requestId: string;
  expiresIn: number;
  // In dev mode the OTP is returned so QA can test without a real SMS.
  devOtp?: string;
}

export interface OtpSendError {
  ok: false;
  status: number;
  error: string;
}

export async function sendOtp(
  phoneE164: string,
  ip: string
): Promise<OtpSendResult | OtpSendError> {
  const redis = getRedis();
  if (!redis) {
    return { ok: false, status: 503, error: 'OTP service is not available right now' };
  }

  // Per-phone resend cooldown — fail fast if user hits "Resend" too eagerly.
  const cdHit = await redis.get(cooldownKey(phoneE164));
  if (cdHit) {
    const ttl = await redis.ttl(cooldownKey(phoneE164));
    return {
      ok: false,
      status: 429,
      error: `Please wait ${ttl > 0 ? ttl : RESEND_COOLDOWN_SECONDS}s before requesting another code`,
    };
  }

  // Per-phone hourly cap.
  const phoneCount = await redis.incr(phoneCountKey(phoneE164));
  if (phoneCount === 1) {
    await redis.expire(phoneCountKey(phoneE164), HOURLY_WINDOW_SECONDS);
  }
  if (phoneCount > PHONE_HOURLY_CAP) {
    return {
      ok: false,
      status: 429,
      error: 'Too many OTP requests for this number. Try again later.',
    };
  }

  // Per-IP hourly cap (anti-enumeration / abuse).
  const ipCount = await redis.incr(ipCountKey(ip));
  if (ipCount === 1) {
    await redis.expire(ipCountKey(ip), HOURLY_WINDOW_SECONDS);
  }
  if (ipCount > IP_HOURLY_CAP) {
    return {
      ok: false,
      status: 429,
      error: 'Too many OTP requests. Try again later.',
    };
  }

  const otp = generateOtp();
  const requestId = crypto.randomUUID();
  const hash = hashOtp(otp, requestId);

  // Single key per phone — issuing a new OTP invalidates the previous one.
  await redis.set(
    otpKey(phoneE164),
    JSON.stringify({ hash, requestId, attempts: 0 }),
    'EX',
    OTP_TTL_SECONDS
  );
  await redis.set(cooldownKey(phoneE164), '1', 'EX', RESEND_COOLDOWN_SECONDS);

  if (OTP_DEV_MODE) {
    console.info(`[otp] DEV MODE — phone=${phoneE164} otp=${otp} requestId=${requestId}`);
    return { ok: true, requestId, expiresIn: OTP_TTL_SECONDS, devOtp: otp };
  }

  try {
    await sendViaMsg91(phoneE164, otp);
  } catch (err) {
    console.error('[otp] MSG91 send failed:', err);
    // Wipe the OTP — user shouldn't be able to verify a code that was never delivered.
    await redis.del(otpKey(phoneE164), cooldownKey(phoneE164));
    return { ok: false, status: 502, error: 'Failed to send OTP. Please try again.' };
  }

  return { ok: true, requestId, expiresIn: OTP_TTL_SECONDS };
}

export interface OtpVerifyResult {
  ok: true;
}

export interface OtpVerifyError {
  ok: false;
  status: number;
  error: string;
}

export async function verifyOtp(
  phoneE164: string,
  otp: string,
  requestId: string
): Promise<OtpVerifyResult | OtpVerifyError> {
  const redis = getRedis();
  if (!redis) {
    return { ok: false, status: 503, error: 'OTP service is not available right now' };
  }

  const raw = await redis.get(otpKey(phoneE164));
  if (!raw) {
    return { ok: false, status: 400, error: 'OTP expired. Please request a new one.' };
  }

  let stored: { hash: string; requestId: string; attempts: number };
  try {
    stored = JSON.parse(raw);
  } catch {
    await redis.del(otpKey(phoneE164));
    return { ok: false, status: 400, error: 'OTP expired. Please request a new one.' };
  }

  if (stored.requestId !== requestId) {
    return { ok: false, status: 400, error: 'OTP no longer valid. Please request a new one.' };
  }

  if (stored.attempts >= MAX_VERIFY_ATTEMPTS) {
    await redis.del(otpKey(phoneE164));
    return {
      ok: false,
      status: 429,
      error: 'Too many incorrect attempts. Please request a new code.',
    };
  }

  const candidate = hashOtp(otp, requestId);
  if (!safeEqual(candidate, stored.hash)) {
    stored.attempts += 1;
    const ttl = await redis.ttl(otpKey(phoneE164));
    await redis.set(
      otpKey(phoneE164),
      JSON.stringify(stored),
      'EX',
      ttl > 0 ? ttl : OTP_TTL_SECONDS
    );
    const remaining = MAX_VERIFY_ATTEMPTS - stored.attempts;
    return {
      ok: false,
      status: 401,
      error:
        remaining > 0
          ? `Incorrect OTP. ${remaining} attempt(s) remaining.`
          : 'Too many incorrect attempts. Please request a new code.',
    };
  }

  // One-shot: burn the OTP on success so it can't be replayed.
  await redis.del(otpKey(phoneE164), cooldownKey(phoneE164));
  return { ok: true };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Normalise an Indian mobile number to E.164 (+91XXXXXXXXXX). Accepts:
//   "+919876543210", "919876543210", "9876543210", "98765 43210"
// Returns null on anything that doesn't look like a 10-digit Indian mobile
// (first digit 6-9 per TRAI numbering plan).
export function normalizePhoneIN(input: string): string | null {
  const digits = input.replace(/[^0-9]/g, '');
  let local: string;
  if (digits.length === 10) {
    local = digits;
  } else if (digits.length === 12 && digits.startsWith('91')) {
    local = digits.slice(2);
  } else if (digits.length === 13 && digits.startsWith('091')) {
    local = digits.slice(3);
  } else {
    return null;
  }
  if (!/^[6-9]\d{9}$/.test(local)) return null;
  return `+91${local}`;
}

// MSG91 OTP send via template. We pass our own OTP so the verify path stays
// fully ours. Docs: https://docs.msg91.com/p/tf9GTextN/e/Hyd0HCG2Mg/MSG91
async function sendViaMsg91(phoneE164: string, otp: string): Promise<void> {
  // MSG91 expects the mobile number with country code, no '+'.
  const mobile = phoneE164.replace(/^\+/, '');
  const url = new URL('https://control.msg91.com/api/v5/otp');
  url.searchParams.set('template_id', MSG91_TEMPLATE_ID);
  url.searchParams.set('mobile', mobile);
  url.searchParams.set('otp', otp);
  url.searchParams.set('otp_expiry', String(Math.ceil(OTP_TTL_SECONDS / 60)));
  if (MSG91_SENDER_ID) url.searchParams.set('sender', MSG91_SENDER_ID);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { authkey: MSG91_AUTH_KEY, accept: 'application/json' },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`MSG91 HTTP ${res.status}: ${body}`);
  }
  // MSG91 returns 200 even on logical failure — inspect type field.
  try {
    const json = JSON.parse(body) as { type?: string; message?: string };
    if (json.type && json.type !== 'success') {
      throw new Error(`MSG91 error: ${json.message ?? body}`);
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`MSG91 unexpected response: ${body}`);
    }
    throw e;
  }
}
