/* Live end-to-end for the gift engine (migration 0023).

   `e2e-live.cjs` proves the money path and `social-e2e.cjs` proves the community controls. This
   suite drives what the gift engine added on top of them: a catalogue that says how an animation
   plays, a send that cannot be paid for twice, an event a device can recognise and drop when it
   arrives twice, and a combo counter the server — not the client — owns.

     1. boot Postgres, Redis, LiveKit and the API (see README)
     2. node scripts/gift-e2e.cjs

   Throwaway accounts and rooms, named from a time stamp, so run it against a development database.
   Two catalogue rows are edited mid-run (a format change and a combo toggle) and restored at the
   end; the socket half needs `socket.io-client`, which the server package already ships. */
const { io } = require('socket.io-client');

const ROOT = process.env.E2E_API_URL ? process.env.E2E_API_URL.replace(/\/$/, '') : 'http://127.0.0.1:4000';
const BASE = `${ROOT}/api`;
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD || 'voiza-admin';
const OTP = process.env.E2E_OTP || '123456';

const out = [];
// Printed as it goes, because this suite holds sockets and a five-second combo window: a run that
// stalls should show the last thing it proved instead of nothing at all.
const check = (name, ok, detail) => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 220)}` : ''}`;
  out.push(line);
  console.log(line);
  if (!ok) process.exitCode = 1;
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

const code = (r) => r.json?.error?.code;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function signUp(phone, username) {
  const r = await call('POST', '/auth/request-otp', { body: { phone } });
  if (r.status !== 200) throw new Error(`request-otp failed for ${phone}: ${JSON.stringify(r.json)}`);
  const v = await call('POST', '/auth/verify-otp', { body: { phone, code: OTP, username } });
  if (v.status !== 200) throw new Error(`verify-otp failed for ${phone}: ${JSON.stringify(v.json)}`);
  return v.json;
}

async function topUp(token, diamonds) {
  const r = await call('POST', '/wallet/recharge', { token, body: { amountDiamonds: diamonds } });
  if (r.status !== 200) throw new Error(`recharge failed: ${JSON.stringify(r.json)}`);
}

async function balance(token) {
  const r = await call('GET', '/wallet', { token });
  return Number(r.json?.user?.diamondBalance ?? -1);
}

async function openRoom(token, title) {
  const r = await call('POST', '/rooms', { token, body: { title, category: 'PARTY' } });
  if (r.status !== 201) throw new Error(`room create failed: ${JSON.stringify(r.json)}`);
  return r.json.room.id;
}

async function joinRoom(token, roomId) {
  const r = await call('POST', `/rooms/${roomId}/join`, { token });
  if (r.status !== 200) throw new Error(`room join failed: ${JSON.stringify(r.json)}`);
}

/** One socket per account, with the gift events it saw kept in order. */
async function watchRoom(token, roomId) {
  const socket = await new Promise((resolve, reject) => {
    const s = io(ROOT, { auth: { token }, transports: ['websocket'], timeout: 5000 });
    const timer = setTimeout(() => reject(new Error(`socket ${roomId} never connected`)), 8000);
    s.on('connect', () => { clearTimeout(timer); resolve(s); });
    s.on('connect_error', (err) => { clearTimeout(timer); reject(new Error(`socket connect_error: ${err.message}`)); });
  });
  const events = [];
  const histories = [];
  socket.on('room:gift_animated', (payload) => events.push(payload));
  socket.on('room:gift_history', (payload) => histories.push(payload));
  // The ack is a database round trip, so it can fail on its own even after a clean connect;
  // without a deadline here a stalled join stops the suite with no explanation.
  const ack = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`room:join ack never came for ${roomId}`)), 8000);
    socket.emit('room:join', { roomId }, (r) => { clearTimeout(timer); resolve(r); });
  });
  if (!ack?.ok) throw new Error(`room:join refused: ${JSON.stringify(ack)}`);
  return { socket, events, histories };
}

/** The broadcast is fire-and-forget after the 201, so a test asks rather than assumes. */
async function waitFor(events, count, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) await sleep(50);
  return events.length >= count;
}

