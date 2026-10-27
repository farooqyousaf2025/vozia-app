/* Captures the *live* wire shapes of this backend so the Android DTO harness
   (android/scripts/DtosGsonHarness.java) can deserialise real payloads instead
   of hand-written fakes.

     node scripts/capture-wire-fixtures.cjs [outDir]

   Writes wire-rest.json (REST envelopes) and wire-socket.json (every socket
   event a real room session produces) into android/scripts/fixtures/. Run it
   whenever a response shape changes, then re-run the harness. */
const fs = require('fs');
const path = require('path');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const OUT_DIR = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(__dirname, '..', '..', 'android', 'scripts', 'fixtures');
const SOCKET_IO = path.resolve(__dirname, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.js');
const EVENTS = [
  'room:seat_update',
  'room:listener_count',
  'room:chat_message',
  'room:mic_toggle',
  'room:user_joined',
  'room:user_left',
  'room:gift_animated',
  'room:hand_raise',
  'room:theme_changed',
  'room:profile_updated',
  'room:liked',
  'wallet:update',
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, { token, body } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** OTP login: the dev transport returns the code in `devCode` (see auth.service). */
async function login(phone, username) {
  const req = await api('POST', '/api/auth/request-otp', { body: { phone } });
  const ver = await api('POST', '/api/auth/verify-otp', { body: { phone, code: req.body && req.body.devCode, username } });
  if (!ver.body || !ver.body.token) throw new Error(`login failed for ${phone}: ${JSON.stringify(ver).slice(0, 200)}`);
  return ver.body;
}

/**
 * These fixtures are committed so the harness can run without a live backend, so
 * no credential-shaped string may survive: a LiveKit access token is a signed JWT
 * and a dev OTP is a login. Shape is what the DTO harness checks, so a constant
 * placeholder parses identically.
 */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const isSecret =
      (key === 'token' || key === 'accessToken' || key === 'refreshToken' || key === 'devCode' || key === 'passwordHash') &&
      typeof raw === 'string';
    out[key] = isSecret ? `redacted-${key}` : redact(raw);
  }
  return out;
}

