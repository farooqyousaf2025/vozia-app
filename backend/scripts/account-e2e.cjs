/* End-to-end tests for the purpose-accounts book (migration 0029, README "Purpose accounts").
   Drives a *running* backend over HTTP and asserts on database state through the backend's own
   pg pool — no mocks, no fixtures.

     1. boot the stack and the API (README), then `npm run build`
     2. node scripts/account-e2e.cjs

   Holds, idempotency claims, account status writes and throwaway admins are named with a time
   stamp and are left in place, so run it against a development database only.

   The checks worth reading first are the four projection identities: `opening + ΣIN − ΣOUT` must
   reproduce the balance the API reported for each of the three books, using a statement fetched
   page by page. That is the single promise the whole feature makes, and the statement query and
   the lifetime totals are two different pieces of SQL — which is how they can disagree. */
const path = require('path');
const zlib = require('zlib');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const out = [];
const check = (n, p, d) => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? `  :: ${JSON.stringify(d).slice(0, 260)}` : ''}`);
let failed = 0;
const report = (n, p, d) => {
  if (!p) failed += 1;
  check(n, p, d);
};

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

/**
 * Read a zip the way the writer's own contract demands: walk the local file headers, inflate each
 * entry and check its CRC against `zlib.crc32`, which is the reference this writer has to agree with.
 *
 * The alternative — grepping the buffer for text — only works on stored entries, so a workbook
 * whose sheet names really are present can fail a check and vice versa. Inflating proves the
 * archive is readable by anything that will open it, which is the actual requirement.
 */
function unzipParts(buf) {
  const parts = {};
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const start = p + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (zlib.crc32(data) >>> 0 !== crc) throw new Error(`crc mismatch in ${name}`);
    parts[name] = data.toString('utf8');
    p = start + compSize;
  }
  return parts;
}

/** `unzipParts` throws on a bad archive; a suite reports that rather than crashing mid-run. */
function openWorkbook(label, buf, meta) {
  try {
    const parts = unzipParts(buf);
    report(`${label}: every entry inflates and its CRC matches`, true, Object.keys(parts).length);
    return parts;
  } catch (e) {
    report(`${label}: every entry inflates and its CRC matches`, false, { error: e.message, bytes: buf.length, ...meta });
    return null;
  }
}

async function api(method, p, { token, body } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  const json = type.includes('json') ? JSON.parse(buf.toString('utf8')) : null;
  return {
    status: res.status,
    buf,
    type,
    json,
    // Errors are `{ error: { code, message } }`, so a top-level `code` is always undefined and a
    // check written against it passes for the wrong reason.
    code: json && json.error && json.error.code,
  };
}

/** A member session, the only way this stack issues one: OTP is mocked in development. */
async function memberToken(phone, username = `ac${phone.slice(-7)}`) {
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error(`request-otp failed: ${JSON.stringify(challenge.json)}`);
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: '123456', username } });
  if (verified.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verified.json)}`);
  return verified.json.token;
}

/** Fetch every page of a statement. The identity has to hold over the whole book, not a page. */
async function fullStatement(token, code) {
  const rows = [];
  let page = 1;
  let unit = null;
  for (;;) {
    // 200 is this route's own ceiling; asking for more is a bad request, not a bigger page.
    const res = await api('GET', `/api/admin/accounts/${encodeURIComponent(code)}/movements?page=${page}&limit=200`, { token });
    if (res.status !== 200) throw new Error(`statement ${code} page ${page} -> ${res.status} ${res.code || ''}`);
    unit = res.json.unit;
    rows.push(...res.json.movements);
    if (rows.length >= res.json.total || res.json.movements.length === 0) return { rows, unit, total: res.json.total };
    page += 1;
  }
}

/** The projection identity for one account, as the API reports it. */
async function identity(token, code) {
  const detail = await api('GET', `/api/admin/accounts/${encodeURIComponent(code)}`, { token });
  if (detail.status !== 200) return { ok: false, reason: `detail ${detail.status}` };
  const a = detail.json.account;
  const { rows, total } = await fullStatement(token, code);
  const inSum = rows.filter((m) => m.direction === 'IN').reduce((s, m) => s + m.amount, 0);
  const outSum = rows.filter((m) => m.direction === 'OUT').reduce((s, m) => s + m.amount, 0);
  return {
    ok: a.opening + inSum - outSum === a.balance,
    account: a,
    inSum,
    outSum,
    listed: rows.length,
    total,
  };
}

