import crypto from 'crypto';
import { env } from '../config/env';
import { ApiError } from '../utils/http';

/**
 * Stripe, called over REST with `fetch` (no SDK dependency, same reasoning as
 * sms.service.ts). Test mode is a `sk_test_...` key plus the checkout secret
 * `pk_test_...`; nothing here behaves differently between test and live, so the
 * sandbox path is the production path.
 *
 * Diamonds are only ever credited from a webhook, never from the client: the
 * client cannot prove it paid, Stripe can.
 */

export type PaymentIntent = {
  id: string;
  clientSecret: string | null;
  amountCents: number;
  currency: string;
  status: string;
};

const STRIPE_API = 'https://api.stripe.com/v1';
/** Replay window for webhook signatures; Stripe's own docs suggest 5 minutes. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The free credit path is only allowed while the stack is in demo mode. */
export function simulatedRechargeAllowed(): boolean {
  return env.payments.provider !== 'stripe';
}

/**
 * The webhook is live whenever Stripe is the provider, and also in development
 * with the default secret, so the signature + idempotency path is exercised by
 * the e2e suite instead of being shipped untested.
 */
export function rechargeWebhookEnabled(): boolean {
  return env.payments.provider === 'stripe' || !env.isProduction;
}

export async function createPaymentIntent(
  amountCents: number,
  metadata: Record<string, string>,
): Promise<PaymentIntent> {
  if (!env.payments.stripeSecretKey) {
    throw ApiError.badGateway('Payments are not configured on this server', 'payments_not_configured');
  }

  const form = new URLSearchParams({ amount: String(amountCents), currency: env.payments.stripeCurrency });
  for (const [key, value] of Object.entries(metadata)) form.append(`metadata[${key}]`, value);

  const res = await fetch(`${STRIPE_API}/payment_intents`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.payments.stripeSecretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    client_secret?: string | null;
    amount?: number;
    currency?: string;
    status?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.id) {
    throw ApiError.badGateway(
      `Could not start the payment${json.error?.message ? `: ${json.error.message}` : ''}`,
      'stripe_payment_intent_failed',
      { status: res.status },
    );
  }

  return {
    id: json.id,
    clientSecret: json.client_secret ?? null,
    amountCents: json.amount ?? amountCents,
    currency: json.currency ?? env.payments.stripeCurrency,
    status: json.status ?? 'requires_payment_method',
  };
}

type ParsedSignature = { timestamp: number; signatures: string[] };

function parseSignatureHeader(header: string | undefined): ParsedSignature {
  const parts = (header ?? '').split(',').map((p) => p.trim());
  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = Number.parseInt(value ?? '', 10);
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || !signatures.length) {
    throw ApiError.badRequest('Malformed Stripe-Signature header', 'webhook_signature_invalid');
  }
  return { timestamp, signatures };
}

function computeSignature(timestamp: number, payload: string): string {
  return crypto.createHmac('sha256', env.payments.stripeWebhookSecret).update(`${timestamp}.${payload}`).digest('hex');
}

/**
 * Stripe's scheme: HMAC-SHA256 over `<t>.<raw body>` with the endpoint secret,
 * any of the listed v1 digests may match, and the timestamp must be recent so a
 * captured payload cannot be replayed forever.
 *
 * Throws on any mismatch. The body must be the exact bytes Express received —
 * re-serialised JSON differs by whitespace and would fail every time.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, header: string | undefined): void {
  if (!env.payments.stripeWebhookSecret) {
    throw ApiError.badGateway('Payments are not configured on this server', 'payments_not_configured');
  }
  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  if (!payload.length) throw ApiError.badRequest('Empty webhook body', 'webhook_body_empty');

  const { timestamp, signatures } = parseSignatureHeader(header);
  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) {
    throw ApiError.badRequest('Webhook signature is too old', 'webhook_timestamp_expired');
  }

  const expected = computeSignature(timestamp, payload);
  const expectedBuf = Buffer.from(expected, 'hex');
  // timingSafeEqual throws on a length mismatch, and a non-hex header value has
  // a different length, so compare lengths first.
  const matched = signatures.some((candidate) => {
    const buf = Buffer.from(candidate, 'hex');
    return buf.length === expectedBuf.length && crypto.timingSafeEqual(buf, expectedBuf);
  });
  if (!matched) throw ApiError.badRequest('Webhook signature does not match', 'webhook_signature_invalid');
}

export type StripeEvent = {
  id: string;
  type: string;
  intentId?: string;
  userId?: string;
  diamonds?: number;
  status?: string;
};

/**
 * Minimal projection of the event object. Anything the handler does not know is
 * returned with `type` only — the controller ignores unknown types rather than
 * failing, because Stripe sends test pings and future event kinds.
 */
export function parseEvent(body: unknown): StripeEvent {
  const event = (body ?? {}) as {
    id?: string;
    type?: string;
    data?: { object?: { id?: string; status?: string; metadata?: Record<string, string> } };
  };
  const object = event.data?.object ?? {};
  const metadata = object.metadata ?? {};
  const diamonds = Number.parseInt(metadata.diamonds ?? '', 10);
  return {
    id: event.id ?? '',
    type: event.type ?? '',
    intentId: object.id,
    userId: metadata.voizaUserId,
    diamonds: Number.isFinite(diamonds) ? diamonds : undefined,
    status: object.status,
  };
}
