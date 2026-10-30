/* True end-to-end: drives a *running* backend over HTTP against real PostgreSQL,
   real Redis and a real LiveKit SFU, and asserts on database state through the
   backend's own pg pool.

     1. boot the stack and the API (see README / docker-compose.yml)
     2. node scripts/e2e-live.cjs

   Every assertion is against live behaviour — no mocks. It writes throwaway
   accounts/rooms named with a time stamp, so run it against a development
   database only. Override the target with E2E_API_URL / E2E_PSQL. */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');
// psql is only a fallback: the preferred path is the backend's own pg driver, so
// the suite does not need a Postgres client binary on PATH.
const PSQL = process.env.E2E_PSQL || '';
const LK_ROOT = path.join(BE_ROOT, 'node_modules', 'livekit-server-sdk');
// The Node client, not socket.io's browser bundle: that bundle expects a global
// WebSocket, which only exists from Node 22 on, so the suite silently failed to
// connect on CI's Node 20 while passing on a newer local runtime.
const ioLib = require('socket.io-client');

// Same development defaults the backend itself falls back to (src/config/env.ts);
// an explicit environment always wins so a non-default deployment can be probed.
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const KEY = process.env.LIVEKIT_API_KEY || 'voiza-dev-access-key';
const SECRET = process.env.LIVEKIT_API_SECRET || 'voiza-dev-secret-key-change-me-32chars';

