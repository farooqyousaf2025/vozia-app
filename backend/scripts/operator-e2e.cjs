/* End-to-end tests for the operator roster (migration 0030, README "Operators").
   Drives a *running* backend over HTTP and asserts on database state through the backend's own
   pg pool — no mocks, no fixtures.

     1. boot the stack and the API (README), then `npm run build`
     2. node scripts/operator-e2e.cjs

   Operators created here are named with a stamp and are left in place, disabled at the end, so
   run it against a development database only. Nothing is deleted: an operator that has written an
   audit row cannot be deleted at all (account-e2e pins that), which is the reason this feature
   exists.

   The checks worth reading first are the two that prove a switch is a switch:
     * a token issued *before* a disable is refused by the next request, and
     * a role raised *after* a login takes effect for the same token.
   Both fall out of one design decision — every admin request re-reads the operator row — and each
   breaks if someone caches the row, lengthens the token or starts trusting the `role` claim. */
const path = require('path');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

let failed = 0;
const out = [];
function report(name, pass, detail) {
  if (!pass) failed += 1;
  out.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 260)}` : ''}`);
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

async function api(method, p, { token, body } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  try {
    json = type.includes('json') ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: res.status,
    json,
    code: json && json.error && json.error.code,
    message: json && json.error && json.error.message,
  };
}

const login = async (username, password) => api('POST', '/api/admin/login', { body: { username, password } });

