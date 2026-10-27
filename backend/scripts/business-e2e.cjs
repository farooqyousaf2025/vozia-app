/* End-to-end tests for the business accounts, coin sellers, recharge workflow and commission
   engine (§21-§25). Drives a *running* backend over HTTP against real PostgreSQL and asserts on
   database state through the backend's own pg pool — no mocks, no fixtures.

     1. boot the stack and the API (README / docker-compose.yml), then `npm run build`
     2. node scripts/business-e2e.cjs

   Throwaway partners, orders and admins are named with a time stamp, so run it against a
   development database only. */
const path = require('path');
const crypto = require('crypto');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const out = [];
const check = (n, p, d) => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? `  :: ${JSON.stringify(d).slice(0, 260)}` : ''}`);

let poolPromise = null;
function db() {
  if (!poolPromise) {
    poolPromise = new (require(path.join(BE_ROOT, 'node_modules', 'pg')).Pool)({
      connectionString: require(path.join(BE_ROOT, 'dist', 'config', 'env.js')).env.databaseUrl,
      max: 6,
    });
  }
  return poolPromise;
}
const sql = async (q, p) => (await db()).query(q, p);
const scalar = async (q, p) => {
  const r = await sql(q, p);
  return r.rows.length ? Object.values(r.rows[0]).join('|') : null;
};

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

async function login(phone, username) {
  const r = await api('POST', '/api/auth/request-otp', { body: { phone } });
  return (await api('POST', '/api/auth/verify-otp', { body: { phone, code: r.json && r.json.devCode, username } })).json;
}

const stamp = Date.now().toString().slice(-7);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- A. operator access ---------------------------------------------------
  const adminLogin = await api('POST', '/api/auth/verify-otp', { body: { phone: '+10000000000', code: '424242' } });
  const admin = adminLogin.json && adminLogin.json.token;
  check('rbac: the bootstrap OTP mints an operator token', adminLogin.status === 200 && !!admin, { status: adminLogin.status });

  // Narrow-role operators. Each row carries a real scrypt hash and signs in through the same
  // endpoint a human uses, so the token under test came from this server — and because the
  // guards re-read the role from the database, the row itself is the thing being tested.
  const mintAdmin = async (username, role) => {
    const password = `e2e-pass-${role.toLowerCase()}-1`;
    await sql(
      `INSERT INTO admins (username, password_hash, display_name, role)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [username, require(path.join(BE_ROOT, 'dist', 'utils', 'crypto.js')).hashSecret(password), `E2E ${role}`, role],
    );
    const signedIn = await api('POST', '/api/admin/login', { body: { username, password } });
    return { id: username, token: signedIn.json && signedIn.json.token, login: signedIn };
  };
  const moderator = await mintAdmin(`e2e_mod_${stamp}`, 'MODERATOR');
  const finance = await mintAdmin(`e2e_fin_${stamp}`, 'FINANCE_ADMIN');
  const ops = await mintAdmin(`e2e_ops_${stamp}`, 'OPERATIONS_ADMIN');

  // ---- B. a partner cannot reach the operator surface ----------------------
  const userPhone = `+15557${stamp}01`;
  const customer = await login(userPhone, `e2e_cust_${stamp.slice(-4)}`);
  const badPartner = await api('POST', '/api/business/login', { body: { code: 'SLR-NONE-0', password: 'whatever12' } });
  check('auth: an unknown business ID answers the same as a wrong password', badPartner.status === 401 && badPartner.json.error.code === 'invalid_credentials', badPartner.json && badPartner.json.error);

  const userOnBusiness = await api('GET', '/api/business/orders', { token: customer.token });
  check('auth: an ordinary user token cannot use the partner panel', userOnBusiness.status === 403 || userOnBusiness.status === 401, { status: userOnBusiness.status, code: userOnBusiness.json && userOnBusiness.json.error && userOnBusiness.json.error.code });

  const userOnAdmin = await api('GET', '/api/admin/business/accounts', { token: customer.token });
  check('auth: an ordinary user token cannot read the operator partner list', userOnAdmin.status === 403 || userOnAdmin.status === 401, { status: userOnAdmin.status });

  // ---- C. the partner network ---------------------------------------------
  const managers = await api('GET', '/api/admin/business/accounts?kind=BD_MANAGER', { token: admin });
  let managerId = managers.json && managers.json.accounts && managers.json.accounts[0] && managers.json.accounts[0].id;
  if (!managerId) {
    const made = await api('POST', '/api/admin/business/accounts', {
      token: admin, body: { kind: 'BD_MANAGER', displayName: `E2E territory ${stamp}`, code: `BD-E2E-${stamp}` },
    });
    managerId = made.json && made.json.account && made.json.account.id;
    await api('POST', `/api/admin/business/accounts/${managerId}/status`, { token: admin, body: { status: 'ACTIVE' } });
  }
  check('bd: a BD manager exists for the territory', !!managerId, managerId);

  const sellerOnlyUnderBd = await api('POST', '/api/admin/business/accounts', {
    token: admin, body: { kind: 'COIN_SELLER', displayName: `E2E orphan ${stamp}`, password: 'e2esellerpass1' },
  });
  check('bd: an unassigned coin seller is refused', sellerOnlyUnderBd.status === 400 && sellerOnlyUnderBd.json.error.code === 'seller_unassigned', sellerOnlyUnderBd.json && sellerOnlyUnderBd.json.error);

  const agent = await api('POST', '/api/admin/business/accounts', {
    token: admin,
    body: { kind: 'BD_AGENT', displayName: `E2E agent ${stamp}`, code: `BDA-E2E-${stamp}`, parentId: managerId },
  });
  const agentId = agent.json && agent.json.account && agent.json.account.id;
  await api('POST', `/api/admin/business/accounts/${agentId}/status`, { token: admin, body: { status: 'ACTIVE' } });
  check('bd: a BD agent is created under the manager', agent.status === 201 && !!agentId, { status: agent.status });

  const sellerCode = `SLR-E2E-${stamp}`;
  const seller = await api('POST', '/api/admin/business/accounts', {
    token: admin,
    body: { kind: 'COIN_SELLER', displayName: `E2E seller ${stamp}`, code: sellerCode, parentId: agentId, password: 'e2esellerpass1' },
  });
  const sellerId = seller.json && seller.json.account && seller.json.account.id;
  check('seller: a pending seller is created with its own ID', seller.status === 201 && !!sellerId, { status: seller.status, code: sellerCode });

  const sellerSecret = (seller.json && seller.json.account && seller.json.account.passwordHash) || null;
  check('seller: the API never returns the password hash', sellerSecret === null, { exposed: sellerSecret !== null });

  const tooEarly = await api('POST', '/api/business/login', { body: { code: sellerCode, password: 'e2esellerpass1' } });
  check('seller: a pending partner cannot sign in', tooEarly.status === 403 && tooEarly.json.error.code === 'business_account_inactive', tooEarly.json && tooEarly.json.error);

  const activated = await api('POST', `/api/admin/business/accounts/${sellerId}/status`, { token: admin, body: { status: 'ACTIVE' } });
  check('seller: an operator activates the partner', activated.status === 200 && activated.json.account.status === 'ACTIVE', { status: activated.status });

  const partnerLogin = await api('POST', '/api/business/login', { body: { code: sellerCode, password: 'e2esellerpass1' } });
  const sellerToken = partnerLogin.json && partnerLogin.json.token;
  check('seller: an active partner signs in with its own credential', partnerLogin.status === 200 && !!sellerToken, { status: partnerLogin.status });

  const partnerOnAdmin = await api('GET', '/api/admin/business/accounts', { token: sellerToken });
  check('rbac: a seller credential cannot reach the operator panel at all', partnerOnAdmin.status === 403, { status: partnerOnAdmin.status, code: partnerOnAdmin.json && partnerOnAdmin.json.error && partnerOnAdmin.json.error.code });

  // ---- D. permissions by role, not by token claim --------------------------
  const modOnAccounts = await api('GET', '/api/admin/business/accounts', { token: moderator.token });
  check('rbac: a moderator may not list partner accounts', modOnAccounts.status === 403 && modOnAccounts.json.error.code === 'permission_denied', { status: modOnAccounts.status });
  const opsOnAccounts = await api('GET', '/api/admin/business/accounts', { token: ops.token });
  check('rbac: an operations administrator may list partner accounts', opsOnAccounts.status === 200, { status: opsOnAccounts.status });
  const opsOnConfig = await api('PUT', '/api/admin/business/config/business.recharge', { token: ops.token, body: { value: { orderValidityMinutes: 60 } } });
  check('rbac: only the config permission may write a money switch', opsOnConfig.status === 403 && opsOnConfig.json.error.code === 'permission_denied', { status: opsOnConfig.status });
  const financeOnApprove = await api('POST', `/api/admin/business/recharges/${crypto.randomUUID()}/approve`, { token: finance.token, body: {} });
  check('rbac: finance holds recharge review (it reaches the order lookup, not the guard)', financeOnApprove.status === 404, { status: financeOnApprove.status });

  // ---- E. the package catalog ---------------------------------------------
  const catalog = await api('GET', '/api/business/packages', { token: sellerToken });
  const packageKeys = (catalog.json && catalog.json.packages || []).map((p) => p.key);
  check('packages: a seller with no allowlist is offered every active package', catalog.status === 200 && packageKeys.length >= 1, { count: packageKeys.length, keys: packageKeys.slice(0, 3) });

  const restricted = await api('PUT', `/api/admin/business/accounts/${sellerId}/packages`, { token: admin, body: { packageKeys: ['PKR_250'] } });
  const afterRestrict = await api('GET', '/api/business/packages', { token: sellerToken });
  check('packages: an administrator can pin a seller to one package', restricted.status === 200 && (afterRestrict.json.packages || []).length === 1 && afterRestrict.json.packages[0].key === 'PKR_250', { keys: (afterRestrict.json.packages || []).map((p) => p.key) });

  // What an operator sees while editing must be the pinned set, not the resolved catalogue:
  // "empty" means "every package", and a read that silently applied that fallback would make
  // the modal look like the admin had selected the whole shop.
  const pinnedView = await api('GET', `/api/admin/business/accounts/${sellerId}/packages`, { token: admin });
  check('packages: the operator read returns only what is explicitly pinned',
    pinnedView.status === 200 && pinnedView.json.packageKeys.length === 1 && pinnedView.json.packageKeys[0] === 'PKR_250',
    { keys: pinnedView.json && pinnedView.json.packageKeys });

  const financeReadsPins = await api('GET', `/api/admin/business/accounts/${sellerId}/packages`, { token: finance.token });
  check('packages: editing a seller\'s allowlist is an operations permission, not a finance one',
    financeReadsPins.status === 403 && financeReadsPins.json.error.code === 'permission_denied',
    financeReadsPins.json && financeReadsPins.json.error);

  const forbiddenOrder = await api('POST', '/api/business/orders', { token: sellerToken, body: { phone: userPhone, packageKey: 'PKR_5000', paymentMethod: 'CASH' } });
  check('packages: a seller cannot open a package it is not permitted to sell', forbiddenOrder.status === 403 && forbiddenOrder.json.error.code === 'package_not_permitted', forbiddenOrder.json && forbiddenOrder.json.error);

  // Prices come from the catalog, so a request body has nothing to say about them.
  const forgedPrice = await api('POST', '/api/business/orders', {
    token: sellerToken, body: { phone: userPhone, packageKey: 'PKR_250', paymentMethod: 'CASH', amountCents: 1, diamonds: 999999 },
  });
  const forged = (forgedPrice.json || {}).order || {};
  check('packages: a client-supplied price or diamond count is ignored',
    forgedPrice.status === 201 && forged.diamonds === 125 && forged.amountCents === 25000,
    { diamonds: forged.diamonds, amountCents: forged.amountCents });

  await api('PUT', `/api/admin/business/accounts/${sellerId}/packages`, { token: admin, body: { packageKeys: [] } });
  const clearedView = await api('GET', `/api/admin/business/accounts/${sellerId}/packages`, { token: admin });
  check('packages: clearing the allowlist reads back as no pins, which the seller sees as the whole catalogue',
    clearedView.status === 200 && clearedView.json.packageKeys.length === 0,
    { keys: clearedView.json && clearedView.json.packageKeys });

  // ---- F. commission rates, versioned and admin-owned --------------------
  // The desk that files rates has to name a partner, and it is not the desk that owns their
  // limits. So the roster is a separate read: finance:read gets identities, and nothing else.
  const financeRoster = await api('GET', '/api/admin/business/partners', { token: finance.token });
  const rosterRow = (financeRoster.json && financeRoster.json.partners || [])[0] || {};
  check('roster: the finance desk can name the partners it owes commission to',
    financeRoster.status === 200 && (financeRoster.json.partners || []).length >= 2,
    { count: financeRoster.json && financeRoster.json.partners.length });
  check('roster: naming a partner does not reveal their limits or contacts',
    Object.keys(rosterRow).sort().join(',') === 'code,displayName,id,kind,status',
    { fields: Object.keys(rosterRow).sort() });

  const moderatorRoster = await api('GET', '/api/admin/business/partners', { token: moderator.token });
  check('roster: a moderator with no finance scope is refused the partner list',
    moderatorRoster.status === 403 && moderatorRoster.json.error.code === 'permission_denied',
    moderatorRoster.json && moderatorRoster.json.error);

  const sellerRule = await api('PUT', '/api/admin/business/commissions/rules', {
    token: admin, body: { kind: 'SELLER_PERCENT', appliesToId: sellerId, percentBps: 500, note: 'e2e seller 5%' },
  });
  const bdRule = await api('PUT', '/api/admin/business/commissions/rules', {
    token: admin, body: { kind: 'BD_PERCENT', appliesToId: agentId, percentBps: 200, note: 'e2e bd 2%' },
  });
  check('commission: seller and BD percentage rules are created', sellerRule.status === 201 && bdRule.status === 201, { seller: sellerRule.status, bd: bdRule.status });

  const overBps = await api('PUT', '/api/admin/business/commissions/rules', {
    token: admin, body: { kind: 'SELLER_PERCENT', appliesToId: sellerId, percentBps: 20000 },
  });
  check('commission: an impossible percentage is refused', overBps.status === 400, { status: overBps.status, code: overBps.json && overBps.json.error && overBps.json.error.code });

  const resaved = await api('PUT', '/api/admin/business/commissions/rules', {
    token: admin, body: { kind: 'SELLER_PERCENT', appliesToId: sellerId, percentBps: 600, note: 'e2e seller 6%' },
  });
  check('commission: re-saving a rate creates a new version and closes the old one',
    resaved.status === 201 && resaved.json.rule.rulesVersion === 2,
    { version: resaved.json && resaved.json.rule && resaved.json.rule.rulesVersion });

  const sellerCannotSetRate = await api('PUT', '/api/admin/business/commissions/rules', {
    token: sellerToken, body: { kind: 'SELLER_PERCENT', appliesToId: sellerId, percentBps: 9000 },
  });
  check('commission: a seller cannot change its own rate', sellerCannotSetRate.status === 403, { status: sellerCannotSetRate.status });

  // ---- G. the nine-step recharge ----------------------------------------
  const order = await api('POST', '/api/business/orders', { token: sellerToken, body: { phone: userPhone, packageKey: 'PKR_1000', paymentMethod: 'CASH', note: 'e2e counter sale' } });
  const orderId = order.json && order.json.order && order.json.order.id;
  check('recharge: a seller opens an order with a unique reference and an expiry',
    order.status === 201 && /^RO-/.test(order.json.order.reference) && !!order.json.order.expiresAt,
    order.json && { reference: order.json.order.reference, status: order.json.order.status, diamonds: order.json.order.diamonds, amountCents: order.json.order.amountCents });

  const attributed = order.json && order.json.order;
  check('recharge: the order is attributed to the BD that owns the seller',
    !!attributed && attributed.bdCode === `BDA-E2E-${stamp}`, { bdCode: attributed && attributed.bdCode });

  const balanceBefore = Number(await scalar(`select diamond_balance from users where phone = '${userPhone}'`));

  const noEvidence = await api('POST', `/api/business/orders/${orderId}/mark-paid`, { token: sellerToken, body: { paymentRef: 'e2e-ref-0001' } });
  check('recharge: marking an order paid without evidence is refused', noEvidence.status === 400 && noEvidence.json.error.code === 'evidence_required', noEvidence.json && noEvidence.json.error);

  const marked = await api('POST', `/api/business/orders/${orderId}/mark-paid`, {
    token: sellerToken, body: { paymentRef: 'e2e-ref-0001', evidence: { receipt: 'e2e://receipt/1', operator: 'counter' } },
  });
  const balanceAfterClaim = Number(await scalar(`select diamond_balance from users where phone = '${userPhone}'`));
  check('recharge: a seller claim moves the order to verification and credits nothing',
    marked.status === 200 && marked.json.order.status === 'AWAITING_VERIFICATION' && balanceAfterClaim === balanceBefore,
    { status: marked.json && marked.json.order.status, balance: balanceAfterClaim });

  const doubleClaim = await api('POST', `/api/business/orders/${orderId}/mark-paid`, {
    token: sellerToken, body: { paymentRef: 'e2e-ref-0002', evidence: { receipt: 'e2e://receipt/2' } },
  });
  check('recharge: a second claim on an order already awaiting verification is refused', doubleClaim.status === 409, { status: doubleClaim.status, code: doubleClaim.json && doubleClaim.json.error && doubleClaim.json.error.code });

  const sellerApproves = await api('POST', `/api/admin/business/recharges/${orderId}/approve`, { token: sellerToken, body: {} });
  check('recharge: a seller cannot approve its own order', sellerApproves.status === 403, { status: sellerApproves.status });

  const approved = await api('POST', `/api/admin/business/recharges/${orderId}/approve`, {
    token: finance.token, body: { decisionNote: 'e2e verified against receipt', feeCents: 2500 },
  });
  const balanceAfterCredit = Number(await scalar(`select diamond_balance from users where phone = '${userPhone}'`));
  check('recharge: finance approval credits the package exactly once',
    approved.status === 200 && approved.json.order.status === 'CREDITED' && balanceAfterCredit === balanceBefore + 550,
    { status: approved.status, order: approved.json && approved.json.order && approved.json.order.status, delta: balanceAfterCredit - balanceBefore });

  const ledgerRows = await scalar(`select count(*) from transactions where meta->>'rechargeOrderId' = '${orderId}'`);
  check('recharge: one ledger row is posted for the credited order', Number(ledgerRows) === 1, { ledgerRows });

  const proof = await scalar(`select provider || '/' || external_id from payment_proofs where user_id = (select id from users where phone = '${userPhone}') order by created_at desc limit 1`);
  check('recharge: the credit is proved under the order reference', /^seller\//.test(proof || ''), { proof });

  const entries = await sql(
    `select kind, beneficiary, amount_cents, rule_version from commission_entries where recharge_order_id = '${orderId}' order by kind`,
  );
  // §22: the percentage is taken on the eligible *net* value — what the platform actually kept
  // after the provider fee — not the face value the customer handed over.
  const amountCents = 100000;
  const feeCents = 2500;
  const netCents = amountCents - feeCents;
  const expected = { SELLER_PERCENT: Math.floor((netCents * 600) / 10000), BD_PERCENT: Math.floor((netCents * 200) / 10000) };
  const sumBy = (kind) => Number((entries.rows.find((e) => e.kind === kind) || {}).amount_cents || -1);
  check('commission: both partners accrue on the eligible net value, in currency not coins',
    entries.rows.length === 2 && sumBy('SELLER_PERCENT') === expected.SELLER_PERCENT && sumBy('BD_PERCENT') === expected.BD_PERCENT,
    { entries: entries.rows.map((e) => `${e.kind}:${e.amount_cents}:${e.rule_version}`), expected });

  const journal = await sql(
    `select l.account_code code, l.direction direction, sum(l.amount_cents) cents
       from fin_journal_entries e
       join fin_journal_lines l on l.entry_id = e.id
      where e.source_kind='RECHARGE_ORDER' and e.source_id='${orderId}'
      group by l.account_code, l.direction order by l.account_code`,
  );
  const booked = Object.fromEntries(journal.rows.map((r) => [`${r.code}:${r.direction}`, Number(r.cents)]));
  const jDebits = journal.rows.filter((r) => r.direction === 'DEBIT').reduce((s, r) => s + Number(r.cents), 0);
  const jCredits = journal.rows.filter((r) => r.direction === 'CREDIT').reduce((s, r) => s + Number(r.cents), 0);
  check('journal: the collection is split into what was kept and what the provider took',
    booked['PROVIDER_COLLECTIONS:DEBIT'] === netCents && booked['PROVIDER_FEES:DEBIT'] === feeCents,
    { booked });
  check('journal: issued coins are a liability, never revenue, and the entry balances',
    booked['COIN_LIABILITY:CREDIT'] === amountCents && jDebits === jCredits && jDebits === amountCents && !booked['PLATFORM_REVENUE:CREDIT'],
    { debits: jDebits, credits: jCredits });

  const commissionJournal = await sql(
    `select coalesce(sum(l.amount_cents) filter (where l.direction='DEBIT'),0) debits,
            coalesce(sum(l.amount_cents) filter (where l.direction='CREDIT'),0) credits,
            count(*) filter (where l.direction='CREDIT') credit_lines
       from fin_journal_entries e
       join fin_journal_lines l on l.entry_id = e.id
      where e.source_kind='COMMISSION_ACCRUAL' and e.source_id='${orderId}'`,
  );
  const cj = commissionJournal.rows[0] || {};
  check('journal: the accrual is its own balanced entry (expense against two payables)',
    Number(cj.debits) === Number(cj.credits) && Number(cj.debits) === expected.SELLER_PERCENT + expected.BD_PERCENT,
    { debits: cj.debits, credits: cj.credits });

  const snapshot = await scalar(`select rules_snapshot::text from recharge_orders where id = '${orderId}'`);
  check('recharge: the rate version used is frozen on the order', /ruleVersion":\s*2/.test(snapshot || ''), { snapshot: (snapshot || '').slice(0, 140) });

  // ---- H. duplicate notifications and concurrent approvals ----------------
  const replay = await api('POST', `/api/admin/business/recharges/${orderId}/approve`, { token: finance.token, body: { decisionNote: 'second click' } });
  const balanceAfterReplay = Number(await scalar(`select diamond_balance from users where phone = '${userPhone}'`));
  const dupEntries = await scalar(`select count(*) from commission_entries where recharge_order_id = '${orderId}'`);
  check('recharge: a repeated approval credits nothing and accrues nothing',
    replay.status === 200 && replay.json.credited === false && balanceAfterReplay === balanceAfterCredit && Number(dupEntries) === 2,
    { credited: replay.json && replay.json.credited, balance: balanceAfterReplay, entries: dupEntries });

  // Fresh order, approved by three operators at once: the row lock and the payment proof must
  // agree that exactly one of them did anything.
  const racedOrder = await api('POST', '/api/business/orders', { token: sellerToken, body: { phone: userPhone, packageKey: 'PKR_500', paymentMethod: 'BANK' } });
  const racedId = racedOrder.json && racedOrder.json.order && racedOrder.json.order.id;
  const balanceBeforeRace = Number(await scalar(`select diamond_balance from users where phone = '${userPhone}'`));
  const race = await Promise.all([
    api('POST', `/api/admin/business/recharges/${racedId}/approve`, { token: finance.token, body: { decisionNote: 'race 1' } }),
    api('POST', `/api/admin/business/recharges/${racedId}/approve`, { token: admin, body: { decisionNote: 'race 2' } }),
    api('POST', `/api/admin/business/recharges/${racedId}/approve`, { token: finance.token, body: { decisionNote: 'race 3' } }),
  ]);
  const creditedCount = race.filter((r) => r.status === 200 && r.json && r.json.credited === true).length;
  const balanceAfterRace = Number(await scalar(`select diamond_balance from users where phone = '${userPhone}'`));
  const raceEntries = await scalar(`select count(*) from commission_entries where recharge_order_id = '${racedId}'`);
  const raceLedger = await scalar(`select count(*) from transactions where meta->>'rechargeOrderId' = '${racedId}'`);
  check('concurrency: three simultaneous approvals credit the coins once',
    race.every((r) => r.status === 200) && creditedCount === 1 && balanceAfterRace - balanceBeforeRace === 260 && Number(raceLedger) === 1 && Number(raceEntries) === 2,
    { credited: creditedCount, delta: balanceAfterRace - balanceBeforeRace, ledger: raceLedger, entries: raceEntries });

  // ---- I. per-seller limits under concurrency ----------------------------
  const beforeLimit = Number(await scalar(`select count(*) from recharge_orders where seller_id = '${sellerId}' and created_at >= date_trunc('day', now()) and status not in ('CANCELLED','EXPIRED','REJECTED')`));
  const limited = await api('PATCH', `/api/admin/business/accounts/${sellerId}`, { token: admin, body: { dailyOrderLimit: beforeLimit + 3 } });
  const burst = await Promise.all(
    [0, 1, 2, 3, 4].map(() => api('POST', '/api/business/orders', { token: sellerToken, body: { phone: userPhone, packageKey: 'PKR_250', paymentMethod: 'CASH' } })),
  );
  const afterLimit = Number(await scalar(`select count(*) from recharge_orders where seller_id = '${sellerId}' and created_at >= date_trunc('day', now()) and status not in ('CANCELLED','EXPIRED','REJECTED')`));
  const rejected = burst.filter((r) => r.status === 403).map((r) => r.json.error.code);
  check('limits: five concurrent orders cannot slip past a daily limit of three',
    limited.status === 200 && afterLimit - beforeLimit === 3 && rejected.includes('daily_order_limit'),
    { created: afterLimit - beforeLimit, rejected: [...new Set(rejected)] });

  await api('PATCH', `/api/admin/business/accounts/${sellerId}`, { token: admin, body: { dailyOrderLimit: 200, maxOrderDiamonds: 100000 } });

  // ---- I2. the provider confirms a payment, twice -------------------------
  // A PSP notification is the other half of step 4. It goes through the backend's own service
  // (the same function a webhook handler calls), because no fake provider posts to this stack.
  const pspOrder = await api('POST', '/api/business/orders', { token: sellerToken, body: { phone: userPhone, packageKey: 'PKR_250', paymentMethod: 'EASYPAISA' } });
  const pspId = pspOrder.json.order.id;
  await api('POST', `/api/business/orders/${pspId}/mark-paid`, {
    token: sellerToken, body: { paymentRef: 'e2e-psp-0001', evidence: { wallet: 'easypaisa', trace: 'e2e' } },
  });
  await sql(`update recharge_orders set provider = 'e2e-psp', external_id = 'pi_e2e_${stamp}' where id = '${pspId}'`);
  const beforePsp = Number(await scalar(`select diamond_balance from users where phone = '${userPhone}'`));

  const rechargeService = require(path.join(BE_ROOT, 'dist', 'services', 'seller-recharge.service.js'));
  const deliveries = await Promise.all([
    rechargeService.verifyProviderPayment({ provider: 'e2e-psp', externalId: `pi_e2e_${stamp}`, meta: { attempt: 1 } }),
    rechargeService.verifyProviderPayment({ provider: 'e2e-psp', externalId: `pi_e2e_${stamp}`, meta: { attempt: 2 } }),
  ]);
  const pspLedger = await scalar(`select count(*) from transactions where meta->>'rechargeOrderId' = '${pspId}'`);
  const afterPsp = Number(await scalar(`select diamond_balance from users where phone = '${userPhone}'`));
  check('notification: a duplicated provider confirmation credits the coins once',
    deliveries.every((d) => d.matched) && deliveries.filter((d) => d.credited).length === 1 &&
      afterPsp - beforePsp === 125 && Number(pspLedger) === 1,
    { credited: deliveries.filter((d) => d.credited).length, delta: afterPsp - beforePsp, ledger: pspLedger });

  // ---- J. reversal and reconciliation -------------------------------------
  const balanceBeforeReverse = Number(await scalar(`select diamond_balance from users where phone = '${userPhone}'`));
  const reversed = await api('POST', `/api/admin/business/recharges/${orderId}/reverse`, {
    token: finance.token, body: { reason: 'e2e chargeback from the bank', refundCents: 100000 },
  });
  const balanceAfterReverse = Number(await scalar(`select diamond_balance from users where phone = '${userPhone}'`));
  const reversedEntries = await scalar(`select count(*) from commission_entries where recharge_order_id = '${orderId}' and status = 'REVERSED'`);
  check('reversal: a clawback and its commission reversal are one decision',
    reversed.status === 200 && reversed.json.order.status === 'REVERSED' && balanceBeforeReverse - balanceAfterReverse === 550 && Number(reversedEntries) === 2,
    { status: reversed.json && reversed.json.order.status, clawedBack: balanceBeforeReverse - balanceAfterReverse, reversedEntries });

  const keptReference = await scalar(`select transaction_id from recharge_orders where id = '${orderId}'`);
  check('reversal: the reversed order still names the ledger row it compensates', !!keptReference, { transactionId: keptReference });

  const clawRows = await scalar(`select count(*) from transactions where type = 'RECHARGE_REVERSAL' and receiver_id is null and meta->>'rechargeOrderId' = '${orderId}'`);
  check('reversal: the clawback is a new posted row, never an edited one', Number(clawRows) === 1, { clawRows });

  const reversalJournal = await sql(
    `select l.account_code code, l.direction direction, sum(l.amount_cents) cents
       from fin_journal_entries e
       join fin_journal_lines l on l.entry_id = e.id
      where e.source_kind='REVERSAL' and e.source_id = 'order:${orderId}'
      group by l.account_code, l.direction`,
  );
  const back = Object.fromEntries(reversalJournal.rows.map((r) => [`${r.code}:${r.direction}`, Number(r.cents)]));
  const rjDebits = Object.entries(back).filter(([k]) => k.endsWith(':DEBIT')).reduce((s, [, v]) => s + v, 0);
  const rjCredits = Object.entries(back).filter(([k]) => k.endsWith(':CREDIT')).reduce((s, [, v]) => s + v, 0);
  check('reversal: the refund is booked back off the coin liability, fee split included',
    rjDebits === rjCredits && rjDebits === amountCents &&
      back['COIN_LIABILITY:DEBIT'] === amountCents && back['PROVIDER_COLLECTIONS:CREDIT'] === netCents && back['PROVIDER_FEES:CREDIT'] === feeCents,
    { debits: rjDebits, credits: rjCredits, back });

  const reopen = await api('POST', `/api/admin/business/recharges/${orderId}/approve`, { token: finance.token, body: {} });
  check('reversal: a reversed order cannot be credited again', reopen.status === 409, { status: reopen.status, code: reopen.json && reopen.json.error && reopen.json.error.code });

  // ---- K. settlements, and who may approve one ---------------------------
  const period = { periodFrom: new Date(Date.now() - 86400000).toISOString(), periodTo: new Date(Date.now() + 86400000).toISOString() };
  const settlement = await api('POST', '/api/admin/business/commissions/settlements', {
    token: admin, body: { beneficiary: 'SELLER', beneficiaryId: sellerId, ...period, payoutMethod: 'BANK' },
  });
  const settlementId = settlement.json && settlement.json.settlement && settlement.json.settlement.id;
  check('settlement: an accrual batch is created from eligible entries only',
    settlement.status === 201 && Number(settlement.json.settlement.amountCents) > 0,
    settlement.json && { amount: settlement.json.settlement.amountCents, entries: settlement.json.settlement.entryCount });

  const selfApprove = await api('POST', `/api/admin/business/commissions/settlements/${settlementId}/approve`, { token: admin, body: {} });
  check('settlement: the operator who raised it cannot approve it', selfApprove.status === 403 && selfApprove.json.error.code === 'self_approval', selfApprove.json && selfApprove.json.error);

  const approvedBatch = await api('POST', `/api/admin/business/commissions/settlements/${settlementId}/approve`, { token: finance.token, body: {} });
  const paidBatch = await api('POST', `/api/admin/business/commissions/settlements/${settlementId}/pay`, { token: finance.token, body: { note: 'e2e bank transfer done' } });
  check('settlement: a second operator approves and the payout is recorded',
    approvedBatch.status === 200 && approvedBatch.json.settlement.status === 'APPROVED' && paidBatch.status === 200 && paidBatch.json.settlement.status === 'PAID',
    { approved: approvedBatch.json && approvedBatch.json.settlement.status, paid: paidBatch.json && paidBatch.json.settlement.status });

  const settleTwice = await api('POST', '/api/admin/business/commissions/settlements', {
    token: admin, body: { beneficiary: 'SELLER', beneficiaryId: sellerId, ...period, payoutMethod: 'BANK' },
  });
  check('settlement: a settled entry cannot be claimed into a second batch', settleTwice.status === 409 && settleTwice.json.error.code === 'nothing_to_settle', settleTwice.json && settleTwice.json.error);

  const reverseSettled = await api('POST', `/api/admin/business/recharges/${racedId}/reverse`, { token: finance.token, body: { reason: 'e2e too late' } });
  check('settlement: commission already paid out is not silently un-paid', reverseSettled.status === 409 && reverseSettled.json.error.code === 'commission_already_settled', reverseSettled.json && reverseSettled.json.error);

  // ---- L. scope boundaries for BD reads ----------------------------------
  const otherSeller = await api('POST', '/api/admin/business/accounts', {
    token: admin, body: { kind: 'COIN_SELLER', displayName: `E2E other ${stamp}`, code: `SLR-OTH-${stamp}`, parentId: managerId, password: 'e2eotherpass1' },
  });
  const otherSellerId = otherSeller.json && otherSeller.json.account && otherSeller.json.account.id;
  await api('POST', `/api/admin/business/accounts/${otherSellerId}/status`, { token: admin, body: { status: 'ACTIVE' } });

  const bdToken = (await api('POST', '/api/business/login', { body: { code: `BDA-E2E-${stamp}`, password: 'e2eagentpass1' } })).json;
  check('bd: an agent needs a credential issued by an operator', !bdToken || !bdToken.token, { got: !!bdToken && !!bdToken.token });

  await api('POST', `/api/admin/business/accounts/${agentId}/password`, { token: admin, body: { password: 'e2eagentpass1' } });
  const agentLogin = await api('POST', '/api/business/login', { body: { code: `BDA-E2E-${stamp}`, password: 'e2eagentpass1' } });
  const agentToken = agentLogin.json && agentLogin.json.token;
  check('bd: the agent signs in with an operator-issued password', agentLogin.status === 200 && !!agentToken, { status: agentLogin.status });

  const agentCannotCreate = await api('POST', '/api/business/orders', { token: agentToken, body: { phone: userPhone, packageKey: 'PKR_250', paymentMethod: 'CASH' } });
  check('bd: a BD agent cannot open recharge orders', agentCannotCreate.status === 403 && agentCannotCreate.json.error.code === 'permission_denied', { status: agentCannotCreate.status });

  const agentRoster = await api('GET', '/api/business/sellers', { token: agentToken });
  const rosterIds = (agentRoster.json && agentRoster.json.sellers || []).map((s) => s.id);
  check('bd: the agent sees its own seller and not the manager’s other seller',
    agentRoster.status === 200 && rosterIds.includes(sellerId) && !rosterIds.includes(otherSellerId),
    { roster: rosterIds.length, includesOther: rosterIds.includes(otherSellerId) });

  const agentOrders = await api('GET', '/api/business/orders', { token: agentToken });
  const foreignOrder = await api('GET', `/api/business/orders/${racedId}`, { token: (await api('POST', '/api/business/login', { body: { code: `SLR-E2E-${stamp}`, password: 'e2esellerpass1' } })).json.token });
  const strangerSeller = await api('POST', '/api/business/login', { body: { code: `SLR-OTH-${stamp}`, password: 'e2eotherpass1' } });
  const peek = await api('GET', `/api/business/orders/${racedId}`, { token: strangerSeller.json && strangerSeller.json.token });
  check('seller: another seller’s order id answers 404, not its contents', peek.status === 404, { status: peek.status });
  check('seller: the owner can still read its own order', foreignOrder.status === 200 && foreignOrder.json.order.id === racedId, { status: foreignOrder.status });
  check('bd: territory orders exclude the other seller’s book',
    agentOrders.status === 200 && (agentOrders.json.orders || []).every((o) => o.sellerId === sellerId),
    { orders: (agentOrders.json && agentOrders.json.orders || []).length });

  const agentStatement = await api('GET', '/api/business/statement', { token: agentToken });
  check('bd: a statement is its own commission, not the whole company’s',
    agentStatement.status === 200 && (agentStatement.json.entries || []).every((e) => e.beneficiaryId === agentId),
    { entries: (agentStatement.json && agentStatement.json.entries || []).length });

  // ---- M. suspension, evidence, expiry, and the audit trail --------------
  const suspended = await api('POST', `/api/admin/business/accounts/${sellerId}/status`, { token: admin, body: { status: 'SUSPENDED', reason: 'e2e suspicious volume' } });
  const whileSuspended = await api('GET', '/api/business/orders', { token: sellerToken });
  check('seller: a suspended partner is locked out on the next request',
    suspended.status === 200 && whileSuspended.status === 403 && whileSuspended.json.error.code === 'business_account_inactive',
    { status: whileSuspended.status });

  const reactivate = await api('POST', `/api/admin/business/accounts/${sellerId}/status`, { token: admin, body: { status: 'ACTIVE' } });
  check('seller: reactivation is an operator decision', reactivate.status === 200 && reactivate.json.account.status === 'ACTIVE', { status: reactivate.status });

  const stale = await api('POST', '/api/business/orders', { token: sellerToken, body: { phone: userPhone, packageKey: 'PKR_250', paymentMethod: 'CASH' } });
  await sql(`update recharge_orders set expires_at = now() - interval '1 minute' where id = '${stale.json.order.id}'`);
  const swept = await api('POST', '/api/admin/business/recharges/sweep-expiry', { token: admin, body: {} });
  const staleNow = await api('GET', `/api/admin/business/recharges/${stale.json.order.id}`, { token: admin });
  check('recharge: an order that aged out is expired by the sweep',
    swept.status === 200 && swept.json.expired >= 1 && staleNow.json.order.status === 'EXPIRED',
    { expired: swept.json && swept.json.expired, status: staleNow.json && staleNow.json.order.status });

  const lateApprove = await api('POST', `/api/admin/business/recharges/${stale.json.order.id}/approve`, { token: finance.token, body: {} });
  check('recharge: an expired claim cannot be paid out of the archive', lateApprove.status === 409, { status: lateApprove.status, code: lateApprove.json && lateApprove.json.error && lateApprove.json.error.code });

  const audit = await api('GET', `/api/admin/audit?businessId=${sellerId}&limit=100`, { token: admin });
  const actions = (audit.json && audit.json.entries || []).map((e) => e.action);
  check('audit: the partner’s own trail is attributable and filterable',
    audit.status === 200 && actions.length > 0 && actions.includes('RECHARGE_ORDER_CREATE') && actions.includes('RECHARGE_ORDER_MARKED_PAID'),
    { actions: [...new Set(actions)] });

  const operatorAudit = await api('GET', `/api/admin/audit?targetType=recharge_order&limit=200`, { token: admin });
  const reviewedEntries = (operatorAudit.json && operatorAudit.json.entries) || [];
  const reviewed = reviewedEntries.map((e) => e.action);
  check('audit: every decision taken about an order is in the log',
    reviewed.includes('RECHARGE_ORDER_CREDIT') && reviewed.includes('RECHARGE_ORDER_REVERSE') && reviewed.includes('RECHARGE_ORDER_EXPIRE'),
    { actions: [...new Set(reviewed)].slice(0, 12) });

  const rateAndAccount = await api('GET', `/api/admin/audit?limit=400`, { token: admin });
  const allActions = (rateAndAccount.json && rateAndAccount.json.entries || []).map((e) => e.action);
  check('audit: opening a partner and publishing its rate are audited as well',
    allActions.includes('COMMISSION_RULE_PUBLISH') && allActions.includes('BUSINESS_ACCOUNT_CREATE'),
    { actions: [...new Set(allActions)].slice(0, 14) });

  const sweptByMachine = reviewedEntries.filter((e) => e.action === 'RECHARGE_ORDER_EXPIRE' && e.actorKind === 'system');
  check('audit: an unattended state change names the process that ran it',
    sweptByMachine.length > 0 && sweptByMachine.every((e) => e.actor === 'recharge-expiry-sweep'),
    { actor: sweptByMachine[0] && sweptByMachine[0].actor, count: sweptByMachine.length });

  const modAudit = await api('GET', '/api/admin/audit?limit=10', { token: moderator.token });
  check('audit: reading the log is its own permission', modAudit.status === 403 && modAudit.json.error.code === 'permission_denied', { status: modAudit.status });

  // ---- N. the books balance ----------------------------------------------
  const trial = await api('GET', '/api/admin/business/finance/trial-balance', { token: finance.token });
  check('journal: the trial balance still sums to zero after all of the above',
    trial.status === 200 && trial.json.trial.balanced === true,
    { debits: trial.json && trial.json.trial.totalDebits, credits: trial.json && trial.json.trial.totalCredits });

  const liability = await api('GET', '/api/admin/business/finance/balance/COIN_LIABILITY', { token: finance.token });
  check('journal: issued coins sit as a liability, not as revenue',
    liability.status === 200 && Number(liability.json.account.balance) > 0,
    { balance: liability.json && liability.json.account.balance });

  const revenue = await api('GET', '/api/admin/business/finance/balance/PLATFORM_REVENUE', { token: finance.token });
  check('journal: nothing has been recognised as revenue from coin face value',
    revenue.status === 200 && Number(revenue.json.account.balance) === 0,
    { balance: revenue.json && revenue.json.account.balance });

  const unbalanced = await scalar(
    `select count(*) from (
       select e.id, sum(l.amount_cents) filter (where l.direction='DEBIT') d, sum(l.amount_cents) filter (where l.direction='CREDIT') c
         from fin_journal_entries e join fin_journal_lines l on l.entry_id = e.id group by e.id) x
      where x.d <> x.c`,
  );
  check('journal: every posted entry is balanced in the database', Number(unbalanced) === 0, { unbalanced });

  const overCommission = await scalar(
    `select count(*) from (
       select recharge_order_id, sum(amount_cents) s from commission_entries
        where status not in ('REJECTED','REVERSED') group by recharge_order_id) x
      join recharge_orders o on o.id = x.recharge_order_id where x.s > o.amount_cents`,
  );
  check('commission: no order ever owed more than it collected', Number(overCommission) === 0, { overCommission });

  const credited = await scalar(
    `select count(*) from recharge_orders where status = 'CREDITED' and transaction_id is null`,
  );
  check('recharge: no credited order is missing its ledger row', Number(credited) === 0, { credited });

  // ---- O. the switches are administrator-owned ---------------------------
  const configRead = await api('GET', '/api/admin/business/config/business.recharge', { token: finance.token });
  check('config: the recharge window and evidence rule are readable', configRead.status === 200 && !!configRead.json.value, configRead.json && configRead.json.value);

  const configWrite = await api('PUT', '/api/admin/business/config/business.recharge', {
    token: admin, body: { value: { orderValidityMinutes: 45, manualEvidenceRequired: true, autoCreditFromProvider: false } },
  });
  check('config: an operator can shorten the verification window', configWrite.status === 200 && configWrite.json.value.orderValidityMinutes === 45, configWrite.json && configWrite.json.value);

  const shortWindow = await api('POST', '/api/business/orders', { token: sellerToken, body: { phone: userPhone, packageKey: 'PKR_250', paymentMethod: 'CASH' } });
  const ttl = shortWindow.json && shortWindow.json.order && shortWindow.json.order.expiresAt
    ? (new Date(shortWindow.json.order.expiresAt).getTime() - Date.now()) / 60000
    : 0;
  check('config: the new window is what the next order is given', ttl > 40 && ttl <= 46, { minutes: Math.round(ttl * 100) / 100 });

  await api('PUT', '/api/admin/business/config/business.recharge', {
    token: admin, body: { value: { orderValidityMinutes: 60, manualEvidenceRequired: true, autoCreditFromProvider: true } },
  });

  const allocation = await api('PUT', '/api/admin/business/config/commission.calculationOrder', {
    token: admin, body: { value: { enabled: ['SELLER_PERCENT', 'BD_PERCENT'], maxAllocationBps: 1200 } },
  });
  check('config: the commission order and ceiling are an administrator decision', allocation.status === 200, { status: allocation.status });

  const cappedOrder = await api('POST', '/api/business/orders', { token: sellerToken, body: { phone: userPhone, packageKey: 'PKR_1000', paymentMethod: 'CASH' } });
  await api('POST', `/api/business/orders/${cappedOrder.json.order.id}/mark-paid`, {
    token: sellerToken, body: { paymentRef: 'e2e-cap-0001', evidence: { receipt: 'e2e://receipt/cap' } },
  });
  const capped = await api('POST', `/api/admin/business/recharges/${cappedOrder.json.order.id}/approve`, { token: finance.token, body: { feeCents: 5000 } });
  const cappedEntries = await sql(
    `select kind, amount_cents from commission_entries where recharge_order_id = '${cappedOrder.json.order.id}' order by kind`,
  );
  const cappedTotal = cappedEntries.rows.reduce((sum, e) => sum + Number(e.amount_cents), 0);
  const ceiling = Math.floor(((100000 - 5000) * 1200) / 10000);
  const sellerLine = Number((cappedEntries.rows.find((e) => e.kind === 'SELLER_PERCENT') || {}).amount_cents || -1);
  check('commission: the configured ceiling and kind order decide what each partner is owed',
    capped.status === 200 && cappedTotal <= ceiling && sellerLine === Math.floor((95000 * 600) / 10000),
    { total: cappedTotal, ceiling, lines: cappedEntries.rows.map((e) => `${e.kind}:${e.amount_cents}`) });

  await api('PUT', '/api/admin/business/config/commission.calculationOrder', {
    token: admin,
    body: { value: { enabled: ['SELLER_TIER', 'SELLER_PERCENT', 'SELLER_FIXED', 'BD_PERCENT', 'BD_FIXED'], maxAllocationBps: 2500 } },
  });

  const passed = out.filter((l) => l.startsWith('PASS')).length;
  process.stdout.write(out.join('\n') + `\n\n${passed}/${out.length} business checks passed\n`);
  await (await db()).end();
  process.exit(passed === out.length ? 0 : 1);
})().catch((e) => {
  process.stdout.write(out.join('\n') + '\n');
  console.error('BUSINESS E2E CRASH', e);
  process.exit(1);
});
