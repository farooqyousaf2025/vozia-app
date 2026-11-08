/* End-to-end tests for promotional diamonds (migrations 0036 + 0037, README "Promotional diamonds").
   Drives a *running* backend over HTTP and asserts on database state through the backend's own pg
   pool — no mocks, no fixtures.

     1. boot the stack and the API (README), then `npm run build`
     2. node scripts/promo-e2e.cjs

   Runs against a development database only: it grants, spends, expires and refunds coins, opens a
   paid game for the duration and restores the shipped free-to-play rules before it exits.

   The checks worth reading first are the four that guard the two pockets staying separate:
   a fee paid from the bonus pocket refunds to the bonus pocket, a fee paid from both splits the
   same way in reverse, a coin returned to a grant whose expiry has passed lapses instead of
   resurrecting, and the bonus account's statement still reproduces its balance afterwards. Each is
   a claim that the second wallet did not quietly become the first one. */
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

/** A member session, the only way this stack issues one: OTP is mocked in development. */
async function member(phone) {
  const username = `pm${phone.slice(-8)}`;
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error(`request-otp failed: ${JSON.stringify(challenge.json)}`);
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: '123456', username } });
  if (verified.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verified.json)}`);
  const row = (await sql('SELECT id, diamond_balance, promo_diamond_balance FROM users WHERE phone = $1', [phone])).rows[0];
  if (!row) throw new Error(`no account behind ${phone}`);
  return { token: verified.json.token, id: row.id, phone };
}

const pocket = async (id) =>
  (await sql('SELECT diamond_balance AS bought, promo_diamond_balance AS bonus FROM users WHERE id = $1', [id])).rows[0];

/** The grant rows, oldest-expiry first — the same order the spend takes them in. */
const grants = async (userId) =>
  (await sql('SELECT id, status, amount, spent, lapsed, remaining FROM promo_grants WHERE user_id = $1 ORDER BY expires_at', [userId])).rows;

/** The ledger row of one type for one account, newest first, with its meta. */
const lastMove = async (type, userId) =>
  (await sql(
    `SELECT id, amount_diamonds, meta FROM transactions WHERE type = $1 AND (sender_id = $2 OR receiver_id = $2)
      ORDER BY created_at DESC LIMIT 1`,
    [type, userId],
  )).rows[0];

/** Both legs of one journal entry, as `{DEBIT: [codes], CREDIT: [...]}` with the amounts. */
const journal = async (sourceKind, sourceId) => {
  const rows = await sql(
    `SELECT e.id, l.direction, l.account_code, l.amount_cents FROM fin_journal_entries e
       JOIN fin_journal_lines l ON l.entry_id = e.id
      WHERE e.source_kind = $1 AND e.source_id = $2
      ORDER BY l.direction`,
    [sourceKind, sourceId],
  );
  return rows.rows;
};

const grantPromo = (token, userId, body) => api('POST', `/api/admin/users/${userId}/promo-grant`, { token, body });

/** `opening + ΣIN − ΣOUT = balance`, over every page of the statement. */
async function identity(token, code) {
  const detail = await api('GET', `/api/admin/accounts/${encodeURIComponent(code)}`, { token });
  if (detail.status !== 200) return { ok: false, reason: `detail ${detail.status} ${detail.code || ''}` };
  const account = detail.json.account;
  const rows = [];
  let page = 1;
  for (;;) {
    const res = await api('GET', `/api/admin/accounts/${encodeURIComponent(code)}/movements?page=${page}&limit=200`, { token });
    if (res.status !== 200) return { ok: false, reason: `statement ${res.status} ${res.code || ''}` };
    rows.push(...res.json.movements);
    if (rows.length >= res.json.total || res.json.movements.length === 0) break;
    page += 1;
  }
  const inSum = rows.filter((m) => m.direction === 'IN').reduce((s, m) => s + m.amount, 0);
  const outSum = rows.filter((m) => m.direction === 'OUT').reduce((s, m) => s + m.amount, 0);
  return {
    ok: account.opening + inSum - outSum === account.balance,
    balance: account.balance,
    inSum,
    outSum,
    legs: rows.length,
    source: account.balanceSource,
  };
}

// The paid-game fixture. `refundPolicy: ALWAYS` is not what makes a refund happen on leave — that
// path is unconditional — but a cancelled match has to look refundable in the rules it pinned.
const GAME = 'TIC_TAC_TOE';
const PAID = {
  isActive: true,
  entryFeeEnabled: true,
  entryFeeMin: 10,
  entryFeeMax: 500,
  entryFeeDiamonds: 130,
  prizeEnabled: false,
  refundPolicy: 'ALWAYS',
  confirmCompliance: true,
};
const SHIPPED = {
  isActive: false,
  entryFeeEnabled: false,
  entryFeeMin: 0,
  entryFeeMax: 0,
  entryFeeDiamonds: 0,
  prizeEnabled: false,
  refundPolicy: 'CANCELLED',
  confirmCompliance: true,
};

/** A room and a fresh paid session for one member: creating it is what charges the fee. */
async function openSession(memberToken, stamp) {
  const room = await api('POST', '/api/rooms', {
    token: memberToken,
    body: { title: `PM ${stamp}`, category: 'CHAT', type: 'PUBLIC', seatCapacity: 4 },
  });
  const roomId = room.json && room.json.room && room.json.room.id;
  if (!roomId) throw new Error(`room create failed: ${room.status} ${room.code || ''}`);
  const session = await api('POST', '/api/games', { token: memberToken, body: { gameKey: GAME, roomId } });
  if (session.status !== 201) throw new Error(`session create failed: ${session.status} ${session.code || ''}`);
  return { sessionId: session.json.session.id, fee: session.json.session.entryFeeDiamonds };
}

(async () => {
  const stamp = Date.now().toString().slice(-7);
  const admin = await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } });
  report('operator sign-in', admin.status === 200 && !!admin.json.token, { status: admin.status });
  const T = admin.json.token;

  const face = Number((await sql(`SELECT value->>'minorPerCoin' AS n FROM system_config WHERE key = 'accounts.coinValue'`)).rows[0]?.n ?? 0);
  const dialBefore = await api('GET', '/api/admin/business/config/accounts.promotional', { token: T });
  report('the promo dial reads back', dialBefore.status === 200 && !!dialBefore.json.value, dialBefore.json && dialBefore.json.value);

  // The fee checks below pay a game entry out of the bonus pocket, and the dial is allowed to refuse
  // that sink. The setting found on boot is restored at the end, so what runs here is the spend path
  // rather than whatever an operator or an earlier interrupted run left switched off.
  await api('PUT', '/api/admin/business/config/accounts.promotional', {
    token: T,
    body: { value: { ...dialBefore.json.value, usableFor: ['GIFT', 'BOX', 'STORE', 'GAME'] } },
  });

  // ---------------------------------------------------------------- the grant
  const A = await member(`+92346${stamp}01`);
  const first = await grantPromo(T, A.id, { amount: 100, reason: `promo-e2e first ${stamp}`, days: 2 });
  report('an operator grants bonus diamonds', first.status === 201 && first.json.grant.remaining === 100, {
    status: first.status,
    code: first.code,
  });
  const grantA1 = first.json && first.json.grant;
  const afterFirst = await pocket(A.id);
  report('the bonus pocket moved and the purchased one did not',
    afterFirst.bonus === 100 && afterFirst.bought === 0, afterFirst);

  const walletA = await api('GET', '/api/wallet', { token: A.token });
  report('the wallet shows the pocket, the grant and the policy',
    walletA.status === 200 && walletA.json.user.promoDiamondBalance === 100 &&
      walletA.json.promo.grants.length >= 1 && Array.isArray(walletA.json.promo.policy.usableFor),
    {
      dto: walletA.json && walletA.json.user.promoDiamondBalance,
      grants: walletA.json && walletA.json.promo.grants.length,
      policy: walletA.json && walletA.json.promo.policy,
    });

  if (face > 0) {
    const lines = await journal('PROMO_GRANT', grantA1.id);
    const debit = lines.find((l) => l.direction === 'DEBIT');
    const credit = lines.find((l) => l.direction === 'CREDIT');
    report('a minted coin is journalled against the promotional budget and the coin liability',
      lines.length === 2 && debit && debit.account_code === 'PROMOTIONAL:PLATFORM' &&
        credit && credit.account_code === 'COIN_LIABILITY' &&
        Number(debit.amount_cents) === 100 * face && Number(credit.amount_cents) === 100 * face,
      lines.map((l) => `${l.direction} ${l.account_code} ${l.amount_cents}`));
  }

  const badAmount = await grantPromo(T, A.id, { amount: 0, reason: 'promo-e2e zero' });
  const badReason = await grantPromo(T, A.id, { amount: 10, reason: '   ' });
  const asMember = await grantPromo(A.token, A.id, { amount: 10, reason: 'promo-e2e self' });
  report('a grant is refused before it exists: no zero, no blank reason, no self-service',
    badAmount.status === 400 && badReason.status === 400 && (asMember.status === 401 || asMember.status === 403),
    { amount: badAmount.status, reason: badReason.status, member: asMember.status });

  // ------------------------------------------------- spend, nearest death first
  const second = await grantPromo(T, A.id, { amount: 60, reason: `promo-e2e second ${stamp}`, days: 20 });
  report('a second grant with a later expiry', second.status === 201, { status: second.status });

  await api('PUT', `/api/admin/games/${GAME}/rules`, { token: T, body: PAID });
  const paidA = await openSession(A.token, stamp);
  report('a fee bigger than one grant is affordable from the pocket alone',
    paidA.fee === 130 && (await pocket(A.id)).bought === 0, { fee: paidA.fee });

  const grantsA = await grants(A.id);
  const spentA = await lastMove('GAME_ENTRY', A.id);
  const receiptsA = await sql(
    'SELECT grant_id, diamonds FROM promo_grant_spends WHERE transaction_id = $1 ORDER BY diamonds DESC',
    [spentA.id],
  );
  report('the near-expiring grant dies first, and the far one only what it must',
    grantsA[0].remaining === 0 && grantsA[0].status === 'EXHAUSTED' && grantsA[1].remaining === 30 &&
      (await pocket(A.id)).bonus === 30,
    grantsA.map((g) => `${g.status}:${g.remaining}`));
  report('the entry row prices the whole fee but records only the purchased part moving',
    spentA && spentA.amount_diamonds === 130 && spentA.meta.promoDiamonds === 130 && spentA.meta.diamondsAfter === 0,
    spentA && spentA.meta);
  report('the spend has one receipt per grant it drew on',
    receiptsA.rows.length === 2 && receiptsA.rows.reduce((s, r) => s + r.diamonds, 0) === 130,
    receiptsA.rows);

  // ------------------------------------------------------------- the refund
  const left = await api('POST', `/api/games/${paidA.sessionId}/leave`, { token: A.token, body: {} });
  report('leaving the lobby before the match starts', left.status === 200, { status: left.status, code: left.code });

  const refundedA = await grants(A.id);
  const refundA = await lastMove('GAME_REFUND', A.id);
  const pocketA2 = await pocket(A.id);
  report('a fee paid in bonus coins comes back as bonus coins, not as purchased ones',
    pocketA2.bonus === 160 && pocketA2.bought === 0, pocketA2);
  report('the grants that paid it are whole again, including the exhausted one',
    refundedA[0].remaining === 100 && refundedA[0].status === 'ACTIVE' && refundedA[0].spent === 0 &&
      refundedA[1].remaining === 60,
    refundedA.map((g) => `${g.status}:${g.remaining}:spent${g.spent}`));
  report('the refund row prices the whole fee and says none of it was purchased',
    refundA && refundA.amount_diamonds === 130 && refundA.meta.promoDiamonds === 130 &&
      refundA.meta.diamondsAfter === 0,
    refundA && refundA.meta);

  const cancelAfterLeave = await api('POST', `/api/games/${paidA.sessionId}/cancel`, { token: A.token, body: { reason: 'twice' } });
  const pocketA3 = await pocket(A.id);
  report('a closed match cannot refund itself a second time',
    cancelAfterLeave.status >= 400 && pocketA3.bonus === 160 && pocketA3.bought === 0,
    { status: cancelAfterLeave.status, code: cancelAfterLeave.code, ...pocketA3 });

  const identityA = await identity(T, `PROMOTIONAL:${A.id}`);
  report('the bonus account reproduces its balance from its statement after a refund',
    identityA.ok && identityA.balance === 160 && identityA.source === 'users.promo_diamond_balance',
    identityA);

  // ------------------------------------------------------- mixed-pocket refund
  const B = await member(`+92346${stamp}02`);
  await sql('UPDATE users SET diamond_balance = 200 WHERE id = $1', [B.id]);
  const grantB = await grantPromo(T, B.id, { amount: 40, reason: `promo-e2e mixed ${stamp}`, days: 5 });
  const paidB = await openSession(B.token, stamp);
  const pocketB1 = await pocket(B.id);
  report('a fee bigger than the bonus pocket takes the rest from purchased diamonds',
    grantB.status === 201 && paidB.fee === 130 && pocketB1.bonus === 0 && pocketB1.bought === 110,
    pocketB1);

  await api('POST', `/api/games/${paidB.sessionId}/leave`, { token: B.token, body: {} });
  const pocketB2 = await pocket(B.id);
  const refundB = await lastMove('GAME_REFUND', B.id);
  report('and the refund splits it the same way in reverse',
    pocketB2.bonus === 40 && pocketB2.bought === 200, pocketB2);
  report('the mixed refund row carries the bonus share in its meta',
    refundB.meta.promoDiamonds === 40 && refundB.meta.diamondsAfter === 200, refundB.meta);
  const identityB = await identity(T, `PROMOTIONAL:${B.id}`);
  report('the mixed account still reproduces its balance', identityB.ok && identityB.balance === 40, identityB);

  // ------------------------------------------- refund into a grant that expired
  const C = await member(`+92346${stamp}03`);
  const grantC = await grantPromo(T, C.id, { amount: 130, reason: `promo-e2e expiry ${stamp}`, days: 2 });
  const paidC = await openSession(C.token, stamp);
  report('a bonus-only fee leaves nothing in the purchased pocket',
    grantC.status === 201 && paidC.fee === 130 && (await pocket(C.id)).bought === 0, await pocket(C.id));

  // The clock, not the sweep: the grant is already spent to zero, so nothing would lapse on its own.
  // Both dates move together because the table CHECKs that a grant expires after it was made.
  await sql(
    `UPDATE promo_grants SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'
      WHERE id = $1`,
    [grantC.json.grant.id],
  );
  await api('POST', `/api/games/${paidC.sessionId}/leave`, { token: C.token, body: {} });
  const grantCRow = (await grants(C.id))[0];
  const pocketC = await pocket(C.id);
  const refundC = await lastMove('GAME_REFUND', C.id);
  report('coins returned to a dead grant do not resurrect it',
    pocketC.bonus === 0 && pocketC.bought === 0 && grantCRow.remaining === 0 && grantCRow.lapsed === 130 &&
      grantCRow.spent === 0 && grantCRow.status !== 'ACTIVE',
    { ...pocketC, ...grantCRow });
  report('the refund row says every coin it returned was promotional, and none reached the wallet',
    refundC.meta.promoDiamonds === 130 && refundC.meta.diamondsAfter === 0, refundC.meta);
  if (face > 0) {
    const lines = await journal('PROMO_LAPSE', (await lastMove('GAME_ENTRY', C.id)).id);
    report('a coin that lapses on the way back releases the liability it was minted against',
      lines.length === 2 &&
        lines.find((l) => l.direction === 'DEBIT')?.account_code === 'COIN_LIABILITY' &&
        lines.find((l) => l.direction === 'CREDIT')?.account_code === 'PROMOTIONAL:PLATFORM' &&
        Number(lines[0].amount_cents) === 130 * face,
      lines.map((l) => `${l.direction} ${l.account_code} ${l.amount_cents}`));
  }
  const identityC = await identity(T, `PROMOTIONAL:${C.id}`);
  report('a dead grant still reproduces a zero balance', identityC.ok && identityC.balance === 0, identityC);

  // ------------------------------------------------------------- the expiry sweep
  const D = await member(`+92346${stamp}04`);
  const grantD = await grantPromo(T, D.id, { amount: 70, reason: `promo-e2e sweep ${stamp}`, days: 1 });
  await sql(
    `UPDATE promo_grants SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 minute'
      WHERE id = $1`,
    [grantD.json.grant.id],
  );
  const swept = await api('POST', '/api/admin/promo-grants/lapse', { token: T, body: {} });
  const grantDRow = (await grants(D.id))[0];
  // Which sweep got there — this request or the server's own 60-second one — is not the promise. That a
  // grant's remainder leaves the pocket exactly once is.
  report('the sweep takes an expired remainder out of the pocket',
    swept.status === 200 && grantDRow.status === 'LAPSED' && grantDRow.lapsed === 70 &&
      grantDRow.remaining === 0 && (await pocket(D.id)).bonus === 0,
    { result: swept.json && swept.json.result, ...grantDRow });
  if (face > 0) {
    const lines = await journal('PROMO_LAPSE', grantDRow.id);
    report('the lapse releases the liability back to the budget that minted it',
      lines.length === 2 && lines.every((l) => Number(l.amount_cents) === 70 * face) &&
        lines.find((l) => l.direction === 'DEBIT')?.account_code === 'COIN_LIABILITY',
      lines.map((l) => `${l.direction} ${l.account_code} ${l.amount_cents}`));
  }
  await api('POST', '/api/admin/promo-grants/lapse', { token: T, body: {} });
  const grantDAfter = (await grants(D.id))[0];
  report('a grant lapses once', grantDAfter.lapsed === 70 && grantDAfter.remaining === 0 &&
    (await pocket(D.id)).bonus === 0, grantDAfter);

  // ------------------------------------------------------- the usage restriction
  const wrongList = await api('PUT', '/api/admin/business/config/accounts.promotional', {
    token: T,
    body: { value: { expiryDays: 30, usableFor: ['GIFT', 'MYSTERY'] } },
  });
  const emptyList = await api('PUT', '/api/admin/business/config/accounts.promotional', {
    token: T,
    body: { value: { expiryDays: 30, usableFor: [] } },
  });
  report('a dial naming an unknown sink is refused rather than widened',
    wrongList.status === 400 && emptyList.status === 400 && wrongList.code === 'bad_config_value',
    { wrong: wrongList.status, empty: emptyList.status });

  const restricted = await api('PUT', '/api/admin/business/config/accounts.promotional', {
    token: T,
    body: { value: { ...dialBefore.json.value, usableFor: ['GIFT'] } },
  });
  const E = await member(`+92346${stamp}05`);
  await sql('UPDATE users SET diamond_balance = 200 WHERE id = $1', [E.id]);
  const grantE = await grantPromo(T, E.id, { amount: 130, reason: `promo-e2e restricted ${stamp}`, days: 3 });
  const paidE = await openSession(E.token, stamp);
  const pocketE = await pocket(E.id);
  const entryE = await lastMove('GAME_ENTRY', E.id);
  report('a pocket the operator closed to this sink is not even counted as affordable',
    restricted.status === 200 && grantE.status === 201 && paidE.fee === 130 &&
      pocketE.bought === 70 && pocketE.bonus === 130,
    { status: restricted.status, ...pocketE });
  report('and the fee row carries no bonus split', !entryE.meta.promoDiamonds, entryE.meta);
  const noReceipt = await scalar('SELECT count(*)::int AS n FROM promo_grant_spends WHERE transaction_id = $1', [entryE.id]);
  report('no receipt is written for a bonus coin that was not spent', noReceipt === 0, { noReceipt });

  await api('PUT', '/api/admin/business/config/accounts.promotional', { token: T, body: { value: dialBefore.json.value } });
  const dialRestored = await api('GET', '/api/admin/business/config/accounts.promotional', { token: T });
  report('the dial goes back to what the suite found',
    JSON.stringify(dialRestored.json.value) === JSON.stringify(dialBefore.json.value), dialRestored.json.value);

  // ---------------------------------------------------------------- the book
  const reconciliation = await api('GET', '/api/admin/accounts/reconcile', { token: T });
  const promoFindings = ((reconciliation.json && reconciliation.json.findings) || []).filter((f) => f.code.startsWith('promo.'));
  report('the promotional book reconciles against the ledger and the grants',
    reconciliation.status === 200 && promoFindings.length === 0, promoFindings.slice(0, 5));

  const negative = await scalar(
    `SELECT count(*)::int AS n FROM promo_grants WHERE remaining < 0 OR spent < 0 OR lapsed < 0
        OR remaining <> amount - spent - lapsed`,
  );
  report('every grant still adds up', negative === 0, { negative });

  // The suite's own exit: no paid game is left switched on for the other suites or the app.
  const restored = await api('PUT', `/api/admin/games/${GAME}/rules`, { token: T, body: SHIPPED });
  report('the game goes back to free-to-play and switched off',
    restored.status === 200 && restored.json.game.entryFeeEnabled === false && restored.json.game.isActive === false,
    { status: restored.status });

  out.push('');
  out.push(`${out.filter((l) => l.startsWith('PASS')).length}/${out.length - 1} promotional-diamond checks passed`);
  process.stdout.write(out.join('\n') + '\n');
  await db().end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  process.stdout.write(out.join('\n') + '\n');
  console.error('PROMO E2E CRASH', e);
  try {
    await api('PUT', `/api/admin/games/${GAME}/rules`, {
      token: (await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } })).json.token,
      body: SHIPPED,
    });
  } catch {
    /* the rules stay paid; the next run or an operator resets them */
  }
  await db().end().catch(() => {});
  process.exitCode = 1;
});

/** The journal id a refund-driven lapse is keyed on: the spend it reverses, not the grant. */
async function paidCEntryId(entryRow) {
  return entryRow.id;
}