(async () => {
  const stamp = Date.now().toString().slice(-7);
  const host = await login(`+15557${stamp}01`, `wire_host_${stamp.slice(-4)}`);
  const seated = await login(`+15557${stamp}02`, `wire_seat_${stamp.slice(-4)}`);
  const listener = await login(`+15557${stamp}03`, `wire_aud_${stamp.slice(-4)}`);
  const H = { token: host.token };
  const recharge = await api('POST', '/api/wallet/recharge', {
    token: host.token,
    body: { amountDiamonds: 5000 },
  });

  // ---- REST envelopes ------------------------------------------------------
  const rooms = await api('GET', '/api/rooms?limit=3', H);
  const roomNumber = rooms.body.rooms[0] ? rooms.body.rooms[0].number : null;
  // A room with a seat occupied, so seats/audience/chat are all populated.
  const created = await api('POST', '/api/rooms', { ...H, body: { title: `Wire Room ${stamp}`, category: 'CHAT', seatCapacity: 4 } });
  const roomId = created.body.room.id;
  await api('POST', `/api/rooms/${roomId}/join`, H);
  await api('POST', `/api/rooms/${roomId}/join`, { token: seated.token });
  await api('POST', `/api/rooms/${roomId}/join`, { token: listener.token });
  await api('POST', `/api/rooms/${roomId}/seat`, { token: seated.token, body: { seatIndex: 1 } });

  const rest = {
    rooms,
    // Discovery is a server answer, so the filtered and ordered shapes are captured as real
    // responses rather than assumed by the DTO harness.
    discovery: await api('GET', '/api/rooms?limit=5&sort=trending&search=Wire&language=en&region=BD', H),
    myRooms: await api('GET', '/api/rooms/mine?limit=5', H),
    quickJoin: await api('GET', '/api/rooms/quick-join', { token: listener.token }),
    // The seat policy, and a room whose host asked for no capacity: together they are the
    // proof that the published default is the number the server actually materialises.
    capacity: await api('GET', '/api/rooms/capacity', {}),
    capacityRoom: await api('POST', '/api/rooms', { ...H, body: { title: `Wire Seats ${stamp}`, category: 'CHAT' } }),
    detail: await api('GET', `/api/rooms/${roomId}`, H),
    join: await api('POST', `/api/rooms/${roomId}/join`, H),
    create: created,
    wallet: await api('GET', '/api/wallet', H),
    gifts: await api('GET', '/api/gifts', H),
    withdrawals: await api('GET', '/api/wallet/withdrawals', H),
    // Both boards of the ranking sheet. The gift sends below have not happened
    // yet, so these rows are whatever earlier suites left behind — shape is all
    // the DTO harness reads, and it reads `leaders` the same either way.
    boardReceivers: await api('GET', '/api/users/top?window=week&limit=5', H),
    boardSenders: await api('GET', '/api/users/top?window=week&limit=5&role=senders', H),
    roomNumber,
  };

  // ---- Socket events -------------------------------------------------------
  // Everything interesting happens *after* the socket is connected: the server
  // fans gifts out as `room:gift_animated` and, per gift.controller.ts, appends a
  // SYSTEM chat row (user:null) alongside it, so the gift sends below are also
  // what puts a null-user chat message into the fixture.
  const io = require(SOCKET_IO);
  const socket = io(API, { transports: ['websocket'], forceNew: true, auth: { token: host.token } });
  const raw = {};
  for (const ev of EVENTS) socket.on(ev, (payload) => { (raw[ev] = raw[ev] || []).push(payload); });
  await new Promise((resolve) => { socket.on('connect', resolve); setTimeout(resolve, 8000); });
  socket.emit('room:join', { roomId }, () => {});
  await wait(1200);
  socket.emit('room:chat', { roomId, message: 'wire capture hello' }, () => {});
  // Two likes inside the same 1s window: like.service buffers per room and emits
  // ONE counted batch, so the second event is what makes the fixture prove the
  // payload carries an aggregate count plus the running room total. The trailing
  // wait(2500) below is what lets both windows flush before the socket closes.
  socket.emit('room:like', { roomId, count: 7 }, () => {});
  socket.emit('room:like', { roomId, count: 3 }, () => {});
  await wait(1200);
  socket.emit('room:like', { roomId, count: 5 }, () => {});

  // `room:raise_hand` is socket-only (the REST /hand-raise route writes the
  // column without broadcasting), so the raiser needs its own connection in the
  // room for the host socket to see `room:hand_raise` at all.
  const audSocket = io(API, { transports: ['websocket'], forceNew: true, auth: { token: listener.token } });
  await new Promise((resolve) => { audSocket.on('connect', resolve); setTimeout(resolve, 8000); });
  audSocket.emit('room:join', { roomId }, () => {});
  await wait(600);
  audSocket.emit('room:raise_hand', { roomId, raise: true }, () => {});
  await wait(700);
  audSocket.emit('room:raise_hand', { roomId, raise: false }, () => {});
  await wait(700);

  const gifts = rest.gifts.body.gifts || [];
  const giftId = gifts[0] && gifts[0].id;
  const toSeated = await api('POST', '/api/gifts/send', {
    token: host.token,
    body: { roomId, receiverId: seated.user.id, giftId, quantity: 1 },
  });
  const toAudience = await api('POST', '/api/gifts/send', {
    token: host.token,
    body: { roomId, receiverId: listener.user.id, giftId, quantity: 1 },
  });

  // Seat churn so `room:seat_update` carries both an occupied and an emptied seat.
  await api('POST', `/api/rooms/${roomId}/seat/1/leave`, { token: seated.token, body: {} });
  await api('POST', `/api/rooms/${roomId}/seat`, { token: listener.token, body: { seatIndex: 1 } });
  // Host restyles the room so `room:theme_changed` is a real broadcast, and the
  // theme registry itself becomes a captured REST shape.
  const theme = await api('POST', `/api/rooms/${roomId}/theme`, { token: host.token, body: { theme: 'nebula' } });
  const themes = await api('GET', '/api/rooms/themes', H);
  // The host edits the profile over REST; the connected socket must see it as
  // `room:profile_updated`, which is the only way a member learns the rules changed.
  const update = await api('PATCH', `/api/rooms/${roomId}`, {
    token: host.token,
    body: { title: `Wire Room Edited ${stamp}`, description: 'captured profile', language: 'en', region: 'BD', rules: 'mic off when not on the seat' },
  });
  // `capacityRoom` was opened only to capture a default-capacity envelope; no need to leave it live.
  await api('POST', `/api/rooms/${rest.capacityRoom.body.room.id}/close`, H);
  await wait(2500);
  audSocket.close();
  socket.close();
  await wait(400);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  rest.theme = theme;
  rest.themes = themes;
  rest.update = update;
  fs.writeFileSync(path.join(OUT_DIR, 'wire-rest.json'), JSON.stringify(redact(rest), null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'wire-socket.json'), JSON.stringify(redact(raw), null, 1));
  console.log(`REST: ${Object.entries(rest).filter(([, v]) => v && v.status).map(([k, v]) => `${k}=${v.status}`).join(' ')}`);
  console.log(`side effects: recharge=${recharge.status} gift->seat=${toSeated.status} gift->audience=${toAudience.status}`);
  console.log(`socket events captured: ${EVENTS.filter((e) => raw[e] && raw[e].length).map((e) => `${e}×${raw[e].length}`).join(' ') || '(none)'}`);
  console.log(`wrote ${path.join(OUT_DIR, 'wire-rest.json')}`);
  console.log(`wrote ${path.join(OUT_DIR, 'wire-socket.json')}`);
})().catch((e) => {
  console.error('WIRE CAPTURE CRASH', e);
  process.exit(1);
});
