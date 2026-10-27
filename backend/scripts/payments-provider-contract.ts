/**
 * Payments provider contract check.
 *
 * The webhook *endpoint* is covered against a live server by e2e-live.cjs; this
 * covers the half that suite cannot reach, because it is outbound: what we send to
 * Stripe when a user asks to top up, and how Stripe's answer (or refusal) is mapped.
 * Those requests are the things that only fail once a real `sk_test_` key is in the
 * environment, and a wrong form encoding means a checkout that never opens.
 *
 *   npm run test:payments
 */
const out: string[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  :: ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

type Recorded = { url: string; method?: string; headers: Record<string, string>; body?: string };

function record(requests: Recorded[], reply: { ok: boolean; status: number; json: unknown }) {
  (globalThis as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return { ok: reply.ok, status: reply.status, json: async () => reply.json } as Response;
  };
}

async function main() {
  const mode = process.argv[2] ?? 'stripe';
  const webhookSecret = 'whsec_contract_test_secret';

  process.env.NODE_ENV = 'development';
  process.env.PAYMENTS_PROVIDER = mode === 'stripe' ? 'stripe' : 'simulated';
  process.env.STRIPE_SECRET_KEY = 'sk_test_contractkey0000000000000000';
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  process.env.STRIPE_CURRENCY = 'usd';
  process.env.STRIPE_CENTS_PER_DIAMOND = '10';

  const stripe = await import('../src/services/stripe.service');
  const crypto = await import('crypto');

  const sign = (payload: string, at: number) =>
    `t=${at},v1=${crypto.createHmac('sha256', webhookSecret).update(`${at}.${payload}`).digest('hex')}`;

  if (mode === 'stripe') {
    check('gate: the free recharge endpoint is closed', stripe.simulatedRechargeAllowed() === false);
    check('gate: the webhook route is live', stripe.rechargeWebhookEnabled() === true);

    const sent: Recorded[] = [];
    record(sent, {
      ok: true,
      status: 200,
      json: { id: 'pi_contract1', client_secret: 'pi_contract1_secret_xyz', amount: 2500, currency: 'usd', status: 'requires_payment_method' },
    });
    const intent = await stripe.createPaymentIntent(2500, { voizaUserId: 'user-1', diamonds: '250' });
    const req = sent[0];
    const form = new URLSearchParams(req.body ?? '');

    check('stripe: POSTs to api.stripe.com/v1/payment_intents', req.url === 'https://api.stripe.com/v1/payment_intents' && req.method === 'POST', req.url);
    check('stripe: authenticates with the secret key as a Bearer token', req.headers.authorization === 'Bearer sk_test_contractkey0000000000000000');
    check('stripe: sends an url-encoded form, not JSON', req.headers['content-type'] === 'application/x-www-form-urlencoded', req.headers);
    check('stripe: amount is cents and the currency comes from env', form.get('amount') === '2500' && form.get('currency') === 'usd', Object.fromEntries(form));
    check('stripe: the Voiza reference rides in metadata', form.get('metadata[voizaUserId]') === 'user-1' && form.get('metadata[diamonds]') === '250', Object.fromEntries(form));
    check('stripe: the client secret is handed back for the card sheet', intent.id === 'pi_contract1' && intent.clientSecret === 'pi_contract1_secret_xyz', intent);

    record(sent, { ok: false, status: 400, json: { error: { message: 'No such currency: `xx`' } } });
    const failed = await run(() => stripe.createPaymentIntent(100, { voizaUserId: 'user-1' }));
    check('stripe: a refused intent is a 502, not a silent success', failed.thrown && failed.status === 502 && failed.code === 'stripe_payment_intent_failed', failed);
    check('stripe: the gateway message is passed through', String(failed.message).includes('No such currency'), failed);
    check('stripe: the failed call is still one recorded request', sent.length === 2, sent.length);
  }

  // Signature + parsing behave the same in both modes, and `simulated` is the mode
  // the e2e suite runs in, so assert them once here rather than twice.
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', status: 'succeeded', metadata: { voizaUserId: 'u9', diamonds: '250' } } } });

  let verified = true;
  try {
    stripe.verifyWebhookSignature(Buffer.from(body), sign(body, Math.floor(Date.now() / 1000)));
  } catch {
    verified = false;
  }
  check('webhook: a correctly signed, current payload verifies', verified);

  const tampered = await run(() => stripe.verifyWebhookSignature(Buffer.from(body.replace('250', '250000')), sign(body, Math.floor(Date.now() / 1000))));
  check('webhook: a body edited after signing is rejected', tampered.code === 'webhook_signature_invalid', tampered);

  const forgedHeader = await run(() => stripe.verifyWebhookSignature(Buffer.from(body), `t=${Math.floor(Date.now() / 1000)},v1=not_hex_at_all`));
  check('webhook: a non-hex signature does not crash the comparison', forgedHeader.code === 'webhook_signature_invalid', forgedHeader);

  const missingHeader = await run(() => stripe.verifyWebhookSignature(Buffer.from(body), undefined));
  check('webhook: a missing signature header is a 400', missingHeader.status === 400, missingHeader);

  const emptyBody = await run(() => stripe.verifyWebhookSignature(Buffer.from(''), sign('', Math.floor(Date.now() / 1000))));
  check('webhook: an empty body is refused before any HMAC work', emptyBody.code === 'webhook_body_empty', emptyBody);

  const stale = await run(() => stripe.verifyWebhookSignature(Buffer.from(body), sign(body, Math.floor(Date.now() / 1000) - 3600)));
  check('webhook: a signature from an old timestamp is refused', stale.code === 'webhook_timestamp_expired', stale);

  const event = stripe.parseEvent(JSON.parse(body));
  check('parse: the credit reference comes out of metadata', event.userId === 'u9' && event.diamonds === 250 && event.intentId === 'pi_1', event);

  const ping = stripe.parseEvent({ id: 'evt_ping', type: 'customer.created', data: { object: { id: 'cus_1' } } });
  check('parse: an unknown event type still reports its type', ping.type === 'customer.created' && ping.userId === undefined, ping);

  if (mode === 'simulated') {
    check('gate: demo mode keeps the free recharge endpoint open', stripe.simulatedRechargeAllowed() === true);
    check('gate: demo mode still serves the webhook so it stays testable', stripe.rechargeWebhookEnabled() === true);
  }

  process.stdout.write(`${out.join('\n')}\n\n${out.length - failures}/${out.length} ${mode} payments contract checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function run(fn: () => unknown): Promise<{ thrown: boolean; status?: number; code?: string; message?: string }> {
  try {
    await fn();
    return { thrown: false };
  } catch (e) {
    const err = e as Error & { status?: number; code?: string };
    return { thrown: true, status: err.status, code: err.code, message: err.message };
  }
}

main().catch((e) => {
  process.stdout.write(`${out.join('\n')}\n`);
  console.error('PAYMENTS CONTRACT CRASH', e);
  process.exit(1);
});

// Keeps this file a module for `tsc`, so two entry scripts can be checked in one
// program without their top-level names colliding.
export {};
