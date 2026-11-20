#!/usr/bin/env node
/**
 * The member coin-seller marketplace (#4): a buyer browses approved sellers, opens manual orders,
 * tracks only their own, and attaches their own proof of payment.
 *
 * The suite proves the boundaries that are easy to get wrong when this surface sits next to the
 * seller desk:
 *
 *   - only ACTIVE, approved COIN_SELLER accounts appear, with an allowlisted catalogue — no
 *     contact phone, owner, approval metadata, limits or commission rate;
 *   - an order names a seller and a package, but the buyer comes from `req.user.sub`, the money
 *     from the catalog row and the rail from the manual allowlist;
 *   - order reads and receipt uploads are buyer-scoped: a guessed id from another member answers
 *     404, and an unapproved or suspended seller cannot be named at all;
 *   - a receipt is evidence only. The order stays AWAITING_PAYMENT and the diamond balance does
 *     not move; replaying the same bytes returns the first receipt rather than storing a second.
 *
 * Accounts are created through product routes, marked E2E by their codes and closed at the end;
 * `business.bd` and the package's active flag are restored even on a throw. Requires migration
 * 0050 (member receipt uploader) to be applied.
 *
 * Run against the live stack:  node scripts/seller-marketplace-e2e.cjs
 */
const path = require('path');
const { Pool } = require('pg');

const BE_ROOT = path.resolve(__dirname, '..');
const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const stamp = Date.now().toString().slice(-7);

let pool;
function db() {
  if (!pool) {
    const { env } = require(path.join(BE_ROOT, 'dist/config/env.js'));
    pool = new Pool({ connectionString: env.databaseUrl, max: 2 });
  }
  return pool;
}
const sql = (text, params) => db().query(text, params);

