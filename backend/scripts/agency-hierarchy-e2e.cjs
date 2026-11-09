/* End-to-end tests for the master / sub-agency hierarchy (migration 0040, README "Agency hierarchy").
   Drives a *running* backend over HTTP and reads the book back through the backend's own pg pool —
   no mocks, and the only fixtures are the throwaway agencies this file inserts.

     1. boot the stack and the API (README), then `npm run build`
     2. node scripts/agency-hierarchy-e2e.cjs

   Names every row it writes with a stamp and leaves it in place, so run it against a development
   database only.

   The checks worth reading first are the ones on the split itself. A sub-agency's commission is
   accrued gross to the sub and then moved, in a second balanced journal entry, to whichever master
   negotiated a share — so the promise the whole design makes is that `COMMISSION_EXPENSE` is still
   debited exactly once, that the sub's payable falls by exactly what the master's rises by, and that
   both entries are keyed on the one commission row that produced them. Everything else here (the
   depth guards, the override clearing, the member surface) is the shape around that money. */
const path = require('path');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const out = [];
let failed = 0;
const report = (n, p, d) => {
  if (!p) failed += 1;
  out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? `  :: ${JSON.stringify(d).slice(0, 300)}` : ''}`);
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

async function api(method, p, { token, body } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.headers.get('content-type')?.includes('json')
    ? JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'))
    : null;
  return { status: res.status, json, code: json && json.error && json.error.code };
}

/** A member session, the only way this stack issues one: OTP is mocked in development. */
async function memberToken(phone, username) {
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error(`request-otp failed: ${JSON.stringify(challenge.json)}`);
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: '123456', username } });
  if (verified.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verified.json)}`);
  return verified.json.token;
}

/** Runs a statement that is expected to be refused, and returns the Postgres error code. */
async function expectRefusal(query, params) {
  try {
    await sql(query, params);
    return { refused: false, code: null };
  } catch (e) {
    return { refused: true, code: e.code, message: e.message };
  }
}