// --- synthetic animation bytes -------------------------------------------
// These are built here rather than shipped as fixtures: what the upload guard promises is that it
// reads a *container*, so the test needs the headers of each container and nothing else about the
// file matters to it. A real SVGA/MP4 pair is exercised on a device, not by this script.

/** A ZIP local file header naming the entry a real SVGA v2 file starts with. */
function svgaBytes() {
  const entry = Buffer.from('svgaprotobuf_2.0', 'utf8');
  const body = Buffer.concat([Buffer.from([0x0a, 0x0c]), Buffer.from('%SVGAFORMAT%', 'ascii'), Buffer.alloc(64, 0x20)]);
  const head = Buffer.alloc(30);
  head.write('PK\x03\x04', 0, 'ascii');
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0, 6);
  head.writeUInt16LE(0, 8);
  head.writeUInt32LE(0, 10);
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(body.length, 22);
  head.writeUInt16LE(entry.length, 26);
  return Buffer.concat([head, entry, body]);
}

/** The same ZIP shape with any other entry name — the bytes a disguised upload would have. */
function zipBytes(entryName) {
  const entry = Buffer.from(entryName, 'utf8');
  const head = Buffer.alloc(30);
  head.write('PK\x03\x04', 0, 'ascii');
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0, 8);
  head.writeUInt32LE(4, 18);
  head.writeUInt32LE(4, 22);
  head.writeUInt16LE(entry.length, 26);
  return Buffer.concat([head, entry, Buffer.alloc(4, 0x20)]);
}

/** An ISO base-media header: 4-byte size, `ftyp`, major brand, then the compatible brands. */
function isoBytes(majorBrand, compatible) {
  const brands = [majorBrand, ...compatible];
  const size = 16 + brands.length * 4;
  const head = Buffer.alloc(size);
  head.writeUInt32BE(size, 0);
  head.write('ftyp', 4, 'ascii');
  brands.forEach((brand, i) => head.write(brand, 8 + i * 4, 'ascii'));
  return Buffer.concat([head, Buffer.alloc(64, 0x20)]);
}

async function upload(token, kind, fileName, buffer) {
  return call('POST', '/admin/uploads', {
    token,
    body: { kind, fileName, data: buffer.toString('base64') },
  });
}

/**
 * Acceptance is either "wrote new bytes" (201) or "already had exactly these" (200 + duplicate).
 * The suite is run against a database that earlier runs left behind, and the fixtures below are
 * deterministic, so a second run legitimately takes the dedupe branch; the format verdict is the
 * same either way. The dedupe itself is asserted separately.
 */
const accepted = (r) =>
  r.status === 201 || (r.status === 200 && r.json?.duplicate === true && Boolean(r.json?.asset?.url));

