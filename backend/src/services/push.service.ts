import crypto from 'node:crypto';
import fs from 'node:fs';
import { env } from '../config/env';
import { one, query } from '../config/db';
import { UserRow } from '../types/db';

export type PushMessage = { title: string; body: string; data?: Record<string, string> };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const sendUrl = (projectId: string) => `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

type ServiceAccount = { client_email: string; private_key: string };

// undefined means "not read yet", null means "read and there is none". Caching
// the failure is deliberate: a missing file must not be re-statbed per gift.
let account: ServiceAccount | null | undefined;
let accessToken: { value: string; expiresAtMs: number } | null = null;

function readServiceAccount(): ServiceAccount | null {
  if (account === undefined) {
    const file = env.push.serviceAccountFile;
    if (!file) {
      account = null;
    } else {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ServiceAccount>;
        account =
          typeof parsed.client_email === 'string' && typeof parsed.private_key === 'string'
            ? { client_email: parsed.client_email, private_key: parsed.private_key }
            : null;
        if (!account) console.error('[push] service account file is missing client_email/private_key');
      } catch (err) {
        console.error('[push] cannot read the FCM service account file', (err as Error).message);
        account = null;
      }
    }
  }
  return account;
}

/**
 * Push is optional in the same shape the OTP provider is: without a Firebase
 * project and a service account, delivery is a logged no-op instead of an error,
 * so a development box with no cloud account still sends gifts.
 */
export function pushIsConfigured(): boolean {
  return env.push.fcmProjectId.length > 0 && readServiceAccount() !== null;
}

const b64url = (input: string): string => Buffer.from(input, 'utf8').toString('base64url');

/** Mint the JWT assertion Google expects and exchange it for an access token. */
async function oauthAccessToken(): Promise<string | null> {
  const credentials = readServiceAccount();
  if (!credentials) return null;
  // Google tokens last an hour; refresh a minute early so a slow send cannot
  // race the expiry.
  if (accessToken && accessToken.expiresAtMs > Date.now() + 60_000) return accessToken.value;

  const now = Math.floor(Date.now() / 1000);
  const assertion = [
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    b64url(
      JSON.stringify({
        iss: credentials.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    ),
  ].join('.');
  const signature = crypto.createSign('RSA-SHA256').update(assertion).sign(credentials.private_key);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${assertion}.${signature.toString('base64url')}`,
    }),
  });
  if (!res.ok) {
    console.error('[push] FCM token exchange failed', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  accessToken = { value: json.access_token, expiresAtMs: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return accessToken.value;
}

export async function registerDeviceToken(userId: string, token: string): Promise<void> {
  await query('UPDATE users SET device_token = $2 WHERE id = $1', [userId, token]);
}

export async function clearDeviceToken(userId: string): Promise<void> {
  await query('UPDATE users SET device_token = NULL WHERE id = $1', [userId]);
}

/**
 * Best-effort by design: a notification is a courtesy on top of the realtime
 * socket, so nothing in the caller's transaction or response should depend on
 * Google being reachable.
 */
export async function pushToUser(userId: string, message: PushMessage): Promise<void> {
  const user = await one<Pick<UserRow, 'device_token'>>(
    'SELECT device_token FROM users WHERE id = $1',
    [userId],
  );
  const token = user?.device_token;
  if (!token) return;

  if (!pushIsConfigured()) {
    if (!env.isProduction) console.info(`[push] skipped (no FCM config) -> ${userId}: ${message.title}`);
    return;
  }

  const access = await oauthAccessToken();
  if (!access) return;

  try {
    const res = await fetch(sendUrl(env.push.fcmProjectId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` },
      body: JSON.stringify({
        message: {
          token,
          // The client owns the copy that matters (deep link data); the
          // notification block is what a locked screen shows.
          notification: { title: message.title, body: message.body },
          data: message.data ?? {},
          android: {
            priority: 'HIGH',
            notification: { channel_id: env.push.androidChannel, sound: 'default' },
          },
        },
      }),
    });
    if (res.ok) return;
    if (res.status === 404 || res.status === 400) {
      // UNREGISTERED / INVALID_ARGUMENT: the app was uninstalled or the token
      // rotated. Drop it so every later send does not repeat the same failure.
      console.warn(`[push] device token for ${userId} is no longer valid; clearing it`);
      await clearDeviceToken(userId);
      return;
    }
    console.error('[push] send failed', res.status, (await res.text()).slice(0, 200));
  } catch (err) {
    console.error('[push] send threw', (err as Error).message);
  }
}
