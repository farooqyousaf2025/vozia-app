#!/usr/bin/env node
/**
 * The partner desk from the member's own session (#150): ownership, scope and the display marker.
 *
 * `/api/partner/*` swaps the partner credential for ownership — `requireBusinessOwner` resolves the
 * caller's account from `business_accounts.owner_user_id` on every request. This suite proves the
 * boundaries that swap has to hold:
 *
 *   - a member who runs nothing is refused, and a partner credential cannot use the member route;
 *   - an operator-created account only opens for its owner once ACTIVE, and activation is what
 *     raises `users.user_type` from USER to the account's kind (migration 0046);
 *   - a seller reaches the seller doors and never the BD doors; a BD reads its territory and never
 *     the seller-only doors; a foreign BD cannot read a seller outside its territory;
 *   - suspension and revocation close the desk immediately while the display marker stays;
 *   - an approved COIN_SELLER application links the account to the applicant and switches their
 *     user_type, and revoking the grant suspends the account.
 *
 * Every account is created through the product's own routes, marked E2E, and closed at the end;
 * the `business.bd` switch is put back exactly as it was found, even on a throw.
 *
 * Run against the live stack:  node scripts/partner-desk-e2e.cjs
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

async function mintOperator(adminToken, username) {
  const password = `e2e-pd-${stamp}`;
  const created = await api('POST', '/api/admin/operators', { token: adminToken, body: { username, password, role: 'OPERATIONS_ADMIN' } });
  if (created.status !== 201) throw new Error(`operator create failed: ${JSON.stringify(created.json)}`);
  const signed = await api('POST', '/api/admin/login', { body: { username, password } });
  if (!signed.json.token) throw new Error(`operator login failed: ${JSON.stringify(signed.json)}`);
  return { id: created.json.operator.id, token: signed.json.token };
}

const userType = async (userId) => (await sql('SELECT user_type FROM users WHERE id = $1', [userId])).rows[0].user_type;
const accountRow = async (id) => (await sql('SELECT kind, status, owner_user_id, parent_id FROM business_accounts WHERE id = $1', [id])).rows[0];

// A real 1×1 PNG: the receipt service sniffs the bytes, so the evidence must be the format it claims.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const createdAccountIds = [];
const operatorIds = [];
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
  const reviewOps = await mintOperator(admin, `e2e_pd_review_${stamp}`);
  operatorIds.push(reviewOps.id);

  // The one-office switch, exactly as found. Creating a second BD manager needs it on; the walk-out
  // restores the prior value (or removes the row again if the default was never written).
  const bdConfigBefore = (await sql("SELECT value FROM system_config WHERE key = 'business.bd'")).rows[0] || null;
  const setBd = (value) => api('PUT', '/api/admin/business/config/business.bd', { token: admin, body: { value } });
  await setBd({ multiManager: true });
  RESTORE = async () => {
    if (bdConfigBefore) await setBd(bdConfigBefore.value);
    else await sql("DELETE FROM system_config WHERE key = 'business.bd'");
    for (const id of createdAccountIds) {
      const row = await accountRow(id);
      if (row && row.status !== 'CLOSED') {
        await api('POST', `/api/admin/business/accounts/${id}/status`, { token: admin, body: { status: 'CLOSED' } });
      }
    }
    for (const id of operatorIds) await api('POST', `/api/admin/operators/${id}/disable`, { token: admin, body: { reason: `partner-desk-e2e-${stamp} finished` } });
  };

  // ---- 1. a member who runs nothing has no desk ------------------------------
  const plain = await login(`+15558${stamp}01`, `e2e_pd_plain_${stamp.slice(-4)}`);
  for (const p of ['/api/partner/me', '/api/partner/dashboard', '/api/partner/orders', '/api/partner/statement', '/api/partner/sellers', '/api/partner/packages']) {
    const r = await api('GET', p, { token: plain.token });
    check(`gate: ${p.replace('/api/partner/', '')} refuses a member with no account`, r.status === 403 && errCode(r) === 'partner_account_not_found', { status: r.status, code: errCode(r) });
  }

  // ---- 2. operator creates the territory, named by the owner's phone ---------
  const bdOwner = await login(`+15558${stamp}02`, `e2e_pd_bd_${stamp.slice(-4)}`);
  const agentOwner = await login(`+15558${stamp}03`, `e2e_pd_agent_${stamp.slice(-4)}`);
  const sellerOwner = await login(`+15558${stamp}04`, `e2e_pd_seller_${stamp.slice(-4)}`);
  const customer = await login(`+15558${stamp}05`, `e2e_pd_cust_${stamp.slice(-4)}`);

  const badOwner = await api('POST', '/api/admin/business/accounts', {
    token: admin, body: { kind: 'BD_MANAGER', displayName: `E2E ghost ${stamp}`, ownerPhone: '+19999999999' },
  });
  check('owner: a phone no member uses is refused', badOwner.status === 400 && errCode(badOwner) === 'owner_not_found', { status: badOwner.status, code: errCode(badOwner) });

  const managerCode = `BD-E2E-${stamp}`;
  const manager = await api('POST', '/api/admin/business/accounts', {
    token: admin,
    body: { kind: 'BD_MANAGER', displayName: `E2E territory ${stamp}`, code: managerCode, marketCountry: 'BD', ownerPhone: bdOwner.phone },
  });
  const managerId = manager.json && manager.json.account && manager.json.account.id;
  createdAccountIds.push(managerId);
  check('owner: the operator creates a BD manager linked to its member', manager.status === 201 && !!managerId, { status: manager.status, code: errCode(manager) });
  check('owner: the link is stored on the row', (await accountRow(managerId)).owner_user_id === bdOwner.user.id, await accountRow(managerId));

  const agent = await api('POST', '/api/admin/business/accounts', {
    token: admin,
    body: { kind: 'BD_AGENT', displayName: `E2E agent ${stamp}`, code: `BDA-E2E-${stamp}`, parentId: managerId, ownerPhone: agentOwner.phone },
  });
  const agentId = agent.json && agent.json.account && agent.json.account.id;
  createdAccountIds.push(agentId);
  const sellerCode = `SLR-E2E-${stamp}`;
  const seller = await api('POST', '/api/admin/business/accounts', {
    token: admin,
    body: { kind: 'COIN_SELLER', displayName: `E2E seller ${stamp}`, code: sellerCode, parentId: agentId, password: 'e2esellerpass1', ownerPhone: sellerOwner.phone },
  });
  const sellerId = seller.json && seller.json.account && seller.json.account.id;
  createdAccountIds.push(sellerId);
  check('owner: an agent and a seller are created under the territory, each linked', agent.status === 201 && seller.status === 201 && !!agentId && !!sellerId, { agent: agent.status, seller: seller.status });

  // ---- 3. PENDING keeps the desk shut and the marker down --------------------
  const pendingMe = await api('GET', '/api/partner/me', { token: bdOwner.token });
  check('marker: a PENDING account does not open the desk', pendingMe.status === 403 && errCode(pendingMe) === 'partner_account_not_found', { status: pendingMe.status });
  check('marker: a PENDING account leaves the member reading as USER', (await userType(bdOwner.user.id)) === 'USER', await userType(bdOwner.user.id));
  const sellerPendingMe = await api('GET', '/api/partner/me', { token: sellerOwner.token });
  check('marker: the pending seller is refused too', sellerPendingMe.status === 403, { status: sellerPendingMe.status });
  const earlyLogin = await api('POST', '/api/business/login', { body: { code: sellerCode, password: 'e2esellerpass1' } });
  check('marker: the partner credential is refused while PENDING as well', earlyLogin.status === 403 && errCode(earlyLogin) === 'business_account_inactive', { status: earlyLogin.status });

  // ---- 4. activation opens the desk and raises the marker --------------------
  const activate = (id) => api('POST', `/api/admin/business/accounts/${id}/status`, { token: admin, body: { status: 'ACTIVE' } });
  check('marker: the manager activates', (await activate(managerId)).status === 200, managerId);
  const bdMe = await api('GET', '/api/partner/me', { token: bdOwner.token });
  check('desk: the owner now reads their own BD account', bdMe.status === 200 && bdMe.json.account.id === managerId && bdMe.json.account.kind === 'BD_MANAGER', { status: bdMe.status, code: errCode(bdMe) });
  check('desk: whoami carries the kind permissions and the cash rails', Array.isArray(bdMe.json.permissions) && bdMe.json.permissions.includes('seller:read') && bdMe.json.paymentRails.includes('CASH'), bdMe.json.permissions);
  check('marker: activation switches the member from USER to BD_MANAGER', (await userType(bdOwner.user.id)) === 'BD_MANAGER', await userType(bdOwner.user.id));

  await activate(agentId);
  const agentMe = await api('GET', '/api/partner/me', { token: agentOwner.token });
  check('desk: the agent reads a BD_AGENT account', agentMe.status === 200 && agentMe.json.account.kind === 'BD_AGENT', { status: agentMe.status });
  check('marker: the agent now reads as BD_AGENT', (await userType(agentOwner.user.id)) === 'BD_AGENT', await userType(agentOwner.user.id));

  await activate(sellerId);
  const sellerMe = await api('GET', '/api/partner/me', { token: sellerOwner.token });
  check('desk: the seller reads a COIN_SELLER account', sellerMe.status === 200 && sellerMe.json.account.id === sellerId, { status: sellerMe.status });
  check('desk: the seller\'s answer names the BD account above it', sellerMe.json.account.parentCode === `BDA-E2E-${stamp}` && !!sellerMe.json.account.parentName, { parentCode: sellerMe.json.account.parentCode, parentName: sellerMe.json.account.parentName });
  check('desk: a BD manager stands alone', bdMe.json.account.parentCode === null, { parentCode: bdMe.json.account.parentCode });
  check('marker: the seller now reads as COIN_SELLER, not HOST', (await userType(sellerOwner.user.id)) === 'COIN_SELLER', await userType(sellerOwner.user.id));

  // ---- 5. the two credentials never mix --------------------------------------
  const bizLogin = await api('POST', '/api/business/login', { body: { code: sellerCode, password: 'e2esellerpass1' } });
  const bizToken = bizLogin.json && bizLogin.json.token;
  check('auth: the active seller still signs in with its partner credential', bizLogin.status === 200 && !!bizToken, { status: bizLogin.status });
  const bizOnMember = await api('GET', '/api/partner/me', { token: bizToken });
  check('auth: a partner credential cannot use the member-session desk', bizOnMember.status === 403 && errCode(bizOnMember) === 'member_token_required', { status: bizOnMember.status, code: errCode(bizOnMember) });
  const bizOnDashboard = await api('GET', '/api/partner/dashboard', { token: bizToken });
  check('auth: and not its dashboard either', bizOnDashboard.status === 403 && errCode(bizOnDashboard) === 'member_token_required', { status: bizOnDashboard.status });

  // ---- 6. the seller's own doors ----------------------------------------------
  const packages = await api('GET', '/api/partner/packages', { token: sellerOwner.token });
  const pkg = packages.json && packages.json.packages && packages.json.packages[0];
  check('seller: the catalogue is offered to the account that moves the cash', packages.status === 200 && !!pkg, { status: packages.status, count: packages.json && packages.json.packages && packages.json.packages.length });

  const created = await api('POST', '/api/partner/orders', {
    token: sellerOwner.token,
    body: { phone: customer.phone, packageKey: pkg.key, paymentMethod: 'CASH', note: `e2e desk order ${stamp}` },
  });
  const order = created.json && created.json.order;
  check('seller: an order is created AWAITING_PAYMENT from the member session', created.status === 201 && order && order.status === 'AWAITING_PAYMENT', { status: created.status, code: errCode(created) });

  // The evidence rule is administrator-owned; read it so the refusal check matches the live switch.
  const rechargeCfg = (await sql("SELECT value FROM system_config WHERE key = 'business.recharge'")).rows[0];
  const evidenceRequired = rechargeCfg ? rechargeCfg.value.manualEvidenceRequired !== false : true;
  if (evidenceRequired) {
    const noEvidence = await api('POST', `/api/partner/orders/${order.id}/mark-paid`, { token: sellerOwner.token, body: { paymentRef: `E2E-CASH-${stamp}` } });
    check('seller: marking paid without evidence is refused while the switch requires it', noEvidence.status === 400 && errCode(noEvidence) === 'evidence_required', { status: noEvidence.status, code: errCode(noEvidence) });
  }

  const receipt = await api('POST', '/api/partner/receipts', {
    token: sellerOwner.token, body: { orderId: order.id, fileName: 'e2e-handover.png', data: PNG_BASE64 },
  });
  check('seller: the cash handover proof is stored against the order', receipt.status === 201 && receipt.json.duplicate === false, { status: receipt.status, code: errCode(receipt) });
  const again = await api('POST', '/api/partner/receipts', {
    token: sellerOwner.token, body: { orderId: order.id, fileName: 'e2e-handover.png', data: PNG_BASE64 },
  });
  check('seller: the same bytes answer duplicate rather than storing twice', again.status === 200 && again.json.duplicate === true, { status: again.status, duplicate: again.json && again.json.duplicate });

  const paid = await api('POST', `/api/partner/orders/${order.id}/mark-paid`, { token: sellerOwner.token, body: { paymentRef: `E2E-CASH-${stamp}` } });
  check('seller: the receipt counts as evidence — marking paid stops at AWAITING_VERIFICATION, never at a balance', paid.status === 200 && paid.json.order.status === 'AWAITING_VERIFICATION', { status: paid.status, code: errCode(paid) });

  const second = await api('POST', '/api/partner/orders', {
    token: sellerOwner.token, body: { phone: customer.phone, packageKey: pkg.key, paymentMethod: 'BANK' },
  });
  const cancelled = await api('POST', `/api/partner/orders/${second.json.order.id}/cancel`, { token: sellerOwner.token, body: { reason: 'e2e: the member changed their mind.' } });
  check('seller: a fresh order can be cancelled with a reason', cancelled.status === 200 && cancelled.json.order.status === 'CANCELLED', { status: cancelled.status });

  const orders = await api('GET', '/api/partner/orders', { token: sellerOwner.token });
  check('seller: the order list carries both orders', orders.status === 200 && orders.json.total >= 2, { status: orders.status, total: orders.json && orders.json.total });
  const oneOrder = await api('GET', `/api/partner/orders/${order.id}`, { token: sellerOwner.token });
  check('seller: one order reads back with its reference', oneOrder.status === 200 && oneOrder.json.order.id === order.id, { status: oneOrder.status });
  const lookup = await api('GET', `/api/partner/customers/lookup?phone=${encodeURIComponent(customer.phone)}`, { token: sellerOwner.token });
  check('seller: the customer lookup answers for the member being recharged', lookup.status === 200 && lookup.json.customer && lookup.json.customer.id === customer.user.id, { status: lookup.status, code: errCode(lookup) });
  const payouts = await api('GET', '/api/partner/payouts', { token: sellerOwner.token });
  check('seller: the cash payout queue is readable', payouts.status === 200 && Array.isArray(payouts.json.payouts), { status: payouts.status });
  const sellerStatement = await api('GET', '/api/partner/statement', { token: sellerOwner.token });
  check('seller: the statement carries the cash book', sellerStatement.status === 200 && sellerStatement.json.cash && typeof sellerStatement.json.cash.collectedNetCents === 'number', { status: sellerStatement.status });
  const sellerDash = await api('GET', '/api/partner/dashboard', { token: sellerOwner.token });
  check('seller: the dashboard counts the order it just processed', sellerDash.status === 200 && sellerDash.json.recharge.orders >= 2, { status: sellerDash.status, recharge: sellerDash.json && sellerDash.json.recharge });

  // ---- 7. the seller never reaches the BD doors -------------------------------
  // The kind gate runs before the permission gate, so a door that does not exist for this kind
  // answers partner_account_not_found; either refusal is the boundary holding.
  const refused = (r) => r.status === 403 && ['partner_account_not_found', 'permission_denied'].includes(errCode(r));
  const sellerOnRoster = await api('GET', '/api/partner/sellers', { token: sellerOwner.token });
  check('scope: a seller cannot read the BD roster', refused(sellerOnRoster), { status: sellerOnRoster.status, code: errCode(sellerOnRoster) });
  const sellerOnReport = await api('GET', `/api/partner/sellers/${sellerId}/report`, { token: sellerOwner.token });
  check('scope: nor a seller report, even its own', refused(sellerOnReport), { status: sellerOnReport.status, code: errCode(sellerOnReport) });

  // ---- 8. the BD reads its territory and never the seller doors ---------------
  const roster = await api('GET', '/api/partner/sellers', { token: bdOwner.token });
  check('bd: the manager sees the seller under its agent', roster.status === 200 && roster.json.sellers.some((s) => s.id === sellerId), { status: roster.status, ids: roster.json && roster.json.sellers && roster.json.sellers.map((s) => s.id) });
  const rosterSeller = roster.json && roster.json.sellers && roster.json.sellers.find((s) => s.id === sellerId);
  check('bd: the roster row names the BD above the seller', !!rosterSeller && rosterSeller.parentCode === `BDA-E2E-${stamp}` && !!rosterSeller.parentName, { parentCode: rosterSeller && rosterSeller.parentCode, parentName: rosterSeller && rosterSeller.parentName });
  const report = await api('GET', `/api/partner/sellers/${sellerId}/report`, { token: bdOwner.token });
  check('bd: the manager reads that seller\'s whole book', report.status === 200 && report.json.seller.id === sellerId && Array.isArray(report.json.orders), { status: report.status, code: errCode(report) });
  check('bd: the report names the BD above the seller too', report.status === 200 && report.json.seller.parentCode === `BDA-E2E-${stamp}` && !!report.json.seller.parentName, { parentCode: report.json && report.json.seller && report.json.seller.parentCode });
  const agentRoster = await api('GET', '/api/partner/sellers', { token: agentOwner.token });
  check('bd: the agent sees the seller directly under it', agentRoster.status === 200 && agentRoster.json.sellers.some((s) => s.id === sellerId), { status: agentRoster.status });
  const agentReport = await api('GET', `/api/partner/sellers/${sellerId}/report`, { token: agentOwner.token });
  check('bd: and reads its report', agentReport.status === 200, { status: agentReport.status });
  const bdOrders = await api('GET', '/api/partner/orders', { token: bdOwner.token });
  check('bd: the territory order list includes the seller\'s orders', bdOrders.status === 200 && bdOrders.json.total >= 2, { status: bdOrders.status, total: bdOrders.json && bdOrders.json.total });
  const bdStatement = await api('GET', '/api/partner/statement', { token: bdOwner.token });
  check('bd: a BD statement has no cash book — it holds no cash', bdStatement.status === 200 && bdStatement.json.cash == null, { status: bdStatement.status, cash: bdStatement.json && bdStatement.json.cash });

  const bdCreate = await api('POST', '/api/partner/orders', { token: bdOwner.token, body: { phone: customer.phone, packageKey: pkg.key, paymentMethod: 'CASH' } });
  check('scope: a BD cannot create recharge orders', refused(bdCreate), { status: bdCreate.status, code: errCode(bdCreate) });
  const bdPackages = await api('GET', '/api/partner/packages', { token: bdOwner.token });
  check('scope: a BD is not offered the catalogue', bdPackages.status === 403, { status: bdPackages.status });
  const bdPayouts = await api('GET', '/api/partner/payouts', { token: bdOwner.token });
  check('scope: a BD cannot read the cash payout queue', bdPayouts.status === 403, { status: bdPayouts.status });
  const bdReceipt = await api('POST', '/api/partner/receipts', { token: bdOwner.token, body: { orderId: order.id, fileName: 'e2e.png', data: PNG_BASE64 } });
  check('scope: a BD cannot attach proof to an order', bdReceipt.status === 403, { status: bdReceipt.status });
  const bdMarkPaid = await api('POST', `/api/partner/orders/${order.id}/mark-paid`, { token: bdOwner.token, body: { paymentRef: 'E2E-BD-TRY' } });
  check('scope: a BD cannot mark an order paid', bdMarkPaid.status === 403, { status: bdMarkPaid.status });

  // ---- 9. a foreign BD has no path into this territory -------------------------
  const foreignOwner = await login(`+15558${stamp}06`, `e2e_pd_foreign_${stamp.slice(-4)}`);
  const foreign = await api('POST', '/api/admin/business/accounts', {
    token: admin,
    body: { kind: 'BD_MANAGER', displayName: `E2E foreign ${stamp}`, code: `BDF-E2E-${stamp}`, marketCountry: 'LK', ownerPhone: foreignOwner.phone },
  });
  const foreignId = foreign.json && foreign.json.account && foreign.json.account.id;
  createdAccountIds.push(foreignId);
  await activate(foreignId);
  const foreignRoster = await api('GET', '/api/partner/sellers', { token: foreignOwner.token });
  check('territory: the foreign BD\'s roster does not contain this seller', foreignRoster.status === 200 && !foreignRoster.json.sellers.some((s) => s.id === sellerId), { status: foreignRoster.status });
  const foreignReport = await api('GET', `/api/partner/sellers/${sellerId}/report`, { token: foreignOwner.token });
  check('territory: and its report answers 404, not the book', foreignReport.status === 404, { status: foreignReport.status, code: errCode(foreignReport) });

  // ---- 10. suspension closes the desk at once; the marker is display -----------
  const suspend = await api('POST', `/api/admin/business/accounts/${sellerId}/status`, { token: admin, body: { status: 'SUSPENDED', reason: 'e2e: proving the desk closes immediately.' } });
  check('suspend: the operator suspends with a reason', suspend.status === 200, { status: suspend.status });
  const suspendedMe = await api('GET', '/api/partner/me', { token: sellerOwner.token });
  check('suspend: the owner is refused on the very next request', suspendedMe.status === 403 && errCode(suspendedMe) === 'partner_account_not_found', { status: suspendedMe.status });
  check('suspend: the display marker stays — the row is the authority', (await userType(sellerOwner.user.id)) === 'COIN_SELLER', await userType(sellerOwner.user.id));
  await activate(sellerId);
  const backMe = await api('GET', '/api/partner/me', { token: sellerOwner.token });
  check('suspend: reactivation opens the desk again', backMe.status === 200, { status: backMe.status });

  // ---- 11. unlinking and relinking the owner -----------------------------------
  const unlink = await api('PATCH', `/api/admin/business/accounts/${agentId}`, { token: admin, body: { ownerPhone: '' } });
  check('owner: an empty phone unlinks the desk without touching the account', unlink.status === 200 && (await accountRow(agentId)).owner_user_id === null, { status: unlink.status });
  const unlinkedMe = await api('GET', '/api/partner/me', { token: agentOwner.token });
  check('owner: the unlinked member is refused', unlinkedMe.status === 403, { status: unlinkedMe.status });
  const relink = await api('PATCH', `/api/admin/business/accounts/${agentId}`, { token: admin, body: { ownerPhone: agentOwner.phone } });
  const relinkedMe = await api('GET', '/api/partner/me', { token: agentOwner.token });
  check('owner: relinking an ACTIVE account opens the desk again', relink.status === 200 && relinkedMe.status === 200, { patch: relink.status, me: relinkedMe.status });

  // ---- 12. the application path: approval links and switches -------------------
  const appSeller = await login(`+15558${stamp}07`, `e2e_pd_app_${stamp.slice(-4)}`);
  const applied = await api('POST', '/api/role-applications', {
    token: appSeller.token,
    body: {
      role: 'COIN_SELLER',
      data: {
        businessOrFullName: `E2E App Seller ${stamp}`,
        location: 'Dhaka, BD',
        contactPhone: appSeller.phone,
        expectedMonthlyVolume: 50000,
        verificationDetails: 'e2e: bank transfer every Friday against the order reference.',
      },
    },
  });
  const appId = applied.json && applied.json.application && applied.json.application.id;
  check('apply: a member files a coin-seller application', applied.status === 201 && !!appId, { status: applied.status, code: errCode(applied) });
  const noParent = await api('POST', `/api/admin/partner-applications/${appId}/approve`, { token: reviewOps.token, body: {} });
  check('apply: approval without the BD account is refused', noParent.status === 400 && errCode(noParent) === 'seller_bd_required', { status: noParent.status, code: errCode(noParent) });
  const approved = await api('POST', `/api/admin/partner-applications/${appId}/approve`, { token: reviewOps.token, body: { bdAccountId: managerId } });
  const grantRow = approved.json && approved.json.application && approved.json.application.grant;
  check('apply: naming the BD grants an ACTIVE account', approved.status === 200 && grantRow && grantRow.status === 'ACTIVE', { status: approved.status, code: errCode(approved) });
  const grantedId = grantRow && grantRow.id;
  if (grantedId) createdAccountIds.push(grantedId);
  check('apply: the granted account belongs to the applicant', grantedId && (await accountRow(grantedId)).owner_user_id === appSeller.user.id, grantedId && await accountRow(grantedId));
  check('apply: approval switches the applicant from USER to COIN_SELLER', (await userType(appSeller.user.id)) === 'COIN_SELLER', await userType(appSeller.user.id));
  const appMe = await api('GET', '/api/partner/me', { token: appSeller.token });
  check('apply: the applicant reads their new desk from their own session', appMe.status === 200 && appMe.json.account.id === grantedId, { status: appMe.status, code: errCode(appMe) });

  const revoked = await api('POST', `/api/admin/partner-applications/${appId}/revoke`, { token: reviewOps.token, body: { reason: 'e2e: the run ends here.' } });
  check('revoke: the grant is withdrawn', revoked.status === 200 && revoked.json.application.status === 'REVOKED', { status: revoked.status });
  check('revoke: the account behind it is suspended', grantedId && (await accountRow(grantedId)).status === 'SUSPENDED', grantedId && await accountRow(grantedId));
  const revokedMe = await api('GET', '/api/partner/me', { token: appSeller.token });
  check('revoke: the desk closes for the revoked member', revokedMe.status === 403 && errCode(revokedMe) === 'partner_account_not_found', { status: revokedMe.status });
  check('revoke: the display marker stays after revocation too', (await userType(appSeller.user.id)) === 'COIN_SELLER', await userType(appSeller.user.id));
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