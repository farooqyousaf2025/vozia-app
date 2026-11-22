#!/usr/bin/env node
/** Multi-device FCM registration, isolation, and rolling-upgrade compatibility checks. */
const path = require('path');
const { Pool } = require('pg');

const BE_ROOT = path.resolve(__dirname, '..');
const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const stamp = Date.now().toString().slice(-9);
let pool;

function db() {
  if (!pool) {
    const { env } = require(path.join(BE_ROOT, 'dist/config/env.js'));
    pool = new Pool({ connectionString: env.databaseUrl, max: 2 });
  }
  return pool;
}
const sql = (text, params) => db().query(text, params);

const output = [];
let failures = 0;
function check(name, pass, detail) {
  output.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` :: ${JSON.stringify(detail)}`}`);
  if (!pass) failures += 1;
}

async function api(method, route, { token, body } = {}) {
  const res = await fetch(API + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty response */ }
  return { status: res.status, json };
}

async function loginMember(suffix) {
  const phone = `+15556${stamp}${suffix}`;
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error(`OTP request failed: ${JSON.stringify(challenge.json)}`);
  const signed = await api('POST', '/api/auth/verify-otp', {
    body: { phone, code: challenge.json.devCode || '123456', username: `push_e2e_${stamp}_${suffix}` },
  });
  if (signed.status !== 200 || !signed.json?.token || !signed.json?.user?.id) {
    throw new Error(`OTP verification failed: ${JSON.stringify(signed.json)}`);
  }
  return { token: signed.json.token, userId: signed.json.user.id };
}

async function register(auth, deviceToken) {
  return api('PUT', '/api/auth/me/device-tokens', {
    token: auth.token, body: { deviceToken },
  });
}

async function unregister(auth, deviceToken) {
  return api('DELETE', '/api/auth/me/device-tokens', {
    token: auth.token, body: { deviceToken },
  });
}

async function registeredTokens(userId) {
  const result = await sql(
    'SELECT token FROM user_device_tokens WHERE user_id = $1 ORDER BY token',
    [userId],
  );
  return result.rows.map((row) => row.token);
}

(async () => {
  const first = await loginMember('01');
  const second = await loginMember('02');

  const firstA = `voiza-push-${stamp}-first-device-token-a`;
  const firstB = `voiza-push-${stamp}-first-device-token-b`;
  const secondA = `voiza-push-${stamp}-second-device-token-a`;
  const legacy = `voiza-push-${stamp}-legacy-device-token`;

  const a = await register(first, firstA);
  const b = await register(first, firstB);
  check('one member can register two independent devices',
    a.status === 200 && b.status === 200 && (await registeredTokens(first.userId)).length === 2,
    { a: a.status, b: b.status });

  await register(first, firstA);
  check('registering the same FCM token is idempotent',
    (await registeredTokens(first.userId)).length === 2,
    await registeredTokens(first.userId));

  const c = await register(second, secondA);
  const transferred = await register(second, firstA);
  check('a token follows the account currently signed in on that installation',
    c.status === 200 && transferred.status === 200
      && (await registeredTokens(first.userId)).join(',') === firstB
      && (await registeredTokens(second.userId)).length === 2,
    { first: await registeredTokens(first.userId), second: await registeredTokens(second.userId) });

  const foreignRemoval = await unregister(first, firstA);
  check('one account cannot unregister a token currently owned by another account',
    foreignRemoval.status === 200
      && (await registeredTokens(second.userId)).includes(firstA),
    { status: foreignRemoval.status, second: await registeredTokens(second.userId) });

  const removeOne = await unregister(second, secondA);
  check('signing out one installation leaves the other device registered',
    removeOne.status === 200
      && (await registeredTokens(second.userId)).length === 1
      && (await registeredTokens(second.userId))[0] === firstA,
    { status: removeOne.status, remaining: await registeredTokens(second.userId) });

  const legacyRegistration = await api('PUT', '/api/auth/me/device-token', {
    token: second.token, body: { deviceToken: legacy },
  });
  const recipients = await sql(
    `SELECT token FROM user_device_tokens WHERE user_id = $1
     UNION
     SELECT device_token AS token FROM users
      WHERE id = $1 AND device_token IS NOT NULL AND btrim(device_token) <> ''`,
    [second.userId],
  );
  check('legacy single-token registrations remain eligible during rolling upgrades',
    recipients.rows.some((row) => row.token === legacy)
      && recipients.rows.some((row) => row.token === firstA),
    recipients.rows);

  check('legacy single-token registrations remain eligible during rolling upgrades',
    legacyRegistration.status === 200
      && recipients.rows.some((row) => row.token === legacy)
      && recipients.rows.some((row) => row.token === firstA),
    { registration: legacyRegistration.status, recipients: recipients.rows });

  const oldClientLogout = await api('DELETE', '/api/auth/me/device-token', { token: second.token });
  const legacyColumn = await sql('SELECT device_token FROM users WHERE id = $1', [second.userId]);
  check('older app logout clears only its legacy slot and keeps new app devices registered',
    oldClientLogout.status === 200
      && (await registeredTokens(second.userId)).length === 1
      && (await registeredTokens(second.userId))[0] === firstA
      && legacyColumn.rows[0].device_token === null,
    { status: oldClientLogout.status, tokens: await registeredTokens(second.userId), legacy: legacyColumn.rows[0].device_token });

  const removeOneNew = await unregister(second, firstA);
  check('new app logout removes only the selected device registration',
    removeOneNew.status === 200 && (await registeredTokens(second.userId)).length === 0,
    { status: removeOneNew.status, remaining: await registeredTokens(second.userId) });

  const limitTokens = Array.from(
    { length: 12 },
    (_, i) => `voiza-push-${stamp}-limit-device-${String(i).padStart(2, '0')}-token`,
  );
  for (const token of limitTokens) {
    const result = await register(first, token);
    if (result.status !== 200) throw new Error(`registration limit fixture failed: ${JSON.stringify(result.json)}`);
  }
  check('a member is capped at ten active device registrations',
    (await registeredTokens(first.userId)).length === 10,
    await registeredTokens(first.userId));

  for (const token of await registeredTokens(first.userId)) {
    const cleanup = await unregister(first, token);
    if (cleanup.status !== 200) throw new Error(`cleanup failed: ${JSON.stringify(cleanup.json)}`);
  }
})().catch((error) => {
  output.push(`FAIL  suite completed without an unexpected exception :: ${error && error.message}`);
  failures += 1;
}).finally(async () => {
  output.forEach((line) => console.log(line));
  if (pool) await pool.end();
  if (failures) process.exitCode = 1;
});
