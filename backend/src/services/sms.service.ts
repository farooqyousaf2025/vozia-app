import { env } from '../config/env';
import { ApiError } from '../utils/http';

/**
 * SMS delivery for login codes. Twilio and Vonage are called over their REST
 * APIs with `fetch` rather than through their SDKs: one POST each, no new
 * dependency, and the failure surface is a plain HTTP status we can map.
 *
 * `mock` is the development default and simply logs. In production the boot
 * guard in config/env.ts refuses to start with it, because "the code was sent"
 * while nothing left the building is the worst kind of auth bug.
 */

type SendResult = { provider: string; id?: string };

const TWILIO_API = 'https://api.twilio.com/2010-04-01';
const VONAGE_API = 'https://rest.nexmo.com/sms/json';

/** True when a real gateway is wired up; callers use it to skip the log path. */
export function smsIsConfigured(): boolean {
  const p = env.sms.provider;
  if (p === 'twilio') return !!(env.sms.twilioAccountSid && env.sms.twilioAuthToken && env.sms.twilioFromNumber);
  if (p === 'vonage') return !!(env.sms.vonageApiKey && env.sms.vonageApiSecret);
  return false;
}

async function sendViaTwilio(to: string, body: string): Promise<SendResult> {
  const { twilioAccountSid: sid, twilioAuthToken: token, twilioFromNumber: from } = env.sms;
  const form = new URLSearchParams({ To: to, From: from, Body: body });
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  const res = await fetch(`${TWILIO_API}/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(8000),
  });

  const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok) {
    throw ApiError.badGateway(
      `SMS gateway rejected the message${json.message ? `: ${json.message}` : ''}`,
      'sms_send_failed',
      { provider: 'twilio', status: res.status, twilioCode: json.code },
    );
  }
  return { provider: 'twilio', id: json.sid };
}

async function sendViaVonage(to: string, body: string): Promise<SendResult> {
  const { vonageApiKey: key, vonageApiSecret: secret, vonageFrom: from } = env.sms;
  const res = await fetch(VONAGE_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, api_secret: secret, to: to.replace(/^\+/, ''), from, text: body }),
    signal: AbortSignal.timeout(8000),
  });

  const json = (await res.json().catch(() => ({}))) as {
    messages?: { status?: string; 'message-id'?: string; 'error-text'?: string }[];
  };
  // Vonage answers 200 even for a rejected message; the per-message status is
  // the only honest signal, so "ok" has to be read out of the body.
  const message = json.messages?.[0];
  if (!res.ok || (message?.status ?? '0') !== '0') {
    throw ApiError.badGateway(
      `SMS gateway rejected the message${message?.['error-text'] ? `: ${message['error-text']}` : ''}`,
      'sms_send_failed',
      { provider: 'vonage', status: res.status, vonageStatus: message?.status },
    );
  }
  return { provider: 'vonage', id: message?.['message-id'] };
}

export async function sendSms(to: string, body: string): Promise<SendResult> {
  switch (env.sms.provider) {
    case 'twilio':
      return sendViaTwilio(to, body);
    case 'vonage':
      return sendViaVonage(to, body);
    default:
      return { provider: 'mock' };
  }
}