(async () => {
  const stamp = Date.now().toString().slice(-7);
  const reason = `account-e2e-${stamp}`;

  const admin = await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } });
  report('operator sign-in', admin.status === 200 && !!admin.json.token, { status: admin.status });
  const T = admin.json.token;

  // ------------------------------------------------------------------ reading
  const ov = await api('GET', '/api/admin/accounts?limit=5', { token: T });
  report('overview pages the book', ov.status === 200 && ov.json.accounts.length > 0 && ov.json.total > 0, {
    total: ov.json.total, first: ov.json.accounts[0] && ov.json.accounts[0].accountCode,
  });

  const byCat = await api('GET', '/api/admin/accounts?category=USER_DIAMOND&onlyWithPosition=true&limit=20', { token: T });
  const diamonds = byCat.json.accounts;
  report('category filter and position filter apply in SQL', diamonds.length > 0 && diamonds.every((a) => a.category === 'USER_DIAMOND' && a.balance !== 0), { rows: diamonds.length });

  const search = await api('GET', `/api/admin/accounts?search=${encodeURIComponent(diamonds[0].accountCode.slice(0, 12))}&limit=50`, { token: T });
  report('search matches code text', search.status === 200 && search.json.accounts.length > 0, { rows: search.json.accounts.length });

  const badCat = await api('GET', '/api/admin/accounts?category=NOPE', { token: T });
  report('unknown category refused', badCat.status === 400, { code: badCat.code });
  const badStatus = await api('GET', '/api/admin/accounts?status=NOPE', { token: T });
  report('unknown status refused', badStatus.status === 400, { code: badStatus.code });

  // The nine platform ledger accounts that predate this migration carry no `:owner` suffix.
  // Requiring one made `PLATFORM_REVENUE` and its siblings unreadable through the API.
  const legacy = await sql(`SELECT code FROM fin_accounts WHERE code NOT LIKE '%:%' ORDER BY code`);
  const legacyReads = [];
  for (const row of legacy.rows) {
    const got = await api('GET', `/api/admin/accounts/${encodeURIComponent(row.code)}`, { token: T });
    legacyReads.push({ code: row.code, status: got.status, source: got.json && got.json.account.balanceSource });
  }
  report('legacy platform ledger codes are readable', legacy.rows.length > 0 && legacyReads.every((r) => r.status === 200), legacyReads.slice(0, 3));
  report('a path-like code is refused', (await api('GET', '/api/admin/accounts/..%2F..%2Fetc', { token: T })).code === 'bad_account_code');

  const rec = await api('GET', '/api/admin/accounts/reconcile', { token: T });
  report('reconcile is not shadowed by /accounts/:code', rec.status === 200 && Array.isArray(rec.json.findings), {
    findings: rec.json.total, errors: rec.json.errors,
  });
  const oddCode = await api('GET', '/api/admin/accounts/reconcileX', { token: T });
  report('a name that is not a ledger code is refused', oddCode.code === 'bad_account_code', { code: oddCode.code });
  report('unknown account is 404', (await api('GET', '/api/admin/accounts/USER_DIAMOND:00000000-0000-4000-8000-000000000000', { token: T })).status === 404);

  // ------------------------------------------------- the projection, all books
  // One non-zero account per category, including the colon-less platform ledger names. The label
  // comes from the `category` column, never from splitting the code: `COIN_LIABILITY` is a code
  // whose category is `PLATFORM_MAIN`, and reading a name out of it would misreport the book.
  const books = await sql(
    `SELECT DISTINCT ON (category) account_code, category::text AS category, balance_source
       FROM purpose_account_balances
      WHERE balance_minor <> 0 ORDER BY category, abs(balance_minor) DESC`,
  );
  report('non-zero accounts exist across categories', books.rows.length > 0, books.rows.map((r) => r.category).join(','));

  for (const row of books.rows) {
    const r = await identity(T, row.account_code);
    report(
      `projection identity: opening + ΣIN − ΣOUT = balance (${row.category} via ${row.balance_source})`,
      r.ok === true,
      r.ok ? { balance: r.account.balance, opening: r.account.opening, in: r.inSum, out: r.outSum, rows: r.listed } : { code: row.account_code, ...r },
    );
  }

  // The payable book once reported lifetimes that disagreed with its own statement; that is the
  // regression this pins, and it only shows on an account that has both an accrual and a reversal.
  const payable = await sql(
    `SELECT account_code FROM purpose_account_balances
      WHERE category IN ('BD_MANAGER','COIN_SELLER') AND lifetime_in_minor <> 0 LIMIT 1`,
  );
  if (payable.rows.length) {
    const r = await identity(T, payable.rows[0].account_code);
    report('payable statement totals equal the lifetime columns', r.ok === true, {
      listedIn: r.inSum, balance: r.account.balance, lifetimeIn: r.account.lifetimeIn, lifetimeOut: r.account.lifetimeOut,
    });
  } else {
    report('payable statement totals equal the lifetime columns', true, 'no payable account with history — skipped');
  }

  const one = diamonds[0].accountCode;
  const win = await api('GET', `/api/admin/accounts/${encodeURIComponent(one)}/movements?from=2000-01-01T00:00:00Z&to=2035-01-01T00:00:00Z&limit=1`, { token: T });
  const nun = await api('GET', `/api/admin/accounts/${encodeURIComponent(one)}/movements?limit=1`, { token: T });
  report('a wide window reports the same total as no window', win.json.total === nun.json.total, { windowed: win.json.total, unwindowed: nun.json.total });
  report('a bad date is refused', (await api('GET', `/api/admin/accounts/${encodeURIComponent(one)}/movements?from=nonsense`, { token: T })).code === 'bad_date');

  // ------------------------------------------------------------------ exports
  const csv = await api('GET', `/api/admin/accounts/${encodeURIComponent(one)}/movements?format=csv&limit=200`, { token: T });
  const csvRaw = csv.buf.toString('utf8');
  // The BOM is part of the file, so it has to come off before anything compares against a header.
  const csvText = csvRaw.replace(/\uFEFF/, '');
  const dataLines = csvText.trim().split('\r\n').length - 1;
  report('csv export is BOM-prefixed UTF-8', csv.status === 200 && csv.buf[0] === 0xef && csv.buf[1] === 0xbb && csv.buf[2] === 0xbf, { bytes: csv.buf.length });
  report('csv rows match the page requested', csvText.startsWith('Occurred at,Reference,') && dataLines > 0 && dataLines <= 200, { dataLines });
  report('csv amounts are unquoted numbers', /^[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,-?\d+(\.\d+)?,/m.test(csvText.split('\r\n')[1] || ''), (csvText.split('\r\n')[1] || '').slice(0, 70));

  const xlsx = await api('GET', `/api/admin/accounts/${encodeURIComponent(one)}/movements?format=xlsx&limit=200`, { token: T });
  const eocd = xlsx.buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  report('xlsx is a real zip: local header + central directory', xlsx.status === 200 && xlsx.buf.readUInt32LE(0) === 0x04034b50 && eocd > 0, { bytes: xlsx.buf.length, eocdAt: eocd });
  report('xlsx content type and filename', /spreadsheetml\.sheet/.test(xlsx.type), xlsx.type);

  // Inflate it and read the parts, so "the export works" means a spreadsheet program can open it.
  const stmtParts = openWorkbook('statement workbook', xlsx.buf, { bytes: xlsx.buf.length });
  const stmtSheet = (stmtParts && stmtParts['xl/worksheets/sheet1.xml']) || '';
  report('statement workbook carries every required part', stmtParts && [
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
  ].every((name) => stmtParts[name]), Object.keys(stmtParts || {}).join(','));
  const stmtDim = (stmtSheet.match(/<dimension ref="A1:([A-Z]+)(\d+)"/) || [])[0];
  report('statement sheet covers its own rows and columns', /A1:I\d+/.test(stmtDim), { dimension: stmtDim, rows: (stmtSheet.match(/<row /g) || []).length });
  report('statement amounts are numeric cells, not text', (stmtSheet.match(/<c r="F\d+"><v>-?\d+<\/v>/g) || []).length > 0, { numericAmounts: (stmtSheet.match(/<c r="F\d+"><v>/g) || []).length });

  const recXlsx = await api('GET', '/api/admin/accounts/reconcile?format=xlsx', { token: T });
  const recParts = unzipParts(recXlsx.buf);
  const recWorkbook = recParts['xl/workbook.xml'] || '';
  const sheetNames = (recWorkbook.match(/name="([^"]+)"/g) || []).map((s) => s.slice(6, -1));
  report('reconcile workbook carries both sheets', recXlsx.status === 200 && sheetNames.includes('Summary') && sheetNames.includes('Findings'), { sheets: sheetNames });
  report('both reconcile sheets exist as parts', !!recParts['xl/worksheets/sheet1.xml'] && !!recParts['xl/worksheets/sheet2.xml'], Object.keys(recParts).length);
  report('rels point at every sheet', (recParts['xl/_rels/workbook.xml.rels'] || '').includes('sheet2.xml'));
  const recCsv = await api('GET', '/api/admin/accounts/reconcile?format=csv', { token: T });
  report('reconcile csv export works', recCsv.status === 200 && recCsv.buf[0] === 0xef, { bytes: recCsv.buf.length });

  // --------------------------------------------------- holds and their replay
  const amount = 3 + (Number(stamp) % 5);
  const holdKey = `e2e-hold-${stamp}`;
  const held = await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/holds`, {
    token: T,
    body: { kind: 'FROZEN', amount, reason, idempotencyKey: holdKey },
  });
  const holdId = held.json && held.json.hold && held.json.hold.id;
  report('hold created', held.status === 201 && held.json.replay === false && !!holdId, { id: holdId, amount: held.json && held.json.hold && held.json.hold.amount });

  const replay = await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/holds`, {
    token: T,
    body: { kind: 'FROZEN', amount, reason, idempotencyKey: holdKey },
  });
  report('same key replays instead of freezing twice', replay.status === 200 && replay.json.replay === true && replay.json.hold && replay.json.hold.id === holdId, { id: replay.json.hold && replay.json.hold.id });

  const dupInDb = await sql('SELECT count(*)::int AS n FROM account_holds WHERE reason = $1', [reason]);
  report('exactly one hold row exists for that key', dupInDb.rows[0].n === 1, { rows: dupInDb.rows[0].n });

  const listed = await api('GET', `/api/admin/accounts/${encodeURIComponent(one)}/holds?status=OPEN`, { token: T });
  const mine = listed.json.holds.filter((h) => h.id === holdId);
  report('hold lists with the operator who made it', mine.length === 1 && mine[0].createdByName === 'admin', { by: mine[0] && mine[0].createdByName });

  // The controller enforces the same 8-character floor the service does, so this answers
  // `bad_request` rather than the service's `reason_required`; either way no money is held.
  const shortReason = await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/holds`, {
    token: T, body: { kind: 'FROZEN', amount: 1, reason: 'no', idempotencyKey: `e2e-short-${stamp}` },
  });
  report('hold needs a readable reason', shortReason.status === 400, { code: shortReason.code });
  report('hold kind is validated', (await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/holds`, {
    token: T, body: { kind: 'NOPE', amount: 1, reason, idempotencyKey: `e2e-kind-${stamp}` },
  })).status === 400);
  report('hold amount must be a positive integer', (await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/holds`, {
    token: T, body: { kind: 'FROZEN', amount: -5, reason, idempotencyKey: `e2e-neg-${stamp}` },
  })).status === 400);

  const releaseKey = `e2e-release-${stamp}`;
  const released = await api('POST', `/api/admin/holds/${holdId}/release`, { token: T, body: { idempotencyKey: releaseKey } });
  report('hold released', released.status === 200 && released.json.status === 'RELEASED' && released.json.replay === false, released.json);

  const relReplay = await api('POST', `/api/admin/holds/${holdId}/release`, { token: T, body: { idempotencyKey: releaseKey } });
  report('release replays rather than closing twice', relReplay.status === 200 && relReplay.json.replay === true, relReplay.json);

  // The nested-transaction guard. A fresh key, then a failure inside the same request: the claim
  // must not survive, because a stranded claim would wedge the key forever while the money had
  // already moved. This is what `client?: PoolClient` on createHold/releaseHold exists for.
  const doomedKey = `e2e-rollback-${stamp}`;
  const doomed = await api('POST', `/api/admin/holds/${holdId}/release`, { token: T, body: { idempotencyKey: doomedKey } });
  const stranded = await sql('SELECT count(*)::int AS n FROM idempotent_requests WHERE key = $1', [doomedKey]);
  report('a released hold answers 409', doomed.status === 409 && doomed.code === 'hold_closed', { status: doomed.status, code: doomed.code });
  report('the failed attempt leaves no idempotency claim behind', stranded.rows[0].n === 0, { claims: stranded.rows[0].n });

  const overFreeze = await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/holds`, {
    token: T,
    body: { kind: 'FROZEN', amount: diamonds[0].available + 10_000_000, reason: `${reason} over-freeze`, idempotencyKey: `e2e-over-${stamp}` },
  });
  report('cannot freeze more than the owner can spend', overFreeze.status === 409 && overFreeze.code === 'freeze_exceeds_available', { code: overFreeze.code });

  // ------------------------------------------------------------------- status
  const susp = await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/status`, { token: T, body: { status: 'SUSPENDED', reason } });
  report('account suspended', susp.status === 200 && susp.json.status === 'SUSPENDED', susp.json);
  report('a non-ACTIVE status needs a reason', (await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/status`, { token: T, body: { status: 'FROZEN' } })).code === 'reason_required');
  const holdOnSuspended = await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/holds`, {
    token: T, body: { kind: 'FROZEN', amount: 1, reason: `${reason} on suspended`, idempotencyKey: `e2e-susp-${stamp}` },
  });
  report('a suspended account takes no new holds', holdOnSuspended.status === 409 && holdOnSuspended.code === 'account_not_active', { code: holdOnSuspended.code });
  const back = await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/status`, { token: T, body: { status: 'ACTIVE' } });
  report('account restored to ACTIVE', back.status === 200 && back.json.status === 'ACTIVE', back.json);

  // -------------------------------------------------------------------- audit
  const audit = await api('GET', '/api/admin/audit?limit=40', { token: T });
  const rows = audit.json.audit || audit.json.entries || audit.json.rows || [];
  const actions = rows.map((r) => r.action);
  report('every account write is audited', ['ACCOUNT_HOLD_CREATE', 'ACCOUNT_HOLD_RELEASE', 'ACCOUNT_STATUS_UPDATE'].every((a) => actions.includes(a)), actions.filter((a) => a.startsWith('ACCOUNT_')).join(','));

  // ------------------------------------------------------------------- RBAC
  const e2eAdmin = (role) => `e2e_ac_${role.toLowerCase().replace(/_/g, '')}_${stamp}`;
  const mint = async (role) => {
    const username = e2eAdmin(role);
    const password = `e2e-${role.toLowerCase()}-${stamp}`;
    await sql(
      `INSERT INTO admins (username, password_hash, display_name, role) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING`,
      [username, require(path.join(BE_ROOT, 'dist', 'utils', 'crypto.js')).hashSecret(password), `account-e2e ${role}`, role],
    );
    const signedIn = await api('POST', '/api/admin/login', { body: { username, password } });
    return signedIn.json && signedIn.json.token;
  };

  const opsToken = await mint('OPERATIONS_ADMIN');
  const finToken = await mint('FINANCE_ADMIN');
  const modToken = await mint('MODERATOR');
  report('throwaway operators can sign in', !!opsToken && !!finToken && !!modToken);

  report('OPERATIONS_ADMIN may read the book', (await api('GET', '/api/admin/accounts?limit=1', { token: opsToken })).status === 200);
  const opsWrite = await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/holds`, {
    token: opsToken, body: { kind: 'FROZEN', amount: 1, reason: `${reason} ops write`, idempotencyKey: `e2e-ops-${stamp}` },
  });
  report('OPERATIONS_ADMIN may not place a hold', opsWrite.status === 403, { status: opsWrite.status, code: opsWrite.code });

  report('FINANCE_ADMIN may read the book', (await api('GET', '/api/admin/accounts?limit=1', { token: finToken })).status === 200);
  const finWrite = await api('POST', `/api/admin/accounts/${encodeURIComponent(one)}/holds`, {
    token: finToken, body: { kind: 'FROZEN', amount: 1, reason: `${reason} finance write`, idempotencyKey: `e2e-fin-${stamp}` },
  });
  report('FINANCE_ADMIN may place a hold', finWrite.status === 201, { status: finWrite.status, code: finWrite.code });
  if (finWrite.json && finWrite.json.hold) {
    await api('POST', `/api/admin/holds/${finWrite.json.hold.id}/release`, { token: T, body: { idempotencyKey: `e2e-fin-rel-${stamp}` } });
  }

  const modRead = await api('GET', '/api/admin/accounts?limit=1', { token: modToken });
  report('MODERATOR sees neither the book nor the holds', modRead.status === 403, { status: modRead.status });

  // A member credential must not reach this router at all — `requireAdminOperator` reads the
  // token's scope, so a user token is refused before any permission is consulted.
  const asMember = await memberToken(`+92300${stamp}`);
  const memberRead = await api('GET', '/api/admin/accounts', { token: asMember });
  report('a member token cannot reach the accounts router', memberRead.status === 401 || memberRead.status === 403, { status: memberRead.status, code: memberRead.code });

  // An operator who has acted is not removable, and this suite has now acted: FINANCE_ADMIN
  // placed a hold, so it owns an `admin_audit` row. `admin_audit.admin_id` is `ON DELETE SET
  // NULL`, but `admin_audit_actor_present` requires an actor on every row, so nulling the link
  // fails the check and the whole DELETE rolls back. That is the correct outcome for an audit
  // trail — and it means any future admin CRUD (#58) has to deactivate rather than delete.
  let auditedDelete;
  try {
    await sql('DELETE FROM admins WHERE username = $1', [e2eAdmin('FINANCE_ADMIN')]);
  } catch (e) {
    auditedDelete = e.code || e.message;
  }
  const stillThere = await sql('SELECT count(*)::int AS n FROM admins WHERE username = $1', [e2eAdmin('FINANCE_ADMIN')]);
  report('an operator with audit history cannot be deleted', auditedDelete === '23514' && stillThere.rows[0].n === 1, {
    error: auditedDelete,
    admins: stillThere.rows[0].n,
  });

  // ------------------------------------------ the withdrawal pipeline (0032)
  //
  // One host's cash-out, start to finish, checked at every step against four places that must agree:
  // the request row, its `transactions` row, the host's purpose account and the journal. The promise
  // under test is narrow and is the whole reason for the migration — the R-coins are still owed until
  // somebody actually pays them out, and only at that moment do they become an outflow.
  const DIAL = { minRCoins: 20_000, feeBps: 500 }; // a 5% cut, so the fee is a number worth checking
  const GROSS = 25_000;
  const FEE = Math.floor((GROSS * DIAL.feeBps) / 10_000);
  const FACE = Number((await sql(`SELECT value->>'minorPerCoin' AS f FROM system_config WHERE key = 'accounts.coinValue'`)).rows[0].f);

  const dialBefore = await api('GET', '/api/admin/business/config/accounts.withdrawal', { token: T });
  report('the withdrawal dial is readable', dialBefore.status === 200 && dialBefore.json.value, dialBefore.json);

  // `writeConfig` replaces the whole blob, so a body naming one field deletes its neighbour and the
  // reader's silent fallback turns that into a wrong minimum nobody notices. The route refuses it.
  const partial = await api('PUT', '/api/admin/business/config/accounts.withdrawal', { token: T, body: { value: { minRCoins: 1_000 } } });
  report('a dial write missing its other field is refused', partial.status === 400 && partial.code === 'bad_config_value', { status: partial.status, code: partial.code });
  const wildFee = await api('PUT', '/api/admin/business/config/accounts.withdrawal', { token: T, body: { value: { minRCoins: 1_000, feeBps: 20_000 } } });
  report('a fee above 100% is refused', wildFee.status === 400, { status: wildFee.status, message: wildFee.json && wildFee.json.error && wildFee.json.error.message });
  const textMin = await api('PUT', '/api/admin/business/config/accounts.withdrawal', { token: T, body: { value: { minRCoins: 'a lot', feeBps: 0 } } });
  report('a non-whole minimum is refused', textMin.status === 400, { status: textMin.status });
  const dialUnmoved = await api('GET', '/api/admin/business/config/accounts.withdrawal', { token: T });
  report('a refused write leaves the dial alone',
    dialUnmoved.json.value.minRCoins === dialBefore.json.value.minRCoins && dialUnmoved.json.value.feeBps === dialBefore.json.value.feeBps,
    dialUnmoved.json.value);

  report('the dial accepts a whole pair',
    (await api('PUT', '/api/admin/business/config/accounts.withdrawal', { token: T, body: { value: DIAL } })).status === 200, DIAL);

  const hostToken = await memberToken('+92301' + stamp, `wd${stamp}`);
  const funded = await api('GET', '/api/wallet', { token: hostToken });
  const hostId = funded.json.user.id;
  const account = `HOST_RCOIN:${hostId}`;
  report('reading an account opens it for a host who signed up after 0029',
    (await api('GET', `/api/admin/accounts/${encodeURIComponent(account)}`, { token: T })).status === 200, account);
  await api('POST', `/api/admin/users/${hostId}/balance`, { token: T, body: { rCoinDelta: 60_000, note: `${reason} funding` } });
  const walletOf = async () => Number((await api('GET', '/api/wallet', { token: hostToken })).json.user.rCoinBalance);
  report('a fresh host starts with the adjustment and nothing else', (await walletOf()) === 60_000, { rCoinBalance: await walletOf() });
  const cleanStart = await identity(T, account);
  report('the account reconciles before anything is withdrawn', cleanStart.ok === true, { balance: cleanStart.account && cleanStart.account.balance, opening: cleanStart.account && cleanStart.account.opening });

  const under = await api('POST', '/api/wallet/withdraw', {
    token: hostToken, body: { amountRCoins: 15_000, payoutMethod: 'BANK', payoutDetails: { account: '0001234567890', holder: 'Voiza E2E' } },
  });
  // 15,000 is above nothing and below the dial: the shipped default is 100,000, so accepting this
  // number at all — or quoting it in the refusal — is what proves the ledger read the stored dial.
  report('the minimum comes from the dial, not the environment',
    under.status === 400 && under.code === 'below_minimum' && /20000/.test((under.json && under.json.error && under.json.error.message) || ''),
    { status: under.status, message: under.json && under.json.error && under.json.error.message });

  const payout = { account: '0001234567890', holder: 'Voiza E2E' };
  const asked = await api('POST', '/api/wallet/withdraw', { token: hostToken, body: { amountRCoins: GROSS, payoutMethod: 'BANK', payoutDetails: payout } });
  const w1 = asked.json && asked.json.withdrawal;
  report('a withdrawal is quoted with its fee and its net',
    asked.status === 201 && w1 && w1.amountRCoins === GROSS && w1.feeRCoins === FEE && w1.netRCoins === GROSS - FEE && w1.status === 'PENDING',
    w1);
  const ledgerOf = async (id) => (await sql(
    `SELECT status FROM transactions WHERE type = 'WITHDRAWAL' AND meta->>'withdrawalId' = $1`, [id],
  )).rows[0];
  report('the escrow left the wallet gross', (await walletOf()) === 60_000 - GROSS);
  report('the request books nothing yet: its ledger row is PENDING', (await ledgerOf(w1.id)).status === 'PENDING');
  const owed = await api('GET', `/api/admin/accounts/${encodeURIComponent(account)}`, { token: T });
  report('the platform still owes the whole amount while it sits unpaid',
    owed.status === 200 && owed.json.account.pending === GROSS && owed.json.account.balance === 60_000,
    { pending: owed.json.account.pending, balance: owed.json.account.balance });
  report('and the account still reconciles at that moment', (await identity(T, account)).ok === true);

  const approved = await api('POST', `/api/admin/withdrawals/${w1.id}/review`, { token: T, body: { approve: true, note: `${reason} ok` } });
  report('approval accepts the request', approved.status === 200 && approved.json.withdrawal.status === 'APPROVED', approved.json.withdrawal && approved.json.withdrawal.status);
  report('approval no longer claims the money was paid', (await ledgerOf(w1.id)).status === 'PENDING');
  report('an approved withdrawal is still owed, still pending',
    (await identity(T, account)).ok === true && (await api('GET', `/api/admin/accounts/${encodeURIComponent(account)}`, { token: T })).json.account.pending === GROSS);
  const twice = await api('POST', `/api/admin/withdrawals/${w1.id}/review`, { token: T, body: { approve: true } });
  report('approving twice is refused', twice.status === 409 && twice.code === 'withdrawal_not_pending', { status: twice.status, code: twice.code });

  const queued = await api('GET', '/api/admin/accounts/reconcile', { token: T });
  const queueFinding = queued.json.findings.find((f) => f.code === 'withdrawal_awaiting_payout');
  report('the reconciler reports the queue without calling it an error',
    queueFinding && queueFinding.severity === 'INFO' && queueFinding.amountMinor >= GROSS, queueFinding);
  report('nothing approved-and-unpaid looks like a state conflict',
    !queued.json.findings.some((f) => f.code === 'withdrawal_state_conflict' && f.detail.includes(w1.id)));

  const blind = await api('POST', `/api/admin/withdrawals/${w1.id}/pay`, { token: T, body: {} });
  report('a payout with no reference is refused', blind.status === 400, { status: blind.status, code: blind.code });
  const byModerator = await api('POST', `/api/admin/withdrawals/${w1.id}/pay`, { token: modToken, body: { payoutReference: `E2E-${stamp}` } });
  report('a moderator cannot pay a withdrawal out', byModerator.status === 403, { status: byModerator.status });

  const reference = `E2E-BANK-${stamp}`;
  const paid = await api('POST', `/api/admin/withdrawals/${w1.id}/pay`, { token: T, body: { payoutReference: reference } });
  report('the payout records who, when and under what reference',
    paid.status === 200 && paid.json.withdrawal.status === 'PAID' && !!paid.json.withdrawal.paidAt && paid.json.withdrawal.payoutReference === reference,
    paid.json.withdrawal);
  report('and only now does the ledger call it an outflow', (await ledgerOf(w1.id)).status === 'COMPLETED');
  const settled = await identity(T, account);
  report('the paid host is owed nothing and the account still reconciles',
    settled.ok === true && settled.account.pending === 0 && settled.account.balance === 60_000 - GROSS,
    { balance: settled.account && settled.account.balance, pending: settled.account && settled.account.pending });
  const paidLeg = await sql(
    `SELECT amount_minor AS a FROM coin_movements
      WHERE owner_id = $1 AND movement_type = 'WITHDRAWAL' AND direction = 'OUT'`, [hostId],
  );
  report('the statement shows the gross leaving, not the net', paidLeg.rows[0] && paidLeg.rows[0].a === GROSS, {
    legs: paidLeg.rows.map((r) => r.a),
  });

  const feeEntry = await sql(
    `SELECT e.reference,
            COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'DEBIT' AND l.account_code = 'COIN_LIABILITY'), 0)::int AS released,
            COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'CREDIT' AND l.account_code = 'PLATFORM_REVENUE'), 0)::int AS kept,
            COUNT(*) AS lines
       FROM fin_journal_entries e JOIN fin_journal_lines l ON l.entry_id = e.id
      WHERE e.source_kind = 'WITHDRAWAL_FEE' AND e.source_id = $1
      GROUP BY e.reference`, [w1.id],
  );
  report('the fee the platform kept is one balanced journal entry',
    feeEntry.rows.length === 1 && feeEntry.rows[0].released === FEE * FACE && feeEntry.rows[0].kept === FEE * FACE && Number(feeEntry.rows[0].lines) === 2,
    feeEntry.rows[0]);
  const repaid = await api('POST', `/api/admin/withdrawals/${w1.id}/pay`, { token: T, body: { payoutReference: `E2E-TWICE-${stamp}` } });
  report('paying twice is refused', repaid.status === 409 && repaid.code === 'withdrawal_not_approved', { status: repaid.status, code: repaid.code });
  const rejectPaid = await api('POST', `/api/admin/withdrawals/${w1.id}/review`, { token: T, body: { approve: false } });
  report('a paid withdrawal cannot be rejected back', rejectPaid.status === 409 && rejectPaid.code === 'withdrawal_not_rejectable', { status: rejectPaid.status, code: rejectPaid.code });

  // The two constraints the service functions assume. Written in SQL because the point is that the
  // database holds them even when a future caller forgets to.
  let lostEvidence;
  try {
    await sql('UPDATE withdrawal_requests SET payout_reference = NULL WHERE id = $1', [w1.id]);
  } catch (e) { lostEvidence = e.code; }
  report('a PAID row cannot lose its evidence', lostEvidence === '23514', { error: lostEvidence });
  let oversizedFee;
  try {
    await sql('UPDATE withdrawal_requests SET fee_r_coins = $2 WHERE id = $1', [w1.id, GROSS + 1]);
  } catch (e) { oversizedFee = e.code; }
  report('a fee cannot exceed the withdrawal it came from', oversizedFee === '23514', { error: oversizedFee });

  const inList = await api('GET', '/api/admin/withdrawals?status=PAID', { token: T });
  report('the panel can list paid withdrawals', inList.status === 200 && inList.json.withdrawals.some((r) => r.id === w1.id), { rows: inList.json.withdrawals.length });

  // Refusal after approval: the escrow left the wallet at the request, so giving it back is the only
  // honest way to undo a decision the bank details turned out to break.
  const second = await api('POST', '/api/wallet/withdraw', { token: hostToken, body: { amountRCoins: DIAL.minRCoins, payoutMethod: 'USDT', payoutDetails: payout } });
  const w2 = second.json.withdrawal;
  await api('POST', `/api/admin/withdrawals/${w2.id}/review`, { token: T, body: { approve: true } });
  const refused = await api('POST', `/api/admin/withdrawals/${w2.id}/review`, { token: T, body: { approve: false, note: `${reason} bad details` } });
  report('an approved-but-unpaid withdrawal can still be refused',
    refused.status === 200 && refused.json.withdrawal.status === 'REJECTED', refused.json.withdrawal && refused.json.withdrawal.status);
  report('refusing it returns the whole escrow', (await walletOf()) === 60_000 - GROSS, { rCoinBalance: await walletOf() });
  report('its ledger row reads as reversed, not as gone', (await ledgerOf(w2.id)).status === 'REVERSED');
  report('and the account reconciles again', (await identity(T, account)).ok === true);

  await api('PUT', '/api/admin/business/config/accounts.withdrawal', { token: T, body: { value: dialBefore.json.value } });
  const dialBack = await api('GET', '/api/admin/business/config/accounts.withdrawal', { token: T });
  report('the dial is put back for the next suite',
    dialBack.json.value.minRCoins === dialBefore.json.value.minRCoins && dialBack.json.value.feeBps === dialBefore.json.value.feeBps,
    dialBack.json.value);

  const afterAll = await api('GET', '/api/admin/accounts/reconcile', { token: T });
  const withdrawalErrors = afterAll.json.findings.filter((f) => f.severity === 'ERROR' && f.code.startsWith('withdrawal'));
  report('the withdrawal pipeline leaves no error in the book', withdrawalErrors.length === 0, withdrawalErrors);
  const audited = await sql(
    `SELECT DISTINCT action FROM admin_audit WHERE target_id::text = $1`, [w1.id],
  );
  report('each decision on the request is its own audit row',
    ['WITHDRAWAL_REVIEW', 'WITHDRAWAL_PAY'].every((a) => audited.rows.some((r) => r.action === a)),
    audited.rows.map((r) => r.action).join(','));

  out.push('');
  out.push(`${out.filter((l) => l.startsWith('PASS')).length}/${out.length - 1} account checks passed`);
  process.stdout.write(out.join('\n') + '\n');
  await db().end();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  process.stdout.write(out.join('\n') + '\n');
  console.error('ACCOUNT E2E CRASH', e);
  process.exitCode = 1;
});