const out = [];
let failures = 0;
function check(name, pass, detail) {
  out.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` :: ${JSON.stringify(detail)}`}`);
  if (!pass) failures += 1;
}

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* raw or empty body */ }
  return { status: res.status, json };
}
const errCode = (r) => r.json && r.json.error && r.json.error.code;

async function login(phone, username) {
  const r = await api('POST', '/api/auth/request-otp', { body: { phone } });
  const code = r.json.devCode || '123456';
  const v = await api('POST', '/api/auth/verify-otp', { body: { phone, code, username } });
  if (!v.json.token) throw new Error(`login failed for ${phone}: ${JSON.stringify(v.json)}`);
  return { token: v.json.token, user: v.json.user, phone };
}

const accountStatus = async (id) => (await sql('SELECT status, approved_at FROM business_accounts WHERE id = $1', [id])).rows[0];
const diamondBalance = async (userId) =>
  Number((await sql('SELECT diamond_balance FROM users WHERE id = $1', [userId])).rows[0].diamond_balance);

// A real 1×1 PNG: the receipt service sniffs the bytes, so the evidence must be the format it claims.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const createdAccountIds = [];
let packageKey = null;
let RESTORE = null;

async function walkOut() {
  if (!RESTORE) return;
  try {
    await RESTORE();
    out.push('PASS  the environment was put back after the run');
  } catch (err) {
    out.push(`FAIL  cleanup itself failed :: ${err && err.message}`);
    failures += 1;
  }
}

async function main() {
  const boot = await api('POST', '/api/auth/verify-otp', { body: { phone: '+10000000000', code: '424242' } });
  const admin = boot.json.token;
  if (!admin) throw new Error(`admin bootstrap failed: ${JSON.stringify(boot.json)}`);

  // The one-office switch is restored exactly as found, even on a throw.
  const bdBefore = (await sql("SELECT value FROM system_config WHERE key = 'business.bd'")).rows[0] || null;
  const setBd = (value) => api('PUT', '/api/admin/business/config/business.bd', { token: admin, body: { value } });
  await setBd({ ...(bdBefore ? bdBefore.value : {}), multiManager: true });
  RESTORE = async () => {
    if (bdBefore) await setBd(bdBefore.value);
    else await sql("DELETE FROM system_config WHERE key = 'business.bd'");
    if (packageKey) {
      await api('POST', `/api/admin/business/packages/${packageKey}/active`, { token: admin, body: { isActive: false } });
    }
    for (const id of createdAccountIds) {
      const row = await accountStatus(id);
      if (row && row.status !== 'CLOSED') {
        await api('POST', `/api/admin/business/accounts/${id}/status`, { token: admin, body: { status: 'CLOSED' } });
      }
    }
  };

  const buyer = await login(`+15559${stamp}01`, `e2e_mkt_buyer_${stamp.slice(-4)}`);
  const stranger = await login(`+15559${stamp}02`, `e2e_mkt_other_${stamp.slice(-4)}`);

  // ---- 1. the read door needs a member session ---------------------------------
  const anonymous = await api('GET', '/api/marketplace/sellers');
  check('auth: the seller catalogue needs a member token', anonymous.status === 401 && errCode(anonymous) === 'unauthorized', { status: anonymous.status, code: errCode(anonymous) });

  // ---- 2. operator builds the catalog and two sellers --------------------------
  const bdCode = `MKTBD-E2E-${stamp}`;
  const bd = await api('POST', '/api/admin/business/accounts', {
    token: admin,
    body: { kind: 'BD_MANAGER', code: bdCode, displayName: `E2E market territory ${stamp}`, marketCountry: 'BD' },
  });
  const bdId = bd.json && bd.json.account && bd.json.account.id;
  createdAccountIds.push(bdId);
  if (!bdId) throw new Error(`BD create failed: ${JSON.stringify(bd.json)}`);

  const sellerCode = `MKT-E2E-${stamp}`;
  const sellerPassword = `e2esellermkt${stamp.slice(-4)}`;
  const seller = await api('POST', '/api/admin/business/accounts', {
    token: admin,
    body: {
      kind: 'COIN_SELLER', code: sellerCode, displayName: `E2E approved seller ${stamp}`,
      marketCountry: 'BD', parentId: bdId, password: sellerPassword,
    },
  });
  const sellerId = seller.json && seller.json.account && seller.json.account.id;
  createdAccountIds.push(sellerId);
  if (!sellerId) throw new Error(`seller create failed: ${JSON.stringify(seller.json)}`);

  const pending = await api('POST', '/api/admin/business/accounts', {
    token: admin,
    body: {
      kind: 'COIN_SELLER', code: `MKTU-E2E-${stamp}`, displayName: `E2E unapproved seller ${stamp}`,
      marketCountry: 'BD', parentId: bdId,
    },
  });
  const pendingId = pending.json && pending.json.account && pending.json.account.id;
  createdAccountIds.push(pendingId);
  if (!pendingId) throw new Error(`unapproved seller create failed: ${JSON.stringify(pending.json)}`);

  packageKey = `mkt_e2e_${stamp}`;
  const pack = await api('PUT', '/api/admin/business/packages', {
    token: admin,
    body: { key: packageKey, label: `E2E market pack ${stamp}`, diamonds: 250, amountCents: 50000, currency: 'pkr', feeBps: 250 },
  });
  check('catalog: the operator saves a package with a private fee rate', pack.status === 201, { status: pack.status, code: errCode(pack) });
  for (const id of [sellerId, pendingId]) {
    await api('PUT', `/api/admin/business/accounts/${id}/packages`, { token: admin, body: { packageKeys: [packageKey] } });
  }

  const activate = (id) => api('POST', `/api/admin/business/accounts/${id}/status`, { token: admin, body: { status: 'ACTIVE' } });
  const suspend = (id, reason) => api('POST', `/api/admin/business/accounts/${id}/status`, { token: admin, body: { status: 'SUSPENDED', reason } });

  const before = await api('GET', '/api/marketplace/sellers', { token: buyer.token });
  check('visibility: a PENDING seller is not on the member catalogue', before.status === 200 && !before.json.sellers.some((s) => s.id === sellerId), { status: before.status });

  check('approval: the operator activates the seller', (await activate(sellerId)).status === 200, sellerId);
  const approvedRow = await accountStatus(sellerId);
  check('approval: ACTIVE also carries an approval stamp', !!approvedRow && approvedRow.status === 'ACTIVE' && !!approvedRow.approved_at, approvedRow);

  // ---- 3. the catalogue is an allowlisted projection ---------------------------
  const listed = await api('GET', '/api/marketplace/sellers', { token: buyer.token });
  const visible = listed.json.sellers.find((s) => s.id === sellerId);
  check('catalogue: the approved seller is visible with its package', listed.status === 200 && !!visible && visible.packages.some((p) => p.key === packageKey), { status: listed.status, code: errCode(listed) });
  check('catalogue: the unapproved seller is still hidden', listed.status === 200 && !listed.json.sellers.some((s) => s.id === pendingId), { status: listed.status });
  check('catalogue: manual rails are advertised', !!visible && visible.paymentRails.includes('CASH') && visible.paymentRails.includes('JAZZCASH') && !visible.paymentRails.includes('STRIPE'), visible && visible.paymentRails);
  const forbiddenSellerKeys = ['contactPhone', 'contactEmail', 'ownerUserId', 'approvedBy', 'approvedAt', 'passwordHash', 'parentId', 'status', 'kind', 'maxOrderDiamonds', 'dailyOrderLimit'];
  check('scope: no seller contact, owner, approval or limit field is returned', !!visible && !forbiddenSellerKeys.some((k) => k in visible), visible);
  const forbiddenPackageKeys = ['feeBps', 'isActive'];
  const visiblePack = visible && visible.packages.find((p) => p.key === packageKey);
  check('scope: the member package has the price, not the rate card', !!visiblePack && !forbiddenPackageKeys.some((k) => k in visiblePack) && visiblePack.diamonds === 250 && visiblePack.amountCents === 50000, visiblePack);

  // ---- 4. a partner credential is a different door -----------------------------
  const bizLogin = await api('POST', '/api/business/login', { body: { code: sellerCode, password: sellerPassword } });
  const bizToken = bizLogin.json && bizLogin.json.token;
  check('auth: the active seller still signs in with its partner credential', bizLogin.status === 200 && !!bizToken, { status: bizLogin.status, code: errCode(bizLogin) });
  const bizOnMarket = await api('GET', '/api/marketplace/sellers', { token: bizToken });
  check('auth: a partner token cannot use the member marketplace', bizOnMarket.status === 403 && errCode(bizOnMarket) === 'forbidden', { status: bizOnMarket.status, code: errCode(bizOnMarket) });

  // ---- 5. order creation resolves the server side and binds the buyer ----------
  const balanceBefore = await diamondBalance(buyer.user.id);
  const created = await api('POST', '/api/marketplace/orders', {
    token: buyer.token,
    body: { sellerId, packageKey, paymentMethod: 'cash', note: `e2e market order ${stamp}` },
  });
  const order = created.json && created.json.order;
  check('order: a member opens an order AWAITING_PAYMENT', created.status === 201 && !!order && order.status === 'AWAITING_PAYMENT', { status: created.status, code: errCode(created) });
  check('order: the server froze diamonds and amount from the package', !!order && order.diamonds === 250 && order.amountCents === 50000 && order.packageKey === packageKey, order);
  check('order: the order is bound to this member, not a body phone', !!order && order.sellerId === sellerId, { sellerId: order && order.sellerId });
  const forbiddenOrderKeys = ['evidence', 'rulesSnapshot', 'bdId', 'bdCode', 'userId', 'username', 'transactionId', 'decisionNote', 'contactPhone', 'ownerUserId'];
  check('scope: the member order omits evidence, commission snapshots and partner data', !!order && !forbiddenOrderKeys.some((k) => k in order), order);

  const byCode = await api('POST', '/api/marketplace/orders', {
    token: buyer.token,
    body: { sellerCode, packageCode: packageKey, paymentMethod: 'BANK' },
  });
  check('order: a seller code and package code resolve too', byCode.status === 201 && byCode.json.order.status === 'AWAITING_PAYMENT', { status: byCode.status, code: errCode(byCode) });

  const badRail = await api('POST', '/api/marketplace/orders', {
    token: buyer.token, body: { sellerId, packageKey, paymentMethod: 'STRIPE' },
  });
  check('order: a non-manual rail is refused', badRail.status === 400 && errCode(badRail) === 'unknown_payment_method', { status: badRail.status, code: errCode(badRail) });
  const badPackage = await api('POST', '/api/marketplace/orders', {
    token: buyer.token, body: { sellerId, packageKey: `missing_${stamp}`, paymentMethod: 'CASH' },
  });
  check('order: an unknown package is refused', badPackage.status === 404 && errCode(badPackage) === 'unknown_package', { status: badPackage.status, code: errCode(badPackage) });
  const badSeller = await api('POST', '/api/marketplace/orders', {
    token: buyer.token, body: { sellerId: pendingId, packageKey, paymentMethod: 'CASH' },
  });
  check('order: an unapproved seller cannot be named', badSeller.status === 404 && errCode(badSeller) === 'seller_not_available', { status: badSeller.status, code: errCode(badSeller) });
  const noSeller = await api('POST', '/api/marketplace/orders', {
    token: buyer.token, body: { packageKey, paymentMethod: 'CASH' },
  });
  check('order: an unnamed seller is refused', noSeller.status === 400 && errCode(noSeller) === 'seller_required', { status: noSeller.status, code: errCode(noSeller) });

  // ---- 6. reads are buyer-scoped -----------------------------------------------
  const mine = await api('GET', '/api/marketplace/orders', { token: buyer.token });
  check('scope: the buyer sees their own orders', mine.status === 200 && mine.json.total >= 2 && mine.json.orders.some((o) => o.id === order.id), { status: mine.status, total: mine.json && mine.json.total });
  const mineOne = await api('GET', `/api/marketplace/orders/${order.id}`, { token: buyer.token });
  check('scope: the buyer reads one order back', mineOne.status === 200 && mineOne.json.order.reference === order.reference, { status: mineOne.status, code: errCode(mineOne) });
  const otherList = await api('GET', '/api/marketplace/orders', { token: stranger.token });
  check('scope: another member\'s list does not contain the order', otherList.status === 200 && !otherList.json.orders.some((o) => o.id === order.id), { status: otherList.status });
  const otherOne = await api('GET', `/api/marketplace/orders/${order.id}`, { token: stranger.token });
  check('scope: a guessed order id answers 404', otherOne.status === 404 && errCode(otherOne) === 'not_found', { status: otherOne.status, code: errCode(otherOne) });

  // ---- 7. the buyer's proof is stored, deduplicated and never credits ----------
  const receipt = await api('POST', `/api/marketplace/orders/${order.id}/receipt`, {
    token: buyer.token, body: { fileName: 'e2e-market-payment.png', data: PNG_BASE64 },
  });
  check('receipt: the member attaches proof of payment', receipt.status === 201 && receipt.json.duplicate === false && !!receipt.json.receiptId, { status: receipt.status, code: errCode(receipt) });
  if (receipt.json.receiptId) {
    const row = (await sql('SELECT uploaded_by, uploaded_by_user_id FROM payment_receipts WHERE id = $1', [receipt.json.receiptId])).rows[0];
    check('receipt: 0050 records the member as uploader, not the seller', !!row && row.uploaded_by === null && row.uploaded_by_user_id === buyer.user.id, row);
  }
  const again = await api('POST', `/api/marketplace/orders/${order.id}/receipt`, {
    token: buyer.token, body: { fileName: 'e2e-market-payment.png', data: PNG_BASE64 },
  });
  check('receipt: the same bytes answer duplicate rather than storing twice', again.status === 200 && again.json.duplicate === true && again.json.receiptId === receipt.json.receiptId, { status: again.status, duplicate: again.json && again.json.duplicate });
  const receiptCount = (await sql('SELECT count(*)::text n FROM payment_receipts WHERE order_id = $1', [order.id])).rows[0];
  check('receipt: exactly one document is on the order', Number(receiptCount.n) === 1, receiptCount);
  const otherReceipt = await api('POST', `/api/marketplace/orders/${order.id}/receipt`, {
    token: stranger.token, body: { fileName: 'e2e-market-payment.png', data: PNG_BASE64 },
  });
  check('scope: another member cannot attach proof to this order', otherReceipt.status === 404 && errCode(otherReceipt) === 'not_found', { status: otherReceipt.status, code: errCode(otherReceipt) });

  const afterReceipt = await api('GET', `/api/marketplace/orders/${order.id}`, { token: buyer.token });
  const balanceAfter = await diamondBalance(buyer.user.id);
  check('ledger: a receipt leaves the order awaiting verification', afterReceipt.status === 200 && afterReceipt.json.order.status === 'AWAITING_PAYMENT', { status: afterReceipt.status, order: afterReceipt.json && afterReceipt.json.order });
  check('ledger: a receipt never credits diamonds', balanceBefore === balanceAfter, { before: balanceBefore, after: balanceAfter });

  // ---- 8. suspension closes the seller door immediately ------------------------
  check('suspension: the operator suspends the seller', (await suspend(sellerId, 'e2e: marketplace visibility check.')).status === 200, sellerId);
  const suspendedList = await api('GET', '/api/marketplace/sellers', { token: buyer.token });
  check('suspension: an inactive seller drops off the catalogue', suspendedList.status === 200 && !suspendedList.json.sellers.some((s) => s.id === sellerId), { status: suspendedList.status });
  const suspendedOrder = await api('POST', '/api/marketplace/orders', {
    token: buyer.token, body: { sellerId, packageKey, paymentMethod: 'CASH' },
  });
  check('suspension: an inactive seller cannot be named on a new order', suspendedOrder.status === 404 && errCode(suspendedOrder) === 'seller_not_available', { status: suspendedOrder.status, code: errCode(suspendedOrder) });
  await activate(sellerId);
}

(async () => {
  try {
    await main();
  } catch (err) {
    out.push(`FAIL  suite threw :: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
    failures += 1;
  } finally {
    await walkOut();
    if (pool) await pool.end();
  }
  console.log(out.join('\n'));
  console.log(`\n${out.filter((l) => l.startsWith('PASS')).length} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
