// Uses existing marked QA identities, API cleanup, and isolated save/restore for expiry simulation.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { isDeepStrictEqual: same } = require('node:util');
const { Pool } = require('pg');
const { io } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
const API = 'http://127.0.0.1:4000';
const QA = '6021e5a1-98f2-4241-81d8-6fe64dec1163';
const EXCLUDED = 'cdf056e0-25b5-47fd-ad1c-6e3d15aa7e64';
const RUN = `qa-bub-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const EVIDENCE = path.resolve('D:/vozia-runtime/qa-evidence', `${RUN}.json`);
const keys = Object.fromEntries(['paid', 'free', 'grant', 'probe', 'invalid'].map(k => [k, `${RUN}-${k}`]));
const trackedKeys = new Set(Object.values(keys));
const results = [];
const receipts = { purchases: [], grants: [], messages: [], roomId: null };
const sockets = new Set();
const expiryRestores = new Map();
const expectedChat = new Map();
const attemptedHosts = new Map();
const roomTitle = `QA bubbles ${RUN}`;
let env, pool, admin, member, originalWear, baseline;
let wearTouched = false;
let catalogueReady = false;
let paidReady = false;
let roomId, roomHost, chatSocket, chatReady = false;
let originalArt, editedArt;

class Stop extends Error {}
function check(name, pass, detail) {
  const row = { result: pass ? 'PASS' : 'FAIL', name, ...(detail ? { detail } : {}) };
  results.push(row);
  console.log(`${row.result} ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ''}`);
  return Boolean(pass);
}
function block(name, reason) {
  results.push({ result: 'BLOCKED', name, reason });
  console.log(`BLOCKED ${name} :: ${reason}`);
}
function need(name, pass, detail) {
  if (!check(name, pass, detail)) throw new Stop(`${name}: prerequisite failed`);
}
function safeError(err) {
  // Never emit arbitrary server messages, SQL detail, response objects, URLs or stacks.
  return err instanceof Stop ? err.message : `Unexpected ${err?.name || 'Error'} (sensitive details withheld)`;
}
async function phase(name, fn) {
  try { await fn(); } catch (err) { block(name, safeError(err)); }
}
const rows = async (sql, args = []) => (await pool.query(sql, args)).rows;
const one = async (sql, args = []) => (await rows(sql, args))[0];
const bodyFor = key => ({ kind: 'BUBBLE', key });
const art = row => Object.fromEntries(['key', 'name', 'background', 'accent', 'textColor', 'motif'].map(k => [k, row?.[k]]));
const bubbleBody = (key, changes = {}) => ({
  key, name: `QA bubble ${key}`, background: '#142235', accent: '#80CCFF', textColor: '#FFFFFF',
  motif: 'SPARKLE', forSale: true, priceDiamonds: 13, periodDays: 2, minVipLevel: 0,
  recommended: false, sortOrder: 9999, ...changes,
});
async function api(method, route, token, body) {
  const response = await fetch(API + route, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  let json;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}
function brief(r) {
  const code = r.json?.error?.code;
  return { status: r.status, ...(typeof code === 'string' && /^[a-z_]{1,70}$/.test(code) ? { code } : {}) };
}
function refused(name, r, status, code) {
  return check(name, r.status === status && (!code || r.json?.error?.code === code), brief(r));
}
async function success(name, method, route, token, body, status = 200) {
  const r = await api(method, route, token, body);
  need(name, r.status === status && !!r.json, brief(r));
  return r.json;
}
async function login(id, hostOnly = false) {
  if (id === EXCLUDED || (id !== QA && !hostOnly)) throw new Stop('Identity is outside the authorized QA scope');
  if (env.sms.provider !== 'mock' || env.isProduction) throw new Stop('OTP requires nonproduction mock SMS');
  const user = await one(`SELECT id, phone, is_test, qa_ref, status,
    EXISTS(SELECT 1 FROM role_applications r WHERE r.user_id=u.id AND r.role='HOST' AND r.status='APPROVED') AS host
    FROM users u WHERE id=$1`, [id]);
  if (!user?.is_test || (id === QA && !user.qa_ref) || (hostOnly && !user.host) || user.status === 'BANNED') {
    throw new Stop('Existing QA identity or approved QA HOST verification failed');
  }
  if (user.phone === env.admin.bootstrapPhone) throw new Stop('QA member must not use the admin bootstrap identity');
  const request = await api('POST', '/api/auth/request-otp', null, { phone: user.phone });
  if (request.status !== 200 || !request.json?.devCode) {
    throw new Stop(`QA OTP request blocked: HTTP ${request.status}; no mock code available`);
  }
  const signed = await api('POST', '/api/auth/verify-otp', null, { phone: user.phone, code: request.json.devCode });
  if (signed.status !== 200 || !signed.json?.token || signed.json?.created !== false || signed.json?.user?.id !== id) {
    throw new Stop(`Existing QA OTP login failed: HTTP ${signed.status}`);
  }
  return { id, token: signed.json.token };
}
async function wallet() {
  return one('SELECT diamond_balance, promo_diamond_balance, r_coin_balance FROM users WHERE id=$1', [QA]);
}
async function wear() {
  return one('SELECT chat_bubble_key, chat_bubble_expires_at::text AS expiry FROM users WHERE id=$1', [QA]);
}
async function held(key) {
  return one(`SELECT id, kind, item_key, acquired_via, transaction_id, expires_at::text AS expiry
    FROM user_items WHERE user_id=$1 AND kind='BUBBLE' AND item_key=$2`, [QA, key]);
}
async function purchaseRows() {
  return rows(`SELECT id, type, status, sender_id, receiver_id, amount_diamonds, amount_r_coins, meta
    FROM transactions WHERE sender_id=$1 AND type='ITEM_PURCHASE' AND meta->>'key'=ANY($2::text[]) ORDER BY id`,
  [QA, [...trackedKeys]]);
}
async function preserveSnapshot() {
  // Hash immutable pre-existing records without printing their contents or holding personal data.
  return one(`SELECT
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY t.id),'')) FROM transactions t
      WHERE t.sender_id=$1 OR t.receiver_id=$1) AS transactions,
    (SELECT md5(COALESCE(string_agg(row_to_json(c)::text, '' ORDER BY c.id),'')) FROM chat_messages c
      WHERE c.user_id=$1) AS messages,
    (SELECT md5(COALESCE(string_agg(row_to_json(i)::text, '' ORDER BY i.id),'')) FROM user_items i
      WHERE i.user_id=$1 AND NOT(i.kind='BUBBLE' AND i.item_key=ANY($2::text[]))) AS items,
    ARRAY(SELECT id::text FROM transactions WHERE sender_id=$1 OR receiver_id=$1) AS transaction_ids,
    ARRAY(SELECT id::text FROM chat_messages WHERE user_id=$1) AS message_ids`, [QA, [...trackedKeys]]);
}
async function verifyPreserved() {
  if (!baseline) return;
  const after = await one(`SELECT
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY t.id),'')) FROM transactions t
      WHERE t.id::text=ANY($1::text[])) AS transactions,
    (SELECT md5(COALESCE(string_agg(row_to_json(c)::text, '' ORDER BY c.id),'')) FROM chat_messages c
      WHERE c.id::text=ANY($2::text[])) AS messages,
    (SELECT md5(COALESCE(string_agg(row_to_json(i)::text, '' ORDER BY i.id),'')) FROM user_items i
      WHERE i.user_id=$3 AND NOT(i.kind='BUBBLE' AND i.item_key=ANY($4::text[]))) AS items`,
  [baseline.transaction_ids, baseline.message_ids, QA, [...trackedKeys]]);
  check('preservation: pre-existing QA receipts, chat and unrelated ownership unchanged',
    ['transactions', 'messages', 'items'].every(k => baseline[k] === after[k]));
}
async function equip(key, name = 'equip owned bubble') {
  wearTouched = true;
  const before = await wallet();
  const count = (await purchaseRows()).length;
  const data = await success(name, 'POST', '/api/store/equip', member.token, bodyFor(key));
  check(`${name}: free of charge and correct art`, data.user?.chatBubble?.key === key &&
    same(before, await wallet()) && (await purchaseRows()).length === count);
  return data.user;
}
async function unequip(name) {
  wearTouched = true;
  const data = await success(name, 'POST', '/api/store/unequip', member.token, { kind: 'BUBBLE' });
  check(`${name}: clears art and worn columns`, data.user?.chatBubble === null &&
    same(await wear(), { chat_bubble_key: null, expiry: null }));
}
async function createFixture(key, changes) {
  const data = await success(`catalogue: create ${key.split('-').at(-1)}`, 'POST', '/api/admin/bubbles',
    admin, bubbleBody(key, changes), 201);
  need('catalogue: POST returns {bubble} with exact BubbleArt', same(art(data.bubble), art(bubbleBody(key, changes))));
  return data.bubble;
}
async function updateFixture(key, changes, name) {
  const data = await success(name, 'PUT', `/api/admin/bubbles/${key}`, admin, changes);
  need(`${name}: PUT returns {bubble}`, data.bubble?.key === key);
  return data.bubble;
}
async function retire(key, name) {
  const holders = Number((await one("SELECT count(*)::int AS n FROM user_items WHERE kind='BUBBLE' AND item_key=$1", [key])).n);
  const r = await api('DELETE', `/api/admin/bubbles/${key}`, admin);
  check(name, r.status === 200 && same(r.json, { removed: { key, holders } }), { ...brief(r), holders });
}
async function ack(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(12000).emit(event, payload, (err, response) => {
      if (err) reject(new Stop(`Socket acknowledgement timed out: ${event}`));
      else resolve(response);
    });
  });
}
async function connect() {
  const socket = io(API, { auth: { token: member.token }, transports: ['websocket'],
    reconnection: false, autoConnect: false, forceNew: true, timeout: 12000 });
  sockets.add(socket);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', () => reject(new Stop('QA socket connection failed (details withheld)')));
    socket.connect();
  });
  const joined = await ack(socket, 'room:join', { roomId });
  need('socket: approved QA member joins own private test room', joined?.ok === true);
  return socket;
}
async function send(name, expected, forged = true) {
  const content = `${RUN}: ${name}`;
  let timer, listener;
  const broadcast = new Promise(resolve => {
    listener = message => { if (message?.content === content) { clearTimeout(timer); resolve(message); } };
    chatSocket.on('room:chat_message', listener);
    timer = setTimeout(() => resolve(null), 12000);
  });
  try {
    const injected = { key: keys.grant, name: 'Forged client bubble', background: '#FFFFFF',
      accent: '#FF0000', textColor: '#000000', motif: 'CROWN' };
    const response = await ack(chatSocket, 'room:chat', { roomId, message: content,
      ...(forged ? { bubble: injected, bubble_style: injected, chatBubble: injected, chat_bubble_key: keys.grant } : {}) });
    need(`chat: ${name} accepted`, response?.ok === true && !!response.message?.id);
    const message = response.message;
    receipts.messages.push(message.id);
    expectedChat.set(message.id, { bubble: expected, type: 'TEXT' });
    check(`chat: ${name} uses server-created snapshot, not forged payload`, same(message.bubble, expected) &&
      message.type === 'TEXT' && message.user?.id === QA && message.roomId === roomId);
    const event = await broadcast;
    check(`socket: ${name} broadcast equals acknowledgement`, same(event, message));
    const saved = await one('SELECT bubble_style, message_type FROM chat_messages WHERE id=$1 AND room_id=$2', [message.id, roomId]);
    check(`storage: ${name} saves exact snapshot`, saved?.message_type === 'TEXT' && same(saved?.bubble_style, expected));
    return message;
  } finally { clearTimeout(timer); chatSocket.off('room:chat_message', listener); }
}
async function history(name) {
  const data = await success(`history: ${name} HTTP read`, 'GET', `/api/rooms/${roomId}`, member.token);
  const chat = data.chat || [];
  check(`history: ${name} preserves every old plain/system/styled snapshot`, [...expectedChat].every(([id, expected]) => {
    const message = chat.find(m => m.id === id);
    return message?.type === expected.type && same(message?.bubble, expected.bubble);
  }));
}
async function restoreExpiry(key) {
  const saved = expiryRestores.get(key);
  if (!saved) return;
  const result = await pool.query(`UPDATE user_items SET expires_at=$4::timestamptz
    WHERE id=$1 AND user_id=$2 AND kind='BUBBLE' AND item_key=$3
      AND expires_at IS NOT DISTINCT FROM $5::timestamptz RETURNING id`,
  [saved.id, QA, key, saved.expiry, saved.simulated]);
  if (result.rowCount !== 1) throw new Stop(`Expiry restoration blocked by concurrent change: ${key}`);
  expiryRestores.delete(key);
  check('cleanup: isolated QA ownership expiry restored exactly', (await held(key)).expiry === saved.expiry);
}

async function preflight() {
  env = require(path.join(ROOT, 'dist/config/env.js')).env;
  need('safety: compiled env is nonproduction with mock SMS', env.sms.provider === 'mock' && !env.isProduction);
  pool = new Pool({ connectionString: env.databaseUrl, max: 2, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
  const identity = await one('SELECT is_test, qa_ref IS NOT NULL AS referenced FROM users WHERE id=$1', [QA]);
  need('safety: exact authorized QA member is marked and referenced', identity?.is_test === true && identity.referenced);
  const occupied = await rows('SELECT key FROM chat_bubbles WHERE key=ANY($1::text[])', [[...trackedKeys]]);
  need('safety: unique fixture keys do not already exist', occupied.length === 0);
  originalWear = await wear();
  if (originalWear.chat_bubble_key) {
    const owned = await held(originalWear.chat_bubble_key);
    const exists = await one('SELECT key FROM chat_bubbles WHERE key=$1', [originalWear.chat_bubble_key]);
    if (!owned || !exists || owned.expiry !== originalWear.expiry || (owned.expiry && Date.parse(owned.expiry) <= Date.now())) {
      throw new Stop('Existing QA bubble cannot be restored exactly through equip API; account left untouched');
    }
  }
  baseline = await preserveSnapshot();
  const signed = await api('POST', '/api/admin/login', null, { username: env.admin.username, password: env.admin.password });
  need('setup: admin login from compiled env (credentials withheld)', signed.status === 200 && !!signed.json?.token, brief(signed));
  admin = signed.json.token;
  member = await login(QA);
  check('setup: existing QA member OTP login; no new identity', member.id === QA);
}
async function catalogueTests() {
  originalArt = art(await createFixture(keys.paid));
  await createFixture(keys.free, { forSale: false, priceDiamonds: 0, periodDays: null, motif: 'NONE' });
  await createFixture(keys.grant, { priceDiamonds: 7, motif: 'CROWN' });
  await createFixture(keys.probe, { motif: 'HEART' });
  const decor = await success('catalogue: decor read', 'GET', '/api/admin/decor', admin);
  check('catalogue: decor includes bubbles and all four motifs', Array.isArray(decor.bubbles) &&
    [keys.paid, keys.free, keys.grant, keys.probe].every(k => decor.bubbles.some(b => b.key === k)));
  const shelf = await success('catalogue: member store read', 'GET', '/api/store', member.token);
  check('catalogue: paid BUBBLE shelf has exact art/pricing, free row not sold',
    same(shelf.items?.find(i => i.kind === 'BUBBLE' && i.key === keys.paid)?.bubble, originalArt) &&
    shelf.items?.find(i => i.key === keys.paid)?.priceDiamonds === 13 && !shelf.items?.some(i => i.key === keys.free));

  for (const [label, token, status] of [['unauthenticated', null, 401], ['member', member.token, 403]]) {
    for (const [method, route, body] of [
      ['GET', '/api/admin/decor'],
      ['POST', '/api/admin/bubbles', bubbleBody(keys.invalid)],
      ['PUT', `/api/admin/bubbles/${keys.probe}`, { name: 'QA unauthorized edit' }],
      ['DELETE', `/api/admin/bubbles/${keys.probe}`],
      ['GET', `/api/admin/bubbles/${keys.probe}/holders`],
      ['POST', `/api/admin/users/${QA}/grant`, bodyFor(keys.probe)],
    ]) refused(`auth: ${label} ${method} ${route.replace(keys.probe, ':key').replace(QA, ':qa')}`,
      await api(method, route, token, body), status);
  }
  for (const route of ['/api/store', '/api/store/purchase', '/api/store/equip', '/api/store/unequip']) {
    refused(`auth: unauthenticated ${route}`, await api(route === '/api/store' ? 'GET' : 'POST', route, null, route === '/api/store' ? undefined : bodyFor(keys.paid)), 401);
  }
  const invalidCases = [
    ['background hex', { background: '#123' }, 'bubble_background_invalid'],
    ['accent hex', { accent: '#GGGGGG' }, 'bubble_accent_invalid'],
    ['text hex', { textColor: 'white' }, 'bubble_text_color_invalid'],
    ['low contrast', { textColor: '#142235' }, 'bubble_contrast_invalid'],
    ['motif', { motif: 'RAINBOW' }, 'bubble_motif_invalid'],
  ];
  for (const [label, patch, code] of invalidCases) {
    refused(`validation: POST invalid ${label}`, await api('POST', '/api/admin/bubbles', admin, bubbleBody(keys.invalid, patch)), 400, code);
    refused(`validation: PUT invalid ${label}`, await api('PUT', `/api/admin/bubbles/${keys.paid}`, admin, patch), 400, code);
  }
  refused('catalogue: duplicate key', await api('POST', '/api/admin/bubbles', admin, bubbleBody(keys.paid)), 409, 'bubble_exists');
  refused('catalogue: key immutable', await api('PUT', `/api/admin/bubbles/${keys.paid}`, admin, { key: keys.invalid }), 400, 'bubble_key_immutable');
  const fresh = await success('catalogue: read after refused writes', 'GET', '/api/admin/decor', admin);
  check('catalogue: invalid writes have no effects', same(art(fresh.bubbles?.find(b => b.key === keys.paid)), originalArt) &&
    !fresh.bubbles?.some(b => b.key === keys.invalid) && fresh.bubbles?.some(b => b.key === keys.probe));
  const updated = await updateFixture(keys.probe, { name: `QA updated ${RUN}`, motif: 'NONE' }, 'catalogue: partial update');
  check('catalogue: partial update preserves colors/pricing', updated.name === `QA updated ${RUN}` && updated.motif === 'NONE' &&
    updated.background === '#142235' && updated.priceDiamonds === 13);
  await retire(keys.probe, 'catalogue: DELETE returns {removed:{key,holders}}');
  refused('catalogue: missing update', await api('PUT', `/api/admin/bubbles/${keys.probe}`, admin, { name: 'QA missing' }), 404, 'bubble_not_found');
  refused('catalogue: repeated delete', await api('DELETE', `/api/admin/bubbles/${keys.probe}`, admin), 404, 'bubble_not_found');
  catalogueReady = true;
}
async function setupChat() {
  const password = crypto.randomBytes(12).toString('hex');
  const create = async host => {
    attemptedHosts.set(host.id, host);
    roomHost = host;
    const r = await api('POST', '/api/rooms', host.token, { title: roomTitle, type: 'PRIVATE', category: 'CHAT', password,
      description: `QA bubble contract ${RUN}; preserve chat evidence` });
    if (r.json?.room?.id) { roomId = r.json.room.id; receipts.roomId = roomId; }
    return r;
  };
  let made = await create(member);
  if (made.status === 403 && made.json?.error?.code === 'role_approval_required') {
    check('room: host approval gate respected; no role/config edits', true);
    const host = await one(`SELECT u.id FROM users u WHERE u.is_test AND u.id<>$1 AND u.id<>$2
      AND u.status<>'BANNED' AND EXISTS(SELECT 1 FROM role_applications r WHERE r.user_id=u.id
        AND r.status='APPROVED' AND r.role='HOST') ORDER BY u.id LIMIT 1`, [EXCLUDED, QA]);
    if (!host) throw new Stop('HTTP 403 role_approval_required; no existing approved is_test HOST outside exclusive emulator user');
    made = await create(await login(host.id, true));
  }
  need('room: authorized QA host creates private test room', made.status === 201 && !!roomId, brief(made));
  await success('room: QA member joins through HTTP', 'POST', `/api/rooms/${roomId}/join`, member.token, { password });
  chatSocket = await connect();
  chatReady = true;
  await unequip('chat setup: start unstyled');
  await send('old plain before equip', null);
  const sys = await success('chat: audited system announcement', 'POST', `/api/admin/rooms/${roomId}/chat`, admin,
    { message: `${RUN}: system before equip`, bubble: originalArt });
  need('chat: system is unstyled even with client bubble', sys.message?.type === 'SYSTEM' && sys.message.bubble === null);
  expectedChat.set(sys.message.id, { type: 'SYSTEM', bubble: null });
  receipts.messages.push(sys.message.id);
}
async function commerceTests() {
  if (!catalogueReady) throw new Stop('Catalogue prerequisites unavailable');
  refused('ownership: paid bubble cannot equip without ownership', await api('POST', '/api/store/equip', member.token, bodyFor(keys.paid)), 403, 'item_not_owned');
  refused('ownership: free catalogue bubble still needs ownership', await api('POST', '/api/store/equip', member.token, bodyFor(keys.free)), 403, 'item_not_owned');
  const before = await wallet();
  const tooMuch = Number(before.diamond_balance) + Number(before.promo_diamond_balance) + 101;
  if (!Number.isSafeInteger(tooMuch) || tooMuch > 100000000) throw new Stop('QA balance exceeds safe insufficient-price ceiling; no balance changes attempted');
  await updateFixture(keys.paid, { priceDiamonds: tooMuch }, 'pricing: reprice above entire QA balance');
  const transactionsBefore = await purchaseRows();
  const broke = await api('POST', '/api/store/purchase', member.token, { ...bodyFor(keys.paid), priceDiamonds: 1, amountDiamonds: 1 });
  refused('pricing: forged cheap price cannot bypass insufficient balance', broke, 402, 'insufficient_balance');
  check('pricing: refusal quotes authoritative catalogue price', broke.json?.error?.details?.needed === tooMuch);
  check('pricing: refusal writes no ownership, debit or receipt', !await held(keys.paid) && same(before, await wallet()) && same(transactionsBefore, await purchaseRows()));
  await updateFixture(keys.paid, { priceDiamonds: 13 }, 'pricing: restore QA sale price');
  const policy = await one('SELECT value FROM system_config WHERE key=$1', ['accounts.promotional']);
  const configured = policy?.value?.usableFor;
  const valid = Array.isArray(configured) ? configured.filter(p => ['GIFT', 'BOX', 'STORE', 'GAME'].includes(p)) : [];
  if (valid.length && !valid.includes('STORE')) throw new Stop('STORE promo spending disabled; no paid funding or policy changes permitted');
  const funded = await success('funding: audited admin promo-grant only', 'POST', `/api/admin/users/${QA}/promo-grant`, admin,
    { amount: 26, days: 1, reason: `QA ${RUN}: two BUBBLE purchases; no real money; preserve receipts` }, 201);
  receipts.grants.push(funded.grant.id);
  const audit = await one(`SELECT count(*)::int AS n FROM admin_audit WHERE action='PROMO_GRANT' AND target_id=$1
    AND details->'grant'->>'id'=$2`, [QA, funded.grant.id]);
  check('funding: grant is attributable and audited with QA reason', funded.grant.amount === 26 &&
    funded.grant.sourceKind === 'ADMIN' && funded.grant.reason.includes(RUN) && audit.n === 1);
  const walletBefore = await wallet();
  const buy = await success('purchase: buy BUBBLE with forged client price', 'POST', '/api/store/purchase', member.token,
    { ...bodyFor(keys.paid), priceDiamonds: 1, amountDiamonds: 1, periodDays: null }, 201);
  receipts.purchases.push(buy.transaction.id);
  const first = await held(keys.paid);
  check('purchase: exact catalogue price, rental period, receipt and BubbleArt', buy.transaction.type === 'ITEM_PURCHASE' &&
    buy.transaction.amountDiamonds === 13 && buy.item.owned === true && buy.item.periodDays === 2 &&
    same(buy.item.bubble, originalArt) && first?.transaction_id === buy.transaction.id && first.acquired_via === 'PURCHASE' &&
    Date.parse(first.expiry) > Date.now() + 1.99 * 86400000 && Date.parse(first.expiry) < Date.now() + 2.01 * 86400000);
  const after = await wallet();
  check('purchase: promo only, purchased diamonds and R-coins unchanged', after.diamond_balance === walletBefore.diamond_balance &&
    after.r_coin_balance === walletBefore.r_coin_balance && after.promo_diamond_balance === walletBefore.promo_diamond_balance - 13);
  await equip(keys.paid, 'ownership: purchased bubble equips');
  if (chatReady) { await send('paid equipped', originalArt); await history('after equip'); }
  const renewal = await success('renewal: purchase same BUBBLE again', 'POST', '/api/store/purchase', member.token, bodyFor(keys.paid), 201);
  receipts.purchases.push(renewal.transaction.id);
  const second = await held(keys.paid);
  check('renewal: one ownership row, adds exactly two days, refreshes equipped expiry', second.id === first.id &&
    Date.parse(second.expiry) - Date.parse(first.expiry) === 2 * 86400000 &&
    Date.parse((await wear()).expiry) === Date.parse(second.expiry) && second.transaction_id === renewal.transaction.id && renewal.item.equipped === true);
  const transactions = await purchaseRows();
  check('receipts: both purchases immutable, authoritative amount and promo allocations', transactions.length === 2 &&
    transactions.every(t => t.status === 'COMPLETED' && t.amount_diamonds === 13 && t.amount_r_coins === 0 &&
      t.sender_id === QA && t.receiver_id === null && t.meta.kind === 'BUBBLE' && t.meta.promoDiamonds === 13));
  const holders = await success('ownership: admin holders read', 'GET', `/api/admin/bubbles/${keys.paid}/holders`, admin);
  check('ownership: exactly one QA holder after renewal', holders.holders?.length === 1 && holders.holders[0].userId === QA);
  paidReady = true;
}
async function expiryTests() {
  if (!paidReady) throw new Stop('Purchased bubble prerequisite unavailable');
  await equip(keys.paid, 'expiry setup: wear live rental');
  const saved = await held(keys.paid);
  const simulated = new Date(Date.now() - 86400000).toISOString();
  expiryRestores.set(keys.paid, { ...saved, simulated });
  try {
    const changed = await pool.query(`UPDATE user_items SET expires_at=$4::timestamptz
      WHERE id=$1 AND user_id=$2 AND kind='BUBBLE' AND item_key=$3
        AND expires_at IS NOT DISTINCT FROM $5::timestamptz RETURNING id`,
    [saved.id, QA, keys.paid, simulated, saved.expiry]);
    need('expiry: only isolated QA ownership timestamp simulated', changed.rowCount === 1);
    refused('expiry: expired owned BUBBLE refuses equip', await api('POST', '/api/store/equip', member.token, bodyFor(keys.paid)), 403, 'item_expired');
    const store = await success('expiry: read store', 'GET', '/api/store', member.token);
    const item = store.items?.find(i => i.key === keys.paid);
    check('expiry: expired copy is neither owned nor equipped in store', item?.owned === false && item.equipped === false &&
      !store.owned?.some(i => i.kind === 'BUBBLE' && i.key === keys.paid));
    check('expiry: denormalized user timestamp deliberately left live', Date.parse((await wear()).expiry) === Date.parse(saved.expiry));
    if (chatReady) { await send('expired ownership despite live user timestamp', null); await history('after expiry'); }
  } finally { await restoreExpiry(keys.paid); }
  await equip(keys.paid, 'expiry cleanup: restored rental equips');
}
async function grantTests() {
  if (!catalogueReady) throw new Stop('Catalogue prerequisite unavailable');
  const before = await wallet();
  const transactionsBefore = await purchaseRows();
  refused('free: off-sale zero-price bubble cannot be purchased', await api('POST', '/api/store/purchase', member.token, bodyFor(keys.free)), 400, 'item_not_for_sale');
  const free = await success('free: admin grants free catalogue bubble', 'POST', `/api/admin/users/${QA}/grant`, admin, bodyFor(keys.free), 201);
  check('free: grant is owned permanently without a purchase', free.item.owned === true && free.item.expiresAt === null &&
    (await held(keys.free))?.transaction_id === null);
  await equip(keys.free, 'free: granted bubble equips without charge');
  if (chatReady) await send('free grant equipped', art(bubbleBody(keys.free, { forSale: false, priceDiamonds: 0, periodDays: null, motif: 'NONE' })));
  const grant = await success('grant: permanent override on rental catalogue bubble', 'POST', `/api/admin/users/${QA}/grant`, admin,
    { ...bodyFor(keys.grant), days: null }, 201);
  const item = await held(keys.grant);
  check('grant: days null creates ADMIN_GRANT, no expiry or money receipt', grant.item.owned === true && grant.item.expiresAt === null &&
    item?.expiry === null && item.acquired_via === 'ADMIN_GRANT' && item.transaction_id === null);
  await equip(keys.grant, 'grant: permanent BUBBLE equips');
  check('grant: user expiry is permanent', (await wear()).expiry === null);
  if (chatReady) await send('permanent grant equipped', art(bubbleBody(keys.grant, { priceDiamonds: 7, motif: 'CROWN' })));
  check('grant: free/permanent grants and equips create no debit', same(before, await wallet()) && same(transactionsBefore, await purchaseRows()));
  const audit = await one(`SELECT count(*)::int AS n FROM admin_audit WHERE action='ITEM_GRANT' AND target_id=$1
    AND details->>'kind'='BUBBLE' AND details->>'key'=ANY($2::text[])`, [QA, [keys.free, keys.grant]]);
  check('grant: both item grants audited', audit.n === 2);
}
async function immutableTests() {
  if (!paidReady) throw new Stop('Purchased bubble prerequisite unavailable');
  await equip(keys.paid, 'snapshot setup: wear original paid art');
  if (chatReady) await send('before unequip', originalArt);
  await unequip('snapshot: unequip');
  if (chatReady) { await send('after unequip forged bubble', null); await history('after unequip'); }
  await equip(keys.paid, 'snapshot: re-equip');
  const changed = { name: `QA edited ${RUN}`, background: '#FFF3D6', accent: '#885500', textColor: '#201600', motif: 'HEART' };
  editedArt = art(await updateFixture(keys.paid, changed, 'snapshot: operator edits live style'));
  if (chatReady) { await send('after style edit', editedArt); await history('after style edit'); }
  const receiptBefore = await held(keys.paid);
  const transactionsBefore = await purchaseRows();
  await retire(keys.paid, 'retirement: owned bubble DELETE names one retained holder');
  const store = await success('retirement: store read', 'GET', '/api/store', member.token);
  check('retirement: item off shelf, ownership receipt retained', !store.items?.some(i => i.key === keys.paid) &&
    store.owned?.some(i => i.kind === 'BUBBLE' && i.key === keys.paid && i.onSale === false) && same(receiptBefore, await held(keys.paid)));
  refused('retirement: re-equip returns item_retired', await api('POST', '/api/store/equip', member.token, bodyFor(keys.paid)), 404, 'item_retired');
  refused('retirement: purchase returns item_not_found', await api('POST', '/api/store/purchase', member.token, bodyFor(keys.paid)), 404, 'item_not_found');
  const me = await success('retirement: member DTO read', 'GET', '/api/auth/me', member.token);
  check('retirement: current DTO loses art without destroying worn key/receipts', me.user?.chatBubble === null &&
    (await wear()).chat_bubble_key === keys.paid && same(transactionsBefore, await purchaseRows()));
  if (chatReady) {
    await send('after retirement forged bubble', null);
    await history('after retirement');
    chatSocket.disconnect();
    chatSocket = await connect();
    await history('after reconnect');
  }
}
async function cleanup() {
  for (const key of expiryRestores.keys()) await phase(`cleanup expiry ${key}`, () => restoreExpiry(key));
  if (wearTouched && member && originalWear) await phase('cleanup original QA outfit', async () => {
    const route = originalWear.chat_bubble_key ? '/api/store/equip' : '/api/store/unequip';
    await success('cleanup: restore original QA bubble via API', 'POST', route, member.token,
      originalWear.chat_bubble_key ? bodyFor(originalWear.chat_bubble_key) : { kind: 'BUBBLE' });
    check('cleanup: original QA worn key/expiry preserved', same(await wear(), originalWear));
  });
  for (const socket of sockets) socket.disconnect();
  if (pool && attemptedHosts.size) await phase('cleanup own test room', async () => {
    // Also recover a room committed before a failed HTTP response; never touch any other title/host.
    const ownRooms = await rows('SELECT id, host_id, status FROM rooms WHERE title=$1 AND host_id=ANY($2::uuid[])',
      [roomTitle, [...attemptedHosts.keys()]]);
    for (const room of ownRooms) {
      receipts.roomId = room.id;
      if (room.status !== 'CLOSED') await success('cleanup: close own QA test room via API', 'POST',
        `/api/rooms/${room.id}/close`, attemptedHosts.get(room.host_id).token, {});
      check('cleanup: QA room closed with history retained', (await one('SELECT status FROM rooms WHERE id=$1', [room.id]))?.status === 'CLOSED');
    }
  });
  if (admin && pool) {
    // Each retirement is independent: a failed fixture must not stop retirement of the others.
    for (const key of trackedKeys) await phase(`cleanup retirement ${key}`, async () => {
      if (await one('SELECT key FROM chat_bubbles WHERE key=$1', [key])) await retire(key, `cleanup: retire ${key.split('-').at(-1)}`);
    });
    await phase('cleanup catalogue verification', async () => {
      const left = await rows('SELECT key FROM chat_bubbles WHERE key=ANY($1::text[])', [[...trackedKeys]]);
      check('cleanup: no run-specific catalogue fixtures remain', left.length === 0, { remainingKeys: left.map(r => r.key) });
      const purchaseIds = (await purchaseRows()).map(t => t.id);
      check('cleanup: new QA purchase receipts retained', receipts.purchases.every(id => purchaseIds.includes(id)));
      if (receipts.messages.length) {
        const messages = await rows('SELECT id FROM chat_messages WHERE id=ANY($1::uuid[])', [receipts.messages]);
        check('cleanup: all new QA chat/system history retained', messages.length === receipts.messages.length);
      }
    });
  }
  if (pool) await phase('preservation verification', verifyPreserved);
}
async function main() {
  try {
    if (process.argv.includes('--evidence') && !fs.statSync(path.dirname(EVIDENCE)).isDirectory()) {
      throw new Stop('Existing QA evidence parent directory required');
    }
    await preflight();
    await phase('catalogue and validation prerequisites', catalogueTests);
    await phase('chat setup', setupChat);
    await phase('commerce and ownership', commerceTests);
    await phase('expiry simulation', expiryTests);
    await phase('free and permanent grants', grantTests);
    await phase('immutability and retirement', immutableTests);
    if (!chatReady) block('socket/chat coverage',
      'Not exercised: forged payloads; send-time snapshots; saved style after unequip/edit/expiry/retirement; plain/system history; reconnect');
  } catch (err) { block('preflight/run', safeError(err)); }
  finally {
    try { await cleanup(); } catch (err) { block('cleanup', safeError(err)); }
    if (pool) await pool.end().catch(() => block('pool shutdown', 'Failed to close QA test database connection'));
  }
  const totals = { passed: results.filter(r => r.result === 'PASS').length,
    failed: results.filter(r => r.result === 'FAIL').length, blocked: results.filter(r => r.result === 'BLOCKED').length };
  const summary = { suite: 'bubbles-e2e', run: RUN, api: API, qaUserId: QA, finishedAt: new Date().toISOString(),
    totals, receipts, fixtureKeys: [...trackedKeys], results };
  if (process.argv.includes('--evidence')) {
    try {
      fs.writeFileSync(EVIDENCE, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
      console.log(`Evidence: ${EVIDENCE}`);
    } catch { block('evidence', 'Could not save redacted result to existing QA evidence directory'); totals.blocked += 1; }
  }
  console.log(`bubbles-e2e: ${totals.passed} passed, ${totals.failed} failed, ${totals.blocked} blocked`);
  process.exitCode = totals.failed ? 1 : totals.blocked ? 2 : 0;
}
main().catch(() => { console.error('bubbles-e2e fatal error (sensitive details withheld)'); process.exitCode = 2; });