(async () => {
  const stamp = Date.now().toString().slice(-7);
  const name = (tag) => `e2e_op_${tag}_${stamp}`.slice(0, 40);
  const pw = (tag) => `e2e-op-${tag}-${stamp}`;

  const adminLogin = await login('admin', 'voiza-admin');
  if (adminLogin.status !== 200) {
    console.log(`FAIL  backend/admin login is required :: ${adminLogin.status} ${adminLogin.message || ''}`);
    console.log('\n1/1 operator checks passed? no — could not sign in');
    process.exit(1);
  }
  const admin = adminLogin.json;
  const T = admin.token;
  report('operator login returns the new status fields', admin.admin.isActive === true && admin.admin.disabledAt === null, {
    isActive: admin.admin.isActive,
    disabledAt: admin.admin.disabledAt,
  });
  report('SUPER_ADMIN holds operator:manage', admin.permissions.includes('operator:manage'));

  // ---- the roster reads -------------------------------------------------------
  const roster = await api('GET', '/api/admin/operators?limit=100', { token: T });
  report('the roster lists operators with a total', roster.status === 200 && roster.json.total >= 1 && Array.isArray(roster.json.operators), {
    status: roster.status,
    total: roster.json && roster.json.total,
  });
  const shaped = (roster.json.operators || []).every(
    (o) => o.id && o.username && typeof o.isActive === 'boolean' && Array.isArray(o.permissions) && o.permissions.length > 0,
  );
  report('every roster row carries its own permission list', shaped, { rows: (roster.json.operators || []).length });

  const legacy = (roster.json.operators || []).every((o) => ['SUPER_ADMIN', 'FINANCE_ADMIN', 'OPERATIONS_ADMIN', 'MODERATOR'].includes(o.role));
  report('stored roles are reported as the roles the guards apply', legacy, {
    off: (roster.json.operators || []).filter((o) => o.role !== o.roleStored).map((o) => o.roleStored),
  });

  const search = await api('GET', `/api/admin/operators?search=${admin.admin.username}&limit=10`, { token: T });
  report('the roster search finds the operator it names', search.status === 200 && search.json.operators.some((o) => o.id === admin.admin.id), {
    hits: search.json.operators && search.json.operators.length,
  });

  const catalogue = await api('GET', '/api/admin/operators/roles', { token: T });
  const byRole = Object.fromEntries((catalogue.json.roles || []).map((r) => [r.role, r.permissions]));
  report('the role catalogue names all four roles', catalogue.status === 200 && Object.keys(byRole).length === 4, catalogue.status);
  report(
    'no role but SUPER_ADMIN may manage operators',
    ['FINANCE_ADMIN', 'OPERATIONS_ADMIN', 'MODERATOR'].every((r) => !byRole[r].includes('operator:manage')) && byRole.SUPER_ADMIN.includes('operator:manage'),
    Object.entries(byRole).map(([r, p]) => `${r}:${p.includes('operator:manage') ? 'yes' : 'no'}`),
  );

  // ---- who may reach the roster ----------------------------------------------
  const fin = await api('POST', '/api/admin/operators', {
    token: T,
    body: { username: name('fin'), password: pw('fin'), role: 'FINANCE_ADMIN', displayName: 'E2E finance operator' },
  });
  report('a super-admin can create a finance operator', fin.status === 201 && fin.json.operator.isActive === true && fin.json.operator.role === 'FINANCE_ADMIN', {
    status: fin.status,
    code: fin.code,
  });
  const finLogin = await login(name('fin'), pw('fin'));
  report('the new operator can sign in', finLogin.status === 200 && finLogin.json.permissions.includes('account:manage'), finLogin.status);
  const finRoster = await api('GET', '/api/admin/operators', { token: finLogin.json.token });
  report('finance may not read the roster', finRoster.status === 403 && finRoster.code === 'permission_denied', {
    status: finRoster.status,
    message: finRoster.message,
  });

  // ---- validation -------------------------------------------------------------
  const clash = await api('POST', '/api/admin/operators', { token: T, body: { username: name('fin'), password: pw('fin'), role: 'MODERATOR' } });
  report('a duplicate username is refused', clash.status === 409 && clash.code === 'username_taken', { status: clash.status, code: clash.code });

  const upper = await api('POST', '/api/admin/operators', { token: T, body: { username: name('Case').toUpperCase(), password: pw('case'), role: 'MODERATOR' } });
  report(
    'a username is stored lowercased, so it survives being typed',
    upper.status === 201 && upper.json.operator.username === name('case').toLowerCase(),
    { username: upper.json && upper.json.operator && upper.json.operator.username },
  );

  const spaced = await api('POST', '/api/admin/operators', { token: T, body: { username: 'e2e op with spaces', password: pw('spaced'), role: 'MODERATOR' } });
  report('a username that cannot be typed is refused', spaced.status === 400 && spaced.code === 'bad_username', { status: spaced.status, code: spaced.code });

  const short = await api('POST', '/api/admin/operators', { token: T, body: { username: name('short'), password: 'abc123', role: 'MODERATOR' } });
  report('a weak operator password is refused', short.status === 400 && short.code === 'bad_password', { status: short.status, code: short.code });

  const badRole = await api('POST', '/api/admin/operators', { token: T, body: { username: name('role'), password: pw('role'), role: 'GOD_MODE' } });
  report('an unknown role is refused', badRole.status === 400, { status: badRole.status });

  // ---- a disable is a disable -------------------------------------------------
  const noReason = await api('POST', `/api/admin/operators/${fin.json.operator.id}/disable`, { token: T, body: {} });
  report('disabling without a reason is refused', noReason.status === 400 && noReason.code === 'reason_required', { status: noReason.status, code: noReason.code });

  const staleToken = finLogin.json.token;
  const disabled = await api('POST', `/api/admin/operators/${fin.json.operator.id}/disable`, {
    token: T,
    body: { reason: `operator-e2e-${stamp} revoking access` },
  });
  report(
    'an operator can be disabled with a reason',
    disabled.status === 200 && disabled.json.operator.isActive === false && typeof disabled.json.operator.disabledAt === 'string',
    { status: disabled.status, disabledAt: disabled.json && disabled.json.operator && disabled.json.operator.disabledAt },
  );

  const afterDisable = await login(name('fin'), pw('fin'));
  report('a disabled operator cannot sign in', afterDisable.status === 403 && afterDisable.code === 'operator_disabled', {
    status: afterDisable.status,
    code: afterDisable.code,
  });

  // The twelve-hour token is the whole reason this check exists.
  const withStaleToken = await api('GET', '/api/admin/accounts?limit=1', { token: staleToken });
  report(
    'a token issued before the disable is refused by the next request',
    withStaleToken.status === 403 && withStaleToken.code === 'operator_disabled',
    { status: withStaleToken.status, code: withStaleToken.code }
  );
  const staleRead = await api('GET', '/api/admin/me', { token: staleToken });
  report('the refusal is not limited to mutations', staleRead.status === 403 && staleRead.code === 'operator_disabled', staleRead.status);

  const twice = await api('POST', `/api/admin/operators/${fin.json.operator.id}/disable`, { token: T, body: { reason: `operator-e2e-${stamp} again` } });
  report('disabling twice reports the state rather than a second act', twice.status === 409 && twice.code === 'already_in_that_state', {
    status: twice.status,
    code: twice.code,
  });

  const disableRow = await sql(
    "SELECT admin_id, target_id, summary FROM admin_audit WHERE action = 'OPERATOR_DISABLE' AND target_id = $1",
    [fin.json.operator.id],
  );
  const rowStill = await sql('SELECT username FROM admins WHERE id = $1', [fin.json.operator.id]);
  report(
    'the switch removes access, not the account',
    disableRow.rowCount === 1 && disableRow.rows[0].admin_id === admin.admin.id && rowStill.rowCount === 1,
    { disableRows: disableRow.rowCount, survives: rowStill.rowCount === 1 },
  );
  report(
    'the disable names the actor who made it and quotes the reason',
    disableRow.rows[0] && /revoking access/.test(disableRow.rows[0].summary || ''),
    disableRow.rows[0] && disableRow.rows[0].summary,
  );

  const enabled = await api('POST', `/api/admin/operators/${fin.json.operator.id}/enable`, { token: T, body: {} });
  report(
    'and re-enabling clears the timestamp',
    enabled.status === 200 && enabled.json.operator.isActive === true && enabled.json.operator.disabledAt === null,
    { status: enabled.status, disabledAt: enabled.json && enabled.json.operator && enabled.json.operator.disabledAt },
  );
  const afterEnable = await login(name('fin'), pw('fin'));
  report('a re-enabled operator signs in again', afterEnable.status === 200, afterEnable.status);

  // ---- the role in the token is advice ---------------------------------------
  const mod = await api('POST', '/api/admin/operators', { token: T, body: { username: name('mod'), password: pw('mod'), role: 'MODERATOR' } });
  const modLogin = await login(name('mod'), pw('mod'));
  const beforePromotion = await api('GET', '/api/admin/accounts?limit=1', { token: modLogin.json.token });
  report('a moderator cannot read the book', beforePromotion.status === 403, { status: beforePromotion.status, code: beforePromotion.code });
  const promoted = await api('PUT', `/api/admin/operators/${mod.json.operator.id}`, { token: T, body: { role: 'FINANCE_ADMIN' } });
  report('a role can be changed in place', promoted.status === 200 && promoted.json.operator.role === 'FINANCE_ADMIN', {
    status: promoted.status,
    role: promoted.json && promoted.json.operator && promoted.json.operator.role,
  });
  const afterPromotion = await api('GET', '/api/admin/accounts?limit=1', { token: modLogin.json.token });
  report(
    'the new role applies to the token that was already issued',
    afterPromotion.status === 200,
    { status: afterPromotion.status, code: afterPromotion.code },
  );
  const noChange = await api('PUT', `/api/admin/operators/${mod.json.operator.id}`, { token: T, body: {} });
  report('an update that changes nothing is refused', noChange.status === 400 && noChange.code === 'nothing_to_update', noChange.status);

  // ---- the guards that keep the platform reachable ----------------------------
  const selfDisable = await api('POST', `/api/admin/operators/${admin.admin.id}/disable`, { token: T, body: { reason: `operator-e2e-${stamp} lockout` } });
  report('an operator cannot disable the account they are using', selfDisable.status === 409 && selfDisable.code === 'cannot_disable_self', {
    status: selfDisable.status,
    code: selfDisable.code,
  });

  const supersBefore = await sql("SELECT COUNT(*)::int AS n FROM admins WHERE role = 'SUPER_ADMIN' AND is_active");
  const demoteLast = await api('PUT', `/api/admin/operators/${admin.admin.id}`, { token: T, body: { role: 'OPERATIONS_ADMIN' } });
  report(
    'the last active super-admin cannot be demoted',
    supersBefore.rows[0].n === 1 && demoteLast.status === 409 && demoteLast.code === 'last_super_admin',
    { activeSupers: supersBefore.rows[0].n, status: demoteLast.status, code: demoteLast.code },
  );
  const stillSuper = await sql('SELECT role, is_active FROM admins WHERE id = $1', [admin.admin.id]);
  report('the refused demotion left the role alone', stillSuper.rows[0].role === 'SUPER_ADMIN' && stillSuper.rows[0].is_active === true, stillSuper.rows[0]);

  const second = await api('POST', '/api/admin/operators', { token: T, body: { username: name('sup2'), password: pw('sup2'), role: 'SUPER_ADMIN' } });
  report('a second super-admin can be created', second.status === 201 && second.json.operator.role === 'SUPER_ADMIN', { status: second.status, code: second.code });
  const demoteNow = await api('PUT', `/api/admin/operators/${admin.admin.id}`, { token: T, body: { role: 'OPERATIONS_ADMIN' } });
  report(
    'with another super-admin in place the demotion goes through',
    demoteNow.status === 200 && demoteNow.json.operator.role === 'OPERATIONS_ADMIN',
    { status: demoteNow.status, code: demoteNow.code },
  );
  // The actor just demoted itself out of operator:manage, so the restore has to come from the
  // operator it created — which is also the first proof that a demoted token loses the roster.
  const secondLogin = await login(name('sup2'), pw('sup2'));
  const lostRoster = await api('GET', '/api/admin/operators?limit=1', { token: admin.token });
  report('a demoted token loses the roster immediately', lostRoster.status === 403 && lostRoster.code === 'permission_denied', {
    status: lostRoster.status,
    code: lostRoster.code,
  });
  const restore = await api('PUT', `/api/admin/operators/${admin.admin.id}`, { token: secondLogin.json.token, body: { role: 'SUPER_ADMIN' } });
  report('and the second super-admin can undo it', restore.status === 200 && restore.json.operator.role === 'SUPER_ADMIN', {
    status: restore.status,
    code: restore.code,
  });
  const adminRefreshed = await login('admin', 'voiza-admin');
  report('the original operator is a super-admin again', adminRefreshed.status === 200 && adminRefreshed.json.permissions.includes('operator:manage'), adminRefreshed.status);
  const T2 = adminRefreshed.json.token;

  // ---- the schema holds the invariant too -------------------------------------
  let flagOnly;
  try {
    await sql('UPDATE admins SET disabled_at = now() WHERE username = $1', [name('mod')]);
  } catch (e) {
    flagOnly = e.code;
  }
  const cleared = await sql('UPDATE admins SET disabled_at = NULL WHERE username = $1', [name('mod')]);
  report(
    'the flag and its timestamp cannot disagree in the table either',
    flagOnly === '23514' && cleared.rowCount === 1,
    { error: flagOnly },
  );

  // ---- audit ------------------------------------------------------------------
  const actions = await sql(
    "SELECT action, COUNT(*)::int AS n FROM admin_audit WHERE action LIKE 'OPERATOR_%' GROUP BY action ORDER BY action",
  );
  const seen = Object.fromEntries(actions.rows.map((r) => [r.action, r.n]));
  report(
    'every roster write is audited by its own verb',
    ['OPERATOR_CREATE', 'OPERATOR_UPDATE', 'OPERATOR_DISABLE', 'OPERATOR_ENABLE'].every((a) => (seen[a] || 0) > 0),
    seen,
  );
  const createRow = await sql("SELECT admin_id, target_id, details FROM admin_audit WHERE action = 'OPERATOR_CREATE' ORDER BY created_at DESC LIMIT 1");
  report(
    'the audit row names the actor and the account created',
    createRow.rows[0] && createRow.rows[0].admin_id === admin.admin.id && createRow.rows[0].details.username === name('sup2'),
    createRow.rows[0] && { actor: createRow.rows[0].admin_id, username: createRow.rows[0].details.username },
  );

  // ---- why this lifecycle is a switch and not a bin ---------------------------
  // sup2 has now written an audit row as its own actor (the restore above). This is the exact
  // combination that makes a delete impossible, and the reason there is no DELETE route.
  let deleteError = null;
  try {
    await sql('DELETE FROM admins WHERE id = $1', [second.json.operator.id]);
  } catch (e) {
    deleteError = e.code;
  }
  const auditSurvived = await sql("SELECT COUNT(*)::int AS n FROM admin_audit WHERE action = 'OPERATOR_UPDATE' AND admin_id = $1", [
    second.json.operator.id,
  ]);
  report(
    'an operator who has written the audit trail cannot be deleted, and their rows survive',
    deleteError === '23514' && auditSurvived.rows[0].n > 0,
    { error: deleteError, actorRows: auditSurvived.rows[0].n },
  );

  // ---- leave every operator this run created switched off ---------------------
  const mine = await sql('SELECT id, username FROM admins WHERE username LIKE $1 AND is_active', [`e2e_op_%_%_${stamp}`]);
  const switchOff = [];
  for (const row of mine.rows) {
    const off = await api('POST', `/api/admin/operators/${row.id}/disable`, {
      token: T2,
      body: { reason: `operator-e2e-${stamp} end of run` },
    });
    switchOff.push(`${row.username}:${off.status}`);
  }
  const remaining = await sql('SELECT COUNT(*)::int AS n FROM admins WHERE username LIKE $1 AND is_active', [`e2e_op_%_%_${stamp}`]);
  report(
    'the run leaves its own operators disabled',
    mine.rows.length === 4 && switchOff.every((entry) => entry.endsWith(':200')) && remaining.rows[0].n === 0,
    { disabled: switchOff, active: remaining.rows[0].n },
  );
  const untouched = await sql("SELECT username, is_active FROM admins WHERE username = 'admin'");
  report('the bootstrap operator is active and unchanged', untouched.rows[0].is_active === true, untouched.rows[0]);

  await db().end();
  console.log(out.join('\n'));
  console.log(`\n${out.length - failed}/${out.length} operator checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  try {
    await db().end();
  } catch {
    /* the pool was never opened */
  }
  process.exit(1);
});
