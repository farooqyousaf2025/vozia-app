/* End-to-end tests for QA marking (migration 0039, README "QA programme marking").
   Drives a *running* backend over HTTP and asserts on database state through the backend's own pg
   pool — no mocks, no fixtures.

     1. boot the stack and the API (README), then `npm run build`
     2. node scripts/qa-e2e.cjs

   Runs against a development database only. It marks real accounts as QA and unmarks them again
   before it exits, and it disables the two operators it creates. Nothing is deleted.

   The checks worth reading first are the three that guard the design decision: marking an account
   reclassifies transactions that already existed (the flag is derived, not copied), unmarking puts
   them back without rewriting a financial row, and neither `is_test` nor `qa_ref` ever reaches a
   member-facing payload. The rest is the permission split and the cohort's all-or-nothing write. */
const path = require('path');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const out = [];
let failed = 0;
function report(name, pass, detail) {
  if (!pass) failed += 1;
  out.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
}

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
const scalar = async (q, p) => Number((await sql(q, p)).rows[0]?.n ?? 0);

async function api(method, p, { token, body } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, code: json && json.error && json.error.code };
}

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const ref = (role) => `QA-${RUN}-${role}`;

/** A member session, the only way this stack issues one: OTP is mocked in development. */
async function member(phone) {
  const username = `qa${phone.slice(-8)}`;
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error(`request-otp failed: ${JSON.stringify(challenge.json)}`);
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: '123456', username } });
  if (verified.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verified.json)}`);
  const row = (await sql('SELECT id FROM users WHERE phone = $1', [phone])).rows[0];
  if (!row) throw new Error(`no account behind ${phone}`);
  return { token: verified.json.token, id: row.id, phone };
}

const markingOf = async (ownerId) =>
  (await sql('SELECT is_test, qa_ref FROM qa_identities WHERE owner_id = $1', [ownerId])).rows[0];

/** How many of one account's transaction rows the derivation currently calls test activity. */
const markedTxCount = async (ownerId) =>
  scalar(
    `SELECT COUNT(*) AS n FROM qa_money_marking m
      WHERE m.source_table = 'transactions' AND m.is_test
        AND m.source_id IN (SELECT id FROM transactions WHERE sender_id = $1 OR receiver_id = $1)`,
    [ownerId],
  );

const createdOperators = [];

(async () => {
  const login = await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } });
  if (login.status !== 200 || !login.json?.token) throw new Error(`admin login failed: ${JSON.stringify(login.json)}`);
  const T = login.json.token;
  const adminId = (await sql("SELECT id FROM admins WHERE username = 'admin'")).rows[0].id;

  // --- The schema's own refusals -------------------------------------------
  const cols = await sql(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'is_test' AND table_name IN ('users','agencies','business_accounts','admins')`,
  );
  report('all four identity tables carry is_test', cols.rows.length === 4, { tables: cols.rows.map((r) => r.table_name).sort() });

  const probe = await member(`+92300${String(Date.now()).slice(-7)}`);
  let checkRefused = false;
  try {
    await sql('UPDATE users SET is_test = true WHERE id = $1', [probe.id]);
  } catch (err) {
    checkRefused = /users_test_needs_ref|check constraint/i.test(String(err.message));
  }
  report('the database refuses a test account with no internal reference', checkRefused);
  report('the refused mark left the account unmarked', (await markingOf(probe.id))?.is_test === false);

  // --- Marking through the product's own route ------------------------------
  const badShape = await api('POST', '/api/admin/qa/identities/mark', {
    token: T, body: { ownerKind: 'USER', ownerId: probe.id, isTest: true, qaRef: 'not a ref!' },
  });
  report('a malformed reference is refused by name', badShape.status === 400 && badShape.code === 'qa_ref_invalid',
    { status: badShape.status, code: badShape.code });

  const noRef = await api('POST', '/api/admin/qa/identities/mark', {
    token: T, body: { ownerKind: 'USER', ownerId: probe.id, isTest: true },
  });
  report('marking without a reference is refused', noRef.status === 400 && noRef.code === 'qa_ref_required',
    { status: noRef.status, code: noRef.code });

  const missing = await api('POST', '/api/admin/qa/identities/mark', {
    token: T, body: { ownerKind: 'USER', ownerId: '00000000-0000-0000-0000-000000000000', isTest: true, qaRef: ref('GHOST') },
  });
  report('marking an account that does not exist is a 404', missing.status === 404 && missing.code === 'qa_account_not_found',
    { status: missing.status, code: missing.code });

  const marked = await api('POST', '/api/admin/qa/identities/mark', {
    token: T, body: { ownerKind: 'USER', ownerId: probe.id, isTest: true, qaRef: ref('USER').toLowerCase() },
  });
  report('an account can be marked', marked.status === 200 && marked.json?.isTest === true, { status: marked.status });
  report('the reference is normalised to upper case', marked.json?.qaRef === ref('USER'), { qaRef: marked.json?.qaRef });
  report('the display name is untouched by marking',
    marked.json?.displayName === (await sql('SELECT username FROM users WHERE id = $1', [probe.id])).rows[0].username);

  const audit = await scalar(
    "SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'QA_MARK' AND target_id = $1 AND admin_id = $2",
    [probe.id, adminId],
  );
  report('the mark wrote an audit row naming the operator', audit === 1, { audit });

  const roster = await api('GET', `/api/admin/qa/identities?search=${ref('USER')}`, { token: T });
  report('the roster finds the marked account by reference',
    roster.status === 200 && roster.json?.identities?.some((i) => i.ownerId === probe.id && i.isTest),
    { status: roster.status, total: roster.json?.total });

  const dupeRef = await api('POST', '/api/admin/qa/identities/mark', {
    token: T, body: { ownerKind: 'USER', ownerId: adminId, isTest: false, qaRef: ref('USER') },
  });
  report('a reference cannot be reused by another account', dupeRef.status >= 400, { status: dupeRef.status });

  // --- The derivation: money that already existed ---------------------------
  const gifter = (await sql(
    `SELECT u.id FROM users u JOIN transactions t ON t.sender_id = u.id
      WHERE t.type = 'GIFT_SENT' AND t.status = 'COMPLETED' AND NOT u.is_test
        AND t.created_at >= now() - interval '30 days'
      GROUP BY u.id ORDER BY COUNT(t.id) DESC LIMIT 1`,
  )).rows[0];
  if (!gifter) throw new Error('no unmarked account with recent gift history — run the gift suite first');

  const before = await markedTxCount(gifter.id);
  report('an unmarked account’s history is production money', before === 0, { before });

  const statsBefore = await api('GET', '/api/admin/stats', { token: T });
  const analyticsBefore = await api('GET', '/api/admin/gifts/analytics?days=365', { token: T });
  const boardBefore = await api('GET', '/api/users/top?window=month&role=senders&limit=100');

  const gifterMark = await api('POST', '/api/admin/qa/identities/mark', {
    token: T, body: { ownerKind: 'USER', ownerId: gifter.id, isTest: true, qaRef: ref('GIFTER') },
  });
  report('an account with existing history can be marked', gifterMark.status === 200, { status: gifterMark.status });

  const after = await markedTxCount(gifter.id);
  const gifterTx = await scalar(
    'SELECT COUNT(*) AS n FROM transactions WHERE sender_id = $1 OR receiver_id = $1', [gifter.id],
  );
  report('marking reclassifies transactions that already existed', after === gifterTx && after > 0,
    { after, gifterTx });

  const refsOnMoney = await sql(
    `SELECT DISTINCT unnest(test_refs) AS r FROM qa_money_marking
      WHERE is_test AND source_table = 'transactions'
        AND source_id IN (SELECT id FROM transactions WHERE sender_id = $1 OR receiver_id = $1)`,
    [gifter.id],
  );
  report('the money rows name whose test it was',
    refsOnMoney.rows.some((r) => r.r === ref('GIFTER')), { refs: refsOnMoney.rows.map((r) => r.r) });

  const journalMarked = await scalar(
    `SELECT COUNT(*) AS n FROM qa_money_marking WHERE source_table = 'fin_journal_entries' AND is_test`,
  );
  report('journal entries inherit the marking through their accounts', journalMarked > 0, { journalMarked });

  // --- Production reports exclude it ---------------------------------------
  const statsAfter = await api('GET', '/api/admin/stats', { token: T });
  report('the dashboard user count drops by the marked account',
    statsAfter.json?.totalUsers === statsBefore.json?.totalUsers - 1,
    { before: statsBefore.json?.totalUsers, after: statsAfter.json?.totalUsers });

  const analyticsAfter = await api('GET', '/api/admin/gifts/analytics?days=365', { token: T });
  report('gift analytics no longer counts the marked account’s sends',
    analyticsAfter.json?.totals?.sends < analyticsBefore.json?.totals?.sends,
    { before: analyticsBefore.json?.totals?.sends, after: analyticsAfter.json?.totals?.sends });

  const boardAfter = await api('GET', '/api/users/top?window=month&role=senders&limit=100');
  report('the marked account was on the member leaderboard before marking',
    boardBefore.json?.leaders?.some((l) => l.id === gifter.id) === true,
    { leaders: boardBefore.json?.leaders?.length });
  report('the member leaderboard drops the marked account',
    !boardAfter.json?.leaders?.some((l) => l.id === gifter.id),
    { present: boardAfter.json?.leaders?.some((l) => l.id === gifter.id) });

  const statsIncluded = await api('GET', '/api/admin/stats?includeTest=true', { token: T });
  // Against the whole table, not against the excluded baseline: `probe` was already marked when the
  // baseline was taken, so the baseline is itself short by one and would make this check pass by
  // coincidence rather than prove that includeTest really lifts the filter.
  const allUsers = await scalar('SELECT COUNT(*) AS n FROM users');
  report('a qa:read holder can ask for the test activity back',
    statsIncluded.json?.totalUsers === allUsers,
    { included: statsIncluded.json?.totalUsers, allUsers });

  // --- The member app never sees the marker ---------------------------------
  const profile = await api('GET', `/api/users/${probe.id}`);
  const profileText = JSON.stringify(profile.json ?? {});
  report('a public profile carries neither is_test nor qa_ref',
    profile.status === 200 && !profileText.includes('is_test') && !profileText.includes('qa_ref')
      && !profileText.includes(ref('USER')),
    { status: profile.status });

  const boardText = JSON.stringify(boardBefore.json ?? {});
  report('the leaderboard payload carries no QA reference', !boardText.includes('qa_ref') && !boardText.includes('QA-'));

  // --- Unmarking puts the money back without rewriting it -------------------
  const txIdsBefore = (await sql(
    'SELECT id FROM transactions WHERE sender_id = $1 OR receiver_id = $1 ORDER BY id', [gifter.id],
  )).rows.map((r) => r.id).join(',');

  // A delta, not a total: the gifter is a real account this suite reuses on every run, so earlier runs
  // have already written their own QA_UNMARK rows against it.
  const unmarksBefore = await scalar(
    "SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'QA_UNMARK' AND target_id = $1", [gifter.id],
  );

  const unmarked = await api('POST', '/api/admin/qa/identities/mark', {
    token: T, body: { ownerKind: 'USER', ownerId: gifter.id, isTest: false },
  });
  report('an account can be unmarked', unmarked.status === 200 && unmarked.json?.isTest === false,
    { status: unmarked.status });
  report('unmarking keeps the reference for the audit trail', unmarked.json?.qaRef === ref('GIFTER'),
    { qaRef: unmarked.json?.qaRef });
  report('the history is production money again', (await markedTxCount(gifter.id)) === 0);

  const txIdsAfter = (await sql(
    'SELECT id FROM transactions WHERE sender_id = $1 OR receiver_id = $1 ORDER BY id', [gifter.id],
  )).rows.map((r) => r.id).join(',');
  report('no financial row was rewritten by marking or unmarking', txIdsBefore === txIdsAfter);

  const statsRestored = await api('GET', '/api/admin/stats', { token: T });
  report('the dashboard count comes back', statsRestored.json?.totalUsers === statsBefore.json?.totalUsers,
    { restored: statsRestored.json?.totalUsers });

  const unmarkAudit = await scalar(
    "SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'QA_UNMARK' AND target_id = $1", [gifter.id],
  );
  report('the unmark wrote its own audit row', unmarkAudit === unmarksBefore + 1,
    { unmarkAudit, unmarksBefore });

  // --- The cohort is all-or-nothing ----------------------------------------
  const second = await member(`+92301${String(Date.now()).slice(-7)}`);
  const cohort = await api('POST', '/api/admin/qa/identities/cohort', {
    token: T,
    body: { accounts: [
      { ownerKind: 'USER', ownerId: probe.id, qaRef: ref('COHORT-A') },
      { ownerKind: 'USER', ownerId: '00000000-0000-0000-0000-000000000000', qaRef: ref('COHORT-B') },
    ] },
  });
  report('a cohort with one bad id is refused', cohort.status === 404, { status: cohort.status, code: cohort.code });
  report('the refused cohort marked nothing', (await markingOf(probe.id))?.qa_ref === ref('USER'),
    { qaRef: (await markingOf(probe.id))?.qa_ref });
  report('the refused cohort did not touch the second account', (await markingOf(second.id))?.is_test === false);

  const dupeCohort = await api('POST', '/api/admin/qa/identities/cohort', {
    token: T,
    body: { accounts: [
      { ownerKind: 'USER', ownerId: probe.id, qaRef: ref('D1') },
      { ownerKind: 'USER', ownerId: probe.id, qaRef: ref('D2') },
    ] },
  });
  report('a cohort naming one account twice is refused', dupeCohort.status === 400 && dupeCohort.code === 'qa_cohort_duplicate',
    { status: dupeCohort.status, code: dupeCohort.code });

  const goodCohort = await api('POST', '/api/admin/qa/identities/cohort', {
    token: T,
    body: { accounts: [
      { ownerKind: 'USER', ownerId: probe.id, qaRef: ref('COHORT-A') },
      { ownerKind: 'USER', ownerId: second.id, qaRef: ref('COHORT-B') },
    ] },
  });
  report('a valid cohort marks every account', goodCohort.status === 200 && goodCohort.json?.accounts?.length === 2,
    { status: goodCohort.status });
  report('the cohort replaced the earlier reference', (await markingOf(probe.id))?.qa_ref === ref('COHORT-A'));
  report('the second account is marked too', (await markingOf(second.id))?.is_test === true);

  // --- The summary reconciles with the derivation ---------------------------
  const summary = await api('GET', '/api/admin/qa/money/summary', { token: T });
  const directTotal = await scalar('SELECT COUNT(*) AS n FROM qa_money_marking');
  const directTest = await scalar('SELECT COUNT(*) AS n FROM qa_money_marking WHERE is_test');
  report('the money summary totals match the view',
    summary.status === 200 && summary.json?.totalRows === directTotal && summary.json?.testRows === directTest,
    { api: summary.json?.totalRows, directTotal, apiTest: summary.json?.testRows, directTest });
  report('the summary splits every row into test or production',
    summary.json?.testRows + summary.json?.productionRows === summary.json?.totalRows);
  report('the summary covers all eleven financial tables', summary.json?.tables?.length === 11,
    { tables: summary.json?.tables?.length });

  const testOnly = await api('GET', '/api/admin/qa/money?isTest=true&limit=500', { token: T });
  report('the money list can be filtered to test activity',
    testOnly.status === 200 && testOnly.json?.rows?.every((r) => r.isTest === true) && testOnly.json?.total === directTest,
    { status: testOnly.status, total: testOnly.json?.total, directTest });

  const badDate = await api('GET', '/api/admin/qa/money?from=not-a-date', { token: T });
  report('a malformed date filter is refused by name', badDate.status === 400 && badDate.code === 'qa_date_invalid',
    { status: badDate.status, code: badDate.code });

  // --- Permissions ----------------------------------------------------------
  const financeName = `qafin${RUN.toLowerCase()}`;
  const opsName = `qaops${RUN.toLowerCase()}`;
  const finance = await api('POST', '/api/admin/operators', {
    token: T, body: { username: financeName, password: 'qa-finance-pass-1', role: 'FINANCE_ADMIN', displayName: 'QA Finance' },
  });
  const ops = await api('POST', '/api/admin/operators', {
    token: T, body: { username: opsName, password: 'qa-ops-pass-1', role: 'OPERATIONS_ADMIN', displayName: 'QA Operations' },
  });
  report('the suite can provision a finance and an operations operator',
    finance.status === 201 && ops.status === 201, { finance: finance.status, ops: ops.status });
  if (finance.json?.operator?.id) createdOperators.push(finance.json.operator.id);
  if (ops.json?.operator?.id) createdOperators.push(ops.json.operator.id);

  const finLogin = await api('POST', '/api/admin/login', { body: { username: financeName, password: 'qa-finance-pass-1' } });
  const opsLogin = await api('POST', '/api/admin/login', { body: { username: opsName, password: 'qa-ops-pass-1' } });
  const FT = finLogin.json?.token;
  const OT = opsLogin.json?.token;

  const finRead = await api('GET', '/api/admin/qa/identities', { token: FT });
  report('finance may read the QA roster', finRead.status === 200, { status: finRead.status });
  const finMark = await api('POST', '/api/admin/qa/identities/mark', {
    token: FT, body: { ownerKind: 'USER', ownerId: second.id, isTest: false },
  });
  report('finance may not mark or unmark', finMark.status === 403, { status: finMark.status, code: finMark.code });

  const opsRead = await api('GET', '/api/admin/qa/identities', { token: OT });
  report('operations may not read the QA roster', opsRead.status === 403, { status: opsRead.status });
  const opsMark = await api('POST', '/api/admin/qa/identities/mark', {
    token: OT, body: { ownerKind: 'USER', ownerId: second.id, isTest: false },
  });
  report('operations may not mark', opsMark.status === 403, { status: opsMark.status });

  const memberRead = await api('GET', '/api/admin/qa/identities', { token: probe.token });
  report('a member token cannot reach the QA roster', memberRead.status === 403, { status: memberRead.status });
  const anonMark = await api('POST', '/api/admin/qa/identities/mark', {
    body: { ownerKind: 'USER', ownerId: second.id, isTest: false },
  });
  report('an anonymous request cannot unmark', anonMark.status === 401 || anonMark.status === 403,
    { status: anonMark.status });

  const opsIncluded = await api('GET', '/api/admin/stats?includeTest=true', { token: OT });
  const opsPlain = await api('GET', '/api/admin/stats', { token: OT });
  report('an operator without qa:read gets the production number even when asking for test',
    opsIncluded.status === 200 && opsIncluded.json?.totalUsers === opsPlain.json?.totalUsers,
    { included: opsIncluded.json?.totalUsers, plain: opsPlain.json?.totalUsers });

  // --- The lockout guard ----------------------------------------------------
  const selfMark = await api('POST', '/api/admin/qa/identities/mark', {
    token: T, body: { ownerKind: 'ADMIN', ownerId: adminId, isTest: true, qaRef: ref('ADMIN') },
  });
  const activeSupers = await scalar(
    "SELECT COUNT(*) AS n FROM admins WHERE role = 'SUPER_ADMIN' AND is_active AND NOT is_test",
  );
  if (activeSupers === 1) {
    report('the last production Super Admin cannot be marked as QA',
      selfMark.status === 409 && selfMark.code === 'last_production_super_admin',
      { status: selfMark.status, code: selfMark.code });
    report('the refused self-mark left the operator usable', (await markingOf(adminId))?.is_test === false);
  } else {
    report('the Super Admin guard is not exercised (more than one production super admin)', true, { activeSupers });
    if (selfMark.status === 200) {
      await api('POST', '/api/admin/qa/identities/mark', { token: T, body: { ownerKind: 'ADMIN', ownerId: adminId, isTest: false } });
    }
  }

  // --- Exit: leave nothing marked that the suite marked ---------------------
  for (const id of [probe.id, second.id]) {
    await api('POST', '/api/admin/qa/identities/mark', { token: T, body: { ownerKind: 'USER', ownerId: id, isTest: false } });
  }
  const leftMarked = await scalar(
    'SELECT COUNT(*) AS n FROM qa_identities WHERE is_test AND qa_ref LIKE $1', [`QA-${RUN}-%`],
  );
  report('the suite unmarked every account it marked', leftMarked === 0, { leftMarked });

  for (const id of createdOperators) {
    await api('POST', `/api/admin/operators/${id}/disable`, { token: T, body: { reason: 'QA suite cleanup' } });
  }
  const stillActive = await scalar(
    `SELECT COUNT(*) AS n FROM admins WHERE id = ANY($1::uuid[]) AND is_active`, [createdOperators],
  );
  report('the operators the suite created are disabled on exit', stillActive === 0, { stillActive });

  const finalTest = await scalar('SELECT COUNT(*) AS n FROM qa_money_marking WHERE is_test');
  report('no test money is left behind by the suite', finalTest === 0, { finalTest });

  out.push('');
  out.push(`${out.filter((l) => l.startsWith('PASS')).length}/${out.length - 1} QA-marking checks passed`);
  process.stdout.write(out.join('\n') + '\n');
  await db().end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  process.stdout.write(out.join('\n') + '\n');
  console.error('QA E2E CRASH', e);
  // Best-effort: unmark anything this run marked, so a crash does not leave production reports
  // quietly excluding a real account.
  try {
    const T = (await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } })).json.token;
    const marked = await sql('SELECT owner_id, owner_kind FROM qa_identities WHERE is_test AND qa_ref LIKE $1', [`QA-${RUN}-%`]);
    for (const row of marked.rows) {
      await api('POST', '/api/admin/qa/identities/mark', {
        token: T, body: { ownerKind: row.owner_kind, ownerId: row.owner_id, isTest: false },
      });
    }
    for (const id of createdOperators) {
      await api('POST', `/api/admin/operators/${id}/disable`, { token: T, body: { reason: 'QA suite cleanup' } });
    }
  } catch {
    /* an operator resets it; the references are namespaced to this run so they are findable */
  }
  await db().end().catch(() => {});
  process.exitCode = 1;
});