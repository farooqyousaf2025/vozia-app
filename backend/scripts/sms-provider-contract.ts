/**
 * SMS provider contract check.
 *
 * The gateway itself is not reachable from here (no Twilio/Vonage account), but the
 * thing that breaks when you first point this at one is the wire format: the URL,
 * the Basic auth header, the form-vs-JSON body, and the fact that Vonage answers
 * 200 for a rejected message. So `fetch` is replaced with a recorder and every
 * assertion below is about what we would actually put on the wire.
 *
 *   npm run test:sms            # both providers
 *   npx tsx scripts/sms-provider-contract.ts vonage
 */
const out: string[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  :: ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

type Recorded = { url: string; method?: string; headers: Record<string, string>; body?: string };

/** Install a fake fetch that records requests and answers with the given reply. */
function record(requests: Recorded[], reply: { ok: boolean; status: number; json: unknown }) {
  (globalThis as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return {
      ok: reply.ok,
      status: reply.status,
      json: async () => reply.json,
    } as Response;
  };
}

async function main() {
  const provider = process.argv[2] ?? 'twilio';
  process.env.NODE_ENV = 'development';
  process.env.SMS_PROVIDER = provider;
  process.env.TWILIO_ACCOUNT_SID = 'ACtestaccount00000000000000000001';
  process.env.TWILIO_AUTH_TOKEN = 'testauthtoken';
  process.env.TWILIO_FROM_NUMBER = '+15005550006';
  process.env.VONAGE_API_KEY = 'test-api-key';
  process.env.VONAGE_API_SECRET = 'test-api-secret';
  process.env.VONAGE_FROM = 'Voiza';

  const { sendSms, smsIsConfigured } = await import('../src/services/sms.service');
  const body = 'Your Voiza code is 424242. It expires in 5 minutes.';

  if (provider === 'twilio') {
    const sent: Recorded[] = [];
    record(sent, { ok: true, status: 201, json: { sid: 'SMtestmessage00000000000000000001' } });
    const result = await sendSms('+15550000001', body);
    const req = sent[0];
    const form = new URLSearchParams(req.body ?? '');

    check('twilio: posts to the account-scoped Messages endpoint', req.url === `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, req.url);
    check('twilio: authenticates with Basic base64(sid:token)', req.headers.authorization === `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:testauthtoken`).toString('base64')}`);
    check('twilio: sends an url-encoded form, not JSON', req.headers['content-type'] === 'application/x-www-form-urlencoded', req.headers);
    check('twilio: carries To, From and Body', form.get('To') === '+15550000001' && form.get('From') === '+15005550006' && form.get('Body') === body, Object.fromEntries(form));
    check('twilio: returns the gateway message id', result.provider === 'twilio' && result.id === 'SMtestmessage00000000000000000001', result);

    record(sent, { ok: false, status: 400, json: { message: 'Missing permission to send SMS', code: 21610 } });
    const rejected = await run(() => sendSms('+15550000001', body));
    check('twilio: a 400 becomes 502 sms_send_failed', rejected.thrown === true && rejected.status === 502 && rejected.code === 'sms_send_failed', rejected);
    check('twilio: the gateway reason reaches the operator', String(rejected.message).includes('Missing permission to send SMS') && rejected.details?.twilioCode === 21610, rejected);
    check('twilio: a failed send still records the attempt', sent.length === 2, sent.length);
  }

  if (provider === 'vonage') {
    const sent: Recorded[] = [];
    record(sent, { ok: true, status: 200, json: { messages: [{ status: '0', 'message-id': 'test-message-id' }] } });
    const result = await sendSms('+15550000001', body);
    const req = sent[0];
    const payload = JSON.parse(req.body ?? '{}') as Record<string, string>;

    check('vonage: posts to rest.nexmo.com/sms/json', req.url === 'https://rest.nexmo.com/sms/json', req.url);
    check('vonage: sends JSON credentials in the body', req.headers['content-type'] === 'application/json' && payload.api_key === 'test-api-key' && payload.api_secret === 'test-api-secret', payload);
    check('vonage: strips the leading + from the destination', payload.to === '15550000001' && payload.from === 'Voiza' && payload.text === body, payload);
    check('vonage: returns the gateway message id', result.provider === 'vonage' && result.id === 'test-message-id', result);

    // The trap this exists for: HTTP 200 with a per-message failure status.
    record(sent, { ok: true, status: 200, json: { messages: [{ status: '1', 'error-text': 'Invalid credentials' }] } });
    const lying = await run(() => sendSms('+15550000001', body));
    check('vonage: a 200 with status "1" is treated as a failure', lying.thrown === true && lying.status === 502 && lying.code === 'sms_send_failed', lying);
    check('vonage: the per-message error text is surfaced', String(lying.message).includes('Invalid credentials') && lying.details?.vonageStatus === '1', lying);
  }

  if (provider === 'mock') {
    const touched: Recorded[] = [];
    record(touched, { ok: true, status: 200, json: {} });
    const result = await sendSms('+15550000001', body);
    check('mock: sends nothing and reports the mock provider', touched.length === 0 && result.provider === 'mock', result);
    check('mock: smsIsConfigured() is false, so OTP stays on the log path', smsIsConfigured() === false);
  }

  process.stdout.write(`${out.join('\n')}\n\n${out.length - failures}/${out.length} ${provider} contract checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function run(fn: () => unknown): Promise<{ thrown: boolean; status?: number; code?: string; message?: string; details?: Record<string, unknown> }> {
  try {
    await fn();
    return { thrown: false };
  } catch (e) {
    const err = e as Error & { status?: number; code?: string; details?: Record<string, unknown> };
    return { thrown: true, status: err.status, code: err.code, message: err.message, details: err.details };
  }
}

main().catch((e) => {
  process.stdout.write(`${out.join('\n')}\n`);
  console.error('SMS CONTRACT CRASH', e);
  process.exit(1);
});

// Keeps this file a module for `tsc`, so two entry scripts can be checked in one
// program without their top-level names colliding.
export {};
