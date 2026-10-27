/* Captures the game wire payloads the Android client parses (§7, §8), so the Kotlin mapper tests
   assert against the shapes the server actually sends instead of shapes invented in the client.

     1. boot the stack and the API, then `npm run build`
     2. node scripts/capture-game-wire.cjs > ../android/scripts/fixtures/wire-games.json

   Plays a short but representative slice of each driver — a claimed TTT cell, an answered quiz
   round, an off-the-yard Ludo roll — because those are the fields the board renderers read.
   Every definition is put back in the shipped free-to-play posture, exactly like games-e2e.cjs,
   so a capture run cannot leave a paid game live in the development database. Development only. */
const path = require('path');
const crypto = require('crypto');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_development_only_not_a_real_secret';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

let poolPromise = null;
function db() {
  if (!poolPromise) {
    poolPromise = new (require(path.join(BE_ROOT, 'node_modules', 'pg')).Pool)({
      connectionString: require(path.join(BE_ROOT, 'dist', 'config', 'env.js')).env.databaseUrl,
      max: 4,
    });
  }
  return poolPromise;
}
const sql = (q) => db().query(q);

const SHIPPED = `is_active = false, entry_fee_enabled = false, entry_fee_diamonds = 0, entry_fee_min = 0,
  entry_fee_max = 0, prize_enabled = false, commission_bps = 0, refund_policy = 'CANCELLED',
  promo_free_entry = false, promo_until = NULL, daily_entry_limit = 50,
  prize_rules = '[{"rank":1,"share_bps":10000}]'::jsonb`;
const resetShipped = () => sql(`update game_definitions set ${SHIPPED} where key in ('TIC_TAC_TOE','QUIZ_BATTLE','LUDO')`);

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

/** Fail fast: a capture file built from a half-finished run would quietly mis-describe the wire. */
function expect(label, res) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${label} -> ${res.status} ${JSON.stringify(res.json).slice(0, 240)}`);
  }
  return res.json;
}

function sign(payload, at = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${at}.${payload}`).digest('hex');
  return `t=${at},v1=${mac}`;
}

async function fund(userId, diamonds) {
  const payload = JSON.stringify({
    id: `evt_w_${userId.slice(0, 8)}_${Date.now()}`,
    type: 'payment_intent.succeeded',
    data: { object: { id: `pi_w_${crypto.randomUUID()}`, status: 'succeeded', metadata: { voizaUserId: userId, diamonds: String(diamonds) } } },
  });
  await fetch(`${API}/api/payments/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
    body: payload,
  });
}

const stamp = Date.now().toString().slice(-7);
let userSeq = 0;
async function makeUser(label) {
  userSeq += 1;
  const phone = `+15559${stamp}${String(userSeq).padStart(2, '0')}`;
  const otp = await api('POST', '/api/auth/request-otp', { body: { phone } });
  const verified = await api('POST', '/api/auth/verify-otp', {
    body: { phone, code: otp.json && otp.json.devCode, username: `wire_${label}_${stamp.slice(-4)}_${userSeq}` },
  });
  const user = expect(`verify-otp ${label}`, verified);
  await fund(user.user.id, 5000);
  return { id: user.user.id, token: user.token };
}

/** Open a table, seat both players, start it, then play the slice `drive` asks for. */
async function captureGame(adminToken, host, guest, roomId, gameKey, drive) {
  expect(`enable ${gameKey}`, await api('PUT', `/api/admin/games/${gameKey}/rules`, { token: adminToken, body: { isActive: true } }));
  const created = expect(`create ${gameKey}`, await api('POST', '/api/games', { token: host.token, body: { gameKey, roomId } }));
  const sid = created.session.id;
  expect('guest join', await api('POST', `/api/games/${sid}/join`, { token: guest.token, body: {} }));
  expect('guest ready', await api('POST', `/api/games/${sid}/ready`, { token: guest.token, body: {} }));
  expect('host ready', await api('POST', `/api/games/${sid}/ready`, { token: host.token, body: {} }));
  expect('start', await api('POST', `/api/games/${sid}/start`, { token: host.token, body: {} }));
  const mid = await drive(host, guest, sid);
  return { sessionId: sid, mid, read: expect(`read ${gameKey}`, await api('GET', `/api/games/${sid}`, { token: host.token })) };
}

(async () => {
  await resetShipped();
  const adminLogin = expect('admin otp', await api('POST', '/api/auth/verify-otp', { body: { phone: '+10000000000', code: '424242' } }));
  const admin = adminLogin.token;

  const host = await makeUser('h');
  const guest = await makeUser('g');
  const room = expect('room', await api('POST', '/api/rooms', {
    token: host.token,
    body: { title: `Wire Games ${stamp}`, category: 'CHAT', type: 'PUBLIC', seatCapacity: 4 },
  }));
  const roomId = (room.room && room.room.id) || room.id;

  const out = {
    capturedAt: new Date().toISOString(),
    api: API,
    catalog: expect('catalog', await api('GET', `/api/games?roomId=${roomId}`, { token: host.token })),
    games: {},
  };

  out.games.TIC_TAC_TOE = await captureGame(admin, host, guest, roomId, 'TIC_TAC_TOE', async (h, g, sid) => ({
    hostMove: expect('ttt host move', await api('POST', `/api/games/${sid}/action`, { token: h.token, body: { type: 'MOVE', payload: { cell: 0 } } })),
    guestMove: expect('ttt guest move', await api('POST', `/api/games/${sid}/action`, { token: g.token, body: { type: 'MOVE', payload: { cell: 3 } } })),
  }));

  out.games.QUIZ_BATTLE = await captureGame(admin, host, guest, roomId, 'QUIZ_BATTLE', async (h, g, sid) => ({
    host: expect('quiz answer host', await api('POST', `/api/games/${sid}/action`, { token: h.token, body: { type: 'ANSWER', payload: { questionIndex: 0, optionIndex: 1 } } })),
    guest: expect('quiz answer guest', await api('POST', `/api/games/${sid}/action`, { token: g.token, body: { type: 'ANSWER', payload: { questionIndex: 0, optionIndex: 2 } } })),
  }));

  out.games.LUDO = await captureGame(admin, host, guest, roomId, 'LUDO', async (h, g, sid) => {
    const rolls = [];
    for (const player of [h, g, h, g]) {
      rolls.push(await api('POST', `/api/games/${sid}/action`, { token: player.token, body: { type: 'ROLL', payload: {} } }));
      rolls.push(await api('POST', `/api/games/${sid}/action`, { token: player.token, body: { type: 'MOVE', payload: { piece: 0 } } }));
    }
    return rolls.map((r) => r.json);
  });

  out.history = expect('history', await api('GET', '/api/games/me/history', { token: host.token }));
  process.stdout.write(JSON.stringify(out, null, 1));
  await resetShipped();
  await db().end();
})().catch(async (e) => {
  process.stderr.write(`capture failed: ${e.message}\n`);
  await resetShipped().catch(() => {});
  await db().end().catch(() => {});
  process.exitCode = 1;
});