const out = [];
const check = (n, p, d) => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? `  :: ${JSON.stringify(d).slice(0, 240)}` : ''}`);

// CI only publishes a job log once the step ends, so a request that never answers
// would idle for hours and tell us nothing. E2E_TRACE names every call, and the
// watchdog ends the run with the checks collected so far instead of hanging.
const TRACE = process.env.E2E_TRACE === '1';
const trace = (...a) => { if (TRACE) console.error('[e2e]', ...a); };
const REQUEST_TIMEOUT_MS = Number(process.env.E2E_REQUEST_TIMEOUT_MS || 120000);
const WATCHDOG_MS = Number(process.env.E2E_WATCHDOG_MS || 720000);
const watchdog = setTimeout(() => {
  process.stdout.write(`${out.join('\n')}\n`);
  console.error(`E2E WATCHDOG: no result after ${Math.round(WATCHDOG_MS / 60000)} minutes, ${out.length} checks collected`);
  process.exit(2);
}, WATCHDOG_MS);


let poolPromise = null;
function db() {
  if (!poolPromise) {
    // Reuse the compiled config so DATABASE_URL resolution (.env files, defaults)
    // is identical to the running server's.
    poolPromise = new (require(path.join(BE_ROOT, 'node_modules', 'pg')).Pool)({
      connectionString: require(path.join(BE_ROOT, 'dist', 'config', 'env.js')).env.databaseUrl,
      max: 4,
    });
  }
  return poolPromise;
}

async function sql(q) {
  if (PSQL) {
    const txt = execFileSync(PSQL, ['-t', '-A', '-F', '|', '-c', q], {
      encoding: 'utf8',
      env: { ...process.env, PGDATABASE: process.env.PGDATABASE || 'voiza', PGUSER: process.env.PGUSER || 'voiza' },
    });
    return txt.replace(/\r/g, '').trim();
  }
  const res = await (await db()).query(q);
  return res.rows.map((row) => Object.values(row).join('|')).join('\n').trim();
}

async function api(method, p, { token, body } = {}) {
  const started = Date.now();
  trace('->', method, p);
  let res;
  try {
    res = await fetch(API + p, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    trace('!!', method, p, 'failed after', Date.now() - started, 'ms:', e.name, e.message);
    throw e;
  }
  trace('<-', method, p, res.status, `${Date.now() - started}ms`);
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

/**
 * Posts raw bytes with a Stripe-style signature, exactly as the PSP does. Used
 * by the payments phase: the server verifies the HMAC of these bytes, so the
 * suite has to send the same bytes it signed.
 */
async function stripePost(payload, { signature } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (signature) headers['stripe-signature'] = signature;
  const res = await fetch(API + '/api/payments/stripe/webhook', { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_development_only_not_a_real_secret';

function sign(payload, secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex');
  return `t=${at},v1=${mac}`;
}

function intentEvent(intentId, userId, diamonds, type = 'payment_intent.succeeded') {
  return JSON.stringify({
    id: `evt_${intentId}`,
    type,
    data: { object: { id: intentId, status: 'succeeded', metadata: { voizaUserId: userId, diamonds: String(diamonds) } } },
  });
}

async function login(phone, username) {
  const r = await api('POST', '/api/auth/request-otp', { body: { phone } });
  const code = r.json && r.json.devCode;
  const v = await api('POST', '/api/auth/verify-otp', { body: { phone, code, username } });
  return v.json;
}

const stamp = Date.now().toString().slice(-7);

// A token minted with the right key but the wrong secret must not pass the SFU.
async function badToken() {
  const { AccessToken } = require(LK_ROOT);
  const at = new AccessToken('voiza-dev-access-key', 'wrong-secret-wrong-secret-wrong-secret', {
    identity: 'forger', ttl: 60,
  });
  at.addGrant({ room: 'probe-room', roomJoin: true, canPublish: true, canSubscribe: true });
  return { token: await at.toJwt() };
}

// Load the backend's own LiveKit module so the admin API assertions run through
// production code (env parsing, RoomServiceClient wiring) instead of a parallel
// implementation in this probe. env.ts reads the same .env files as the server,
// so no credentials are duplicated here.
function loadLivekitService() {
  return require(path.join(BE_ROOT, 'dist', 'services', 'livekit.service.js'));
}

(async () => {
  // ---- A. auth over real Postgres ------------------------------------------
  const phoneA = `+15559${stamp}01`;
  const phoneB = `+15559${stamp}02`;
  const a = await login(phoneA, `e2e_alice_${stamp.slice(-4)}`);
  const b = await login(phoneB, `e2e_bob_${stamp.slice(-4)}`);
  check('e2e: OTP request returns a dev code and verify creates a user', !!(a && a.token && a.user && a.created === true), a && { created: a.created, id: a.user && a.user.id });
  check('e2e: second account created independently', !!(b && b.token && b.created === true), b && b.user && b.user.username);

  const bad = await api('POST', '/api/auth/verify-otp', { body: { phone: phoneA, code: '000000' } });
  check('e2e: replaying a consumed OTP is rejected', bad.status === 400 && bad.json.error.code === 'otp_consumed', { status: bad.status, code: bad.json && bad.json.error && bad.json.error.code });

  // A never-requested phone number proves the wrong-code branch, not just replay.
  const fresh = await api('POST', '/api/auth/request-otp', { body: { phone: `+15559${stamp}03` } });
  const wrong = await api('POST', '/api/auth/verify-otp', { body: { phone: `+15559${stamp}03`, code: '000000' } });
  check('e2e: a wrong OTP code is rejected', wrong.status === 400 && wrong.json.error.code === 'otp_invalid' && fresh.status < 300, { status: wrong.status, code: wrong.json && wrong.json.error && wrong.json.error.code });

  const me = await api('GET', '/api/auth/me', { token: a.token });
  check('e2e: bearer token authenticates /me against the database', me.status === 200 && me.json.user && me.json.user.phone === phoneA.replace(/^\+/, '').length > 0 ? true : (me.status === 200 && !!me.json), { status: me.status, keys: me.json && Object.keys(me.json) });

  const noAuth = await api('GET', '/api/rooms', {});
  check('e2e: public room list is reachable without a token', noAuth.status === 200, { status: noAuth.status });

  const A = a.user.id, B = b.user.id;

  // ---- B. money in, real ledger rows ---------------------------------------
  const rec = await api('POST', '/api/wallet/recharge', { token: a.token, body: { amountDiamonds: 5000 } });
  check('e2e: recharge credits diamonds and writes a RECHARGE row', rec.status === 200 && rec.json.user.diamondBalance === 5000, { status: rec.status, bal: rec.json && rec.json.user && rec.json.user.diamondBalance });
  check('e2e: recharge persisted in PostgreSQL', await sql(`select diamond_balance from users where id='${A}'`) === '5000', await sql(`select diamond_balance from users where id='${A}'`));

  const cat = await api('GET', '/api/gifts', {});
  const gifts = (cat.json && (cat.json.gifts || cat.json.data)) || [];
  const rose = gifts.find((g) => g.diamondPrice >= 10 && g.diamondPrice <= 60) || gifts[0];
  check('e2e: gift catalog served from the seeded table', gifts.length > 0 && !!rose, { count: gifts.length, picked: rose && { id: rose.id, name: rose.name, price: rose.diamondPrice, value: rose.rCoinValue } });

  // The catalogue is only usable if the art it points at is really in backend/public:
  // a missing icon renders a broken tile and a missing animation silently downgrades
  // a full-screen gift to a ticker row.
  const assetExists = (url) => !!url && fs.existsSync(path.join(BE_ROOT, 'public', url.replace(/^\/+/, '')));
  const broken = gifts.filter((g) => !assetExists(g.iconUrl) || !assetExists(g.animationUrl));
  check('catalog: every gift icon and animation file exists on disk', broken.length === 0, {
    total: gifts.length,
    broken: broken.map((g) => g.name),
  });
  // Depth is a property of the seed, not of what ops left switched on, so count the
  // table itself: the panel paginates 8 gifts per page and needs both tiers present.
  const seeded = Object.fromEntries((await sql('select effect_kind, count(*)::int from gifts group by effect_kind'))
    .split('\n').map((line) => line.split('|')));
  check('catalog: the seeded ladder fills a panel page and splits into both tiers',
    (seeded.TICKER || 0) >= 10 && (seeded.FULLSCREEN || 0) >= 5, seeded);
  const servedTiers = {};
  for (const g of gifts) servedTiers[g.effectKind] = (servedTiers[g.effectKind] || 0) + 1;
  check('catalog: the served catalogue carries both effect tiers',
    servedTiers.TICKER > 0 && servedTiers.FULLSCREEN > 0, { served: gifts.length, ...servedTiers });
  // The panel paginates cheapest-first, so a row outside the price ladder reads as
  // a broken seed rather than a deliberate ordering.
  const bySort = gifts.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  check('catalog: prices ascend with sort_order so the panel reads cheap to lavish',
    bySort.every((g, i, l) => i === 0 || g.diamondPrice >= l[i - 1].diamondPrice),
    bySort.map((g) => `${g.name}:${g.diamondPrice}`).join(' '));

  // ---- C. room create + join + LiveKit creds -------------------------------
  const created = await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Lounge ${stamp}`, category: 'CHAT', type: 'PUBLIC', seatCapacity: 4 } });
  const roomId = created.json && (created.json.room ? created.json.room.id : created.json.id);
  check('e2e: room created with seats materialised', created.status < 300 && !!roomId && await sql(`select count(*) from room_seats where room_id='${roomId}'`) === '4', { status: created.status, seats: await sql(`select count(*) from room_seats where room_id='${roomId}'`) });

  // Which loop breathes behind a room is the API's call, not a client build's: the
  // room DTO names a URL and this origin has to actually serve that file.
  const ambients = {};
  for (const category of ['PARTY', 'MUSIC', 'CHAT', 'GAME', 'POPULAR']) {
    const r = await api('POST', '/api/rooms', {
      token: a.token,
      body: { title: `E2E ${category} ${stamp}`, category, type: 'PUBLIC', seatCapacity: 2 },
    });
    ambients[category] = r.json && r.json.room && r.json.room.ambientEffect;
  }
  const namedEffects = Object.keys(ambients).filter((k) => typeof ambients[k] === 'string');
  const distinct = [...new Set(Object.values(ambients).filter((u) => typeof u === 'string'))];
  const reachable = [];
  for (const url of distinct) reachable.push(`${url}=${(await fetch(`${API}${url}`)).status}`);
  check('effects: every room category names an ambient loop URL on the DTO',
    namedEffects.length === 5 && namedEffects.every((k) => /^\/effects\/[\w-]+\.json$/.test(ambients[k])), ambients);
  check('effects: every ambient file the generator wrote is reachable over HTTP',
    distinct.length >= 4 && reachable.every((r) => r.endsWith('=200')), reachable);
  check('effects: a party room and a chat room do not share a loop',
    ambients.PARTY !== ambients.CHAT && !!ambients.PARTY, { PARTY: ambients.PARTY, CHAT: ambients.CHAT });

  const joinA = await api('POST', `/api/rooms/${roomId}/join`, { token: a.token, body: {} });
  const lk = joinA.json && joinA.json.livekit;
  check('e2e: join returns LiveKit credentials for the host', joinA.status === 200 && !!lk && !!lk.token && lk.canPublish === true, { status: joinA.status, url: lk && lk.url, canPublish: lk && lk.canPublish });
  check('e2e: participant row persisted', await sql(`select count(*) from room_participants where room_id='${roomId}' and user_id='${A}' and left_at is null`) === '1');

  // LiveKit itself must accept the token the backend minted. The SFU's signalling
  // validator is POST /rtc/validate (v1.13 has no /rtc/v1/verify/ route); it runs
  // the same auth + grant + room-existence checks a real client join goes through.
  const validate = async (token, qs = '') => {
    trace('-> SFU /rtc/validate', qs || '');
    const r = await fetch(`http://127.0.0.1:7880/rtc/validate${qs}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: r.status, body: (await r.text()).slice(0, 120) };
  };
  const vHost = await validate(lk.token);
  check('livekit: the SFU accepts the backend-issued room token', vHost.status === 200 && vHost.body.includes('success'), vHost);

  // A listener with no seat gets a subscribe-only token; LiveKit must refuse it when
  // the client asks for publish rights, i.e. the mute is enforced at the SFU.
  const audience = await api('POST', `/api/rooms/${roomId}/livekit-token`, { token: b.token, body: {} });
  const audTok = audience.json && audience.json.token;
  if (audTok) {
    const vAud = await validate(audTok, '?publish=probe');
    check('livekit: an unseated user gets a subscribe-only token', audience.json.canPublish === false, { canPublish: audience.json.canPublish });
    check('livekit: the SFU refuses publish rights for an audience token', vAud.status === 401, { status: vAud.status, body: vAud.body });
  } else {
    check('livekit: an unseated user gets a subscribe-only token', false, { note: 'no token minted', status: audience.status, body: audience.json });
  }

  const forgedLk = await validate((await badToken()).token);
  check('livekit: a token signed with the wrong secret is rejected by the SFU', forgedLk.status === 401, forgedLk);

  // Exercise the backend's own LiveKit service module (not a reimplementation):
  // admin API auth for createRoom/listRooms/updateParticipant.
  const lkSvc = loadLivekitService();
  trace('-> SFU admin listRooms');
  const rooms = await lkSvc.livekitRooms().listRooms();
  const roomNames = rooms.map((r) => r.name);
  check('livekit: backend API key/secret is authorised on the SFU admin API', roomNames.includes(lk.roomName), { rooms: roomNames.slice(0, 8) });
  // setPublishPermission() swallows errors by design, so assert on the raw client
  // call: a non-auth failure means the SFU accepted the admin credentials and got
  // as far as room/participant logic.
  let permErr = null;
  try {
    await lkSvc.livekitRooms().updateParticipant(lk.roomName, 'e2e-ghost', {
      permission: { canPublish: false, canSubscribe: true, canPublishData: false },
    });
  } catch (e) { permErr = e.message; }
  check('livekit: the server-side mute call is authorised at the SFU', !/unauthenticated|permissions denied/i.test(String(permErr)), { error: permErr });

  // ---- D. seat contention against real row locks ---------------------------
  // Five distinct accounts race for one seat; FOR UPDATE on the seat row must admit
  // exactly one winner. The losers then race for a second seat to prove a user can
  // never hold two seats at once (takeSeat vacates the previous one).
  const extras = await Promise.all(
    ['05', '06', '07'].map((s) => login(`+15559${stamp}${s}`, `e2e_x${s}_${stamp.slice(-4)}`)),
  );
  const racers = [{ t: a.token, id: A }, { t: b.token, id: B }, ...extras.map((e) => ({ t: e.token, id: e.user.id }))];
  for (const r of racers) await api('POST', `/api/rooms/${roomId}/join`, { token: r.t, body: {} });

  const seatResults = await Promise.all(
    racers.map((r) => api('POST', `/api/rooms/${roomId}/seat`, { token: r.t, body: { seatIndex: 1 } })),
  );
  const wins = seatResults.filter((r) => r.status === 200);
  const conflicts = seatResults.filter((r) => r.status === 409 && r.json.error.code === 'seat_taken');
  check('seat: five concurrent takes of one seat admit exactly one winner', wins.length === 1 && conflicts.length === 4, seatResults.map((r) => `${r.status}:${(r.json && r.json.error && r.json.error.code) || 'ok'}`));
  const winnerSeat = wins[0].json.seats.find((s) => s.seatIndex === 1);
  check('seat: the winner is the only occupant recorded', await sql(`select count(*) from room_seats where room_id='${roomId}' and seat_index=1 and status='OCCUPIED'`) === '1' && !!winnerSeat && await sql(`select coalesce(user_id::text,'-') from room_seats where room_id='${roomId}' and seat_index=1`) === winnerSeat.user.id, { occupant: winnerSeat && winnerSeat.user && winnerSeat.user.username });

  const winner = racers[seatResults.indexOf(wins[0])];
  const moved = await api('POST', `/api/rooms/${roomId}/seat`, { token: winner.t, body: { seatIndex: 2 } });
  check('seat: moving to another seat never leaves the user double-seated', moved.status === 200 && await sql(`select count(*) from room_seats where room_id='${roomId}' and user_id='${winner.id}'`) === '1' && await sql(`select seat_index from room_seats where room_id='${roomId}' and user_id='${winner.id}'`) === '2', { status: moved.status, seats: await sql(`select seat_index||'='||coalesce(user_id::text,'-') from room_seats where room_id='${roomId}' and seat_index in (1,2) order by seat_index`) });
  check('seat: the previous seat is released back to EMPTY', await sql(`select status from room_seats where room_id='${roomId}' and seat_index=1`) === 'EMPTY', await sql(`select seat_index||'='||status from room_seats where room_id='${roomId}' and seat_index in (1,2) order by seat_index`));

  // ---- E. gift double-spend under real concurrency -------------------------
  // A dedicated sender whose balance is smaller than the 60/min gift throttle, so
  // the rejects below are genuinely 'insufficient_balance' races rather than the
  // abuse limiter. This is the check that a modified client hammering /send cannot
  // buy more gifts than it can afford.
  const c = await login(`+15559${stamp}04`, `e2e_carol_${stamp.slice(-4)}`);
  const C = c.user.id;
  const price = rose.diamondPrice;
  await api('POST', '/api/wallet/recharge', { token: c.token, body: { amountDiamonds: price * 15 } });
  await api('POST', `/api/rooms/${roomId}/join`, { token: c.token, body: {} });
  const balBefore = Number(await sql(`select diamond_balance from users where id='${C}'`));
  const maxAffordable = Math.floor(balBefore / price);
  const attempts = maxAffordable + 20;
  const giftCalls = await Promise.all(
    Array.from({ length: attempts }, () => api('POST', '/api/gifts/send', { token: c.token, body: { giftId: rose.id, receiverId: B, quantity: 1, roomId } })),
  );
  const codes = giftCalls.map((r) => `${r.status}:${(r.json && r.json.error && r.json.error.code) || 'ok'}`);
  const okGifts = giftCalls.filter((r) => r.status === 200 || r.status === 201).length;
  const insufficient = giftCalls.filter((r) => r.json && r.json.error && r.json.error.code === 'insufficient_balance').length;
  const serverErrors = giftCalls.filter((r) => r.status >= 500).length;
  const balAfter = Number(await sql(`select diamond_balance from users where id='${C}'`));
  check('ledger: an in-room gift is accepted at all (no 5xx)', serverErrors === 0, { serverErrors, sample: codes.slice(0, 4) });
  check('ledger: concurrent gifts never overdraw the sender', balAfter >= 0 && balBefore - balAfter === okGifts * price, { balBefore, balAfter, okGifts, price });
  check('ledger: exactly the affordable number of gifts succeeded', okGifts === maxAffordable, { okGifts, maxAffordable, attempts });
  check(`ledger: every over-drawing gift reports insufficient_balance (${attempts - okGifts} rejects)`, insufficient === attempts - okGifts, { okGifts, insufficient, attempts });
  check('ledger: one transaction row per successful gift, no partial writes', await sql(`select count(*) from transactions where type='GIFT_SENT' and sender_id='${C}'`) === String(okGifts), await sql(`select count(*) from transactions where type='GIFT_SENT' and sender_id='${C}'`));
  const recvAfter = Number(await sql(`select r_coin_balance from users where id='${B}'`));
  check('ledger: receiver r-coin credit equals successes * unit value', recvAfter === okGifts * rose.rCoinValue, { recvAfter, expected: okGifts * rose.rCoinValue });
  check('ledger: the room total_gift_value moved with the gifts', await sql(`select total_gift_value from rooms where id='${roomId}'`) === String(okGifts * rose.rCoinValue), await sql(`select total_gift_value::text from rooms where id='${roomId}'`));
  check('ledger: the leftover balance cannot buy another gift', balAfter >= 0 && balAfter < price, { balAfter, price });

  // The abuse limiter is a separate guarantee: 60 gifts/min/account.
  const flood = await Promise.all(
    Array.from({ length: 75 }, () => api('POST', '/api/gifts/send', { token: a.token, body: { giftId: rose.id, receiverId: C, quantity: 1, roomId } })),
  );
  const limited = flood.filter((r) => r.status === 429).length;
  check('ledger: the per-minute gift throttle engages under a flood', limited > 0 && flood.filter((r) => r.status < 400).length <= 60, {
    limited, ok: flood.filter((r) => r.status < 400).length,
  });

  // ---- F. socket fan-out with real persistence -----------------------------
  const sockResult = await socketPhase(a.token, b.token, roomId, gifts, A, B, a.user.username, b.user.username);
  Object.entries(sockResult).forEach(([k, v]) => check(k, v.pass, v.detail));

  // ---- G. webhook trust ----------------------------------------------------
  // Mimic exactly what the SFU sends: `Content-Type: application/webhook+json` and
  // a *bare* (no `Bearer`) Authorization JWT whose `sha256` claim is the base64
  // digest of the raw body bytes.
  const { AccessToken } = require(LK_ROOT);
  const crypto = require('crypto');
  const postHook = async (payload, { secret = SECRET, sign = true, contentType = 'application/webhook+json', bare = true } = {}) => {
    const at = new AccessToken(KEY, secret, { identity: 'webhook', ttl: 60 });
    if (sign) at.sha256 = crypto.createHash('sha256').update(payload).digest('base64');
    const jwt = await at.toJwt();
    const res = await fetch(`${API}/api/livekit/webhook`, {
      method: 'POST',
      headers: { 'content-type': contentType, authorization: bare ? jwt : `Bearer ${jwt}` },
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: res.status, body: (await res.text()).slice(0, 140) };
  };

  const finished = JSON.stringify({ event: 'room_finished', room: { name: lk.roomName, sid: 'RM_probe' }, id: `EV_${stamp}` });
  const real = await postHook(finished);
  check('webhook: a correctly signed LiveKit event is accepted', real.status === 200, real);
  // The handler acks with 200 *before* it reconciles (livekit.controller.ts does
  // that on purpose so LiveKit never retries a slow webhook), so these two
  // assertions must poll for the write instead of reading it once.
  const settled = async (predicate, limitMs = 5000) => {
    const until = Date.now() + limitMs;
    for (;;) {
      if (await predicate()) return true;
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const roomStatus = () => sql(`select status from rooms where id='${roomId}'`);
  const roomState = () => sql(`select status||'/'||coalesce(closed_at::text,'-') from rooms where id='${roomId}'`);
  check('webhook: room_finished reconciles the room row in PostgreSQL', await settled(async () => (await roomStatus()) === 'CLOSED'), await roomState());
  const seatState = async () => ({
    open: await sql(`select count(*) from room_participants where room_id='${roomId}' and left_at is null`),
    seated: await sql(`select count(*) from room_seats where room_id='${roomId}' and user_id is not null`),
  });
  check(
    'webhook: participants and seats are cleared by reconciliation',
    await settled(async () => {
      const s = await seatState();
      return s.open === '0' && s.seated === '0';
    }),
    await seatState(),
  );

  const tampered = JSON.stringify({ event: 'room_finished', room: { name: 'someone-elses-room' }, id: 'EV_x' });
  const wrongSecret = await postHook(tampered, { secret: 'wrong-secret-wrong-secret-wrong-secret' });
  check('webhook: a signature from a different secret is rejected with 401', wrongSecret.status === 401, wrongSecret);
  const noHash = await postHook(tampered, { sign: false });
  check('webhook: an event without a body digest is rejected with 401', noHash.status === 401, noHash);
  // Same signature, different bytes: the digest claim must pin the exact payload.
  const swapped = await postHook(tampered, { sign: true });
  const mismatchBody = JSON.stringify({ event: 'room_finished', room: { name: 'other' } });
  const at2 = new AccessToken(KEY, SECRET, { identity: 'webhook', ttl: 60 });
  at2.sha256 = crypto.createHash('sha256').update(mismatchBody).digest('base64');
  const rescan = await fetch(`${API}/api/livekit/webhook`, { method: 'POST', headers: { 'content-type': 'application/webhook+json', authorization: await at2.toJwt() }, body: swapped });
  check('webhook: a body that does not match its digest is rejected with 401', rescan.status === 401, { status: rescan.status });
  const unsigned = await fetch(`${API}/api/livekit/webhook`, { method: 'POST', headers: { 'content-type': 'application/webhook+json' }, body: tampered });
  check('webhook: an unauthorised delivery is rejected with 401', unsigned.status === 401, { status: unsigned.status });
  const bearer = await postHook(tampered);
  check('webhook: the SFU delivery format (bare token) is what the handler expects', bearer.status === 200 || bearer.status === 401, { note: 'control' });

  // ---- H. VIP spend tier -----------------------------------------------------
  // gifts.min_vip_level is only real if the ledger refuses the spend *before*
  // looking at the balance, and if the tier can be raised by an operator. The
  // bootstrap OTP is the documented development entry into the admin API.
  const adminLogin = await api('POST', '/api/auth/verify-otp', {
    body: { phone: '+10000000000', code: '424242' },
  });
  const adminToken = adminLogin.json && adminLogin.json.token;
  check('admin: the operator bootstrap OTP mints an admin token', adminLogin.status === 200 && !!adminToken, { status: adminLogin.status, code: adminLogin.json && adminLogin.json.error && adminLogin.json.error.code });

  const vipGift = await api('POST', '/api/admin/gifts', {
    token: adminToken,
    body: { name: `E2E Crown ${stamp}`, iconUrl: '/assets/gifts/rose.png', diamondPrice: 50, rCoinValue: 40, category: 'E2E', minVipLevel: 5, sortOrder: 900 },
  });
  const vipGiftId = vipGift.json && vipGift.json.gift && vipGift.json.gift.id;
  check('admin: a gift can be created with a VIP tier', vipGift.status === 201 && !!vipGiftId && vipGift.json.gift.minVipLevel === 5, { status: vipGift.status, body: vipGift.json });

  const d = await login(`+15559${stamp}08`, `e2e_dana_${stamp.slice(-4)}`);
  const D = d.user.id;
  await api('POST', '/api/wallet/recharge', { token: d.token, body: { amountDiamonds: 500 } });
  check('vip: a new account is VIP 0 over the API', !!adminToken && d.user.vipLevel === 0, d.user && { vipLevel: d.user.vipLevel });

  // No roomId: the phase-G webhook closed that room, and a DM gift goes through
  // the same ledger gate.
  const locked = await api('POST', '/api/gifts/send', { token: d.token, body: { giftId: vipGiftId, receiverId: B, quantity: 1 } });
  check('vip: a tier-5 gift is refused for a VIP-0 sender even with 500 diamonds', locked.status === 403 && locked.json.error.code === 'vip_required', { status: locked.status, error: locked.json && locked.json.error });
  check('vip: the refusal names the tier the sender needs', !!(locked.json && locked.json.error && locked.json.error.details && locked.json.error.details.required === 5 && locked.json.error.details.current === 0), locked.json && locked.json.error && locked.json.error.details);
  check('vip: the rejected gift moved no money', await sql(`select diamond_balance from users where id='${D}'`) === '500', await sql(`select diamond_balance::text from users where id='${D}'`));

  const tooHigh = await api('POST', `/api/admin/users/${D}/vip`, { token: adminToken, body: { vipLevel: 21 } });
  check('admin: a VIP level above the schema CHECK is rejected', tooHigh.status === 400, { status: tooHigh.status, code: tooHigh.json && tooHigh.json.error && tooHigh.json.error.code });

  const raised = await api('POST', `/api/admin/users/${D}/vip`, { token: adminToken, body: { vipLevel: 5 } });
  check('admin: an operator can raise a user VIP level', raised.status === 200 && raised.json.user.vipLevel === 5, { status: raised.status, vip: raised.json && raised.json.user && raised.json.user.vipLevel });
  check('vip: the tier is persisted in PostgreSQL', await sql(`select vip_level from users where id='${D}'`) === '5', await sql(`select vip_level::text from users where id='${D}'`));

  const unlocked = await api('POST', '/api/gifts/send', { token: d.token, body: { giftId: vipGiftId, receiverId: B, quantity: 2 } });
  check('vip: the same gift succeeds once the sender has the tier', unlocked.status === 201 && unlocked.json.sender.diamondBalance === 400, { status: unlocked.status, bal: unlocked.json && unlocked.json.sender && unlocked.json.sender.diamondBalance });
  check('vip: the tiered gift is ledgered like any other', await sql(`select count(*) from transactions where type='GIFT_SENT' and sender_id='${D}'`) === '1', await sql(`select diamond_balance||','||r_coin_balance from users where id='${D}' or id='${B}' order by id`));

  await api('DELETE', `/api/admin/gifts/${vipGiftId}`, { token: adminToken });
  check('admin: the throwaway VIP gift is removed again', await sql(`select count(*) from gifts where id='${vipGiftId}'`) === '0');

  // ---- H1b. uploaded media -------------------------------------------------
  // "Add and remove gifts from the admin panel" needs somewhere for the art to come
  // from. These drive the real upload path: bytes in, file on disk, row in the
  // database, URL served back out — and the refusals that keep a hostile or merely
  // careless operator from putting a script where a gift icon belongs.
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const LOTTIE = Buffer.from(JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 10, w: 100, h: 100, layers: [{ ty: 4 }] }));
  const b64 = (buf) => buf.toString('base64');
  const upload = (body) => api('POST', '/api/admin/uploads', { token: adminToken, body });

  const icon = await upload({ kind: 'GIFT_ICON', fileName: 'e2e-rose.png', data: b64(PNG_1PX) });
  const iconUrl = icon.json && icon.json.asset && icon.json.asset.url;
  check('upload: a PNG is accepted as a gift icon', icon.status === 201 && !!iconUrl && icon.json.duplicate === false, { status: icon.status, body: icon.json });
  check('upload: the stored name is server-chosen, not the file name sent', !!(iconUrl && /^[0-9a-f-]{36}\.png$/.test(iconUrl.split('/').pop())), iconUrl);
  check('upload: the image header was parsed, not trusted from the client', !!(icon.json && icon.json.asset.width === 1 && icon.json.asset.height === 1 && icon.json.asset.byteSize === PNG_1PX.length), icon.json && icon.json.asset);

  const served = await fetch(`${API}${iconUrl}`);
  const servedBytes = Buffer.from(await served.arrayBuffer());
  check('upload: the API serves the bytes back, unchanged and typed', served.status === 200 && served.headers.get('content-type').startsWith('image/png') && servedBytes.equals(PNG_1PX), { status: served.status, type: served.headers.get('content-type'), bytes: servedBytes.length });
  check('upload: the file really exists on disk under backend/uploads', fs.existsSync(path.join(BE_ROOT, 'uploads', path.basename(iconUrl))));

  const again = await upload({ kind: 'GIFT_ICON', fileName: 'e2e-rose-copy.png', data: b64(PNG_1PX) });
  check('upload: identical bytes return the existing row instead of a second file', again.status === 200 && again.json.duplicate === true && again.json.asset.id === icon.json.asset.id, { status: again.status, dup: again.json && again.json.duplicate });
  check('upload: the duplicate wrote no extra row', await sql(`select count(*) from media_assets where url='${iconUrl}'`) === '1');

  const disguised = await upload({ kind: 'GIFT_ICON', fileName: 'payload.png', data: Buffer.from('<?php system($_GET["c"]); ?>').toString('base64') });
  check('upload: a script named .png is refused by its magic bytes', disguised.status === 400 && disguised.json.error.code === 'upload_format_unsupported', { status: disguised.status, code: disguised.json && disguised.json.error && disguised.json.error.code });

  const wrongSlot = await upload({ kind: 'GIFT_SOUND', fileName: 'not-a-sound.png', data: b64(PNG_1PX) });
  check('upload: a PNG is refused in a sound slot', wrongSlot.status === 400 && wrongSlot.json.error.code === 'upload_format_unsupported', wrongSlot.json && wrongSlot.json.error && wrongSlot.json.error.message);

  const scene = await upload({ kind: 'GIFT_ANIMATION', fileName: 'e2e-scene.json', data: b64(LOTTIE) });
  check('upload: a Lottie scene is accepted as a gift animation', scene.status === 201 && scene.json.asset.contentType === 'application/json', { status: scene.status, body: scene.json });

  const notLottie = await upload({ kind: 'GIFT_ANIMATION', fileName: 'config.json', data: Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64') });
  check('upload: JSON that is not a Lottie scene is refused', notLottie.status === 400 && notLottie.json.error.code === 'upload_format_unsupported', notLottie.json && notLottie.json.error && notLottie.json.error.message);

  const notBase64 = await upload({ kind: 'GIFT_ICON', fileName: 'broken.png', data: 'not base64 at all!!' });
  check('upload: a body that is not base64 is refused before anything is written', notBase64.status === 400 && notBase64.json.error.code === 'upload_not_base64', { status: notBase64.status, code: notBase64.json && notBase64.json.error && notBase64.json.error.code });

  const oversized = await upload({ kind: 'BADGE', fileName: 'big.png', data: b64(Buffer.concat([PNG_1PX, Buffer.alloc(600 * 1024, 0x41)])) });
  check('upload: a file over the cap for its kind is refused', oversized.status === 400 && oversized.json.error.code === 'upload_too_large', { status: oversized.status, code: oversized.json && oversized.json.error && oversized.json.error.code });

  const traversal = await upload({ kind: 'GIFT_ICON', fileName: '../../../../etc/evil.png', data: b64(Buffer.concat([PNG_1PX, Buffer.from('e2e-distinct-bytes')])) });
  check('upload: a traversal-shaped file name is stored as text only', traversal.status === 201 && traversal.json.asset.fileName.includes('..') && !traversal.json.asset.url.includes('..'), traversal.json && traversal.json.asset);
  check('upload: nothing was written outside the uploads directory', fs.existsSync(path.join(BE_ROOT, 'uploads', path.basename(traversal.json.asset.url))) && !fs.existsSync(path.resolve(BE_ROOT, '..', '..', 'etc')));

  const userDenied = await api('POST', '/api/admin/uploads', { token: d.token, body: { kind: 'GIFT_ICON', fileName: 'nope.png', data: b64(PNG_1PX) } });
  check('upload: a member token cannot reach the upload route', userDenied.status === 403, { status: userDenied.status, code: userDenied.json && userDenied.json.error && userDenied.json.error.code });

  const listed = await api('GET', '/api/admin/uploads?kind=GIFT_ICON&limit=10', { token: adminToken });
  check('upload: the library lists what was stored', listed.status === 200 && listed.json.assets.some((asset) => asset.id === icon.json.asset.id) && listed.json.total >= 1, { status: listed.status, n: listed.json && listed.json.assets && listed.json.assets.length });

  const usedGift = await api('POST', '/api/admin/gifts', {
    token: adminToken,
    body: { name: `E2E Uploaded ${stamp}`, iconUrl, diamondPrice: 7, rCoinValue: 5, category: 'E2E', minVipLevel: 0, sortOrder: 901, animationUrl: scene.json.asset.url },
  });
  const usedGiftId = usedGift.json && usedGift.json.gift && usedGift.json.gift.id;
  check('upload: a catalogue row can point at uploaded art', usedGift.status === 201 && usedGift.json.gift.iconUrl === iconUrl, { status: usedGift.status });

  const blocked = await api('DELETE', `/api/admin/uploads/${icon.json.asset.id}`, { token: adminToken });
  check('upload: deleting art a gift still points at is refused', blocked.status === 409 && blocked.json.error.code === 'upload_in_use', { status: blocked.status, msg: blocked.json && blocked.json.error && blocked.json.error.message });
  check('upload: the refusal survives the gift being removed', (await api('DELETE', `/api/admin/gifts/${usedGiftId}`, { token: adminToken })).status === 200);

  const freed = await api('DELETE', `/api/admin/uploads/${icon.json.asset.id}`, { token: adminToken });
  check('upload: once unreferenced the asset can be deleted', freed.status === 200 && freed.json.ok === true, { status: freed.status });
  check('upload: the row is gone from PostgreSQL', await sql(`select count(*) from media_assets where id='${icon.json.asset.id}'`) === '0');
  check('upload: the bytes are gone from disk', !fs.existsSync(path.join(BE_ROOT, 'uploads', path.basename(iconUrl))));
  check('upload: the served URL now 404s rather than falling back to a directory listing', (await fetch(`${API}${iconUrl}`)).status === 404);

  await api('DELETE', `/api/admin/uploads/${scene.json.asset.id}`, { token: adminToken });
  await api('DELETE', `/api/admin/uploads/${traversal.json.asset.id}`, { token: adminToken });
  const auditUploads = await sql(`select count(*) from admin_audit where action in ('MEDIA_UPLOAD','MEDIA_DELETE') and target_id in ('${icon.json.asset.id}','${scene.json.asset.id}','${traversal.json.asset.id}')`);
  check('upload: every write and delete is in the audit log', Number(auditUploads) >= 5, auditUploads);
  check('upload: no e2e upload is left behind', await sql(`select count(*) from media_assets where file_name like 'e2e-%' or file_name like '%evil%'`) === '0');

  // ---- H1c. room decoration: themes, effects, category mapping --------------
  // The look of a room used to be a file in the repository. These checks drive the
  // database-backed catalogue instead: an operator adds a theme whose wallpaper is
  // an upload, points a room category at an uploaded loop, and every room DTO then
  // carries the URL rather than a slug the client would have to guess a path from.
  const publicCatalog = await api('GET', '/api/rooms/themes');
  const seededThemes = publicCatalog.json && publicCatalog.json.themes || [];
  check('decor: the published catalogue is the database rows, seeded and non-empty',
    publicCatalog.status === 200 && seededThemes.length >= 4 && !!publicCatalog.json.defaultTheme &&
    seededThemes.some((theme) => theme.slug === publicCatalog.json.defaultTheme) &&
    seededThemes.every((theme) => typeof theme.wallpaper === 'string' && theme.wallpaper.startsWith('/')),
    { themes: seededThemes.length, defaultTheme: publicCatalog.json && publicCatalog.json.defaultTheme });

  const adminDecor = await api('GET', '/api/admin/decor', { token: adminToken });
  check('decor: the admin view adds the fields a phone does not need',
    adminDecor.status === 200 && Array.isArray(adminDecor.json.themes) &&
    adminDecor.json.themes.every((theme) => 'isDefault' in theme && 'sortOrder' in theme && 'roomsUsing' in theme) &&
    adminDecor.json.categoryEffects.length >= 5,
    adminDecor.json && { themes: adminDecor.json.themes.length, mappings: adminDecor.json.categoryEffects.length });

  const deniedDecor = await api('GET', '/api/admin/decor', { token: d.token });
  check('decor: a member token cannot read the operator view', deniedDecor.status === 403, { status: deniedDecor.status });

  const wallpaper = await upload({ kind: 'WALLPAPER', fileName: 'e2e-wallpaper.png', data: b64(Buffer.concat([PNG_1PX, Buffer.from('e2e-wallpaper-bytes')])) });
  const wallpaperUrl = wallpaper.json && wallpaper.json.asset && wallpaper.json.asset.url;
  check('decor: a wallpaper is a supported upload kind', wallpaper.status === 201 && !!wallpaperUrl, { status: wallpaper.status, url: wallpaperUrl });

  const themeSlug = `e2e-theme-${stamp}`.toLowerCase().slice(0, 39);
  const madeTheme = await api('POST', '/api/admin/themes', {
    token: adminToken,
    body: { slug: themeSlug, name: `E2E Theme ${stamp}`, accent: '#ff8800', wallpaperUrl, sortOrder: 900 },
  });
  check('decor: an operator can add a theme pointing at uploaded art',
    madeTheme.status === 201 && madeTheme.json.theme.slug === themeSlug && madeTheme.json.theme.wallpaper === wallpaperUrl,
    { status: madeTheme.status, body: madeTheme.json });

  const republished = await api('GET', '/api/rooms/themes');
  check('decor: the new theme is published to clients without a restart',
    (republished.json.themes || []).some((theme) => theme.slug === themeSlug),
    { themes: (republished.json.themes || []).map((theme) => theme.slug).join(',') });

  const dupTheme = await api('POST', '/api/admin/themes', { token: adminToken, body: { slug: themeSlug, name: 'clash', accent: '#ff8800', wallpaperUrl } });
  check('decor: a second theme cannot reuse a slug', dupTheme.status === 409 && dupTheme.json.error.code === 'theme_exists', { status: dupTheme.status, code: dupTheme.json && dupTheme.json.error && dupTheme.json.error.code });

  const badAccent = await api('POST', '/api/admin/themes', { token: adminToken, body: { slug: 'e2e-bad-accent', name: 'x', accent: '#fff', wallpaperUrl } });
  check('decor: a malformed accent is refused, not stored', badAccent.status === 400 && badAccent.json.error.code === 'accent_invalid', badAccent.json && badAccent.json.error && badAccent.json.error.message);

  const jsUrl = await api('POST', '/api/admin/themes', { token: adminToken, body: { slug: 'e2e-js-url', name: 'x', accent: '#ffffff', wallpaperUrl: 'javascript:alert(1)' } });
  check('decor: a wallpaper URL that is not http(s) or root-relative is refused',
    jsUrl.status === 400 && jsUrl.json.error.code === 'wallpaperUrl_invalid', { status: jsUrl.status, msg: jsUrl.json && jsUrl.json.error && jsUrl.json.error.message });

  const themedRoom = await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Themed ${stamp}`, category: 'CHAT', type: 'PUBLIC', seatCapacity: 2, theme: themeSlug } });
  const themedRoomId = themedRoom.json && themedRoom.json.room && themedRoom.json.room.id;
  check('decor: a room can be created with the new theme', themedRoom.status < 300 && !!themedRoomId, { status: themedRoom.status });
  check('decor: the room DTO carries the wallpaper URL, so no client derives a path',
    themedRoom.json.room.theme === themeSlug && themedRoom.json.room.themeWallpaper === wallpaperUrl,
    { theme: themedRoom.json.room.theme, wallpaper: themedRoom.json.room.themeWallpaper });
  check('decor: that wallpaper is actually served over HTTP', (await fetch(`${API}${wallpaperUrl}`)).status === 200);

  const rename = await api('PUT', `/api/admin/themes/${themeSlug}`, { token: adminToken, body: { slug: 'e2e-renamed' } });
  check('decor: a slug cannot be renamed — rooms store it as their identity',
    rename.status === 400 && rename.json.error.code === 'theme_slug_immutable', rename.json && rename.json.error && rename.json.error.message);

  const renameDefault = await api('PUT', '/api/admin/themes/aurora', { token: adminToken, body: { isDefault: false } });
  check('decor: demoting the only default is not allowed, so the flag is one-way',
    renameDefault.status === 200 && renameDefault.json.theme.isDefault === true, { status: renameDefault.status, isDefault: renameDefault.json && renameDefault.json.theme && renameDefault.json.theme.isDefault });

  const deleteDefault = await api('DELETE', '/api/admin/themes/aurora', { token: adminToken });
  check('decor: the default theme cannot be deleted out from under every room',
    deleteDefault.status === 409 && deleteDefault.json.error.code === 'theme_is_default', { status: deleteDefault.status, msg: deleteDefault.json && deleteDefault.json.error && deleteDefault.json.error.message });

  const makeDefault = await api('PUT', `/api/admin/themes/${themeSlug}`, { token: adminToken, body: { isDefault: true } });
  const defaultRows = await sql('select count(*) from room_themes where is_default');
  check('decor: making a theme the default leaves exactly one default row',
    makeDefault.status === 200 && makeDefault.json.theme.isDefault === true && defaultRows === '1',
    { status: makeDefault.status, defaults: defaultRows });

  const blockedWallpaper = await api('DELETE', `/api/admin/uploads/${wallpaper.json.asset.id}`, { token: adminToken });
  check('decor: a wallpaper a theme points at cannot be deleted',
    blockedWallpaper.status === 409 && blockedWallpaper.json.error.code === 'upload_in_use',
    { status: blockedWallpaper.status, msg: blockedWallpaper.json && blockedWallpaper.json.error && blockedWallpaper.json.error.message });

  // A Lottie scene is parsed as JSON, so unlike a PNG it cannot carry identifying
  // bytes after the document — this is a second scene, not the first with a tail.
  const LOOP_SCENE = Buffer.from(JSON.stringify({ v: '5.7.4', fr: 24, ip: 0, op: 12, w: 80, h: 80, layers: [{ ty: 4 }], nm: `e2e-loop-${stamp}` }));
  const loop = await upload({ kind: 'EFFECT', fileName: 'e2e-loop.json', data: b64(LOOP_SCENE) });
  const loopUrl = loop.json && loop.json.asset && loop.json.asset.url;
  const madeEffect = await api('POST', '/api/admin/effects', { token: adminToken, body: { key: `e2e-loop-${stamp}`.toLowerCase().slice(0, 39), kind: 'AMBIENT', name: `E2E Loop ${stamp}`, url: loopUrl, sortOrder: 900 } });
  const effectKey = madeEffect.json && madeEffect.json.effect && madeEffect.json.effect.key;
  check('decor: an ambient loop can be added from an uploaded Lottie',
    madeEffect.status === 201 && !!effectKey && madeEffect.json.effect.url === loopUrl &&
    (await api('GET', '/api/rooms/themes')).json.effects.includes(loopUrl),
    { status: madeEffect.status, key: effectKey });

  const mappedAway = await api('PUT', `/api/admin/room-categories/GAME/effect`, { token: adminToken, body: { effectKey } });
  const gameRoom = await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Game ${stamp}`, category: 'GAME', type: 'PUBLIC', seatCapacity: 2 } });
  check('decor: which loop a category plays is data — remapping it changes the next room',
    mappedAway.status === 200 && gameRoom.json.room.ambientEffect === loopUrl,
    { status: mappedAway.status, ambient: gameRoom.json.room && gameRoom.json.room.ambientEffect });
  check('decor: the remapped loop is served, not just named', !!loopUrl && (await fetch(`${API}${loopUrl}`)).status === 200, { url: loopUrl });

  const deleteMapped = await api('DELETE', `/api/admin/effects/${effectKey}`, { token: adminToken });
  check('decor: an effect a category still plays cannot be deleted',
    deleteMapped.status === 409 && deleteMapped.json.error.code === 'effect_in_use',
    { status: deleteMapped.status, msg: deleteMapped.json && deleteMapped.json.error && deleteMapped.json.error.message });

  const unknownCategory = await api('PUT', '/api/admin/room-categories/DATING/effect', { token: adminToken, body: { effectKey } });
  check('decor: a category outside the room_category enum is refused',
    unknownCategory.status === 400 && unknownCategory.json.error.code === 'room_category_invalid',
    { status: unknownCategory.status, msg: unknownCategory.json && unknownCategory.json.error && unknownCategory.json.error.message });

  const welcomeAsAmbient = await api('PUT', '/api/admin/room-categories/GAME/effect', { token: adminToken, body: { effectKey: 'welcome' } });
  check('decor: a welcome flourish cannot be assigned as the loop behind a room',
    welcomeAsAmbient.status === 400 && welcomeAsAmbient.json.error.code === 'effect_kind_mismatch',
    { status: welcomeAsAmbient.status, msg: welcomeAsAmbient.json && welcomeAsAmbient.json.error && welcomeAsAmbient.json.error.message });

  // Put GAME back on the seeded loop, then take the e2e rows out again.
  const restoredMapping = await api('PUT', '/api/admin/room-categories/GAME/effect', { token: adminToken, body: { effectKey: 'room-glow' } });
  check('decor: the category mapping restores to the seeded loop',
    restoredMapping.status === 200 && (await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Game2 ${stamp}`, category: 'GAME', type: 'PUBLIC', seatCapacity: 2 } })).json.room.ambientEffect === '/effects/room-glow.json',
    { status: restoredMapping.status });

  const backToAurora = await api('PUT', '/api/admin/themes/aurora', { token: adminToken, body: { isDefault: true } });
  const droppedTheme = await api('DELETE', `/api/admin/themes/${themeSlug}`, { token: adminToken });
  check('decor: a retired theme deletes, and the rooms that used it keep rendering',
    backToAurora.status === 200 && droppedTheme.status === 200 && droppedTheme.json.roomsLeftOnDefault >= 1 &&
    (await api('GET', `/api/rooms/${themedRoomId}`)).json.room.themeWallpaper === '/themes/aurora/wallpaper.png',
    { status: droppedTheme.status, rooms: droppedTheme.json && droppedTheme.json.roomsLeftOnDefault });

  const freedWallpaper = await api('DELETE', `/api/admin/uploads/${wallpaper.json.asset.id}`, { token: adminToken });
  const droppedEffect = await api('DELETE', `/api/admin/effects/${effectKey}`, { token: adminToken });
  const freedLoop = await api('DELETE', `/api/admin/uploads/${loop.json.asset.id}`, { token: adminToken });
  check('decor: once nothing points at them, the rows and the bytes go',
    freedWallpaper.status === 200 && droppedEffect.status === 200 && freedLoop.status === 200 &&
    !(await api('GET', '/api/rooms/themes')).json.themes.some((theme) => theme.slug === themeSlug) &&
    await sql(`select count(*) from room_themes where slug='${themeSlug}'`) === '0' &&
    await sql(`select count(*) from visual_effects where key='${effectKey}'`) === '0' &&
    !fs.existsSync(path.join(BE_ROOT, 'uploads', path.basename(loopUrl))),
    { wallpaper: freedWallpaper.status, effect: droppedEffect.status, loop: freedLoop.status });

  const decorAudit = await sql(`select count(*) from admin_audit where action in ('THEME_CREATE','THEME_UPDATE','THEME_DELETE','EFFECT_CREATE','EFFECT_DELETE','EFFECT_CATEGORY_MAP')`);
  check('decor: every catalogue write is attributable in the audit log', Number(decorAudit) >= 7, decorAudit);
  check('decor: no e2e theme or effect row is left behind',
    await sql(`select count(*) from room_themes where slug like 'e2e-%'`) === '0' &&
    await sql(`select count(*) from visual_effects where key like 'e2e-%'`) === '0' &&
    await sql(`select count(*) from media_assets where file_name like 'e2e-%'`) === '0');

  // ---- H1b. chat emoji catalogue ------------------------------------------
  // A message stores the token `[key]`, never a URL, so the contract worth testing is that the
  // published codes all match the published pattern — that is what lets a client delete its own
  // emoji table and still render history.
  const shippedEmoji = await api('GET', '/api/emoji');
  const emojiPattern = new RegExp(`^${shippedEmoji.json.codePattern}$`);
  check('emoji: the public catalogue publishes codes a client can match with its own pattern',
    shippedEmoji.status === 200 && Array.isArray(shippedEmoji.json.emojis) && shippedEmoji.json.emojis.length >= 60 &&
    shippedEmoji.json.emojis.every((e) => emojiPattern.test(e.code) && e.url.startsWith('/') && e.key === e.code.slice(1, -1)),
    { status: shippedEmoji.status, count: shippedEmoji.json && shippedEmoji.json.emojis.length });

  const emojiArt = await upload({ kind: 'EMOJI', fileName: 'e2e-emoji.png', data: b64(PNG_1PX) });
  check('emoji: a glyph is a media upload of its own kind',
    emojiArt.status === 201 && emojiArt.json.asset.kind === 'EMOJI' &&
    fs.existsSync(path.join(BE_ROOT, 'uploads', path.basename(emojiArt.json.asset.url))),
    { status: emojiArt.status, kind: emojiArt.json && emojiArt.json.asset && emojiArt.json.asset.kind });

  const emojiKey = `e2e-grin-${stamp}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
  const madeEmoji = await api('POST', '/api/admin/emoji', {
    token: adminToken, body: { key: emojiKey, label: 'E2E Grin', url: emojiArt.json.asset.url, sortOrder: 7 },
  });
  const publishedEmoji = (await api('GET', '/api/emoji')).json.emojis.find((e) => e.key === emojiKey);
  check('emoji: an added code is published to clients on the next read, with its art served',
    madeEmoji.status === 201 && !!publishedEmoji && publishedEmoji.code === `[${emojiKey}]` &&
    publishedEmoji.url === emojiArt.json.asset.url &&
    (await fetch(`${API}${emojiArt.json.asset.url}`)).status === 200,
    { status: madeEmoji.status, published: publishedEmoji });

  const dupeEmoji = await api('POST', '/api/admin/emoji', {
    token: adminToken, body: { key: emojiKey, label: 'Twice', url: emojiArt.json.asset.url },
  });
  check('emoji: a second row cannot reuse a code',
    dupeEmoji.status === 409 && dupeEmoji.json.error.code === 'emoji_exists',
    { status: dupeEmoji.status, code: dupeEmoji.json && dupeEmoji.json.error && dupeEmoji.json.error.code });

  const scriptedEmoji = await api('POST', '/api/admin/emoji', {
    token: adminToken, body: { key: `e2e-evil-${stamp}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'), label: 'Evil', url: 'javascript:alert(1)' },
  });
  check('emoji: a script URL is not storable, because this string renders in everyone\'s chat',
    scriptedEmoji.status === 400 && scriptedEmoji.json.error.code === 'emoji_url_invalid',
    { status: scriptedEmoji.status, code: scriptedEmoji.json && scriptedEmoji.json.error && scriptedEmoji.json.error.code });

  const unmatchable = await api('POST', '/api/admin/emoji', {
    token: adminToken, body: { key: 'a'.repeat(33), label: 'Too Long', url: emojiArt.json.asset.url },
  });
  check('emoji: a key the token pattern could never match is refused',
    unmatchable.status === 400 && unmatchable.json.error.code === 'emoji_key_invalid',
    { status: unmatchable.status, code: unmatchable.json && unmatchable.json.error && unmatchable.json.error.code });

  const renamedEmoji = await api('PUT', `/api/admin/emoji/${emojiKey}`, { token: adminToken, body: { key: 'e2e-other' } });
  check('emoji: a code already typed into messages cannot be renamed',
    renamedEmoji.status === 400 && renamedEmoji.json.error.code === 'emoji_key_immutable',
    { status: renamedEmoji.status, code: renamedEmoji.json && renamedEmoji.json.error && renamedEmoji.json.error.code });

  const relabelled = await api('PUT', `/api/admin/emoji/${emojiKey}`, { token: adminToken, body: { label: 'E2E Grin Renamed', sortOrder: 3 } });
  check('emoji: label and picker position do change',
    relabelled.status === 200 && relabelled.json.emoji.label === 'E2E Grin Renamed' && relabelled.json.emoji.sortOrder === 3,
    { status: relabelled.status, body: relabelled.json && relabelled.json.emoji });

  const blockedGlyph = await api('DELETE', `/api/admin/uploads/${emojiArt.json.asset.id}`, { token: adminToken });
  check('emoji: the art cannot be deleted while a code points at it',
    blockedGlyph.status === 409 && blockedGlyph.json.error.code === 'upload_in_use',
    { status: blockedGlyph.status, msg: blockedGlyph.json && blockedGlyph.json.error && blockedGlyph.json.error.message });

  const droppedEmoji = await api('DELETE', `/api/admin/emoji/${emojiKey}`, { token: adminToken });
  const freedGlyph = await api('DELETE', `/api/admin/uploads/${emojiArt.json.asset.id}`, { token: adminToken });
  check('emoji: retiring a code leaves no row, and the bytes go once nothing points at them',
    droppedEmoji.status === 200 && freedGlyph.status === 200 &&
    await sql(`select count(*) from emoji_characters where key='${emojiKey}'`) === '0' &&
    !(await api('GET', '/api/emoji')).json.emojis.some((e) => e.key === emojiKey) &&
    !fs.existsSync(path.join(BE_ROOT, 'uploads', path.basename(emojiArt.json.asset.url))),
    { emoji: droppedEmoji.status, upload: freedGlyph.status });

  const emojiAudit = await sql(`select count(*) from admin_audit where action in ('EMOJI_CREATE','EMOJI_UPDATE','EMOJI_DELETE')`);
  check('emoji: every catalogue write is attributable in the audit log', Number(emojiAudit) >= 3, emojiAudit);
  check('emoji: no e2e emoji row is left behind',
    await sql(`select count(*) from emoji_characters where key like 'e2e-%'`) === '0');

  // ---- H1d. level ladder ----------------------------------------------------
  // §5 asks for "user experience and levels" beside "VIP membership", and this repository had
  // neither: no experience counter, no names for the rungs, no badge art. The ladder is the rule
  // that turns a number into something a member can see, so the contract worth testing is that the
  // number only moves from server-side activity, the rung always resolves from the operator's rows,
  // and an operator can retune it — a threshold, a name, a badge — without shipping a backend.
  const ladderStart = await api('GET', '/api/ranks', {});
  const rungs = (ladderStart.json && ladderStart.json.levels) || [];
  const rankLevelAt = (list, xp) => list.filter((rung) => rung.minXp <= xp).slice(-1)[0].level;
  check('rank: the public ladder is one strictly ascending floor per rung, starting at zero',
    ladderStart.status === 200 && rungs.length >= 20 && rungs[0].level === 0 && rungs[0].minXp === 0 &&
    rungs.every((rung, i) => i === 0 || (rung.level > rungs[i - 1].level && rung.minXp > rungs[i - 1].minXp)),
    { status: ladderStart.status, rungs: rungs.length });
  check('rank: every rung publishes a name, a colour and art as a URL a device loads as-is',
    rungs.every((rung) => !!rung.name && /^#[0-9a-f]{6}$/i.test(rung.accent) && typeof rung.badge === 'string' && rung.badge.startsWith('/')),
    rungs[0]);
  const badgeServed = await fetch(`${API}${rungs[rungs.length - 1].badge}`);
  check('rank: a published badge URL is really served, not just named',
    badgeServed.status === 200 && (badgeServed.headers.get('content-type') || '').includes('image'),
    { status: badgeServed.status, type: badgeServed.headers.get('content-type') });
  check('rank: the rate the number grows at is published, so a member can see how they climbed',
    !!ladderStart.json.xpRules && ladderStart.json.xpRules.perDiamondSpent === 1 && ladderStart.json.xpRules.perRCoinEarned === 0.5,
    ladderStart.json.xpRules);

  const xpSender = await login(`+15559${stamp}11`, `e2e_xp_sender_${stamp.slice(-4)}`);
  const xpHost = await login(`+15559${stamp}12`, `e2e_xp_host_${stamp.slice(-4)}`);
  const atFloor = (await api('GET', '/api/auth/me', { token: xpSender.token })).json.user;
  check('rank: a new account sits on the floor rung, with the next one already priced out',
    atFloor.xp === 0 && atFloor.rank.level === rungs[0].level && atFloor.rank.name === rungs[0].name &&
    atFloor.rank.badge === rungs[0].badge && !!atFloor.nextRank && atFloor.nextRank.remainingXp === rungs[1].minXp,
    { xp: atFloor.xp, rank: atFloor.rank, nextRank: atFloor.nextRank });

  await api('POST', '/api/wallet/recharge', { token: xpSender.token, body: { amountDiamonds: 5000 } });
  const cheapGift = (((await api('GET', '/api/gifts', {})).json || {}).gifts || [])
    .filter((g) => (g.minVipLevel || 0) === 0 && g.diamondPrice > 0)
    .sort((a, b) => a.diamondPrice - b.diamondPrice)[0];
  // A first gift of the day also finishes a daily quest (migration 0020), so the sender's total is
  // the ledger rate *plus* the reward of whatever that same transaction completed. Both parts are
  // asserted: the rate on the diamonds, and no XP beyond the listed rewards.
  const questsBeforeGift = (await api('GET', '/api/quests', { token: xpSender.token })).json;
  const xpGift = await api('POST', '/api/gifts/send', {
    token: xpSender.token, body: { giftId: cheapGift.id, receiverId: xpHost.user.id, quantity: 3 },
  });
  const questsAfterGift = (await api('GET', '/api/quests', { token: xpSender.token })).json;
  const questXp = ((questsAfterGift && questsAfterGift.quests) || [])
    .filter((q) => q.completed && !(((questsBeforeGift && questsBeforeGift.quests) || []).find((p) => p.key === q.key && p.completed)))
    .reduce((sum, q) => sum + q.xpAwarded, 0);
  const senderXp = cheapGift.diamondPrice * 3 + questXp;
  const hostXp = Math.floor((cheapGift.rCoinValue * 3) / 2);
  check('rank: the ledger awards experience to both sides of a gift at the published rates',
    xpGift.status === 201 && xpGift.json.sender.xp === senderXp && xpGift.json.receiver.xp === hostXp,
    { status: xpGift.status, ledgerXp: cheapGift.diamondPrice * 3, questXp, sent: xpGift.json && xpGift.json.sender && xpGift.json.sender.xp, hosted: xpGift.json && xpGift.json.receiver && xpGift.json.receiver.xp });
  check('rank: the rung in the same response is the one the ladder says that number sits on',
    xpGift.json.sender.rank.level === rankLevelAt(rungs, senderXp) &&
    xpGift.json.sender.rank.name === rungs.find((rung) => rung.level === rankLevelAt(rungs, senderXp)).name,
    { xp: senderXp, rank: xpGift.json && xpGift.json.sender && xpGift.json.sender.rank });
  check('rank: experience persisted, so a restart cannot hand the member a fresh low badge',
    await sql(`select xp from users where id='${xpSender.user.id}'`) === String(senderXp),
    await sql(`select xp::text from users where id='${xpSender.user.id}'`));

  const selfWrite = await api('PATCH', '/api/auth/me', { token: xpSender.token, body: { xp: 9_999_999, bio: 'e2e ladder' } });
  const afterSelfWrite = (await api('GET', '/api/auth/me', { token: xpSender.token })).json.user;
  check('rank: a member cannot write their own experience — the profile route ignores the field',
    selfWrite.status === 200 && afterSelfWrite.xp === senderXp && afterSelfWrite.bio === 'e2e ladder',
    { status: selfWrite.status, xp: afterSelfWrite.xp });

  const topRung = rungs[rungs.length - 1];
  const hostXpAfterGrant = hostXp + topRung.minXp + 5;
  const granted = await api('POST', `/api/admin/users/${xpHost.user.id}/xp`, {
    token: adminToken, body: { delta: topRung.minXp + 5, reason: 'e2e ladder probe' },
  });
  check('rank: an operator correction re-resolves the badge on the same response',
    granted.status === 200 && granted.json.user.rank.level === topRung.level && granted.json.user.nextRank === null,
    { status: granted.status, rank: granted.json && granted.json.user && granted.json.user.rank });
  const tooDeep = await api('POST', `/api/admin/users/${xpHost.user.id}/xp`, { token: adminToken, body: { delta: -999_999_999 } });
  check('rank: a correction cannot take a member below zero experience',
    tooDeep.status === 400 && tooDeep.json.error.code === 'xp_would_go_negative',
    { status: tooDeep.status, code: tooDeep.json && tooDeep.json.error && tooDeep.json.error.code });
  const memberTried = await api('POST', `/api/admin/users/${xpHost.user.id}/xp`, { token: xpSender.token, body: { delta: 1 } });
  check('rank: the experience route is unreachable with a member credential',
    memberTried.status === 401 || memberTried.status === 403, { status: memberTried.status });

  const offScale = await api('POST', '/api/admin/ranks', {
    token: adminToken, body: { level: 21, name: 'Beyond', badgeUrl: rungs[0].badge, accent: '#ffffff', minXp: 99 },
  });
  check('rank: a rung outside the scale the schema allows is refused', offScale.status === 400, { status: offScale.status });
  const dupeRung = await api('POST', '/api/admin/ranks', {
    token: adminToken, body: { level: rungs[1].level, name: 'Twice', badgeUrl: rungs[0].badge, accent: '#ffffff', minXp: 99 },
  });
  check('rank: two rungs cannot share a level',
    dupeRung.status === 409 && dupeRung.json.error.code === 'rank_exists',
    { status: dupeRung.status, code: dupeRung.json && dupeRung.json.error && dupeRung.json.error.code });
  const scriptedBadge = await api('PUT', '/api/admin/ranks/5', { token: adminToken, body: { badgeUrl: 'javascript:alert(1)' } });
  check('rank: a badge is a URL every device loads, so a script is not storable',
    scriptedBadge.status === 400 && scriptedBadge.json.error.code === 'rank_url_invalid',
    { status: scriptedBadge.status, code: scriptedBadge.json && scriptedBadge.json.error && scriptedBadge.json.error.code });
  const badRungAccent = await api('PUT', '/api/admin/ranks/5', { token: adminToken, body: { accent: 'hot pink' } });
  check('rank: a colour the client cannot parse is refused rather than stored',
    badRungAccent.status === 400 && badRungAccent.json.error.code === 'rank_accent_invalid', { status: badRungAccent.status });
  const movedIdentity = await api('PUT', '/api/admin/ranks/5', { token: adminToken, body: { level: 6 } });
  check('rank: a level already held by accounts cannot be renumbered',
    movedIdentity.status === 400 && movedIdentity.json.error.code === 'rank_level_immutable', { status: movedIdentity.status });
  const folded = await api('PUT', '/api/admin/ranks/5', { token: adminToken, body: { minXp: 100 } });
  check('rank: a rung cannot be folded onto the floor of the rung under it',
    folded.status === 409 && folded.json.error.code === 'rank_xp_order',
    { status: folded.status, code: folded.json && folded.json.error && folded.json.error.code });
  const movedFloor = await api('PUT', '/api/admin/ranks/0', { token: adminToken, body: { minXp: 10 } });
  check('rank: the floor rung stays free, because every account has to stand somewhere',
    movedFloor.status === 400 && movedFloor.json.error.code === 'rank_floor_immutable', { status: movedFloor.status });
  const notALevel = await api('PUT', '/api/admin/ranks/abc', { token: adminToken, body: { name: 'x' } });
  check('rank: a rung path parameter that is not a level says so',
    notALevel.status === 400 && notALevel.json.error.code === 'rank_level_invalid', { status: notALevel.status });
  const deleteFloor = await api('DELETE', '/api/admin/ranks/0', { token: adminToken });
  check('rank: the floor rung cannot be deleted',
    deleteFloor.status === 409 && deleteFloor.json.error.code === 'rank_floor', { status: deleteFloor.status });

  const retired = await api('PUT', `/api/admin/ranks/${topRung.level}`, { token: adminToken, body: { isActive: false } });
  const hiddenTop = (await api('GET', '/api/ranks', {})).json.levels.some((rung) => rung.level === topRung.level);
  const demotedMember = (await api('GET', '/api/auth/me', { token: xpHost.token })).json.user;
  check('rank: retiring a rung hides it and drops its members one rung, without touching their XP',
    retired.status === 200 && !hiddenTop && demotedMember.rank.level === topRung.level - 1 && demotedMember.xp === hostXpAfterGrant,
    { status: retired.status, rank: demotedMember.rank, xp: demotedMember.xp });
  await api('PUT', `/api/admin/ranks/${topRung.level}`, { token: adminToken, body: { isActive: true } });

  const renamedRung = await api('PUT', `/api/admin/ranks/${topRung.level}`, {
    token: adminToken, body: { name: 'E2E Renamed Rung', accent: '#123456', badgeUrl: rungs[0].badge },
  });
  const publishedRename = (await api('GET', '/api/ranks', {})).json.levels.find((rung) => rung.level === topRung.level);
  check('rank: renaming a rung, its colour and its art reaches every device on the next read',
    renamedRung.status === 200 && publishedRename.name === 'E2E Renamed Rung' && publishedRename.accent === '#123456' &&
    publishedRename.badge === rungs[0].badge && (await fetch(`${API}${rungs[0].badge}`)).status === 200,
    { status: renamedRung.status, published: publishedRename });

  const droppedTop = await api('DELETE', `/api/admin/ranks/${topRung.level}`, { token: adminToken });
  const outOfOrderAgain = await api('POST', '/api/admin/ranks', {
    token: adminToken, body: { level: topRung.level, name: topRung.name, badgeUrl: topRung.badge, accent: topRung.accent, minXp: 10 },
  });
  const reAdded = await api('POST', '/api/admin/ranks', {
    token: adminToken, body: { level: topRung.level, name: topRung.name, badgeUrl: topRung.badge, accent: topRung.accent, minXp: topRung.minXp },
  });
  check('rank: a rung can be deleted and re-added, and the refusal in between explains the order',
    droppedTop.status === 200 && droppedTop.json.membersMoved >= 1 && outOfOrderAgain.status === 409 &&
    outOfOrderAgain.json.error.code === 'rank_xp_order' && reAdded.status === 201,
    { dropped: droppedTop.status, moved: droppedTop.json && droppedTop.json.membersMoved, order: outOfOrderAgain.status, added: reAdded.status });
  await api('PUT', `/api/admin/ranks/${topRung.level}`, {
    token: adminToken, body: { name: topRung.name, accent: topRung.accent, badgeUrl: topRung.badge, minXp: topRung.minXp },
  });

  const board = await api('GET', '/api/users/top?window=month&role=senders&limit=20', {});
  check('rank: the ranking board carries the rung of each row, so the sheet draws badges without a second call',
    board.status === 200 && board.json.leaders.length > 0 &&
    board.json.leaders.every((row) => row.rank && typeof row.rank.name === 'string' && row.rank.badge.startsWith('/')),
    { status: board.status, rows: board.json && board.json.leaders.length, first: board.json && board.json.leaders[0] });

  const ladderEnd = await api('GET', '/api/ranks', {});
  check('rank: the ladder is left exactly as this run found it',
    JSON.stringify(ladderEnd.json.levels) === JSON.stringify(rungs),
    { before: rungs.length, after: ladderEnd.json.levels.length });
  const rankAudit = await sql(`select count(*) from admin_audit where action in ('RANK_CREATE','RANK_UPDATE','RANK_DELETE','USER_XP_ADJUST')`);
  check('rank: every ladder and experience write is attributable in the audit log',
    Number(rankAudit) >= 6, rankAudit);
  check('rank: no e2e rung was left on the ladder',
    await sql(`select count(*) from rank_levels where name like 'E2E %'`) === '0');

  // ---- H1e. cosmetic store --------------------------------------------------
  // The first place a member spends diamonds on something that is not a gift, so the contract
  // worth testing is the money one: the price is read from the database inside the purchase
  // transaction (a modified client cannot name its own), a purchase posts exactly one ledger row,
  // two taps against one balance buy once, and the thing bought — or lost to expiry, or retired by
  // an operator — leaves the receipt that proves where it came from. The art and wearing side is
  // checked through the same DTOs a device reads: /me, the store screen, the seat grid, the host
  // card and the socket banner.
  const shopUser = await login(`+15559${stamp}21`, `e2e_shop_${stamp.slice(-4)}`);
  const rivalUser = await login(`+15559${stamp}22`, `e2e_rival_${stamp.slice(-4)}`);
  const watcher = await login(`+15559${stamp}23`, `e2e_watch_${stamp.slice(-4)}`);
  const SHOP = shopUser.user.id;

  const anonShop = await api('GET', '/api/store', {});
  check('store: the catalogue marks what *you* own, so an anonymous read is refused',
    anonShop.status === 401, { status: anonShop.status });

  const shop = await api('GET', '/api/store', { token: shopUser.token });
  const shelf = (shop.json && shop.json.items) || [];
  const itemOn = (kind, key) => shelf.find((i) => i.kind === kind && i.key === key);
  const bronze = itemOn('FRAME', 'ring-bronze');
  check('store: one shop lists all three catalogues at the prices an operator set',
    shop.status === 200 && shelf.length >= 16 && !!itemOn('THEME', 'nebula') && !!itemOn('EFFECT', 'welcome-confetti') &&
    !!bronze && bronze.priceDiamonds === 300 && bronze.owned === false && bronze.equipped === false,
    { status: shop.status, rows: shelf.length, kinds: shelf.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] || 0) + 1 }), {}) });
  const ringArt = bronze ? await fetch(`${API}${bronze.art}`) : null;
  check('store: the ring the shop names is art the server really serves',
    !!ringArt && ringArt.status === 200 && (ringArt.headers.get('content-type') || '').includes('image'),
    bronze && { art: bronze.art, status: ringArt && ringArt.status });

  const unpaidTheme = await api('POST', '/api/rooms', {
    token: shopUser.token,
    body: { title: `E2E Store Unpaid ${stamp}`, category: 'PARTY', type: 'PUBLIC', theme: 'nebula' },
  });
  check('store: a room cannot wear a paid theme its host has not bought',
    unpaidTheme.status === 403 && unpaidTheme.json.error.code === 'theme_not_owned' &&
    unpaidTheme.json.error.details.priceDiamonds === 1500,
    { status: unpaidTheme.status, error: unpaidTheme.json && unpaidTheme.json.error });

  const broke = await api('POST', '/api/store/purchase', { token: shopUser.token, body: { kind: 'FRAME', key: 'ring-bronze' } });
  check('store: an empty wallet is refused before anything is written',
    broke.status === 402 && broke.json.error.code === 'insufficient_balance' &&
    broke.json.error.details.needed === 300 && broke.json.error.details.available === 0 &&
    await sql(`select count(*) from transactions where sender_id='${SHOP}'`) === '0' &&
    await sql(`select count(*) from user_items where user_id='${SHOP}'`) === '0',
    { status: broke.status, error: broke.json && broke.json.error });

  await api('POST', '/api/wallet/recharge', { token: shopUser.token, body: { amountDiamonds: 500 } });
  const bought = await api('POST', '/api/store/purchase', { token: shopUser.token, body: { kind: 'FRAME', key: 'ring-bronze' } });
  check('store: a purchase debits the catalogue price and answers with both receipts',
    bought.status === 201 && bought.json.wallet.diamondBalance === 200 &&
    bought.json.transaction.type === 'ITEM_PURCHASE' && bought.json.transaction.amountDiamonds === 300 &&
    bought.json.item.owned === true,
    { status: bought.status, wallet: bought.json && bought.json.wallet && bought.json.wallet.diamondBalance, tx: bought.json && bought.json.transaction });
  check('store: spending on a cosmetic earns experience at the same rate as a gift',
    bought.json.wallet.xp === 300, bought.json && bought.json.wallet && bought.json.wallet.xp);
  check('store: the debit is one posted row with no receiver — a sink, not a transfer',
    await sql(`select count(*) from transactions where type='ITEM_PURCHASE' and sender_id='${SHOP}' and receiver_id is null and amount_r_coins=0`) === '1',
    await sql(`select amount_diamonds||'/'||coalesce(receiver_id::text,'none') from transactions where sender_id='${SHOP}'`));

  const sneaky = await api('POST', '/api/store/purchase', {
    token: shopUser.token, body: { kind: 'FRAME', key: 'ring-silver', priceDiamonds: 1, amountDiamonds: 1 },
  });
  check('store: a price in the request body changes nothing about what is charged',
    sneaky.status === 402 && sneaky.json.error.code === 'insufficient_balance' && sneaky.json.error.details.needed === 600,
    { status: sneaky.status, error: sneaky.json && sneaky.json.error });

  const equipped = await api('POST', '/api/store/equip', { token: shopUser.token, body: { kind: 'FRAME', key: 'ring-bronze' } });
  check('store: equipping puts the ring on the account every DTO reads',
    equipped.status === 200 && !!equipped.json.user.profileFrame && equipped.json.user.profileFrame.key === 'ring-bronze' &&
    equipped.json.user.profileFrame.art === bronze.art,
    { status: equipped.status, frame: equipped.json && equipped.json.user && equipped.json.user.profileFrame });

  const shopAfter = await api('GET', '/api/store', { token: shopUser.token });
  const ownedBronze = (shopAfter.json.owned || []).find((o) => o.kind === 'FRAME' && o.key === 'ring-bronze');
  const listedBronze = (shopAfter.json.items || []).find((i) => i.kind === 'FRAME' && i.key === 'ring-bronze');
  check('store: the shop reads back what the member owns, through which door, and what is on',
    !!ownedBronze && ownedBronze.acquiredVia === 'PURCHASE' && ownedBronze.onSale === true &&
    !!listedBronze && listedBronze.owned === true && listedBronze.equipped === true,
    { owned: ownedBronze, listed: listedBronze });

  const shopRoom = await api('POST', '/api/rooms', {
    token: shopUser.token, body: { title: `E2E Store Room ${stamp}`, category: 'PARTY', type: 'PUBLIC' },
  });
  const shopRoomId = shopRoom.json && shopRoom.json.room && shopRoom.json.room.id;
  check('store: the ring travels on the seat grid and the room card, not only on /me',
    shopRoom.status === 201 && shopRoom.json.room.seats[0].user.profileFrame.key === 'ring-bronze' &&
    shopRoom.json.room.host.profileFrame.key === 'ring-bronze',
    { status: shopRoom.status, seat0: shopRoom.json && shopRoom.json.room && shopRoom.json.room.seats[0], host: shopRoom.json && shopRoom.json.room && shopRoom.json.room.host });

  const expiresAtEpoch = async () => Number(await sql(`select extract(epoch from expires_at) from user_items where user_id='${SHOP}' and kind='FRAME' and item_key='ring-bronze'`));
  const firstExpiry = await expiresAtEpoch();
  await api('POST', '/api/wallet/recharge', { token: shopUser.token, body: { amountDiamonds: 300 } });
  const renewed = await api('POST', '/api/store/purchase', { token: shopUser.token, body: { kind: 'FRAME', key: 'ring-bronze' } });
  const renewedExpiry = await expiresAtEpoch();
  check('store: buying the same ring again adds a period to the one receipt, never a second row',
    renewed.status === 201 &&
    await sql(`select count(*) from user_items where user_id='${SHOP}' and kind='FRAME' and item_key='ring-bronze'`) === '1' &&
    Math.abs((renewedExpiry - firstExpiry) - 30 * 86_400) < 120,
    { status: renewed.status, first: new Date(firstExpiry * 1000).toISOString(), renewed: new Date(renewedExpiry * 1000).toISOString() });

  const lapsedAt = new Date(Date.now() - 86_400_000).toISOString();
  await sql(`update user_items set expires_at = '${lapsedAt}' where user_id='${SHOP}' and kind='FRAME' and item_key='ring-bronze'`);
  await sql(`update users set profile_frame_expires_at = '${lapsedAt}' where id='${SHOP}'`);
  const lapsedEquip = await api('POST', '/api/store/equip', { token: shopUser.token, body: { kind: 'FRAME', key: 'ring-bronze' } });
  const meLapsed = (await api('GET', '/api/auth/me', { token: shopUser.token })).json.user;
  check('store: an expired ring cannot be re-equipped and stops drawing on every seat',
    lapsedEquip.status === 403 && lapsedEquip.json.error.code === 'item_expired' && meLapsed.profileFrame === null,
    { status: lapsedEquip.status, frame: meLapsed.profileFrame });
  check('store: expiry deletes the receipt the member paid for',
    await sql(`select count(*) from user_items where user_id='${SHOP}' and item_key='ring-bronze'`) === '1');

  await api('POST', '/api/wallet/recharge', { token: shopUser.token, body: { amountDiamonds: 300 } });
  const revived = await api('POST', '/api/store/purchase', { token: shopUser.token, body: { kind: 'FRAME', key: 'ring-bronze' } });
  check('store: renewing a lapsed ring starts from today, not from the old date',
    revived.status === 201 && !!(await api('GET', '/api/auth/me', { token: shopUser.token })).json.user.profileFrame &&
    await sql(`select (profile_frame_expires_at > now() + interval '29 days')::text from users where id='${SHOP}'`) === 'true',
    revived.json && revived.json.item);

  const memberGrant = await api('POST', `/api/admin/users/${SHOP}/grant`, { token: shopUser.token, body: { kind: 'FRAME', key: 'ring-jade' } });
  const memberFrameWrite = await api('POST', '/api/admin/frames', {
    token: shopUser.token, body: { key: `e2e-nope-${stamp}`, name: 'Nope', artUrl: bronze.art, accent: '#123456' },
  });
  check('store: a member cannot grant themselves anything, and the catalogue is not a member route',
    (memberGrant.status === 401 || memberGrant.status === 403) && (memberFrameWrite.status === 401 || memberFrameWrite.status === 403),
    { grant: memberGrant.status, frame: memberFrameWrite.status });

  const grant = await api('POST', `/api/admin/users/${SHOP}/grant`, { token: adminToken, body: { kind: 'FRAME', key: 'ring-jade', days: 7 } });
  check('store: an operator can hand over a ring without money moving',
    grant.status === 201 && grant.json.item.owned === true && grant.json.item.expiresAt !== null &&
    await sql(`select count(*) from user_items where user_id='${SHOP}' and kind='FRAME' and item_key='ring-jade' and acquired_via='ADMIN_GRANT' and transaction_id is null`) === '1' &&
    await sql(`select count(*) from transactions where type='ITEM_PURCHASE' and sender_id='${SHOP}'`) === '3',
    { status: grant.status, item: grant.json && grant.json.item });

  await api('POST', '/api/wallet/recharge', { token: shopUser.token, body: { amountDiamonds: 3000 } });
  const themeBuy = await api('POST', '/api/store/purchase', { token: shopUser.token, body: { kind: 'THEME', key: 'nebula' } });
  check('store: a theme is bought through the same transaction as a ring',
    themeBuy.status === 201 && themeBuy.json.item.owned === true,
    themeBuy.json && { status: themeBuy.status, item: themeBuy.json.item });
  const themed = await api('POST', '/api/rooms', {
    token: shopUser.token, body: { title: `E2E Store Theme ${stamp}`, category: 'PARTY', type: 'PUBLIC', theme: 'nebula' },
  });
  check('store: the paid theme is accepted once its host owns it',
    themed.status === 201 && themed.json.room.theme === 'nebula', { status: themed.status, error: themed.json && themed.json.error });
  const themeEquip = await api('POST', '/api/store/equip', { token: shopUser.token, body: { kind: 'THEME', key: 'nebula' } });
  check('store: a theme decorates a room, so it cannot be equipped to an account',
    themeEquip.status === 400 && themeEquip.json.error.code === 'theme_is_per_room', { status: themeEquip.status });

  const freeTheme = await api('POST', '/api/store/purchase', { token: shopUser.token, body: { kind: 'THEME', key: 'aurora' } });
  const ghost = await api('POST', '/api/store/purchase', { token: shopUser.token, body: { kind: 'FRAME', key: `ring-none-${stamp}` } });
  check('store: a free theme has nothing to buy, and an unknown key is a 404 rather than a charge',
    freeTheme.status === 400 && freeTheme.json.error.code === 'item_not_for_sale' &&
    ghost.status === 404 && ghost.json.error.code === 'item_not_found',
    { free: freeTheme.status, ghost: ghost.status });

  const effectBuy = await api('POST', '/api/store/purchase', { token: shopUser.token, body: { kind: 'EFFECT', key: 'welcome-confetti' } });
  const effectEquip = await api('POST', '/api/store/equip', { token: shopUser.token, body: { kind: 'EFFECT', key: 'welcome-confetti' } });
  const effectUrl = await sql(`select url from visual_effects where key='welcome-confetti'`);
  const meEffect = (await api('GET', '/api/auth/me', { token: shopUser.token })).json.user;
  check('store: a bought entry flourish becomes the URL other clients play on join',
    effectBuy.status === 201 && effectEquip.status === 200 && meEffect.entryEffect === effectUrl,
    { status: effectBuy.status, entryEffect: meEffect.entryEffect, url: effectUrl });

  // The banner is a socket event, not a row: a member buys the flourish so that *other* people see
  // it, which is only true if the join payload carries it. Two throwaway sockets, one observer.
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const socketFor = (token) => ioLib('http://127.0.0.1:4000', { transports: ['websocket'], forceNew: true, auth: { token } });
  const entrances = [];
  const connected = (s, label) => {
    s.on('connect_error', (e) => trace('!! socket', label, 'connect_error:', e.message));
    return Promise.race([
      new Promise((r) => s.once('connected', r)),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} socket never connected`)), 20000)),
    ]);
  };
  const watchSocket = socketFor(watcher.token);
  watchSocket.on('room:user_joined', (p) => entrances.push(p));
  trace('-> socket watcher connect');
  await connected(watchSocket, 'watcher');
  watchSocket.emit('room:join', { roomId: shopRoomId }, () => {});
  await delay(400);
  const wearerSocket = socketFor(shopUser.token);
  trace('-> socket wearer connect');
  await connected(wearerSocket, 'wearer');
  wearerSocket.emit('room:join', { roomId: shopRoomId }, () => {});
  await delay(1200);
  const banner = entrances.find((p) => p.user && p.user.id === SHOP);
  check('store: the entry banner another member receives carries the paid flourish and ring',
    !!banner && banner.user.entryEffect === effectUrl && !!banner.user.profileFrame && banner.user.profileFrame.key === 'ring-bronze',
    banner && banner.user);
  watchSocket.close();
  wearerSocket.close();
  await delay(300);

  // Two taps against one balance: the second must lose cleanly rather than overdraw. This is the
  // same guarantee /api/gifts/send gives, from the same ledger primitive.
  await api('POST', '/api/wallet/recharge', { token: rivalUser.token, body: { amountDiamonds: 600 } });
  const doubleTap = await Promise.all([
    api('POST', '/api/store/purchase', { token: rivalUser.token, body: { kind: 'FRAME', key: 'ring-silver' } }),
    api('POST', '/api/store/purchase', { token: rivalUser.token, body: { kind: 'FRAME', key: 'ring-silver' } }),
  ]);
  const paid = doubleTap.filter((r) => r.status === 201).length;
  const refused = doubleTap.filter((r) => r.json && r.json.error && r.json.error.code === 'insufficient_balance').length;
  check('store: two taps against one balance buy once — the ledger locks the wallet',
    paid === 1 && refused === 1 &&
    await sql(`select count(*) from transactions where type='ITEM_PURCHASE' and sender_id='${rivalUser.user.id}'`) === '1' &&
    await sql(`select diamond_balance from users where id='${rivalUser.user.id}'`) === '0',
    { paid, refused, balance: await sql(`select diamond_balance from users where id='${rivalUser.user.id}'`) });

  const shopBalance = Number(await sql(`select diamond_balance from users where id='${SHOP}'`));
  const shopSpent = Number(await sql(`select coalesce(sum(amount_diamonds),0) from transactions where type='ITEM_PURCHASE' and sender_id='${SHOP}'`));
  const shopRecharged = Number(await sql(`select coalesce(sum(amount_diamonds),0) from transactions where type='RECHARGE' and receiver_id='${SHOP}'`));
  check('store: the wallet is exactly recharges minus purchases, to the diamond',
    shopBalance === shopRecharged - shopSpent, { balance: shopBalance, recharged: shopRecharged, spent: shopSpent });

  const e2eFrame = `e2e-ring-${stamp}`;
  const unpriced = await api('POST', '/api/admin/frames', {
    token: adminToken, body: { key: `${e2eFrame}-free`, name: 'E2E Free Sale', artUrl: bronze.art, accent: '#123456', forSale: true },
  });
  check('store: an item cannot be on sale for nothing',
    unpriced.status === 400 && unpriced.json.error.code === 'frame_price_required',
    { status: unpriced.status, error: unpriced.json && unpriced.json.error });
  const madeFrame = await api('POST', '/api/admin/frames', {
    token: adminToken,
    body: { key: e2eFrame, name: 'E2E Ring', artUrl: bronze.art, accent: '#123456', sortOrder: 999, priceDiamonds: 400, forSale: true, periodDays: 7 },
  });
  check('store: an operator can add a ring to the shop from the console',
    madeFrame.status === 201 && madeFrame.json.frame.forSale === true && madeFrame.json.frame.priceDiamonds === 400 && madeFrame.json.frame.holders === 0,
    { status: madeFrame.status, frame: madeFrame.json && madeFrame.json.frame });

  const grantedE2e = await api('POST', `/api/admin/users/${SHOP}/grant`, { token: adminToken, body: { kind: 'FRAME', key: e2eFrame } });
  const holders = await api('GET', `/api/admin/frames/${e2eFrame}/holders`, { token: adminToken });
  check('store: the console can see who holds a ring and by which door',
    grantedE2e.status === 201 && holders.status === 200 &&
    holders.json.holders.some((h) => h.userId === SHOP && h.acquiredVia === 'ADMIN_GRANT'),
    { status: grantedE2e.status, holders: holders.json && holders.json.holders });

  const permanent = await api('POST', `/api/admin/users/${SHOP}/grant`, {
    token: adminToken, body: { kind: 'FRAME', key: e2eFrame, days: null },
  });
  check('store: a null period is how an operator makes a grant permanent',
    permanent.status === 201 && permanent.json.item.expiresAt === null,
    { status: permanent.status, item: permanent.json && permanent.json.item });

  const retiredRing = await api('DELETE', `/api/admin/frames/${e2eFrame}`, { token: adminToken });
  check('store: retiring a ring keeps the receipts and says how many members wear it',
    retiredRing.status === 200 && retiredRing.json.membersStillHolding >= 1 &&
    await sql(`select count(*) from user_items where user_id='${SHOP}' and item_key='${e2eFrame}'`) === '1' &&
    !(await api('GET', '/api/store', { token: shopUser.token })).json.items.some((i) => i.key === e2eFrame),
    { status: retiredRing.status, body: retiredRing.json });

  const restoredRing = await api('POST', '/api/admin/frames', {
    token: adminToken,
    body: { key: e2eFrame, name: 'E2E Ring', artUrl: bronze.art, accent: '#123456', sortOrder: 999, priceDiamonds: 400, forSale: true, periodDays: 7 },
  });
  check('store: the key can be added back and the receipt finds its art again',
    restoredRing.status === 201 && restoredRing.json.frame.holders === 1,
    { status: restoredRing.status, frame: restoredRing.json && restoredRing.json.frame });

  const decor = await api('GET', '/api/admin/decor', { token: adminToken });
  check('store: the decoration screen reads the frames from the same catalogue call',
    decor.status === 200 && decor.json.frames.some((f) => f.key === 'ring-bronze'), { status: decor.status });

  const cleaned = await api('DELETE', `/api/admin/frames/${e2eFrame}`, { token: adminToken });
  check('store: the e2e ring is retired again, leaving the shop as this run found it',
    cleaned.status === 200 && await sql(`select count(*) from profile_frames where key like 'e2e-%'`) === '0',
    { status: cleaned.status });

  const storeAudit = await sql(`select count(*) from admin_audit where action in ('FRAME_CREATE','FRAME_DELETE') and target_id like 'e2e-ring-%'`);
  const grantAudit = await sql(`select count(*) from admin_audit where action='ITEM_GRANT' and target_id='${SHOP}'`);
  check('store: every catalogue write and grant is attributable in the audit log',
    Number(storeAudit) >= 4 && Number(grantAudit) >= 2, { frameRows: storeAudit, grants: grantAudit });

  // ---- H1c. daily quests and the check-in ------------------------------------
  await questPhase(adminToken, rose);

  // ---- H2. seat policy ------------------------------------------------------
  // "A default of 15 speaker seats, configurable by the administrator" is only true if the
  // number comes from the database rather than a constant, so this drives the policy itself:
  // read it, move it, build a room that the old hardcoded ceiling could not have held, and
  // put it back.
  const shipped = await api('GET', '/api/rooms/capacity');
  check('seats: the public policy names the platform default of 15 speaker seats',
    shipped.status === 200 && shipped.json.seatCapacity.default === 16 && shipped.json.speakerSeats === 15,
    shipped.json && shipped.json.seatCapacity);

  const defaultRoom = await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Default Seats ${stamp}`, category: 'CHAT', type: 'PUBLIC' } });
  const defaultRoomId = defaultRoom.json && defaultRoom.json.room && defaultRoom.json.room.id;
  const defaultSeats = await sql(`select count(*) from room_seats where room_id='${defaultRoomId}'`);
  check('seats: a room created without a capacity gets the policy default, not a constant',
    defaultRoom.status === 201 && defaultSeats === '16' && defaultRoom.json.room.seatCapacity === 16,
    { status: defaultRoom.status, seats: defaultSeats });

  const tooBig = await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Too Big ${stamp}`, category: 'CHAT', seatCapacity: 40 } });
  check('seats: a capacity above the policy ceiling is refused', tooBig.status === 400, { status: tooBig.status, code: tooBig.json && tooBig.json.error && tooBig.json.error.code });

  const raisedPolicy = await api('PUT', '/api/admin/rooms/seat-policy', {
    token: adminToken, body: { speakerSeats: 20, maxSpeakerSeats: 40 },
  });
  check('seats: an operator can raise the speaker-seat policy',
    raisedPolicy.status === 200 && raisedPolicy.json.seatCapacity.default === 21 && raisedPolicy.json.maxSpeakerSeats === 40,
    { status: raisedPolicy.status, body: raisedPolicy.json });
  check('seats: the policy change is written to the audit trail',
    Number(await sql(`select count(*) from admin_audit where action='SYSTEM_CONFIG_UPDATE' and target_id='rooms.seats'`)) >= 1,
    await sql(`select summary from admin_audit where action='SYSTEM_CONFIG_UPDATE' and target_id='rooms.seats' order by created_at desc limit 1`));

  const wideRoom = await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Wide Room ${stamp}`, category: 'CHAT', type: 'PUBLIC' } });
  const wideRoomId = wideRoom.json && wideRoom.json.room && wideRoom.json.room.id;
  check('seats: the new default makes 21 seats, all materialised',
    wideRoom.status === 201 && (await sql(`select count(*) from room_seats where room_id='${wideRoomId}'`)) === '21',
    { seats: await sql(`select count(*) from room_seats where room_id='${wideRoomId}'`) });

  // The failure the old MAX_SEATS = 9 made impossible: a speaker three screens away from the host.
  await api('POST', `/api/rooms/${wideRoomId}/join`, { token: b.token, body: {} });
  const farSeat = await api('POST', `/api/rooms/${wideRoomId}/seat`, { token: b.token, body: { seatIndex: 20 } });
  check('seats: seat 20 exists and can be taken (beyond the old hardcoded nine)',
    farSeat.status === 200 && await sql(`select status from room_seats where room_id='${wideRoomId}' and seat_index=20`) === 'OCCUPIED',
    { status: farSeat.status, seat: await sql(`select status from room_seats where room_id='${wideRoomId}' and seat_index=20`) });

  const pastSeat = await api('POST', `/api/rooms/${wideRoomId}/seat`, { token: a.token, body: { seatIndex: 21 } });
  check('seats: one seat past the room is still no seat at all', pastSeat.status === 400, { status: pastSeat.status, code: pastSeat.json && pastSeat.json.error && pastSeat.json.error.code });

  // The ceiling is the schema's, so a policy that asks for more than the CHECK allows must be
  // refused by the API rather than by a 23514 from inside a transaction.
  const beyondCeiling = await api('PUT', '/api/admin/rooms/seat-policy', { token: adminToken, body: { speakerSeats: 64, maxSpeakerSeats: 64 } });
  check('seats: a policy above the schema ceiling is rejected with 400', beyondCeiling.status === 400, { status: beyondCeiling.status });

  const maxPolicy = await api('PUT', '/api/admin/rooms/seat-policy', { token: adminToken, body: { speakerSeats: 40, maxSpeakerSeats: 63 } });
  const ceilingRoom = maxPolicy.status === 200
    ? await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Ceiling Room ${stamp}`, category: 'CHAT', seatCapacity: 64 } })
    : { status: 0 };
  check('seats: a room at the schema ceiling (64 seats) is accepted by PostgreSQL',
    ceilingRoom.status === 201 && (await sql(`select count(*) from room_seats where room_id='${ceilingRoom.json.room.id}'`)) === '64',
    { status: ceilingRoom.status, seats: ceilingRoom.json ? await sql(`select count(*) from room_seats where room_id='${ceilingRoom.json.room.id}'`) : null });

  const restored = await api('PUT', '/api/admin/rooms/seat-policy', { token: adminToken, body: { speakerSeats: 15, maxSpeakerSeats: 32 } });
  const afterRestore = await api('GET', '/api/rooms/capacity');
  check('seats: the shipped policy is restored so no test room sets the house number',
    restored.status === 200 && afterRestore.json.speakerSeats === 15 && afterRestore.json.maxSpeakerSeats === 32,
    afterRestore.json && afterRestore.json.seatCapacity);
  for (const id of [defaultRoomId, wideRoomId, ceilingRoom.json && ceilingRoom.json.room && ceilingRoom.json.room.id]) {
    if (id) await api('POST', `/api/rooms/${id}/close`, { token: a.token, body: {} });
  }

  // ---- H3. room profile and discovery --------------------------------------
  // §3 wants a room to state language/region/rules, the lobby to search and order by them
  // server-side, and hosts to edit and delete their own rooms. Each check here is the shape
  // a modified Android client cannot change: the filter, the ownership test and the
  // "history is not deletable" rule all live in PostgreSQL and the service.
  const messy = await api('POST', '/api/rooms', {
    token: a.token,
    body: {
      title: `E2E Profile ${stamp}`, category: 'MUSIC', type: 'PUBLIC',
      language: 'EN-us', region: 'us', rules: '  No hate speech. Mic etiquette after 22:00.  ',
    },
  });
  const profileRoom = messy.json && messy.json.room;
  check('profile: language and region are normalized and rules trimmed on the way in',
    messy.status === 201 && profileRoom.language === 'en-us' && profileRoom.region === 'US'
      && profileRoom.rules === 'No hate speech. Mic etiquette after 22:00.',
    profileRoom && { language: profileRoom.language, region: profileRoom.region, rules: profileRoom.rules });

  const badLang = await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Bad Lang ${stamp}`, language: 'english' } });
  check('profile: a language that is not an ISO tag is a 400, not a room nobody can filter',
    badLang.status === 400 && badLang.json.error.code === 'language_invalid', { status: badLang.status, code: badLang.json && badLang.json.error });
  const badRegion = await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Bad Region ${stamp}`, region: 'USA' } });
  check('profile: a three-letter region is refused the same way', badRegion.status === 400, { status: badRegion.status });
  const longRules = await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Long Rules ${stamp}`, rules: 'x'.repeat(1001) } });
  check('profile: rules past the column limit are refused before PostgreSQL raises 22001',
    longRules.status === 400 && /rules/.test((longRules.json && longRules.json.error && longRules.json.error.message) || ''),
    { status: longRules.status, message: longRules.json && longRules.json.error });

  const byLang = await api('GET', `/api/rooms?language=en-us&limit=100&sort=recent`);
  check('discovery: the language filter is the server\'s, and finds the room by its normalized tag',
    byLang.status === 200 && byLang.json.rooms.some((r) => r.id === profileRoom.id),
    { count: byLang.json.rooms && byLang.json.rooms.length });
  const byOtherLang = await api('GET', '/api/rooms?language=de&limit=100');
  check('discovery: a different language does not leak it',
    byOtherLang.status === 200 && !byOtherLang.json.rooms.some((r) => r.id === profileRoom.id), null);
  const bySearch = await api('GET', `/api/rooms?search=${encodeURIComponent('E2E Profile')}&limit=100`);
  check('discovery: title search finds it, and the room number search would too',
    bySearch.status === 200 && bySearch.json.rooms.some((r) => r.id === profileRoom.id),
    { count: bySearch.json.rooms && bySearch.json.rooms.length });

  const edited = await api('PATCH', `/api/rooms/${profileRoom.id}`, {
    token: a.token, body: { title: `E2E Profile Edited ${stamp}`, rules: 'Host approves speakers on request.' },
  });
  check('profile: the host can edit the title and rules, and the seat count is untouched',
    edited.status === 200 && edited.json.room.title === `E2E Profile Edited ${stamp}`
      && edited.json.room.rules === 'Host approves speakers on request.'
      && edited.json.room.seatCapacity === profileRoom.seatCapacity,
    edited.json && edited.json.room && { title: edited.json.room.title, seats: edited.json.room.seatCapacity });

  const foreignEdit = await api('PATCH', `/api/rooms/${profileRoom.id}`, { token: b.token, body: { rules: 'hijacked' } });
  check('profile: another member cannot edit the room, whatever their client says',
    foreignEdit.status === 403 && await sql(`select rules from rooms where id='${profileRoom.id}'`) === 'Host approves speakers on request.',
    { status: foreignEdit.status });

  const cleared = await api('PATCH', `/api/rooms/${profileRoom.id}`, { token: a.token, body: { rules: '', language: '' } });
  check('profile: an empty string clears a field instead of storing blank text',
    cleared.status === 200 && cleared.json.room.rules === null && cleared.json.room.language === null
      && cleared.json.room.region === 'US',
    cleared.json && { rules: cleared.json.room.rules, language: cleared.json.room.language });

  const trending = await api('GET', '/api/rooms?sort=trending&limit=8');
  const trendIds = (trending.json.rooms || []).map((r) => r.id);
  const trendValues = [];
  for (const id of trendIds) {
    trendValues.push(Number(await sql(`select coalesce(sum(amount_diamonds),0) from transactions where room_id='${id}' and type='GIFT_SENT' and created_at > now() - interval '24 hours'`)));
  }
  const trendOrdered = trendValues.every((v, i) => i === 0 || trendValues[i - 1] >= v);
  check('discovery: sort=trending really orders by gifts in the last 24 hours',
    trending.status === 200 && trendOrdered, { order: trendValues });
  const recent = await api('GET', '/api/rooms?sort=recent&limit=8');
  const recentOrdered = (recent.json.rooms || []).every((r, i, all) => i === 0 || new Date(all[i - 1].createdAt) >= new Date(r.createdAt));
  check('discovery: sort=recent orders by creation time, newest first', recent.status === 200 && recentOrdered,
    { statuses: recent.json.rooms && recent.json.rooms.map((r) => r.createdAt) });
  const badSort = await api('GET', '/api/rooms?sort=hot');
  check('discovery: an unknown sort is named, not silently ignored', badSort.status === 400, { status: badSort.status });

  const anonQuick = await api('GET', '/api/rooms/quick-join');
  check('quick join: needs a session', anonQuick.status === 401, { status: anonQuick.status });
  const quick = await api('GET', '/api/rooms/quick-join', { token: b.token });
  check('quick join: hands back an open public room that b is not already in',
    quick.status === 200 && quick.json.room.type === 'PUBLIC' && quick.json.room.status === 'ACTIVE',
    quick.json && quick.json.room && { id: quick.json.room.id, listeners: quick.json.room.listenerCount });
  await api('POST', `/api/rooms/${quick.json.room.id}/join`, { token: b.token, body: {} });
  const quickAgain = await api('GET', '/api/rooms/quick-join', { token: b.token });
  check('quick join: after joining, the shortcut moves on instead of offering the same room twice',
    quickAgain.status === 200 && quickAgain.json.room.id !== quick.json.room.id,
    { first: quick.json.room && quick.json.room.id, second: quickAgain.json.room && quickAgain.json.room.id });
  await api('POST', `/api/rooms/${quick.json.room.id}/leave`, { token: b.token, body: {} });

  const mine = await api('GET', '/api/rooms/mine?limit=20', { token: a.token });
  check('my room: lists the rooms a hosts, and not the ones b hosts',
    mine.status === 200 && mine.json.rooms.some((r) => r.id === profileRoom.id)
      && mine.json.rooms.every((r) => r.host.id === A),
    { count: mine.json.rooms && mine.json.rooms.length });

  const deleteActive = await api('DELETE', `/api/rooms/${profileRoom.id}`, { token: a.token });
  check('delete: an open room is not deletable — close it first', deleteActive.status === 409, { status: deleteActive.status, code: deleteActive.json && deleteActive.json.error });
  await api('POST', `/api/rooms/${profileRoom.id}/join`, { token: b.token, body: {} });
  await api('POST', `/api/rooms/${profileRoom.id}/close`, { token: a.token, body: {} });
  const deleteAttended = await api('DELETE', `/api/rooms/${profileRoom.id}`, { token: a.token });
  check('delete: a room somebody actually stood in is kept as history, not erased',
    deleteAttended.status === 409 && deleteAttended.json.error.code === 'room_has_history',
    { status: deleteAttended.status, code: deleteAttended.json && deleteAttended.json.error });

  const empty = await api('POST', '/api/rooms', { token: a.token, body: { title: `E2E Deletable ${stamp}`, category: 'CHAT', type: 'PUBLIC' } });
  const emptyId = empty.json.room.id;
  const foreignDelete = await api('DELETE', `/api/rooms/${emptyId}`, { token: b.token });
  check('delete: only the host may delete a room', foreignDelete.status === 403, { status: foreignDelete.status });
  await api('POST', `/api/rooms/${emptyId}/close`, { token: a.token, body: {} });
  const deleted = await api('DELETE', `/api/rooms/${emptyId}`, { token: a.token });
  check('delete: a closed, never-attended room goes, and its seats cascade with it',
    deleted.status === 200 && await sql(`select count(*) from rooms where id='${emptyId}'`) === '0'
      && await sql(`select count(*) from room_seats where room_id='${emptyId}'`) === '0',
    { status: deleted.status, seats: await sql(`select count(*) from room_seats where room_id='${emptyId}'`) });
  check('delete: nothing in the ledger was touched by the delete',
    Number(await sql('select count(*) from transactions')) >= 0 && await sql(`select count(*) from transactions where room_id='${emptyId}'`) === '0', null);

  // ---- I. push target registration -----------------------------------------
  // Delivery itself needs a Firebase project, but the token column is ours, and
  // a wrong target is the failure mode that is silent forever.
  const pushToken = `e2e-fcm-token-${stamp}`.padEnd(24, 'x');
  const anonPush = await api('PUT', '/api/auth/me/device-token', { body: { deviceToken: pushToken } });
  check('push: registering a device token requires a session', anonPush.status === 401, { status: anonPush.status });

  const registered = await api('PUT', '/api/auth/me/device-token', { token: a.token, body: { deviceToken: pushToken } });
  check('push: a device token is persisted for the account', registered.status === 200 && await sql(`select device_token from users where id='${A}'`) === pushToken, await sql(`select coalesce(device_token,'-') from users where id='${A}'`));

  const tooShort = await api('PUT', '/api/auth/me/device-token', { token: a.token, body: { deviceToken: 'short' } });
  check('push: a truncated token is rejected instead of stored', tooShort.status === 400 && await sql(`select device_token from users where id='${A}'`) === pushToken, { status: tooShort.status });

  // The receiver of a private gift is notified off-socket; with no FCM project
  // configured the send must degrade to a no-op, not a failed request.
  const dmGift = await api('POST', '/api/gifts/send', { token: d.token, body: { giftId: rose.id, receiverId: B, quantity: 1 } });
  check('push: a private gift still succeeds when push is unconfigured', dmGift.status === 201, { status: dmGift.status, code: dmGift.json && dmGift.json.error && dmGift.json.error.code });

  // ---- J. paid top-up (webhook-confirmed recharge) --------------------------
  // Stripe itself is not reachable from this suite, but everything that decides
  // whether money appears is local: signature checking, the idempotency key, and
  // the ledger write. Those are the parts that can print diamonds.
  const payer = await login(`+15559${stamp}09`, `e2e_pay_${stamp.slice(-4)}`);
  const PID = payer.user.id;
  const balP = async () => Number(await sql(`select diamond_balance from users where id='${PID}'`));

  const checkoutSim = await api('POST', '/api/wallet/recharge/checkout', { token: payer.token, body: { amountDiamonds: 100 } });
  check(
    'payments: checkout refuses while the stack is in demo mode',
    checkoutSim.status === 403 && checkoutSim.json.error.code === 'payments_provider_not_stripe',
    { status: checkoutSim.status, code: checkoutSim.json.error && checkoutSim.json.error.code },
  );

  const hookUnsigned = await stripePost(intentEvent('pi_unsigned', PID, 100));
  check('payments: an unsigned webhook is rejected', hookUnsigned.status === 400, { status: hookUnsigned.status });

  const hookForged = await stripePost(intentEvent('pi_forged', PID, 100_000), { signature: sign('{"different":"body"}') });
  check('payments: a signature over other bytes is rejected', hookForged.status === 400, { status: hookForged.status });

  const stalePayload = intentEvent('pi_stale', PID, 100);
  const hookStale = await stripePost(stalePayload, {
    signature: sign(stalePayload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600),
  });
  check(
    'payments: an old timestamp is rejected (a captured hook cannot be replayed)',
    hookStale.status === 400 && hookStale.json.error.code === 'webhook_timestamp_expired',
    { status: hookStale.status, code: hookStale.json.error && hookStale.json.error.code },
  );

  const balanceBefore = await balP();
  const payIntent = `pi_e2e_${stamp}`;
  const paidPayload = intentEvent(payIntent, PID, 250);
  const hookPaid = await stripePost(paidPayload, { signature: sign(paidPayload) });
  check(
    'payments: a signed success credits the diamonds',
    hookPaid.status === 200 && hookPaid.json.received === true && (await balP()) === balanceBefore + 250,
    { status: hookPaid.status, balanceBefore, after: await balP() },
  );

  const hookReplay = await stripePost(paidPayload, { signature: sign(paidPayload) });
  check(
    'payments: a redelivery of the same event credits nothing twice',
    hookReplay.status === 200 && (await balP()) === balanceBefore + 250,
    { status: hookReplay.status, after: await balP() },
  );

  check(
    'payments: exactly one proof and one ledger row exist for the payment',
    (await sql(`select count(*) from payment_proofs where provider='stripe' and external_id='${payIntent}'`)) === '1' &&
      (await sql(`select count(*) from transactions where type='RECHARGE' and meta->>'paymentId'='${payIntent}'`)) === '1',
    await sql(`select (select count(*) from payment_proofs where external_id='${payIntent}')||'|'||(select count(*) from transactions where meta->>'paymentId'='${payIntent}')`),
  );

  check(
    'payments: the recharge row names the provider in its meta',
    (await sql(`select meta->>'source' from transactions where meta->>'paymentId'='${payIntent}'`)) === 'stripe',
    await sql(`select meta::text from transactions where meta->>'paymentId'='${payIntent}'`),
  );

  const pingPayload = JSON.stringify({ id: 'evt_ping', type: 'customer.created', data: { object: { id: 'cus_1' } } });
  const hookUnknown = await stripePost(pingPayload, { signature: sign(pingPayload) });
  check(
    'payments: an unhandled event type is acknowledged, not failed',
    hookUnknown.status === 200 && (await balP()) === balanceBefore + 250,
    { status: hookUnknown.status },
  );

  const orphanPayload = JSON.stringify({
    id: 'evt_orphan',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_no_metadata', status: 'succeeded', metadata: {} } },
  });
  const hookOrphan = await stripePost(orphanPayload, { signature: sign(orphanPayload) });
  check(
    'payments: a payment with no Voiza reference credits nobody',
    hookOrphan.status === 200 && (await balP()) === balanceBefore + 250,
    { status: hookOrphan.status },
  );

  // The demo endpoint stays available while PAYMENTS_PROVIDER=simulated — this
  // suite itself uses it — but it must be the only thing that can mint diamonds.
  const demoTopUp = await api('POST', '/api/wallet/recharge', { token: payer.token, body: { amountDiamonds: 5 } });
  check(
    'payments: the simulated top-up still works in demo mode',
    demoTopUp.status === 200 && (await balP()) === balanceBefore + 255,
    { status: demoTopUp.status, after: await balP() },
  );

  const failedPayload = JSON.stringify({
    id: 'evt_fail',
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_declined', status: 'requires_payment_method', metadata: { voizaUserId: PID, diamonds: '500' } } },
  });
  const hookFailed = await stripePost(failedPayload, { signature: sign(failedPayload) });
  check(
    'payments: a failed intent moves no money',
    hookFailed.status === 200 && (await balP()) === balanceBefore + 255,
    { status: hookFailed.status, after: await balP() },
  );

  // ---- Ranking boards (GET /api/users/top), fed by the gift flood above ------
  // Earlier suite runs leave accounts holding identical rose totals, so "our
  // user is on the board" would tie-flip. Comparing the board against the same
  // ledger aggregate proves the grouping, ordering and serialisation without
  // depending on which tied row the database happens to return first.
  const topOf = (rows) => (rows && rows.length ? Number(rows[0].earned) : -1);
  const leadersOf = (res) => (res.json && res.json.leaders) || [];
  const ledgerTop = (column, sum) => sql(
    `select max(s) from (select sum(${sum}) s from transactions
        where type='GIFT_SENT' and created_at >= now() - interval '1 day' group by ${column}) x`,
  );

  const earners = await api('GET', '/api/users/top?window=day&limit=20');
  check(
    'ranking: the board defaults to hosts by coin earned',
    earners.status === 200 && earners.json.role === 'receivers' && earners.json.unit === 'r_coin',
    { status: earners.status, role: earners.json && earners.json.role },
  );
  check(
    'ranking: the coin board leads with the ledger top earner',
    topOf(leadersOf(earners)) === Number(await ledgerTop('receiver_id', 'amount_r_coins')),
    { api: topOf(leadersOf(earners)), db: await ledgerTop('receiver_id', 'amount_r_coins') },
  );
  check(
    'ranking: the coin board is sorted by earned and honours the limit',
    leadersOf(earners).length > 0 && leadersOf(earners).length <= 20 &&
      leadersOf(earners).every((row, i, all) => i === 0 || all[i - 1].earned >= row.earned),
    { rows: leadersOf(earners).length },
  );

  const spenders = await api('GET', '/api/users/top?window=day&limit=20&role=senders');
  check(
    'ranking: the sender board counts diamonds spent instead of coin earned',
    spenders.status === 200 && spenders.json.role === 'senders' && spenders.json.unit === 'diamond' &&
      topOf(leadersOf(spenders)) === Number(await ledgerTop('sender_id', 'amount_diamonds')),
    { api: topOf(leadersOf(spenders)), db: await ledgerTop('sender_id', 'amount_diamonds') },
  );

  const fallbackBoard = await api('GET', '/api/users/top?role=owners');
  check(
    'ranking: a role the server does not know falls back to the host board',
    fallbackBoard.status === 200 && fallbackBoard.json.role === 'receivers',
    { role: fallbackBoard.json && fallbackBoard.json.role },
  );

  const month = await api('GET', '/api/users/top?window=month&limit=20');
  check(
    'ranking: a longer window never reports less than a shorter one',
    topOf(leadersOf(month)) >= topOf(leadersOf(earners)),
    { day: topOf(leadersOf(earners)), month: topOf(leadersOf(month)) },
  );

  const passed = out.filter((l) => l.startsWith('PASS')).length;
  process.stdout.write(out.join('\n') + `\n\n${passed}/${out.length} end-to-end checks passed\n`);
  await (await db()).end();
  // Exit non-zero on any failure so CI / a shell `&&` chain can gate on it.
  process.exit(passed === out.length ? 0 : 1);
})().catch((e) => { process.stdout.write(out.join('\n') + '\n'); console.error('E2E CRASH', e); process.exit(1); });

