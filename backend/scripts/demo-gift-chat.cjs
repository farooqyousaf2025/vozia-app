/* Gives the two seeded demo hosts a real avatar_url and a funded wallet so the
   Android app on the emulator shows gift icons and avatars over the same
   root-relative URLs a production client would receive.

     node scripts/demo-gift-chat.cjs [phone]

   The phone argument is the account under test; it requests an OTP the same way
   a client does and prints the dev code, so the emulator login is one copy/paste. */
const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const path = require('node:path');
const { Pool } = require('pg');

const phone = process.argv[2] || '+15550000010';
if (!/^\+\d{7,15}$/.test(phone)) {
  console.error('pass an E.164 phone, e.g. +15550000010');
  process.exit(1);
}

const db = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://voiza:voiza@127.0.0.1:5432/voiza', max: 2 });

async function api(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  // 1. Make sure the account exists and can pay for gifts.
  const otp = await api('POST', '/api/auth/request-otp', { body: { phone } });
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: otp.body.devCode, username: 'demo_viewer' } });
  const token = verified.body.token;
  const funded = await api('POST', '/api/wallet/recharge', { token, body: { amountDiamonds: 5000 } });

  // 2. Seed the two hosts with relative avatar URLs (same shape the app must resolve).
  const hosts = await db.query(
    `UPDATE users SET avatar_url = CASE username WHEN 'nova_host' THEN '/avatars/host-nova.png'
                                   WHEN 'echo_dj'    THEN '/avatars/host-echo.png' END
     WHERE username IN ('nova_host','echo_dj') RETURNING username, avatar_url`,
  );

  // 3. Put the seeded host (the account that owns the relative avatar URL) in a
  // room, then send it gifts from the account under test. The host is reached
  // through the same dev-OTP login a real client uses — no SQL backdoor.
  const hostRow = (await db.query("SELECT id, username, phone, avatar_url FROM users WHERE username = 'nova_host'")).rows[0];
  if (!hostRow) throw new Error('database/seed.sql has not been applied (no nova_host row)');
  const hostOtp = await api('POST', '/api/auth/request-otp', { body: { phone: hostRow.phone } });
  const hostLogin = await api('POST', '/api/auth/verify-otp', {
    body: { phone: hostRow.phone, code: hostOtp.body.devCode },
  });
  const hostToken = hostLogin.body.token;

  const listed = await api('GET', '/api/rooms?limit=5', { token: hostToken });
  const existing = (listed.body.rooms || []).find((r) => r.status === 'OPEN');
  const room = existing
    ? existing
    : (await api('POST', '/api/rooms', { token: hostToken, body: { title: 'Placeholder Art Room', category: 'CHAT', seatCapacity: 6 } })).body.room;
  if (!room) throw new Error('could not find an open room or create one');
  const hostJoin = await api('POST', `/api/rooms/${room.id}/join`, { token: hostToken });
  const hostSeat = await api('POST', `/api/rooms/${room.id}/seat`, { token: hostToken, body: { seatIndex: 0 } });
  const joined = await api('POST', `/api/rooms/${room.id}/join`, { token });
  const seat = await api('POST', `/api/rooms/${room.id}/seat`, { token, body: { seatIndex: 1 } });

  const gifts = await api('GET', '/api/gifts', { token });
  // Three cheap catalogue entries — the sender only holds 5000 diamonds, and
  // `/api/gifts` hides inactive rows (Rose is seeded inactive on purpose).
  const picks = [...((gifts.body && gifts.body.gifts) || [])].sort((a, b) => a.diamondPrice - b.diamondPrice).slice(0, 3);
  const sent = [];
  for (const gift of picks) {
    const r = await api('POST', '/api/gifts/send', {
      token,
      body: { roomId: room.id, receiverId: hostRow.id, giftId: gift.id, quantity: 1 },
    });
    sent.push(`${gift.name}:${r.status}`);
  }
  // Chat is socket-only (room.routes.ts has no REST chat endpoint), so fan the
  // line out over the same Socket.IO transport a client uses.
  const io = require('socket.io-client');
  const socket = io(API, { transports: ['websocket'], forceNew: true, auth: { token } });
  const chat = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 8000);
    socket.on('connect', () => socket.emit('room:join', { roomId: room.id }, () => {
      socket.emit('room:chat', { roomId: room.id, message: 'placeholder art check' }, (ack) => {
        clearTimeout(timer);
        socket.close();
        resolve(ack);
      });
    }));
  });

  console.log(JSON.stringify({
    devOtpCode: otp.body.devCode,
    phone,
    recharge: funded.status,
    hosts: hosts.rows,
    room: { id: room.id, number: room.number ?? room.roomNumber, title: room.title },
    host: { join: hostJoin.status, seat: `${hostSeat.status} ${hostSeat.body && hostSeat.body.error ? hostSeat.body.error.code : ''}`.trim() },
    joined: joined.status,
    seat: seat.status,
    giftsSent: sent,
    chat,
  }, null, 1));
  await db.end();
})().catch((e) => { console.error('DEMO SETUP CRASH', e); process.exit(1); });