(async () => {
  const stamp = Date.now().toString().slice(-7);
  const key = (n) => `gift-${stamp}-${n}`;

  const a = await signUp(`+1559${stamp}01`, `gift_a_${stamp}`);
  const b = await signUp(`+1559${stamp}02`, `gift_b_${stamp}`);
  const c = await signUp(`+1559${stamp}03`, `gift_c_${stamp}`);
  const poor = await signUp(`+1559${stamp}04`, `gift_povert_${stamp}`);
  const [A, B, C, P] = [a.token, b.token, c.token, poor.token];
  const [AID, BID, CID] = [a.user.id, b.user.id, c.user.id];
  check('setup: four accounts exist', Boolean(A && B && C && P && AID && BID && CID));

  await topUp(A, 100_000);
  await topUp(B, 100_000);
  await topUp(C, 100_000);

  const roomId = await openRoom(A, `Gift engine ${stamp}`);
  await joinRoom(B, roomId);
  await joinRoom(C, roomId);

  const gifts = (await call('GET', '/gifts')).json.gifts ?? [];
  const rose = gifts.find((g) => g.name === 'Rose');
  const heart = gifts.find((g) => g.name === 'True Heart');
  const car = gifts.find((g) => g.name === 'Sports Car');
  check('setup: the catalogue is served', Boolean(rose && heart && car), { count: gifts.length });

  // --- 1. the catalogue describes playback ---------------------------------
  check('catalogue: every gift carries an animation format and a lifetime',
    gifts.every((g) => ['LOTTIE', 'SVGA', 'MP4'].includes(g.animationFormat)
      && typeof g.durationMs === 'number' && typeof g.displayPriority === 'number'
      && typeof g.comboEnabled === 'boolean' && typeof g.comboWindowMs === 'number'),
    gifts[0] && { animationFormat: gifts[0].animationFormat, durationMs: gifts[0].durationMs, displayPriority: gifts[0].displayPriority });

  check('catalogue: a ticker gift is quieter than a full-screen one',
    rose.displayPriority < car.displayPriority && rose.durationMs < car.durationMs,
    { rose: [rose.displayPriority, rose.durationMs], car: [car.displayPriority, car.durationMs] });

  const adminLogin = await call('POST', '/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASS } });
  const adminToken = adminLogin.json?.token;
  check('setup: operator login', adminLogin.status === 200 && Boolean(adminToken));

  const repurposed = await call('PUT', `/admin/gifts/${car.id}`, {
    token: adminToken,
    body: { ...car, animationFormat: 'SVGA', durationMs: 4321, displayPriority: 250, comboWindowMs: 9000 },
  });
  check('admin: an operator can re-time a gift and change its renderer',
    repurposed.status === 200 && repurposed.json.gift.animationFormat === 'SVGA'
      && repurposed.json.gift.durationMs === 4321 && repurposed.json.gift.displayPriority === 250
      && repurposed.json.gift.comboWindowMs === 9000,
    code(repurposed) ?? repurposed.json?.gift);

  const afterRepurpose = (await call('GET', '/gifts')).json.gifts.find((g) => g.id === car.id);
  check('admin: the phone sees the changed row, not the shipped one',
    afterRepurpose?.animationFormat === 'SVGA' && afterRepurpose?.durationMs === 4321,
    afterRepurpose && { animationFormat: afterRepurpose.animationFormat, durationMs: afterRepurpose.durationMs });

  const badFormat = await call('PUT', `/admin/gifts/${car.id}`, { token: adminToken, body: { animationFormat: 'GIF' } });
  check('admin: an unknown animation format is a 400, not a database check error',
    badFormat.status === 400, code(badFormat));

  const badDuration = await call('PUT', `/admin/gifts/${car.id}`, { token: adminToken, body: { durationMs: 900_000 } });
  check('admin: an hour-long overlay is refused before it can be saved',
    badDuration.status === 400, code(badDuration));

  await call('PUT', `/admin/gifts/${car.id}`, {
    token: adminToken,
    body: { animationFormat: 'LOTTIE', durationMs: 6000, displayPriority: 100, comboWindowMs: 5000 },
  });

  // --- 2. uploads: the container decides ------------------------------------
  const svga = await upload(adminToken, 'GIFT_ANIMATION', 'jet.svga', svgaBytes());
  check('upload: an SVGA scene is accepted as a gift animation',
    accepted(svga) && svga.json.asset.contentType === 'application/octet-stream'
      && svga.json.asset.url.endsWith('.svga'),
    code(svga) ?? { status: svga.status, url: svga.json?.asset?.url, contentType: svga.json?.asset?.contentType });

  const mp4 = await upload(adminToken, 'GIFT_ANIMATION', 'cinematic.mp4', isoBytes('isom', ['mp42', 'isom']));
  check('upload: an MP4 is accepted as a gift animation',
    accepted(mp4) && mp4.json.asset.contentType === 'video/mp4' && mp4.json.asset.url.endsWith('.mp4'),
    code(mp4) ?? { status: mp4.status, url: mp4.json?.asset?.url, contentType: mp4.json?.asset?.contentType });

  const again = await upload(adminToken, 'GIFT_ANIMATION', 'jet.svga', svgaBytes());
  check('upload: identical bytes are answered with the asset that already holds them',
    again.status === 200 && again.json?.duplicate === true && again.json?.asset?.id === svga.json?.asset?.id,
    { status: again.status, duplicate: again.json?.duplicate, same: again.json?.asset?.id === svga.json?.asset?.id });

  const aac = await upload(adminToken, 'GIFT_ANIMATION', 'voice.m4a', isoBytes('M4A ', ['M4A ', 'mp42']));
  check('upload: an audio container is refused in the animation slot',
    aac.status === 400 && code(aac) === 'upload_format_unsupported', { status: aac.status, code: code(aac) });

  const audioElsewhere = await upload(adminToken, 'GIFT_SOUND', 'voice.m4a', isoBytes('M4A ', ['M4A ', 'mp42']));
  check('upload: the same bytes are accepted in the sound slot',
    accepted(audioElsewhere) && audioElsewhere.json.asset.contentType === 'audio/mp4',
    code(audioElsewhere) ?? { status: audioElsewhere.status, contentType: audioElsewhere.json?.asset?.contentType });

  const disguised = await upload(adminToken, 'GIFT_ANIMATION', 'loot.zip', zipBytes('payload/readme.txt'));
  check('upload: a zip that is not an SVGA scene is refused',
    disguised.status === 400 && code(disguised) === 'upload_format_unsupported', code(disguised));

  const oversizedVideo = await upload(adminToken, 'GIFT_ANIMATION', 'huge.mp4',
    Buffer.concat([isoBytes('isom', ['mp42']), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20)]));
  check('upload: a video over the MP4 budget is refused by size, not by format',
    oversizedVideo.status === 400 && code(oversizedVideo) === 'upload_too_large', code(oversizedVideo));

  // --- 3. one payment per request ------------------------------------------
  const before = await balance(A);
  const first = await call('POST', '/gifts/send', { token: A, body: { giftId: rose.id, receiverId: BID, quantity: 1, roomId, idempotencyKey: key(1) } });
  check('send: an in-room gift is paid for and answered with its receipt',
    first.status === 201 && first.json.replayed === false && first.json.transaction.type === 'GIFT_SENT',
    code(first) ?? { status: first.status, diamonds: first.json?.transaction?.amountDiamonds });
  const afterFirst = await balance(A);
  check('send: the sender paid exactly the catalogue price', afterFirst === before - rose.diamondPrice, { before, afterFirst });

  const retry = await call('POST', '/gifts/send', { token: A, body: { giftId: rose.id, receiverId: BID, quantity: 1, roomId, idempotencyKey: key(1) } });
  check('idempotency: the same key answered with the same transaction',
    retry.status === 200 && retry.json.replayed === true && retry.json.transaction.id === first.json.transaction.id,
    code(retry) ?? { status: retry.status, same: retry.json?.transaction?.id === first.json?.transaction?.id });
  check('idempotency: the retry cost nothing', (await balance(A)) === afterFirst, { balance: await balance(A) });

  const reused = await call('POST', '/gifts/send', { token: A, body: { giftId: heart.id, receiverId: BID, quantity: 2, roomId, idempotencyKey: key(1) } });
  check('idempotency: the same key for a different gift is refused, not answered',
    reused.status === 409 && code(reused) === 'idempotency_key_reused', code(reused));
  check('idempotency: a refused key collision moved no money', (await balance(A)) === afterFirst);

  const badKey = await call('POST', '/gifts/send', { token: A, body: { giftId: rose.id, receiverId: BID, quantity: 1, roomId, idempotencyKey: 'short' } });
  check('idempotency: a key too short to be a real key is a 400',
    badKey.status === 400 && code(badKey) === 'idempotency_key_invalid', code(badKey));
  check('idempotency: a malformed key moved no money', (await balance(A)) === afterFirst);

  // --- 4. the room is part of the authorisation ----------------------------
  const outsider = await call('POST', '/gifts/send', {
    token: C,
    body: { giftId: rose.id, receiverId: BID, quantity: 1, roomId: (await openRoom(A, `Ghost ${stamp}`)), idempotencyKey: key(9) },
  });
  check('room: a member of another room cannot broadcast into one they never joined',
    outsider.status === 403 && code(outsider) === 'not_in_room', code(outsider));

  const strangerRoom = await call('POST', '/gifts/send', { token: A, body: { giftId: rose.id, receiverId: BID, quantity: 1, roomId: '00000000-0000-0000-0000-000000000000' } });
  check('room: a room id that does not exist is a 404', strangerRoom.status === 404, code(strangerRoom));

  await call('POST', `/rooms/${roomId}/leave`, { token: B });
  const gone = await call('POST', '/gifts/send', { token: A, body: { giftId: rose.id, receiverId: BID, quantity: 1, roomId, idempotencyKey: key(2) } });
  check('room: a receiver who has left cannot be gifted into that room',
    gone.status === 403 && code(gone) === 'receiver_not_in_room', code(gone));
  check('room: an unauthorised gift left the balance alone', (await balance(A)) === afterFirst);
  await joinRoom(B, roomId);

  const noRoom = await call('POST', '/gifts/send', { token: A, body: { giftId: rose.id, receiverId: BID, quantity: 1, idempotencyKey: key(3) } });
  check('private: a gift with no room is still a paid, delivered gift',
    noRoom.status === 201 && noRoom.json.transaction.type === 'GIFT_SENT', code(noRoom));

  // --- 5. the guards that were here before are still here -------------------
  // The unfunded account has to be *in* the room for these: membership is checked first, and a
  // guard that fires before the one under test would report a green suite for the wrong reason.
  await joinRoom(P, roomId);

  const vip = await call('POST', '/gifts/send', { token: P, body: { giftId: car.id, receiverId: AID, quantity: 1, roomId } });
  check('wallet: the spend tier is read before the balance, so a locked gift says so',
    vip.status === 403 && code(vip) === 'vip_required', { status: vip.status, code: code(vip) });

  const broke = await call('POST', '/gifts/send', { token: P, body: { giftId: rose.id, receiverId: AID, quantity: 1, roomId, idempotencyKey: key(4) } });
  check('wallet: an empty account is told to top up, not silently charged',
    broke.status === 402 && code(broke) === 'insufficient_balance', { status: broke.status, code: code(broke) });
  check('wallet: a refused gift spent what the empty account did not have', (await balance(P)) === 0,
    { balance: await balance(P) });

  await call('POST', `/users/${BID}/block`, { token: A, body: { reason: 'gift suite' } });
  const blocked = await call('POST', '/gifts/send', { token: B, body: { giftId: rose.id, receiverId: AID, quantity: 1, roomId, idempotencyKey: key(5) } });
  check('social: a block still outranks the balance check on the gift path',
    blocked.status === 403 && code(blocked) === 'interaction_blocked', code(blocked));
  await call('DELETE', `/users/${BID}/block`, { token: A });

  // --- 6. the event a room can recognise -----------------------------------
  const watcher = await watchRoom(C, roomId);
  const listener = await watchRoom(A, roomId);

  const big = await call('POST', '/gifts/send', { token: A, body: { giftId: car.id, receiverId: BID, quantity: 1, roomId, idempotencyKey: key(6) } });
  check('send: a VIP-gated gift is refused for a VIP 0 sender',
    big.status === 403 && code(big) === 'vip_required', code(big));

  const animated = await call('POST', '/gifts/send', { token: A, body: { giftId: rose.id, receiverId: BID, quantity: 3, roomId, idempotencyKey: key(7) } });
  const arrived = await waitFor(watcher.events, 1);
  check('broadcast: every member of the room is told about the gift',
    animated.status === 201 && arrived, { status: animated.status, events: watcher.events.length });

  const event = watcher.events[0] ?? {};
  check('broadcast: the event carries the id the receipt carries',
    event.eventId === animated.json?.transaction?.id, { event: event.eventId, tx: animated.json?.transaction?.id });
  check('broadcast: the event says how to play the gift',
    event.gift?.animationFormat === 'LOTTIE' && typeof event.gift?.durationMs === 'number'
      && typeof event.gift?.displayPriority === 'number',
    event.gift && { animationFormat: event.gift.animationFormat, durationMs: event.gift.durationMs });
  check('broadcast: the event names both halves of the pair',
    event.sender?.id === AID && event.receiver?.id === BID && event.quantity === 3,
    { sender: event.sender?.id, receiver: event.receiver?.id, quantity: event.quantity });
  check('broadcast: the sender hears the same single event as everyone else',
    listener.events.length === 1 && listener.events[0].eventId === event.eventId,
    { count: listener.events.length });
  check('broadcast: a replay of the request published nothing new',
    (await call('POST', '/gifts/send', { token: A, body: { giftId: rose.id, receiverId: BID, quantity: 3, roomId, idempotencyKey: key(7) } })).status === 200
      && (await sleep(300), watcher.events.length === 1),
    { events: watcher.events.length });

  // --- 6b. a reconnecting device is caught up, quietly ----------------------
  // Snapshot first: every socket already took its own tail when it joined, so "nobody else got
  // anything" only means something relative to the moment the new device arrived.
  const liveBefore = watcher.events.length + listener.events.length;
  const tailsBefore = watcher.histories.length + listener.histories.length;
  const rejoiner = await watchRoom(C, roomId);
  await waitFor(rejoiner.histories, 1);
  const caughtUp = rejoiner.histories[0] ?? {};
  check('reconnect: joining a room hands the device the gifts it was not connected for',
    caughtUp.roomId === roomId && (caughtUp.gifts ?? []).length >= 1,
    { gifts: (caughtUp.gifts ?? []).length });
  check('reconnect: the tail is short — a room does not re-animate its whole evening',
    (caughtUp.gifts ?? []).length <= 12, { gifts: (caughtUp.gifts ?? []).length });
  check('reconnect: the tail is keyed by the same ids the live events used',
    (caughtUp.gifts ?? []).some((g) => g.eventId === animated.json?.transaction?.id),
    { ids: (caughtUp.gifts ?? []).map((g) => g.eventId) });
  // The row a device reads after reconnecting has to describe the same gift the live event did,
  // including the money: the ledger is the source for both, so a divergence would be a bug here.
  const sameEvent = (caughtUp.gifts ?? []).find((g) => g.eventId === animated.json?.transaction?.id) ?? {};
  const liveEvent = watcher.events[0] ?? {};
  check('reconnect: the tailed row and the live event describe the same gift',
    sameEvent.quantity === liveEvent.quantity
      && Number(sameEvent.totalDiamonds) === Number(liveEvent.totalDiamonds)
      && Number(sameEvent.totalRCoins) === Number(liveEvent.totalRCoins)
      && sameEvent.gift?.id === liveEvent.gift?.id,
    { tail: [sameEvent.quantity, sameEvent.totalDiamonds, sameEvent.totalRCoins], live: [liveEvent.quantity, liveEvent.totalDiamonds, liveEvent.totalRCoins] });
  check('reconnect: a tailed gift carries what a renderer needs',
    (caughtUp.gifts ?? []).every((g) => g.gift?.name && g.sender?.username && g.receiver?.username
      && typeof g.gift?.animationFormat === 'string' && typeof g.gift?.durationMs === 'number'
      && Number(g.quantity) >= 1 && typeof g.createdAt === 'string' && g.createdAt.length > 0),
    caughtUp.gifts?.[0] && { gift: caughtUp.gifts[0].gift.name, format: caughtUp.gifts[0].gift.animationFormat });
  await sleep(300);
  check('reconnect: catching one socket up replayed nothing to the others',
    watcher.events.length + listener.events.length === liveBefore
      && watcher.histories.length + listener.histories.length === tailsBefore,
    { live: [liveBefore, watcher.events.length + listener.events.length], tails: [tailsBefore, watcher.histories.length + listener.histories.length] });
  rejoiner.socket.close();

  // --- 7. combos the server owns --------------------------------------------
  const combo1 = await call('POST', '/gifts/send', { token: B, body: { giftId: rose.id, receiverId: AID, quantity: 1, roomId, idempotencyKey: key(10) } });
  const combo2 = await call('POST', '/gifts/send', { token: B, body: { giftId: rose.id, receiverId: AID, quantity: 1, roomId, idempotencyKey: key(11) } });
  const combo3 = await call('POST', '/gifts/send', { token: B, body: { giftId: rose.id, receiverId: AID, quantity: 1, roomId, idempotencyKey: key(12) } });
  check('combo: repeat sends share one window and count up',
    combo1.json?.combo?.count === 1 && combo2.json?.combo?.count === 2 && combo3.json?.combo?.count === 3
      && combo1.json?.combo?.comboId === combo3.json?.combo?.comboId,
    [combo1.json?.combo, combo2.json?.combo, combo3.json?.combo]);
  check('combo: each send in a combo is its own paid transaction',
    new Set([combo1.json?.transaction?.id, combo2.json?.transaction?.id, combo3.json?.transaction?.id]).size === 3);

  const otherGift = await call('POST', '/gifts/send', { token: B, body: { giftId: heart.id, receiverId: AID, quantity: 1, roomId, idempotencyKey: key(13) } });
  check('combo: a different gift does not join the rose counter',
    otherGift.json?.combo?.count === 1 && otherGift.json?.combo?.comboId !== combo3.json?.combo?.comboId,
    { status: otherGift.status, combo: otherGift.json?.combo });

  const otherSender = await call('POST', '/gifts/send', { token: C, body: { giftId: rose.id, receiverId: AID, quantity: 1, roomId, idempotencyKey: key(14) } });
  check('combo: another member tapping the same gift starts their own counter',
    otherSender.json?.combo?.count === 1 && otherSender.json?.combo?.comboId !== combo3.json?.combo?.comboId,
    { status: otherSender.status, combo: otherSender.json?.combo });

  const otherTarget = await call('POST', '/gifts/send', { token: B, body: { giftId: rose.id, receiverId: CID, quantity: 1, roomId, idempotencyKey: key(15) } });
  check('combo: a different receiver is a different combo',
    otherTarget.json?.combo?.count === 1 && otherTarget.json?.combo?.comboId !== combo3.json?.combo?.comboId,
    { status: otherTarget.status, combo: otherTarget.json?.combo });

  const secondRoom = await openRoom(A, `Second ${stamp}`);
  await joinRoom(B, secondRoom);
  const elsewhere = await call('POST', '/gifts/send', { token: B, body: { giftId: rose.id, receiverId: AID, quantity: 1, roomId: secondRoom, idempotencyKey: key(16) } });
  check('combo: the same pair in another room is not the same combo',
    elsewhere.json?.combo?.count === 1 && elsewhere.json?.combo?.comboId !== combo3.json?.combo?.comboId,
    elsewhere.json?.combo);

  await call('PUT', `/admin/gifts/${rose.id}`, { token: adminToken, body: { comboEnabled: false } });
  const plain1 = await call('POST', '/gifts/send', { token: B, body: { giftId: rose.id, receiverId: AID, quantity: 1, roomId, idempotencyKey: key(17) } });
  const plain2 = await call('POST', '/gifts/send', { token: B, body: { giftId: rose.id, receiverId: AID, quantity: 1, roomId, idempotencyKey: key(18) } });
  check('combo: a gift the operator left out of the system never counts past one',
    plain1.json?.combo?.count === 1 && plain2.json?.combo?.count === 1,
    [plain1.json?.combo?.count, plain2.json?.combo?.count]);
  await call('PUT', `/admin/gifts/${rose.id}`, { token: adminToken, body: { comboEnabled: true } });

  // --- 8. what a reconnecting device asks for ------------------------------
  const tail = await call('GET', `/rooms/${roomId}/gifts?limit=10`, { token: C });
  const eventIds = (tail.json?.gifts ?? []).map((g) => g.eventId);
  check('replay: the room hands a device its recent gift events',
    tail.status === 200 && eventIds.length >= 5, { status: tail.status, count: eventIds.length });
  check('replay: the ids are the receipts, so a device that saw them live drops them',
    eventIds.includes(animated.json?.transaction?.id) && new Set(eventIds).size === eventIds.length,
    { includes: eventIds.includes(animated.json?.transaction?.id) });
  check('replay: an event describes the gift well enough to animate it',
    (tail.json?.gifts ?? []).every((g) => g.gift?.name && g.sender?.username && g.receiver?.username
      && typeof g.gift.animationFormat === 'string' && Number(g.quantity) >= 1),
    tail.json?.gifts?.[0] && { gift: tail.json.gifts[0].gift.name, format: tail.json.gifts[0].gift.animationFormat });
  check('replay: newest first', tail.json?.gifts?.[0]?.createdAt >= tail.json?.gifts?.[1]?.createdAt,
    tail.json?.gifts?.slice(0, 2).map((g) => g.createdAt));
  const capped = await call('GET', `/rooms/${roomId}/gifts?limit=2`, { token: C });
  check('replay: the page size is respected', (capped.json?.gifts ?? []).length === 2, capped.json?.gifts?.length);
  const greedy = await call('GET', `/rooms/${roomId}/gifts?limit=1000`, { token: C });
  check('replay: an absurd page is refused rather than served', greedy.status === 400, code(greedy));

  const mine1 = await call('GET', '/gifts/history?limit=3', { token: B });
  const ids1 = (mine1.json?.gifts ?? []).map((g) => g.eventId);
  check('history: the caller reads their own gift receipts',
    mine1.status === 200 && ids1.length === 3 && (mine1.json.gifts ?? []).every((g) => Number(g.diamonds) > 0),
    { status: mine1.status, ids: ids1.length });
  const mine2 = await call('GET', `/gifts/history?limit=3&before=${mine1.json?.nextCursor}`, { token: B });
  const ids2 = (mine2.json?.gifts ?? []).map((g) => g.eventId);
  check('history: the cursor walks backwards without repeating or skipping',
    ids2.length === 3 && ids2.every((id) => !ids1.includes(id)), { page1: ids1, page2: ids2 });
  check('history: the pages arrive newest first',
    (mine1.json?.gifts ?? []).every((g, i, all) => i === 0 || all[i - 1].createdAt >= g.createdAt),
    mine1.json?.gifts?.map((g) => g.createdAt));
  const foreign = await call('GET', `/gifts/history?limit=3&before=${animated.json?.transaction?.id}`, { token: B });
  check('history: a cursor belonging to somebody else reads nothing',
    foreign.status === 200 && (foreign.json?.gifts ?? []).length === 0, foreign.json?.gifts?.length);
  const scoped = await call('GET', `/gifts/history?limit=10&receiverId=${AID}`, { token: B });
  check('history: a receiver filter only ever returns that receiver',
    (scoped.json?.gifts ?? []).every((g) => g.receiver?.id === AID), scoped.json?.gifts?.length);
  const anon = await call('GET', '/gifts/history');
  check('history: the receipts belong to the signed-in member', anon.status === 401, code(anon));

  watcher.socket.close();
  listener.socket.close();

  // --- 9. the window closes on the clock, not on the client -----------------
  const windowMs = Number(rose.comboWindowMs || 5000);
  await sleep(windowMs + 400);
  const nextWindow = await call('POST', '/gifts/send', { token: B, body: { giftId: rose.id, receiverId: AID, quantity: 1, roomId, idempotencyKey: key(20) } });
  check(`combo: after the ${windowMs} ms window the counter starts again`,
    nextWindow.json?.combo?.count === 1 && nextWindow.json?.combo?.comboId !== combo3.json?.combo?.comboId,
    nextWindow.json?.combo);

  await call('DELETE', `/rooms/${secondRoom}`, { token: A }).catch(() => undefined);
  await call('DELETE', `/rooms/${roomId}`, { token: A }).catch(() => undefined);

  const failed = out.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${out.length - failed}/${out.length} live gift-engine checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  // The stack, not just the message: these checks chain through response bodies, and "reading 'id'"
  // is only actionable once it names the line.
  console.error('\nSUITE ABORTED:', err?.stack ?? err);
  process.exit(1);
});