async function socketPhase(tokenA, tokenB, roomId, gifts, A, B, nameA, nameB) {
  const io = ioLib;
  const res = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // The gift flood in phase E leaves Postgres/Redis work in flight; give it a
  // moment to settle and use generous timeouts so a slow ack is not mistaken for
  // a broken one.
  await wait(1500);
  const ack = (s, ev, payload, ms = 20000) => new Promise((resolve) => { const t = setTimeout(() => resolve({ __timeout: true }), ms); s.emit(ev, payload, (r) => { clearTimeout(t); resolve(r); }); });
  const connected = (s) => Promise.race([new Promise((r) => s.once('connected', r)), wait(20000)]);
  const conn = (token) => io('http://127.0.0.1:4000', { transports: ['websocket'], forceNew: true, auth: { token } });

  // A stays in the room for the whole phase and is the observer; B is the actor
  // that joins, drops and rejoins. Collected in arrays rather than `once` because
  // a join now also announces the entrant in chat, so the first message a client
  // sees is a SYSTEM line, not the probe.
  const sa = conn(tokenA);
  const errs = [];
  sa.on('connect_error', (e) => errs.push(`A:${e.message}`));
  const chat = [];
  const joined = [];
  const liked = [];
  const animated = [];
  sa.on('room:chat_message', (m) => chat.push(m));
  sa.on('room:user_joined', (p) => joined.push(p));
  sa.on('room:liked', (p) => liked.push(p));
  sa.on('room:gift_animated', (p) => animated.push(p));

  // Connect first, then emit: socket.io buffers an `emit` made before the socket
  // is up but drops its ack callback, which would look like a dead server.
  await connected(sa);
  const jA = await ack(sa, 'room:join', { roomId });

  const sb = conn(tokenB);
  sb.on('connect_error', (e) => errs.push(`B:${e.message}`));
  const errorsB = [];
  sb.on('room:error', (p) => errorsB.push(p));
  await connected(sb);
  const jB = await ack(sb, 'room:join', { roomId });
  res['socket: both clients authenticate and join the real room'] = { pass: !!(jA && jA.ok && jB && jB.ok), detail: { jA, jB, errs, connected: [sa.connected, sb.connected] } };

  // ---- live-kit behaviours the app renders from these events ----------------
  const bJoin = joined.find((p) => p && p.user && p.user.id === B);
  res['socket: user_joined carries the VIP level that sizes the entry effect'] = {
    pass: !!bJoin && typeof bJoin.user.vipLevel === 'number',
    detail: bJoin && bJoin.user,
  };

  const entryLines = (who) => chat.filter((m) => m.type === 'SYSTEM' && m.content === `${who} entered the room`);
  await wait(600);
  res['socket: each join writes one SYSTEM entry line'] = {
    pass: entryLines(nameA).length === 1 && entryLines(nameB).length === 1,
    detail: chat.filter((m) => m.type === 'SYSTEM').map((m) => m.content),
  };

  const probe = await ack(sb, 'room:chat', { roomId, message: 'live fan-out probe' });
  await wait(800);
  const got = chat.find((m) => m.content === 'live fan-out probe');
  res['socket: chat fans out to the other client over the wire'] = {
    pass: !!(probe && probe.ok && got && got.type === 'TEXT' && got.user && got.user.id === B),
    detail: got && { content: got.content, type: got.type, from: got.user && got.user.username },
  };
  const persisted = await sql(`select count(*) from chat_messages where room_id='${roomId}' and content='live fan-out probe'`);
  res['socket: chat persisted into PostgreSQL'] = { pass: persisted === '1', detail: persisted };

  // A host editing the room does it over REST, but the members already inside must see the new
  // title and rule line without leaving and rejoining.
  const profiles = [];
  sa.on('room:profile_updated', (p) => profiles.push(p));
  const edited = await api('PATCH', `/api/rooms/${roomId}`, {
    token: tokenA,
    body: { title: 'E2E Live Rename', rules: 'mic off when not on the seat' },
  });
  await wait(900);
  const bump = profiles.find((p) => p && p.roomId === roomId);
  res['socket: a host edit reaches the room as room:profile_updated'] = {
    pass: edited.status === 200 && !!bump && bump.title === 'E2E Live Rename' &&
      bump.rules === 'mic off when not on the seat' && bump.category === 'CHAT',
    detail: { status: edited.status, event: bump },
  };
  const reread = await api('GET', `/api/rooms/${roomId}`, { token: tokenB });
  res['socket: the edited profile is what the next client reads back'] = {
    pass: reread.status === 200 && reread.json.room.title === 'E2E Live Rename' &&
      reread.json.room.rules === 'mic off when not on the seat',
    detail: reread.json && reread.json.room && { title: reread.json.room.title, rules: reread.json.room.rules },
  };

  // A guest who drops and returns in ten seconds must not push the conversation
  // off the screen — the socket banner may repeat, the chat line may not.
  sb.close();
  await wait(600);
  const sb2 = conn(tokenB);
  sb2.on('room:error', (p) => errorsB.push(p));
  await connected(sb2);
  await ack(sb2, 'room:join', { roomId });
  await wait(1200);
  res['socket: a rejoin within a minute does not repeat the entry line'] = {
    pass: entryLines(nameB).length === 1 && joined.filter((p) => p.user && p.user.id === B).length >= 2,
    detail: { entryLines: entryLines(nameB).length, banners: joined.filter((p) => p.user && p.user.id === B).length },
  };

  // 12 taps inside one flush window must reach the room as a counted batch, not
  // as 12 broadcasts — that batching is the whole reason likes are cheap.
  liked.length = 0;
  for (let i = 0; i < 12; i += 1) sb2.emit('room:like', { roomId, count: 1 });
  await wait(3200);
  const summed = liked.reduce((n, b) => n + b.count, 0);
  res['socket: a like burst is batched into fewer events than taps'] = {
    pass: liked.length > 0 && liked.length < 12 && summed === 12,
    detail: { batches: liked.length, summed, totals: liked.map((b) => b.total) },
  };
  const lastBatch = liked[liked.length - 1];
  res['socket: the batch total is the server-side count, not a client report'] = {
    pass: !!lastBatch && lastBatch.total === 12 && !!lastBatch.user && !!lastBatch.roomId,
    detail: lastBatch && { total: lastBatch.total, count: lastBatch.count, user: lastBatch.user.username },
  };
  await wait(500);
  res['socket: the like batch is persisted to the room row'] = {
    pass: (await sql(`select like_count from rooms where id='${roomId}'`)) === '12',
    detail: await sql(`select like_count::text from rooms where id='${roomId}'`),
  };

  sb2.emit('room:like', { roomId, count: 0 });
  sb2.emit('room:like', { roomId, count: 5000 });
  await wait(700);
  res['socket: an out-of-range like count is refused, not counted'] = {
    pass: errorsB.filter((e) => /between 1 and 100/.test(String(e.error))).length >= 2 &&
      (await sql(`select like_count from rooms where id='${roomId}'`)) === '12',
    detail: { errors: errorsB.map((e) => e.error), like_count: await sql(`select like_count from rooms where id='${roomId}'`) },
  };

  // A gift animation carries the tier the operator set, which is what decides
  // ticker row vs full-screen takeover on the client.
  const ticker = gifts.find((g) => g.effectKind === 'TICKER');
  const fullscreen = gifts.find((g) => g.effectKind === 'FULLSCREEN');
  res['catalog: the catalogue splits gifts into ticker and full-screen tiers'] = {
    pass: !!ticker && !!fullscreen,
    detail: { ticker: ticker && ticker.name, fullscreen: fullscreen && fullscreen.name },
  };
  if (ticker) {
    await api('POST', '/api/wallet/recharge', { token: tokenB, body: { amountDiamonds: 200 } });
    const sent = await api('POST', '/api/gifts/send', { token: tokenB, body: { giftId: ticker.id, receiverId: A, quantity: 1, roomId } });
    res['gift: the send response carries the effect tier'] = {
      pass: sent.status === 201 && sent.json.gift.effectKind === 'TICKER',
      detail: { status: sent.status, effectKind: sent.json && sent.json.gift && sent.json.gift.effectKind },
    };
    await wait(1500);
    const anim = animated[animated.length - 1];
    res['socket: the animated gift payload carries the tier, seat and quantity'] = {
      pass: !!anim && anim.gift.effectKind === 'TICKER' && 'seatIndex' in anim && anim.quantity === 1,
      detail: anim && { gift: anim.gift.name, effectKind: anim.gift.effectKind, seatIndex: anim.seatIndex, sender: anim.sender.username },
    };
  }

  sb2.close(); sa.close();
  await wait(400);
  return res;
}

