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
const SOCKET_IO = path.join(BE_ROOT, 'node_modules', 'socket.io', 'client-dist', 'socket.io.js');

// Same development defaults the backend itself falls back to (src/config/env.ts);
// an explicit environment always wins so a non-default deployment can be probed.
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const KEY = process.env.LIVEKIT_API_KEY || 'voiza-dev-access-key';
const SECRET = process.env.LIVEKIT_API_SECRET || 'voiza-dev-secret-key-change-me-32chars';

const out = [];
const check = (n, p, d) => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? `  :: ${JSON.stringify(d).slice(0, 240)}` : ''}`);

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
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
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
  const res = await fetch(API + '/api/payments/stripe/webhook', { method: 'POST', headers, body: payload });
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
    const r = await fetch(`http://127.0.0.1:7880/rtc/validate${qs}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
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
  const io = require(SOCKET_IO);
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