(async () => {
  const stamp = Date.now().toString().slice(-7);
  const reason = `agency-hh-${stamp}`;
  const tag = `hhs${stamp}`;

  const admin = await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } });
  report('operator sign-in', admin.status === 200 && !!admin.json.token, { status: admin.status });
  const T = admin.json.token;

  const FACE = Number(
    (await sql(`SELECT value->>'minorPerCoin' AS f FROM system_config WHERE key = 'accounts.coinValue'`)).rows[0].f,
  );
  report('the coin face value is configured, so a share can be priced', FACE > 0, { minorPerCoin: FACE });

  // ------------------------------------------------------------------------ fixtures
  const newAgency = async (name, bps, status) =>
    (await sql('INSERT INTO agencies (name, commission_bps, status) VALUES ($1,$2,$3) RETURNING id', [name, bps, status])).rows[0].id;

  const MASTER = await newAgency(`${tag} master`, 2000, 'ACTIVE');
  const SUB = await newAgency(`${tag} sub`, 1500, 'ACTIVE');
  const OTHER = await newAgency(`${tag} other master`, 2000, 'ACTIVE');
  const SUSPENDED = await newAgency(`${tag} suspended master`, 2000, 'SUSPENDED');
  const LONE = await newAgency(`${tag} lone`, 2000, 'ACTIVE');

  const member = async (prefix, username) => {
    const token = await memberToken(`+923${prefix}${stamp}`, username);
    return { token, id: (await api('GET', '/api/wallet', { token })).json.user.id };
  };
  const hostSub = await member('05', `hh1${stamp}`);
  const hostMaster = await member('06', `hh2${stamp}`);
  const ownerMaster = await member('11', `ho1${stamp}`);
  const ownerSub = await member('12', `ho2${stamp}`);
  const ownerLone = await member('13', `ho3${stamp}`);
  const plain = await member('14', `hp${stamp}`);

  await sql('INSERT INTO agency_hosts (agency_id, host_user_id, commission_bps, status) VALUES ($1,$2,NULL,$3)', [SUB, hostSub.id, 'ACTIVE']);
  await sql('INSERT INTO agency_hosts (agency_id, host_user_id, commission_bps, status) VALUES ($1,$2,NULL,$3)', [MASTER, hostMaster.id, 'ACTIVE']);
  await sql('UPDATE agencies SET owner_user_id = $2 WHERE id = $1', [MASTER, ownerMaster.id]);
  await sql('UPDATE agencies SET owner_user_id = $2 WHERE id = $1', [SUB, ownerSub.id]);
  await sql('UPDATE agencies SET owner_user_id = $2 WHERE id = $1', [LONE, ownerLone.id]);

  const sender = await member('07', `hs${stamp}`);
  await api('POST', `/api/admin/users/${sender.id}/balance`, {
    token: T, body: { diamondDelta: 20_000_000, note: `${reason} gift money` },
  });
  const catalogue = (await api('GET', '/api/gifts')).json;
  const cheapest = (catalogue.gifts || catalogue)
    .filter((g) => !g.minVipLevel && g.diamondPrice > 0)
    .sort((a, b) => a.diamondPrice - b.diamondPrice)[0];
  const qty = Math.max(1, Math.ceil(100 / (cheapest.rCoinValue || 1)));

  let sends = 0;
  const send = async (receiverId) =>
    api('POST', '/api/gifts/send', {
      token: sender.token,
      body: { giftId: cheapest.id, receiverId, quantity: qty, idempotencyKey: `${reason}-send-${(sends += 1)}` },
    });

  /** The commission row one agency accrued for one host, and both journal sides keyed on it. */
  const booked = async (agencyId, receiverId) => {
    const row = (await sql(
      `SELECT t.id, t.amount_r_coins AS coins,
              t.meta->>'commissionBps' AS bps, t.meta->>'rateSource' AS src,
              t.meta->>'parentAgencyId' AS parent_id, t.meta->>'overrideBps' AS override_bps,
              COALESCE((t.meta->>'overrideCoins')::bigint, 0) AS override_coins
         FROM transactions t
        WHERE t.type = 'AGENCY_COMMISSION' AND t.agency_id = $1 AND t.receiver_id = $2
        ORDER BY t.created_at DESC LIMIT 1`,
      [agencyId, receiverId],
    )).rows[0];
    if (!row) return null;
    const legs = (await sql(
      `SELECT e.source_kind, l.account_code, l.direction, l.amount_cents
         FROM fin_journal_entries e JOIN fin_journal_lines l ON l.entry_id = e.id
        WHERE e.source_id = $1::text AND e.source_kind IN ('AGENCY_COMMISSION','AGENCY_OVERRIDE')
        ORDER BY e.source_kind, l.direction`,
      [row.id],
    )).rows;
    return { ...row, legs, entryKinds: [...new Set(legs.map((l) => l.source_kind))] };
  };

  const code = (agencyId) => `AGENCY:${agencyId}`;
  const book = async (accountCode) =>
    Number((await sql('SELECT balance_minor AS b FROM purpose_account_balances WHERE account_code = $1', [accountCode])).rows[0]?.b ?? 0);
  const getAgency = async (agencyId) => (await api('GET', `/api/admin/agencies/${agencyId}`, { token: T })).json.agency;
  const putParent = (agencyId, parentAgencyId, body) =>
    api('PUT', `/api/admin/agencies/${agencyId}/parent`, { token: T, body: body === undefined ? { parentAgencyId } : body });
  const putOverride = (agencyId, body) => api('PUT', `/api/admin/agencies/${agencyId}/override`, { token: T, body });

  // ------------------------------------------------------------------------ depth guards
  const selfParent = await putParent(SUB, SUB);
  report('an agency cannot be its own master', selfParent.status === 400 && selfParent.code === 'self_parent', selfParent.code);

  const ghost = '00000000-0000-4000-8000-000000000000';
  const ghostParent = await putParent(SUB, ghost);
  report('a master that does not exist is refused by name',
    ghostParent.status === 404 && ghostParent.code === 'parent_not_found', ghostParent.code);

  const blank = await putParent(SUB, null, {});
  report('omitting the field is refused rather than read as "detach"',
    blank.status === 400 && blank.code === 'parent_required', blank.code);

  const notUuid = await putParent(SUB, 'the-big-one');
  report('a parent that is not a uuid is refused', notUuid.status === 400, { status: notUuid.status, code: notUuid.code });

  const linked = await putParent(SUB, MASTER);
  report('a sub-agency is put under a master',
    linked.status === 200 && linked.json.agency.kind === 'SUB'
      && linked.json.agency.parentAgencyId === MASTER
      && linked.json.agency.parentAgencyName.includes(`${tag} master`),
    linked.json.agency && { kind: linked.json.agency.kind, parent: linked.json.agency.parentAgencyName });

  const subAsMaster = await putParent(OTHER, SUB);
  report('a sub-agency cannot take sub-agencies of its own',
    subAsMaster.status === 400 && subAsMaster.code === 'parent_not_master',
    subAsMaster.json.error && subAsMaster.json.error.message);

  const underSuspended = await putParent(SUB, SUSPENDED);
  report('a suspended master cannot take sub-agencies',
    underSuspended.status === 400 && underSuspended.code === 'parent_inactive', underSuspended.code);

  const demote = await putParent(MASTER, OTHER);
  report('a master that already has sub-agencies cannot itself become one',
    demote.status === 400 && demote.code === 'agency_has_children', demote.json.error && demote.json.error.message);

  // The trigger is the backstop for anything that writes the column without going through the service.
  const rawSelf = await expectRefusal('UPDATE agencies SET parent_agency_id = id WHERE id = $1', [SUB]);
  const rawDeep = await expectRefusal(
    'INSERT INTO agencies (name, commission_bps, status, parent_agency_id) VALUES ($1, 1000, $2, $3)',
    [`${tag} grandchild`, 'ACTIVE', SUB],
  );
  const rawRate = await expectRefusal(
    'UPDATE agencies SET parent_override_bps = 500 WHERE id = $1', [MASTER],
  );
  report('the 0040 trigger refuses what the service refuses',
    rawSelf.refused && rawSelf.code === '23514' && rawDeep.refused && rawDeep.code === '23514'
      && rawRate.refused && rawRate.code === '23514',
    { self: rawSelf.code, deep: rawDeep.code, rateOnMaster: rawRate.code });

  const released = await putParent(SUB, null);
  report('the same relationship can be released',
    released.status === 200 && released.json.agency.kind === 'MASTER' && released.json.agency.parentAgencyId === null,
    released.json.agency && released.json.agency.kind);
  await putParent(SUB, MASTER);

  // ------------------------------------------------------------------------ the share itself
  const rateOnMaster = await putOverride(MASTER, { parentOverrideBps: 2500 });
  report('a master carries no allocation, so setting one is refused',
    rateOnMaster.status === 400 && rateOnMaster.code === 'override_needs_parent', rateOnMaster.json.error && rateOnMaster.json.error.message);

  const wild = await putOverride(SUB, { parentOverrideBps: 20_000 });
  report('an allocation above 100% is refused', wild.status === 400 && wild.code === 'bad_rate', wild.code);
  const negative = await putOverride(SUB, { parentOverrideBps: -1 });
  report('a negative allocation is refused', negative.status === 400 && negative.code === 'bad_rate', negative.code);
  const fraction = await putOverride(SUB, { parentOverrideBps: 12.5 });
  report('a fractional basis-point value is refused', fraction.status === 400 && fraction.code === 'bad_rate', fraction.code);
  const absent = await putOverride(SUB, {});
  report('omitting the allocation is refused rather than read as no change',
    absent.status === 400 && absent.code === 'rate_required', absent.code);

  const set25 = await putOverride(SUB, { parentOverrideBps: 2500 });
  report('a quarter of the sub’s commission is allocated to its master',
    set25.status === 200 && set25.json.agency.parentOverrideBps === 2500
      && set25.json.agency.parentOverrideLabel === 'Master keeps 25% — this agency keeps 75%',
    set25.json.agency && set25.json.agency.parentOverrideLabel);

  // ------------------------------------------------------------------------ the split on a gift
  const beforeSub = await book(code(SUB));
  const beforeMaster = await book(code(MASTER));
  const beforeExpense = await book('COMMISSION_EXPENSE');

  const firstSend = await send(hostSub.id);
  const first = await booked(SUB, hostSub.id);
  report('a gift to a sub-agency’s host accrues to that sub',
    firstSend.status === 201 && !!first && Number(first.bps) === 1500 && first.src === 'AGENCY'
      && first.parent_id === MASTER && Number(first.override_bps) === 2500,
    first && { coins: first.coins, bps: first.bps, parent: first.parent_id, overrideBps: first.override_bps });

  const expectOverrideCoins = Math.floor((Number(first.coins) * 2500) / 10_000);
  const grossMinor = Number(first.coins) * FACE;
  const overrideMinor = expectOverrideCoins * FACE;
  report('the share recorded on the commission row is the sub’s gross times the allocation, truncated',
    Number(first.override_coins) === expectOverrideCoins && expectOverrideCoins > 0,
    { grossCoins: Number(first.coins), overrideCoins: Number(first.override_coins), exact: (Number(first.coins) * 2500) / 10_000 });

  const commissionLegs = first.legs.filter((l) => l.source_kind === 'AGENCY_COMMISSION');
  const overrideLegs = first.legs.filter((l) => l.source_kind === 'AGENCY_OVERRIDE');
  report('the accrual is one balanced entry: expense up, the sub’s payable up',
    commissionLegs.length === 2
      && commissionLegs.some((l) => l.account_code === 'COMMISSION_EXPENSE' && l.direction === 'DEBIT' && Number(l.amount_cents) === grossMinor)
      && commissionLegs.some((l) => l.account_code === code(SUB) && l.direction === 'CREDIT' && Number(l.amount_cents) === grossMinor),
    commissionLegs);
  report('the master’s share is a second balanced entry, from the sub to the master',
    overrideLegs.length === 2
      && overrideLegs.some((l) => l.account_code === code(SUB) && l.direction === 'DEBIT' && Number(l.amount_cents) === overrideMinor)
      && overrideLegs.some((l) => l.account_code === code(MASTER) && l.direction === 'CREDIT' && Number(l.amount_cents) === overrideMinor),
    overrideLegs);

  const afterSub = await book(code(SUB));
  const afterMaster = await book(code(MASTER));
  const afterExpense = await book('COMMISSION_EXPENSE');
  report('the sub keeps the rest and the master is owed exactly the share',
    afterSub - beforeSub === grossMinor - overrideMinor && afterMaster - beforeMaster === overrideMinor,
    { sub: afterSub - beforeSub, master: afterMaster - beforeMaster, gross: grossMinor, share: overrideMinor });
  report('the platform promised the commission once — the expense is not doubled by the split',
    afterExpense - beforeExpense === grossMinor, { expenseDelta: afterExpense - beforeExpense, grossMinor });

  const entryCount = (await sql(
    `SELECT source_kind, COUNT(*)::int AS n FROM fin_journal_entries
      WHERE source_id = $1::text AND source_kind IN ('AGENCY_COMMISSION','AGENCY_OVERRIDE')
      GROUP BY source_kind`,
    [first.id],
  )).rows;
  report('both sides are keyed on the one commission row, once each',
    entryCount.length === 2 && entryCount.every((r) => r.n === 1), entryCount);

  const masterRoster = await send(hostMaster.id);
  const masterBooked = await booked(MASTER, hostMaster.id);
  report('a master’s own roster keeps 100% — no transfer to anybody',
    masterRoster.status === 201 && Number(masterBooked.override_coins) === 0
      && masterBooked.entryKinds.length === 1 && masterBooked.entryKinds[0] === 'AGENCY_COMMISSION',
    { kinds: masterBooked.entryKinds, overrideCoins: Number(masterBooked.override_coins) });

  // ------------------------------------------------------------------------ what stops the split
  const nullShare = await putOverride(SUB, { parentOverrideBps: null });
  await send(hostSub.id);
  const afterNull = await booked(SUB, hostSub.id);
  report('a null allocation stops the transfer and says no share was agreed',
    nullShare.json.agency.parentOverrideLabel === 'Master takes nothing — keeps 100%'
      && Number(afterNull.override_coins) === 0 && afterNull.entryKinds.length === 1,
    { label: nullShare.json.agency.parentOverrideLabel, kinds: afterNull.entryKinds });

  const zeroShare = await putOverride(SUB, { parentOverrideBps: 0 });
  await send(hostSub.id);
  const afterZero = await booked(SUB, hostSub.id);
  report('and a zero allocation stops it too, as an agreed number rather than an unset one',
    Number(zeroShare.json.agency.parentOverrideBps) === 0 && Number(afterZero.override_coins) === 0
      && afterZero.entryKinds.length === 1,
    { bps: zeroShare.json.agency.parentOverrideBps, kinds: afterZero.entryKinds });

  const odd = await putOverride(SUB, { parentOverrideBps: 333 });
  await send(hostSub.id);
  const afterOdd = await booked(SUB, hostSub.id);
  const oddCoins = Number(afterOdd.coins);
  const oddShare = Number(afterOdd.override_coins);
  report('an awkward rate truncates in the sub’s favour and the book agrees with the arithmetic',
    oddShare * 10_000 <= oddCoins * 333 && (oddShare + 1) * 10_000 > oddCoins * 333
      && afterOdd.legs.filter((l) => l.source_kind === 'AGENCY_OVERRIDE')
        .every((l) => Number(l.amount_cents) === oddShare * FACE),
    { coins: oddCoins, share: oddShare, exact: (oddCoins * 333) / 10_000 });

  // ------------------------------------------------------------------------ history is not rewritten
  const masterReceivedBefore = (await getAgency(MASTER)).receivedOverrideCoins;
  const subOverrideBefore = (await getAgency(SUB)).overrideCoins;
  const detached = await putParent(SUB, MASTER, { parentAgencyId: null });
  report('detaching a sub clears its allocation and the master takes nothing further',
    detached.status === 200 && detached.json.agency.parentAgencyId === null
      && detached.json.agency.parentOverrideBps === null,
    detached.json.agency && { parent: detached.json.agency.parentAgencyId, bps: detached.json.agency.parentOverrideBps });
  const masterBalanceDetached = await book(code(MASTER));
  await send(hostSub.id);
  const afterDetach = await booked(SUB, hostSub.id);
  const masterAfterDetach = await book(code(MASTER));
  report('the gifts that already split keep their split — history is untouched',
    afterDetach.entryKinds.length === 1
      && masterAfterDetach === masterBalanceDetached
      && (await getAgency(MASTER)).receivedOverrideCoins === masterReceivedBefore
      && (await getAgency(SUB)).overrideCoins === subOverrideBefore,
    { received: masterReceivedBefore, overrideCoins: subOverrideBefore, masterBalance: masterAfterDetach });

  // Changing masters must not carry a number negotiated under the old one.
  await putParent(SUB, MASTER);
  await putOverride(SUB, { parentOverrideBps: 2500 });
  const moved = await putParent(SUB, OTHER);
  const moveAudit = (await sql(
    `SELECT details FROM admin_audit WHERE action = 'AGENCY_PARENT_UPDATE' AND target_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [SUB],
  )).rows[0];
  report('moving to another master clears the allocation it was agreed under',
    moved.status === 200 && moved.json.agency.parentAgencyId === OTHER
      && moved.json.agency.parentOverrideBps === null
      && Number(moveAudit && moveAudit.details.clearedOverrideBps) === 2500,
    { to: OTHER, cleared: moveAudit && moveAudit.details.clearedOverrideBps });

  const reattached = await putParent(SUB, MASTER);
  await putOverride(SUB, { parentOverrideBps: 2500 });
  await send(hostSub.id);
  report('and putting it back under the original master needs the allocation set again',
    reattached.status === 200 && reattached.json.agency.parentOverrideBps === null
      && (await getAgency(SUB)).kind === 'SUB',
    { parentOverrideBps: reattached.json.agency.parentOverrideBps });

  const auditActions = (await sql(
    `SELECT DISTINCT action FROM admin_audit WHERE target_id = $1`, [SUB],
  )).rows.map((r) => r.action);
  report('every relationship decision is its own audit row',
    ['AGENCY_PARENT_UPDATE', 'AGENCY_OVERRIDE_UPDATE'].every((a) => auditActions.includes(a)),
    auditActions.join(','));

  // ------------------------------------------------------------------------ the operator's reads
  const subs = await api('GET', `/api/admin/agencies?kind=SUB&search=${tag}`, { token: T });
  report('the roster can be filtered to sub-agencies',
    subs.status === 200 && subs.json.agencies.length === 1 && subs.json.agencies[0].id === SUB,
    { rows: subs.json.agencies.map((a) => a.name) });
  const masters = await api('GET', `/api/admin/agencies?kind=MASTER&search=${tag}`, { token: T });
  report('and to masters, which is the parent link and nothing else',
    masters.json.agencies.every((a) => a.parentAgencyId === null)
      && masters.json.agencies.some((a) => a.id === MASTER)
      && !masters.json.agencies.some((a) => a.id === SUB),
    masters.json.agencies.map((a) => a.kind));
  const byParent = await api('GET', `/api/admin/agencies?parentAgencyId=${MASTER}`, { token: T });
  report('a master’s sub-agencies are listed by parent',
    byParent.json.agencies.length === 1 && byParent.json.agencies[0].id === SUB, { rows: byParent.json.total });
  const badKind = await api('GET', '/api/admin/agencies?kind=NOPE', { token: T });
  report('an unknown kind is refused, not silently ignored', badKind.status === 400, badKind.code);

  const masterDetail = await api('GET', `/api/admin/agencies/${MASTER}`, { token: T });
  const alloc = masterDetail.json.subAgencies;
  const subDto = masterDetail.json.agency;
  report('the master’s desk carries its sub-agencies and what each keeps',
    masterDetail.status === 200 && alloc.length === 1 && alloc[0].id === SUB
      && alloc[0].parentOverrideBps === 2500 && alloc[0].retainedCoins === alloc[0].accruedCoins - alloc[0].overrideCoins
      && alloc[0].accruedCoins > 0 && alloc[0].overrideCoins > 0,
    alloc && alloc[0]);
  report('the allocation is priced the same way the payable is held',
    alloc.length === 1 && Number(alloc[0].owedMinor) === await book(code(SUB)),
    { owedMinor: alloc[0].owedMinor, book: await book(code(SUB)) });
  const loneDetail = await api('GET', `/api/admin/agencies/${LONE}`, { token: T });
  report('an agency with no children reads an empty allocation table',
    loneDetail.status === 200 && Array.isArray(loneDetail.json.subAgencies) && loneDetail.json.subAgencies.length === 0,
    loneDetail.json.subAgencies && loneDetail.json.subAgencies.length);
  const subRow = await getAgency(SUB);
  report('the sub’s own row names its master and keeps its own arithmetic straight',
    subRow.kind === 'SUB' && subRow.parentAgencyId === MASTER && subRow.parentOverrideBps === 2500
      && subRow.retainedCoins === subRow.accruedCoins - subRow.overrideCoins && subRow.subAgencyCount === 0,
    { kind: subRow.kind, accrued: subRow.accruedCoins, override: subRow.overrideCoins, retained: subRow.retainedCoins });

  // ------------------------------------------------------------------------ the book still adds up
  const statements = {};
  for (const [label, agencyId] of [['sub', SUB], ['master', MASTER]]) {
    const page1 = await api('GET', `/api/admin/accounts/${encodeURIComponent(code(agencyId))}/movements?limit=200`, { token: T });
    statements[label] = page1.json;
    const rows = page1.json.movements;
    const inSum = rows.filter((m) => m.direction === 'IN').reduce((s, m) => s + m.amount, 0);
    const outSum = rows.filter((m) => m.direction === 'OUT').reduce((s, m) => s + m.amount, 0);
    const detail = (await api('GET', `/api/admin/accounts/${encodeURIComponent(code(agencyId))}`, { token: T })).json.account;
    report(`${label}: the statement is the balance it reports`,
      detail.opening + inSum - outSum === detail.balance, { balance: detail.balance, in: inSum, out: outSum });
  }
  report('the sub’s statement shows the share leaving it, and the master’s shows the same share arriving',
    statements.sub.movements.some((m) => m.type === 'AGENCY_OVERRIDE' && m.direction === 'OUT')
      && statements.master.movements.some((m) => m.type === 'AGENCY_OVERRIDE' && m.direction === 'IN'),
    { sub: statements.sub.movements.filter((m) => m.type === 'AGENCY_OVERRIDE').length,
      master: statements.master.movements.filter((m) => m.type === 'AGENCY_OVERRIDE').length });

  // The two books have two reports. `/accounts/reconcile` answers "is every account's own position
  // explained by its ledger"; the tie-outs between the commission rows, the rates and the journal live
  // in the finance reconciliation, which is where a promised allocation that was never booked shows up.
  const recon = await api('GET', '/api/admin/business/finance/reconciliation', { token: T });
  const overrideChecks = (recon.json.checks || []).filter((c) => /agency_override/.test(c.key));
  const positions = await api('GET', '/api/admin/accounts/reconcile', { token: T });
  const agencyErrors = positions.json.findings.filter((f) => f.severity === 'ERROR' && /agency|override/.test(f.code));
  report('the reconciler asks about the split, and asks it of the whole book',
    overrideChecks.length === 2 && overrideChecks.every((c) => c.passed && c.breaches === 0),
    overrideChecks.map((c) => ({ key: c.key, breaches: c.breaches })));
  report('nothing about the hierarchy leaves the agency book in breach', agencyErrors.length === 0, agencyErrors);

  // A check that only ever answers zero proves nothing, so one real accrual is briefly described as
  // an allocation nobody agreed — both halves of the pair have to notice, and the book has to come
  // back to clean when the description is put right.
  const probe = (await sql(
    `SELECT id, source_id FROM fin_journal_entries WHERE source_kind = 'AGENCY_OVERRIDE' AND source_id = $1::text`,
    [first.id],
  )).rows[0];
  const overrideState = async () => ((await api('GET', '/api/admin/business/finance/reconciliation', { token: T })).json.checks || [])
    .filter((c) => /agency_override/.test(c.key));
  try {
    await sql('UPDATE fin_journal_entries SET source_id = $2 WHERE id = $1', [probe.id, ghost]);
    const broken = await overrideState();
    report('an allocation the commission row promises but the book does not hold is a breach',
      broken.some((c) => c.key === 'commission.agency_override_posted' && c.breaches >= 1),
      broken.map((c) => ({ key: c.key, breaches: c.breaches })));
    report('and an allocation with no commission row behind it is its own breach',
      broken.some((c) => c.key === 'commission.agency_override_authorised' && c.breaches >= 1),
      broken.map((c) => ({ key: c.key, breaches: c.breaches })));
  } finally {
    await sql('UPDATE fin_journal_entries SET source_id = $2 WHERE id = $1', [probe.id, probe.source_id]);
  }
  const healed = await overrideState();
  report('putting the description back makes both checks pass again',
    healed.length === 2 && healed.every((c) => c.passed), healed.map((c) => c.breaches));

  // ------------------------------------------------------------------------ the agency's own desk
  const plainPosition = await api('GET', '/api/agency/position', { token: plain.token });
  report('a member who runs no agency reaches no agency’s book',
    plainPosition.status === 403 && plainPosition.code === 'agency_not_found', plainPosition.code);

  const adminOnMemberRoute = await api('GET', '/api/agency/position', { token: T });
  report('an operator token is refused on the member surface',
    adminOnMemberRoute.status === 403 && adminOnMemberRoute.code === 'member_token_required', adminOnMemberRoute.code);

  const subPosition = await api('GET', '/api/agency/position', { token: ownerSub.token });
  const sp = subPosition.json && subPosition.json.agency;
  report('a sub-agency owner reads its own position, and who it reports to',
    subPosition.status === 200 && sp.kind === 'SUB' && sp.master && sp.master.id === MASTER
      && sp.master.overrideBps === 2500 && sp.master.overrideLabel === 'Master keeps 25% — this agency keeps 75%',
    sp && { kind: sp.kind, master: sp.master && sp.master.name, label: sp.master && sp.master.overrideLabel });
  report('the position separates what it earned from what it keeps',
    sp.earnings.retainedCoins === sp.earnings.accruedCoins - sp.earnings.overrideCoins
      && sp.earnings.overrideCoins > 0 && sp.earnings.receivedOverrideCoins === 0,
    sp && sp.earnings);
  report('and states the payable in money, with what is claimed or frozen beside it',
    !!sp.account && sp.account.availableMinor === await book(code(SUB)) && sp.account.currency === 'pkr',
    sp && sp.account);

  const masterPosition = await api('GET', '/api/agency/position', { token: ownerMaster.token });
  const mp = masterPosition.json && masterPosition.json.agency;
  report('a master owner reads itself as a master, with no master above it',
    masterPosition.status === 200 && mp.kind === 'MASTER' && mp.master === null && mp.subAgencyCount === 1,
    mp && { kind: mp.kind, master: mp.master, subs: mp.subAgencyCount });
  report('what it took in from its subs is shown beside what its own roster earned',
    mp.earnings.receivedOverrideCoins > 0 && mp.earnings.overrideCoins === 0, mp && mp.earnings);

  const masterSubs = await api('GET', '/api/agency/sub-agencies', { token: ownerMaster.token });
  const one = masterSubs.json && masterSubs.json.subAgencies;
  report('a master sees its subs’ allocation table — gross, share, and what each keeps',
    masterSubs.status === 200 && one.length === 1 && one[0].id === SUB
      && one[0].retainedCoins === one[0].accruedCoins - one[0].overrideCoins && one[0].overrideCoins > 0,
    one && one[0]);
  const subSubs = await api('GET', '/api/agency/sub-agencies', { token: ownerSub.token });
  report('a sub is refused the sub-agency list rather than shown an empty one',
    subSubs.status === 403 && subSubs.code === 'master_only', subSubs.code);

  const roster = await api('GET', '/api/agency/hosts', { token: ownerSub.token });
  const rosterBody = JSON.stringify(roster.json);
  report('the roster names its hosts and nothing the owner has no need of',
    roster.status === 200 && roster.json.hosts.some((h) => h.accruedCoins > 0)
      && !rosterBody.includes('phone') && !rosterBody.includes('membershipId')
      && !rosterBody.includes(hostSub.id),
    roster.json.hosts && Object.keys(roster.json.hosts[0]));

  const batches = await api('GET', '/api/agency/settlements', { token: ownerSub.token });
  report('the batches raised for this agency read without the operator or the bank reference',
    batches.status === 200 && Array.isArray(batches.json.settlements)
      && !JSON.stringify(batches.json).includes('payoutReference'),
    batches.json.settlements && batches.json.settlements.length);

  const selfRate = await api('PUT', `/api/admin/agencies/${SUB}/override`, { token: ownerSub.token, body: { parentOverrideBps: 10_000 } });
  const selfBatch = await api('POST', `/api/admin/agencies/${SUB}/settlements`, {
    token: ownerSub.token,
    body: { periodFrom: '2000-01-01T00:00:00.000Z', periodTo: new Date().toISOString(), idempotencyKey: `${reason}-self-batch` },
  });
  report('an agency owner cannot set their own rate or claim their own payout',
    selfRate.status === 403 && selfBatch.status === 403, { rate: selfRate.code, batch: selfBatch.code });

  await sql(`UPDATE agencies SET status = 'SUSPENDED' WHERE id = $1`, [LONE]);
  const suspendedOwner = await api('GET', '/api/agency/position', { token: ownerLone.token });
  report('a suspended agency’s owner is locked out of the desk',
    suspendedOwner.status === 403 && suspendedOwner.code === 'agency_not_found', suspendedOwner.code);

  // ------------------------------------------------------------------------ the arithmetic, on its own
  const { overrideCoinsFor, overrideLabel, MAX_COMMISSION_BPS } = require(path.join(BE_ROOT, 'dist', 'services', 'agency.service.js'));
  report('the share is truncated, never rounded up, and nothing for an unset or zero rate',
    overrideCoinsFor(1001, 5000) === 500 && overrideCoinsFor(1001, null) === 0 && overrideCoinsFor(1001, 0) === 0
      && overrideCoinsFor(0, 2500) === 0 && overrideCoinsFor(-5, 2500) === 0
      && overrideCoinsFor(10_000, MAX_COMMISSION_BPS) === 10_000,
    { odd: overrideCoinsFor(1001, 5000), full: overrideCoinsFor(10_000, MAX_COMMISSION_BPS) });
  report('the label a master reads is not the label a sub reads',
    overrideLabel(2500, false) === 'Keeps its own roster’s commission'
      && overrideLabel(null, true) === 'Master takes nothing — keeps 100%'
      && overrideLabel(2500, true) === 'Master keeps 25% — this agency keeps 75%'
      && overrideLabel(1000, true) === 'Master keeps 10% — this agency keeps 90%',
    overrideLabel(2500, true));

  out.push('');
  out.push(`${out.filter((l) => l.startsWith('PASS')).length}/${out.length - 1} agency-hierarchy checks passed`);
  process.stdout.write(out.join('\n') + '\n');
  await db().end();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  process.stdout.write(out.join('\n') + '\n');
  console.error('AGENCY HIERARCHY E2E CRASH', e);
  process.exitCode = 1;
});
