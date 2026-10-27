import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// backend/.env wins, then the repo-root .env used by docker compose.
for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../.env'),
]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate });
}

function str(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`[config] missing required env var ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`[config] ${name} must be an integer, got "${raw}"`);
  return parsed;
}

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

export const env = {
  nodeEnv,
  isProduction,
  port: int('PORT', 4000),

  databaseUrl: str('DATABASE_URL', 'postgres://voiza:voiza@localhost:5432/voiza'),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),

  jwtSecret: str('JWT_SECRET', 'change-me-in-production'),
  jwtExpiresIn: str('JWT_EXPIRES_IN', '30d'),

  livekit: {
    url: str('LIVEKIT_URL', 'ws://localhost:7880'),
    // Clients must dial a reachable address; inside compose the service name is
    // only resolvable container-to-container, so expose an override for phones.
    publicUrl: str('LIVEKIT_PUBLIC_URL', str('LIVEKIT_URL', 'ws://localhost:7880')),
    apiKey: str('LIVEKIT_API_KEY', 'voiza-dev-access-key'),
    apiSecret: str('LIVEKIT_API_SECRET', 'voiza-dev-secret-key-change-me-32chars'),
    tokenTtlSeconds: int('LIVEKIT_TOKEN_TTL', 6 * 60 * 60),
  },

  auth: {
    otpMockCode: process.env.OTP_MOCK_CODE || '',
    otpTtlSeconds: int('OTP_TTL_SECONDS', 300),
    otpMaxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    otpRequestPerMinute: int('OTP_REQUEST_PER_MINUTE', 4),
  },

  sms: {
    // `mock` logs the code instead of sending it and is the only sensible value
    // on a laptop; the production boot guard below rejects it.
    provider: str('SMS_PROVIDER', 'mock'),
    twilioAccountSid: str('TWILIO_ACCOUNT_SID', ''),
    twilioAuthToken: str('TWILIO_AUTH_TOKEN', ''),
    twilioFromNumber: str('TWILIO_FROM_NUMBER', ''),
    vonageApiKey: str('VONAGE_API_KEY', ''),
    vonageApiSecret: str('VONAGE_API_SECRET', ''),
    vonageFrom: str('VONAGE_FROM', 'Voiza'),
  },

  payments: {
    // `simulated` keeps the free `/api/wallet/recharge` credit path (demo mode).
    // `stripe` disables it and pays diamonds out of a webhook-confirmed
    // PaymentIntent instead.
    provider: str('PAYMENTS_PROVIDER', 'simulated'),
    stripeSecretKey: str('STRIPE_SECRET_KEY', ''),
    // A fixed development default so the signature scheme is actually exercised
    // locally (the e2e suite signs its own webhook payload). assertSecretsAreSafe
    // refuses to boot in production while it is still this value.
    stripeWebhookSecret: str('STRIPE_WEBHOOK_SECRET', 'whsec_development_only_not_a_real_secret'),
    stripeCurrency: str('STRIPE_CURRENCY', 'usd'),
    // 10 cents per diamond => a 100-diamond top-up is $10.00.
    centsPerDiamond: int('STRIPE_CENTS_PER_DIAMOND', 10),
  },

  admin: {
    bootstrapPhone: str('ADMIN_BOOTSTRAP_PHONE', '+10000000000'),
    bootstrapOtp: str('ADMIN_BOOTSTRAP_OTP', '424242'),
    username: str('ADMIN_USERNAME', 'admin'),
    password: str('ADMIN_PASSWORD', 'voiza-admin'),
  },

  economy: {
    minWithdrawRCoins: int('MIN_WITHDRAW_RCOINS', 100000),
    // Per-minute gift throttle per account, as an abuse brake.
    giftRatePerMinute: int('GIFT_RATE_PER_MINUTE', 60),
  },

  push: {
    // Firebase Cloud Messaging v1 needs a project id plus a service account
    // that has the Cloud Messaging scope. Both are optional: without them the
    // backend logs pushes instead of sending them, which is what a development
    // machine without a cloud project gets.
    fcmProjectId: str('FCM_PROJECT_ID', ''),
    serviceAccountFile: str('FCM_SERVICE_ACCOUNT_FILE', str('GOOGLE_APPLICATION_CREDENTIALS', '')),
    // Must match the channel the app registers with NotificationManager.
    androidChannel: str('PUSH_ANDROID_CHANNEL', 'voiza_activity'),
  },

  corsOrigin: str('CORS_ORIGIN', '*'),
} as const;

// Fail fast rather than shipping a well-known secret to a VPS.
export function assertSecretsAreSafe(): void {
  if (!isProduction) return;
  const unsafe: string[] = [];
  if (env.jwtSecret === 'change-me-in-production') unsafe.push('JWT_SECRET');
  if (env.livekit.apiSecret.startsWith('voiza-dev-')) unsafe.push('LIVEKIT_API_SECRET');
  if (env.livekit.apiKey.startsWith('voiza-dev-')) unsafe.push('LIVEKIT_API_KEY');
  if (env.auth.otpMockCode) unsafe.push('OTP_MOCK_CODE (must be empty in production)');
  if (env.admin.password === 'voiza-admin') unsafe.push('ADMIN_PASSWORD');
  if (env.corsOrigin === '*') unsafe.push('CORS_ORIGIN (must be pinned)');
  // Two guards that are about money and identity rather than a leaked string:
  // `mock` SMS means nobody ever receives a login code, and `simulated` payments
  // means /api/wallet/recharge mints diamonds for free.
  if (env.sms.provider === 'mock') unsafe.push('SMS_PROVIDER (mock never delivers an OTP)');
  if (env.payments.provider === 'simulated') unsafe.push('PAYMENTS_PROVIDER (simulated credits diamonds with no money)');
  if (env.payments.stripeWebhookSecret === 'whsec_development_only_not_a_real_secret') unsafe.push('STRIPE_WEBHOOK_SECRET');
  const smsIncomplete =
    (env.sms.provider === 'twilio' && !(env.sms.twilioAccountSid && env.sms.twilioAuthToken && env.sms.twilioFromNumber)) ||
    (env.sms.provider === 'vonage' && !(env.sms.vonageApiKey && env.sms.vonageApiSecret));
  if (smsIncomplete) unsafe.push(`SMS_PROVIDER=${env.sms.provider} (credentials incomplete)`);
  if (env.payments.provider === 'stripe' && !env.payments.stripeSecretKey) unsafe.push('STRIPE_SECRET_KEY');
  if (env.sms.provider !== 'mock' && env.sms.provider !== 'twilio' && env.sms.provider !== 'vonage') {
    unsafe.push(`SMS_PROVIDER (unknown value "${env.sms.provider}")`);
  }
  if (env.payments.provider !== 'simulated' && env.payments.provider !== 'stripe') {
    unsafe.push(`PAYMENTS_PROVIDER (unknown value "${env.payments.provider}")`);
  }
  if (unsafe.length) {
    throw new Error(
      `[config] refusing to start in production with development secrets: ${unsafe.join(', ')}`,
    );
  }
}