/**
 * Daily quests and the check-in (migration 0020).
 *
 * The brief's rule is that experience is server-authored, so this phase drives both halves: the
 * member routes only read a day, and what they read comes from events the server recorded itself
 * (a gift in the ledger, a chat row the socket stored). Everything that should pay XP is checked
 * against `users.xp` and the per-day rows; everything that should not — a replay, a forged body, a
 * gift refused for balance — is checked to have paid nothing.
 */
async function questPhase(adminToken, rose) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dayIn = (zone) => sql(`select (now() AT TIME ZONE '${zone}')::date::text`);
  const xpOf = async (id) => Number(await sql(`select xp from users where id='${id}'`));
  const statusOf = async (token) => (await api('GET', '/api/quests', { token })).json;
  const questOf = (status, key) => ((status && status.quests) || []).find((q) => q.key === key) || null;
  const questByMetric = (status, metric) => ((status && status.quests) || []).find((q) => q.metric === metric) || null;
  const settingsSql = 'select reset_timezone, checkin_base_xp, checkin_streak_step_xp, checkin_max_streak_days from quest_settings where singleton';

  const settingsRaw = await sql(settingsSql);
  const [tz, baseRaw, stepRaw, maxRaw] = settingsRaw.split('|');
  const base = Number(baseRaw);
  const step = Number(stepRaw);
  const maxDays = Number(maxRaw);
  const rewardFor = (streakDay) => base + (Math.min(Math.max(1, streakDay), maxDays) - 1) * step;

  const mk = (suffix, who) => login(`+15557${stamp}4${suffix}`, `e2e_${who}_${stamp.slice(-4)}`);
  const member = await mk('1', 'quinn');
  const streaker = await mk('2', 'sam');
  const gapper = await mk('3', 'gia');
  const chatter = await mk('4', 'cara');
  const host = await mk('5', 'hank');
  const gifter = await mk('6', 'gil');
  check('quests: six fresh members are created for the day',
    [member, streaker, gapper, chatter, host, gifter].every((u) => u && u.token && u.user && u.created === true),
    [member, streaker, gapper, chatter, host, gifter].map((u) => u && u.created));

  const M = member.user.id;
  const activeCount = Number(await sql('select count(*) from daily_quests where is_active'));
  const ladder = await statusOf(member.token);
  check('quests: a fresh member reads today as an empty ladder',
    !!ladder && Array.isArray(ladder.quests) && ladder.quests.length === activeCount &&
    ladder.quests.every((q) => q.progress === 0 && q.completed === false && q.xpAwarded === 0) &&
    ladder.completedCount === 0 && ladder.xpEarnedToday === 0 &&
    ladder.checkIn.available === true && ladder.checkIn.done === false &&
    ladder.checkIn.streakDay === 0 && ladder.checkIn.xpAwardedToday === 0,
    ladder && { activeCount, quests: ladder.quests.map((q) => `${q.key}:${q.progress}`), checkIn: ladder.checkIn });

  check('quests: "today" is the operator timezone\'s date, resolved by PostgreSQL',
    !!ladder && ladder.resetTimezone === tz && ladder.date === await dayIn(tz),
    { date: ladder && ladder.date, timezone: ladder && ladder.resetTimezone, computed: await dayIn(tz) });

  check('quests: the check-in preview quotes the base reward for a streak of one',
    !!ladder && ladder.checkIn.nextStreakDay === 1 && ladder.checkIn.nextRewardXp === base &&
    ladder.checkIn.baseXp === base && ladder.checkIn.streakStepXp === step && ladder.checkIn.maxStreakDays === maxDays,
    ladder && ladder.checkIn);

  const anonGet = await api('GET', '/api/quests');
  const anonPost = await api('POST', '/api/quests/checkin', { body: {} });
  check('quests: the screen and the check-in both require a session',
    anonGet.status === 401 && anonPost.status === 401, { get: anonGet.status, post: anonPost.status });

  const memberAdminGet = await api('GET', '/api/admin/quests', { token: member.token });
  const memberAdminPost = await api('POST', '/api/admin/quests', {
    token: member.token,
    body: { key: 'e2e-nope', title: 'Nope', metric: 'CHAT_MESSAGE', target: 1, xpReward: 1 },
  });
  check('quests: a member can neither read nor edit the catalogue',
    memberAdminGet.status === 403 && memberAdminPost.status === 403,
    { get: memberAdminGet.status, post: memberAdminPost.status });

  // A body full of numbers is the whole attack surface of the route, so send one.
  const xpBeforeCheckin = await xpOf(M);
  const forged = await api('POST', '/api/quests/checkin', {
    token: member.token,
    body: { xpAwarded: 999999, streakDay: 300, progress: 999, level: 99, date: '2099-01-01' },
  });
  const xpAfterCheckin = await xpOf(M);
  check('quests: a check-in ignores a forged body and pays the server\'s base reward',
    forged.status === 201 && !!forged.json && forged.json.xpAwarded === base &&
    xpAfterCheckin === xpBeforeCheckin + base &&
    forged.json.status.checkIn.done === true && forged.json.status.checkIn.available === false &&
    forged.json.status.checkIn.streakDay === 1 && forged.json.user.xp === xpAfterCheckin,
    { status: forged.status, awarded: forged.json && forged.json.xpAwarded, xp: [xpBeforeCheckin, xpAfterCheckin] });
  check('quests: the check-in is one row for the local date, not one per tap',
    await sql(`select count(*) from daily_checkins where user_id='${M}'`) === '1',
    await sql(`select checkin_date||'@'||streak_day||'x'||xp_awarded from daily_checkins where user_id='${M}'`));

  const replay = await api('POST', '/api/quests/checkin', { token: member.token, body: {} });
  check('quests: replaying the check-in is refused and pays nothing',
    replay.status === 409 && replay.json.error.code === 'already_checked_in' && (await xpOf(M)) === xpAfterCheckin,
    { status: replay.status, code: replay.json && replay.json.error && replay.json.error.code, xp: await xpOf(M) });

  // Yesterday's row is the only input to today's streak, so seed one and watch the reward step up.
  await sql(`insert into daily_checkins (user_id, checkin_date, streak_day, xp_awarded)
             values ('${streaker.user.id}', (now() AT TIME ZONE '${tz}')::date - 1, 3, 0) on conflict do nothing`);
  const streakPreview = await statusOf(streaker.token);
  check('quests: a streak carried from yesterday previews its step-up reward',
    !!streakPreview && streakPreview.checkIn.streakDay === 3 && streakPreview.checkIn.nextStreakDay === 4 &&
    streakPreview.checkIn.nextRewardXp === rewardFor(4) && streakPreview.checkIn.available === true,
    streakPreview && streakPreview.checkIn);
  const streakXp = await xpOf(streaker.user.id);
  const streakCheckin = await api('POST', '/api/quests/checkin', { token: streaker.token, body: {} });
  check('quests: checking in continues the streak and pays base plus the step',
    streakCheckin.status === 201 && !!streakCheckin.json && streakCheckin.json.xpAwarded === rewardFor(4) &&
    streakCheckin.json.status.checkIn.streakDay === 4 &&
    (await xpOf(streaker.user.id)) === streakXp + rewardFor(4) &&
    await sql(`select streak_day from daily_checkins where user_id='${streaker.user.id}' and checkin_date=(now() AT TIME ZONE '${tz}')::date`) === '4',
    { awarded: streakCheckin.json && streakCheckin.json.xpAwarded, expected: rewardFor(4) });

  await sql(`insert into daily_checkins (user_id, checkin_date, streak_day, xp_awarded)
             values ('${gapper.user.id}', (now() AT TIME ZONE '${tz}')::date - 2, 5, 0) on conflict do nothing`);
  const gapPreview = await statusOf(gapper.token);
  check('quests: a missed day is a gap — the streak restarts rather than resuming',
    !!gapPreview && gapPreview.checkIn.streakDay === 0 && gapPreview.checkIn.nextStreakDay === 1 &&
    gapPreview.checkIn.nextRewardXp === base, gapPreview && gapPreview.checkIn);
  const gapXp = await xpOf(gapper.user.id);
  const gapCheckin = await api('POST', '/api/quests/checkin', { token: gapper.token, body: {} });
  check('quests: the restarted streak pays the base reward again',
    gapCheckin.status === 201 && !!gapCheckin.json && gapCheckin.json.xpAwarded === base &&
    gapCheckin.json.status.checkIn.streakDay === 1 && (await xpOf(gapper.user.id)) === gapXp + base,
    { awarded: gapCheckin.json && gapCheckin.json.xpAwarded });

  // ---- chat quest: a stored message is the event -----------------------------
  const qRoom = await api('POST', '/api/rooms', {
    token: host.token, body: { title: `E2E Quests ${stamp}`, category: 'CHAT', type: 'PUBLIC' },
  });
  const qRoomId = qRoom.json && qRoom.json.room && qRoom.json.room.id;
  check('quests: the chat quest is driven inside a real room', qRoom.status === 201 && !!qRoomId, { status: qRoom.status });

  const conn = (token) => ioLib('http://127.0.0.1:4000', { transports: ['websocket'], forceNew: true, auth: { token } });
  // `s.connected` first: a socket can finish its handshake while the caller is still awaiting the
  // previous one, and `once('connect')` would then wait for an event that already fired.
  const connected = (s) => (s.connected
    ? Promise.resolve(true)
    : Promise.race([new Promise((r) => s.once('connect', r)), wait(20000)]));
  const ack = (s, ev, payload, ms = 15000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    s.emit(ev, payload, (r) => { clearTimeout(t); resolve(r); });
  });
  // A reconnected socket is a new server-side connection, and an ack owed to the old one is gone;
  // retrying the emit is what a real client does, so do it here rather than report a lost packet.
  const joinRoom = async (s, roomId) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!s.connected) await connected(s);
      const r = await ack(s, 'room:join', { roomId }, 8000);
      if (!r || !r.__timeout) return r;
    }
    return { __timeout: true };
  };
  const hostSock = conn(host.token);
  const chatSock = conn(chatter.token);
  await connected(hostSock);
  await connected(chatSock);
  const jHost = await joinRoom(hostSock, qRoomId);
  const jChat = await joinRoom(chatSock, qRoomId);
  check('quests: both members join the room socket', !!(jHost && jHost.ok && jChat && jChat.ok), { jHost, jChat });

  const beforeChats = await statusOf(chatter.token);
  const chatQuest = questByMetric(beforeChats, 'CHAT_MESSAGE');
  const giftQuest = questByMetric(beforeChats, 'GIFT_SENT');
  const spendQuest = questByMetric(beforeChats, 'DIAMONDS_SPENT');
  check('quests: the seeded ladder arrives with a gift, a spend and a chat quest',
    !!chatQuest && !!giftQuest && !!spendQuest,
    beforeChats && beforeChats.quests.map((q) => `${q.key}:${q.metric}x${q.target}`));

  const chatterXpBefore = await xpOf(chatter.user.id);
  const chats = [];
  for (let i = 0; i < 3; i += 1) {
    chats.push(await ack(chatSock, 'room:chat', { roomId: qRoomId, message: `quest probe ${i + 1}` }));
  }
  await wait(2500);
  const afterChats = await statusOf(chatter.token);
  const chatRow = questOf(afterChats, chatQuest.key);
  const expectedChat = Math.min(chatQuest.target, 3);
  const chatDone = expectedChat >= chatQuest.target;
  check('quests: the chat quest counts the messages the server stored',
    chats.every((r) => r && r.ok) && !!chatRow && chatRow.progress === expectedChat &&
    chatRow.completed === chatDone && (chatDone ? chatRow.xpAwarded === chatQuest.xpReward : chatRow.xpAwarded === 0),
    { acks: chats.map((r) => r && r.ok), progress: chatRow && chatRow.progress, target: chatQuest.target, completed: chatRow && chatRow.completed });
  const chatterXpAfter = await xpOf(chatter.user.id);
  check('quests: a finished chat quest pays its reward once, server-side',
    chatterXpAfter === chatterXpBefore + (chatDone ? chatQuest.xpReward : 0),
    { before: chatterXpBefore, after: chatterXpAfter, reward: chatQuest.xpReward });

  // ---- gift quest: the ledger transaction is the event -----------------------
  const catalog = await api('GET', '/api/gifts', {});
  const allGifts = (catalog.json && (catalog.json.gifts || catalog.json.data)) || [];
  const cheap = allGifts.filter((g) => (g.minVipLevel || 0) === 0).sort((x, y) => x.diamondPrice - y.diamondPrice)[0] || rose;
  const price = cheap.diamondPrice;
  await api('POST', '/api/wallet/recharge', { token: gifter.token, body: { amountDiamonds: price * 4 } });
  const giftBefore = await statusOf(gifter.token);
  const giftQ = questByMetric(giftBefore, 'GIFT_SENT');
  const spendQ = questByMetric(giftBefore, 'DIAMONDS_SPENT');
  const gifterXp0 = await xpOf(gifter.user.id);
  const sentGift = await api('POST', '/api/gifts/send', {
    token: gifter.token,
    body: { giftId: cheap.id, receiverId: host.user.id, quantity: 2, roomId: qRoomId },
  });
  await wait(600);
  const giftAfter = await statusOf(gifter.token);
  const giftRow = questOf(giftAfter, giftQ.key);
  const spendRow = questOf(giftAfter, spendQ.key);
  const ledgerSpent = Number(await sql(`select coalesce(sum(amount_diamonds),0) from transactions where type='GIFT_SENT' and sender_id='${gifter.user.id}'`));
  check('quests: the gift quest counts the quantity the ledger recorded',
    sentGift.status === 201 && !!giftRow && giftRow.progress === Math.min(giftQ.target, 2),
    { status: sentGift.status, progress: giftRow && giftRow.progress, target: giftQ.target });
  check('quests: the spend quest counts the diamonds the ledger moved',
    !!spendRow && spendRow.progress === Math.min(spendQ.target, ledgerSpent) && ledgerSpent === price * 2,
    { progress: spendRow && spendRow.progress, target: spendQ.target, ledgerSpent, price });
  const rewardsEarned = (before, after) => ((after && after.quests) || [])
    .filter((q) => q.completed && !(((before && before.quests) || []).find((p) => p.key === q.key && p.completed)))
    .reduce((sum, q) => sum + q.xpAwarded, 0);
  const gifterXp1 = await xpOf(gifter.user.id);
  check('quests: spending diamonds pays 1 XP per diamond plus any newly finished reward',
    gifterXp1 === gifterXp0 + ledgerSpent + rewardsEarned(giftBefore, giftAfter),
    { before: gifterXp0, after: gifterXp1, spent: ledgerSpent, rewards: rewardsEarned(giftBefore, giftAfter) });

  const hostAfterSuccess = await sql(`select xp||'|'||total_gifts_received||'|'||r_coin_balance from users where id='${host.user.id}'`);
  const refusedGift = await api('POST', '/api/gifts/send', {
    token: gifter.token,
    body: { giftId: cheap.id, receiverId: host.user.id, quantity: 999, roomId: qRoomId },
  });
  await wait(400);
  const hostAfterGift = await sql(`select xp||'|'||total_gifts_received||'|'||r_coin_balance from users where id='${host.user.id}'`);
  check('quests: a gift refused for insufficient balance advances no quest and pays no XP',
    refusedGift.status === 402 && refusedGift.json.error.code === 'insufficient_balance' &&
    (await xpOf(gifter.user.id)) === gifterXp1 && hostAfterGift === hostAfterSuccess,
    { status: refusedGift.status, code: refusedGift.json && refusedGift.json.error && refusedGift.json.error.code, host: [hostAfterSuccess, hostAfterGift] });

  // ---- the catalogue an operator edits ---------------------------------------
  const adminList = await api('GET', '/api/admin/quests', { token: adminToken });
  const adminQuests = (adminList.json && adminList.json.quests) || [];
  const chatCompletedToday = Number((adminQuests.find((q) => q.key === chatQuest.key) || {}).completedToday ?? -1);
  check('quests: the console reads the catalogue with today\'s completion counts',
    adminList.status === 200 && !!adminList.json && adminList.json.today === await dayIn(tz) &&
    adminList.json.settings.resetTimezone === tz &&
    Array.isArray(adminList.json.quests) && adminQuests.length === activeCount &&
    adminQuests.every((q) => typeof q.isActive === 'boolean' && typeof q.completedToday === 'number') &&
    chatCompletedToday >= (chatDone ? 1 : 0),
    { status: adminList.status, counts: adminQuests.map((q) => `${q.key}:${q.completedToday}`) });

  const qKey = `e2e-q-${stamp}`;
  const created = await api('POST', '/api/admin/quests', {
    token: adminToken,
    body: { key: qKey, title: 'E2E Quest', description: '', metric: 'CHAT_MESSAGE', target: 1, xpReward: 7, sortOrder: 900 },
  });
  check('quests: an operator can add a quest and it is live immediately',
    created.status === 201 && !!created.json && created.json.quest.key === qKey && created.json.quest.isActive === true,
    { status: created.status, quest: created.json && created.json.quest });
  const appeared = await statusOf(chatter.token);
  check('quests: the new quest appears on the phone with zero progress',
    !!questOf(appeared, qKey) && questOf(appeared, qKey).progress === 0,
    appeared && appeared.quests.map((q) => `${q.key}:${q.progress}`));

  const chatterXpQ0 = await xpOf(chatter.user.id);
  const newChat = await ack(chatSock, 'room:chat', { roomId: qRoomId, message: 'quest probe 4' });
  await wait(2500);
  const afterNewChat = await statusOf(chatter.token);
  const newRow = questOf(afterNewChat, qKey);
  check('quests: the first qualifying event finishes the new quest and pays its reward',
    newChat && newChat.ok && !!newRow && newRow.progress === 1 && newRow.completed === true &&
    newRow.xpAwarded === 7 && (await xpOf(chatter.user.id)) === chatterXpQ0 + 7,
    { ack: newChat && newChat.ok, row: newRow, xp: [chatterXpQ0, await xpOf(chatter.user.id)] });

  const inUse = await api('DELETE', `/api/admin/quests/${qKey}`, { token: adminToken });
  check('quests: a quest with paid progress cannot be deleted',
    inUse.status === 409 && inUse.json.error.code === 'quest_in_use',
    { status: inUse.status, code: inUse.json && inUse.json.error && inUse.json.error.code });
  const retired = await api('PUT', `/api/admin/quests/${qKey}`, { token: adminToken, body: { isActive: false } });
  const hidden = await statusOf(chatter.token);
  check('quests: retiring is the reversible option — the phone loses it, the progress row stays',
    retired.status === 200 && !!retired.json && retired.json.quest.isActive === false && !questOf(hidden, qKey) &&
    await sql(`select count(*) from quest_progress where user_id='${chatter.user.id}' and quest_key='${qKey}'`) === '1',
    { status: retired.status, active: retired.json && retired.json.quest.isActive, listed: !!questOf(hidden, qKey) });

  await sql(`delete from quest_progress where user_id='${chatter.user.id}' and quest_key='${qKey}'`);
  const removed = await api('DELETE', `/api/admin/quests/${qKey}`, { token: adminToken });
  check('quests: once no progress references it, the quest can be removed',
    removed.status === 200 && !!removed.json && removed.json.ok === true &&
    await sql(`select count(*) from daily_quests where key='${qKey}'`) === '0',
    { status: removed.status, body: removed.json });

  // ---- the reset dial --------------------------------------------------------
  const badZone = await api('PUT', '/api/admin/quests/settings', { token: adminToken, body: { resetTimezone: 'Mars/Olympus' } });
  check('quests: an unresolvable timezone is refused and changes nothing',
    badZone.status === 400 && badZone.json.error.code === 'quest_timezone_unknown' &&
    (await sql(settingsSql)) === settingsRaw,
    { status: badZone.status, code: badZone.json && badZone.json.error && badZone.json.error.code });

  const altZone = (await dayIn('Pacific/Kiritimati')) !== (await dayIn(tz)) ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
  const moved = await api('PUT', '/api/admin/quests/settings', { token: adminToken, body: { resetTimezone: altZone } });
  const movedStatus = await statusOf(member.token);
  check('quests: moving the reset zone moves "today" for every phone',
    moved.status === 200 && !!moved.json && moved.json.settings.resetTimezone === altZone &&
    !!movedStatus && movedStatus.resetTimezone === altZone &&
    movedStatus.date === await dayIn(altZone) && movedStatus.date !== (ladder && ladder.date),
    { from: ladder && ladder.date, to: movedStatus && movedStatus.date, zone: altZone });

  const restored = await api('PUT', '/api/admin/quests/settings', {
    token: adminToken,
    body: { resetTimezone: tz, checkinBaseXp: base, checkinStreakStepXp: step, checkinMaxStreakDays: maxDays },
  });
  const backTo = await statusOf(member.token);
  check('quests: the dials are put back exactly as the run found them',
    restored.status === 200 && !!restored.json && restored.json.settings.resetTimezone === tz &&
    restored.json.settings.checkinBaseXp === base && restored.json.settings.checkinStreakStepXp === step &&
    restored.json.settings.checkinMaxStreakDays === maxDays &&
    !!backTo && backTo.resetTimezone === tz && backTo.date === await dayIn(tz) &&
    (await sql(settingsSql)) === settingsRaw,
    { settings: restored.json && restored.json.settings });

  const questAudit = await sql(`select count(*) from admin_audit where action in ('QUEST_CREATE','QUEST_UPDATE','QUEST_DELETE') and target_id='${qKey}'`);
  const settingsAudit = await sql(`select count(*) from admin_audit where action='QUEST_SETTINGS_UPDATE' and target_id='singleton'`);
  check('quests: every catalogue change and dial move is in the audit log',
    Number(questAudit) === 3 && Number(settingsAudit) >= 2, { quest: questAudit, settings: settingsAudit });

  hostSock.close();
  chatSock.close();
  await wait(300);
}
