import crypto from 'node:crypto';
import fs from 'node:fs';
import { env } from '../config/env';
import { many, query, withTransaction } from '../config/db';

export type PushMessage = { title: string; body: string; data?: Record<string, string> };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const sendUrl = (projectId: string) => `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
const MAX_DEVICE_TOKENS_PER_USER = 10;

type ServiceAccount = { client_email: string; private_key: string };
type DeviceTokenRow = { token: string };

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

export function pushIsConfigured(): boolean {
  return env.push.fcmProjectId.length > 0 && readServiceAccount() !== null;
}

const b64url = (input: string): string => Buffer.from(input, 'utf8').toString('base64url');

async function oauthAccessToken(): Promise<string | null> {
  const credentials = readServiceAccount();
  if (!credentials) return null;
  if (accessToken && accessToken.expiresAtMs > Date.now() + 60_000) return accessToken.value;

  const now = Math.floor(Date.now() / 1000);
  const assertion = [
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    b64url(JSON.stringify({
      iss: credentials.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })),
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

/**
 * One physical app installation has one current FCM token. The token is globally
 * unique and can move between member accounts when a device signs into another account.
 * Each member is capped at ten active registrations to prevent unbounded token growth.
 */
export async function registerLegacyDeviceToken(userId: string, token: string): Promise<void> {
  await withTransaction(async (client) => {
    const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!owner.rowCount) throw new Error('Cannot register a device token for a missing member');

    // The legacy API can describe only one installation per member. Keep it in the
    // compatibility column, separate from the plural multi-device registrations.
    await client.query(
      'DELETE FROM user_device_tokens WHERE token = $1 AND user_id <> $2',
      [token, userId],
    );
    await client.query(
      'UPDATE users SET device_token = NULL WHERE device_token = $1 AND id <> $2',
      [token, userId],
    );
    await client.query('UPDATE users SET device_token = $2 WHERE id = $1', [userId, token]);
  });
}

export async function registerDeviceToken(userId: string, token: string): Promise<void> {
  await withTransaction(async (client) => {
    const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!owner.rowCount) throw new Error('Cannot register a device token for a missing member');

    // A token identifies one installation. When that installation changes accounts,
    // remove any legacy column copy held by its previous owner before moving it.
    await client.query(
      'UPDATE users SET device_token = NULL WHERE device_token = $1 AND id <> $2',
      [token, userId],
    );

    await client.query(
      `INSERT INTO user_device_tokens (user_id, token, last_seen_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             last_seen_at = now(),
             updated_at = now()`,
      [userId, token],
    );

    await client.query(
      `DELETE FROM user_device_tokens
        WHERE user_id = $1
          AND token NOT IN (
            SELECT token
              FROM user_device_tokens
             WHERE user_id = $1
             ORDER BY last_seen_at DESC, created_at DESC
             LIMIT $2
          )`,
      [userId, MAX_DEVICE_TOKENS_PER_USER],
    );

    // The rolling-upgrade fallback must not silently keep a token that was pruned
    // from the account's capped active-device set.
    await client.query(
      `UPDATE users
          SET device_token = NULL
        WHERE id = $1
          AND device_token IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_device_tokens
             WHERE user_id = $1 AND token = users.device_token
          )`,
      [userId],
    );
  });
}

/** Remove only one multi-device registration, including its legacy-column copy if present. */
export async function clearDeviceToken(userId: string, expectedToken: string): Promise<void> {
  await query(
    `WITH removed AS (
       DELETE FROM user_device_tokens WHERE user_id = $1 AND token = $2
     )
     UPDATE users SET device_token = NULL
      WHERE id = $1 AND device_token = $2`,
    [userId, expectedToken],
  );
}

/**
 * The pre-multi-device Android API does not identify an installation on DELETE.
 * Remove only its legacy column target and any migrated copy of that same token,
 * leaving registrations made through the new plural endpoint intact.
 */
export async function clearLegacyDeviceToken(userId: string): Promise<void> {
  await query(
    `WITH previous AS (
       UPDATE users SET device_token = NULL WHERE id = $1 RETURNING device_token
     )
     DELETE FROM user_device_tokens AS registrations
      USING previous
      WHERE registrations.user_id = $1
        AND registrations.token = previous.device_token`,
    [userId],
  );
}

/**
 * Send once to every registered device. The legacy users.device_token field is
 * read during the rolling-upgrade window so older app builds continue receiving pushes.
 */
export async function pushToUser(userId: string, message: PushMessage): Promise<void> {
  const registrations = await many<DeviceTokenRow>(
    `SELECT token FROM user_device_tokens WHERE user_id = $1
     UNION
     SELECT device_token AS token
       FROM users
      WHERE id = $1 AND device_token IS NOT NULL AND btrim(device_token) <> ''`,
    [userId],
  );
  if (!registrations.length) return;

  if (!pushIsConfigured()) {
    if (!env.isProduction) {
      console.info(`[push] skipped (no FCM config) -> ${userId}: ${registrations.length} device(s)`);
    }
    return;
  }

  const access = await oauthAccessToken();
  if (!access) return;

  await Promise.all(registrations.map(async ({ token }) => {
    try {
      const res = await fetch(sendUrl(env.push.fcmProjectId), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` },
        body: JSON.stringify({
          message: {
            token,
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

      const responseBody = await res.text();
      if (res.status === 404) {
        console.warn(`[push] one device token for ${userId} is no longer valid; clearing that token`);
        await clearDeviceToken(userId, token);
        return;
      }
      console.error('[push] send failed', res.status, responseBody.slice(0, 200));
    } catch (err) {
      console.error('[push] send threw', (err as Error).message);
    }
  }));
}
