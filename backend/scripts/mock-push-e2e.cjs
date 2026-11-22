#!/usr/bin/env node
/** Verify mock push events use the authenticated private user channel and never call FCM. */
const http = require('http');
const path = require('path');
const { io: createClient } = require('socket.io-client');

const BE_ROOT = path.resolve(__dirname, '..');
process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
process.env.NODE_ENV = 'development';

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const stamp = Date.now().toString().slice(-7);
const output = [];
let failures = 0;
let ioServer;
let httpServer;
const clients = [];

function check(name, pass, detail) {
  output.push((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : ' :: ' + JSON.stringify(detail)));
  if (!pass) failures += 1;
}

async function api(method, route, body) {
  const response = await fetch(API + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { /* empty response */ }
  return { status: response.status, json };
}

async function login(suffix) {
  const phone = '+15557' + stamp + suffix;
  const challenge = await api('POST', '/api/auth/request-otp', { phone });
  if (challenge.status !== 200) throw new Error('OTP request failed: ' + JSON.stringify(challenge.json));
  const signed = await api('POST', '/api/auth/verify-otp', {
    phone,
    code: challenge.json.devCode || '123456',
    username: 'mock_push_' + stamp + '_' + suffix,
  });
  if (signed.status !== 200 || !signed.json?.token || !signed.json?.user?.id) {
    throw new Error('OTP verification failed: ' + JSON.stringify(signed.json));
  }
  return { token: signed.json.token, userId: signed.json.user.id };
}

function connectUser(token) {
  return new Promise((resolve, reject) => {
    const socket = createClient('http://127.0.0.1:' + httpServer.address().port, {
      auth: { token },
      transports: ['websocket'],
      timeout: 5000,
      reconnection: false,
    });
    clients.push(socket);
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 7000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  // Resolve the app's signed tokens first; this server uses the same verifier and JWT secret.
  const recipient = await login('01');
  const other = await login('02');
  const unrelated = await login('03');

  const { initSocket } = require(path.join(BE_ROOT, 'dist/services/socket.service.js'));
  const { pushToUser } = require(path.join(BE_ROOT, 'dist/services/push.service.js'));

  httpServer = http.createServer();
  ioServer = initSocket(httpServer);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });

  const [recipientSocket, otherSocket, unrelatedSocket] = await Promise.all([
    connectUser(recipient.token),
    connectUser(other.token),
    connectUser(unrelated.token),
  ]);

  const received = { recipient: [], other: [], unrelated: [] };
  recipientSocket.on('push:mock', (event) => received.recipient.push(event));
  otherSocket.on('push:mock', (event) => received.other.push(event));
  unrelatedSocket.on('push:mock', (event) => received.unrelated.push(event));

  // Count all fetches after login/socket setup: mock delivery must not contact OAuth or FCM.
  const originalFetch = global.fetch;
  let externalFetches = 0;
  global.fetch = (...args) => { externalFetches += 1; return originalFetch(...args); };

  const message = {
    title: 'Mock notification test',
    body: 'Private delivery check',
    data: { type: 'direct_message', partnerId: other.userId },
  };
  try {
    await pushToUser(recipient.userId, message);
    await delay(300);
  } finally {
    global.fetch = originalFetch;
  }

  check('mock push reaches the intended authenticated user',
    received.recipient.length === 1
      && received.recipient[0].title === message.title
      && received.recipient[0].body === message.body
      && received.recipient[0].data?.partnerId === other.userId,
    received.recipient);
  check('mock push is not broadcast to another signed-in user', received.other.length === 0, received.other);
  check('mock push is not broadcast to an unrelated signed-in user', received.unrelated.length === 0, received.unrelated);
  check('mock push makes no OAuth or FCM network request', externalFetches === 0, { externalFetches });
})().catch((error) => {
  output.push('FAIL  suite completed without an unexpected exception :: ' + (error && error.message));
  failures += 1;
}).finally(async () => {
  clients.forEach((client) => client.disconnect());
  if (ioServer) await new Promise((resolve) => ioServer.close(resolve));
  else if (httpServer?.listening) await new Promise((resolve) => httpServer.close(resolve));
  try {
    const { closePool } = require(path.join(BE_ROOT, 'dist/config/db.js'));
    const { closeRedis } = require(path.join(BE_ROOT, 'dist/config/redis.js'));
    await Promise.allSettled([closePool(), closeRedis()]);
  } catch { /* imports may not have initialized their clients */ }
  output.forEach((line) => console.log(line));
  if (failures) process.exitCode = 1;
});
