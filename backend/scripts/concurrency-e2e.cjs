/* Concurrency, duplicate-request and whole-book reconciliation (spec section 10).
   Drives a *running* backend over HTTP with parallel requests and asserts on database state
   through the backend's own pg pool — no mocks.

     1. boot the stack and the API (README), then `npm run build`
     2. node scripts/concurrency-e2e.cjs   (npm run test:concurrency)

   The other suites prove a money path does the right thing one request at a time. This one asks
   the question a phone always ends up asking: what happens when the same tap arrives twice, or
   twice at once, or six times at once against a balance that affords three.

   Everything here is a *parallel* fan-out over HTTP, so the serialisation being tested is the
   database's — `SELECT ... FOR UPDATE` on the account rows, the `gift_requests` claim that lands
   before those locks, the unique key on `payment_proofs`, and the CHECK clauses that make a
   negative balance a rejected statement rather than a bad report. A unit test cannot see any of
   that; only a live server with two connections at the same instant can.

   It leaves the database consistent rather than pristine: the throws-away accounts keep their
   ledger rows, because a money path's history is the evidence the reconciler reads. Every hold is
   released and every open withdrawal rejected before it finishes, so no escrow stays stuck on an
   account nobody owns. */
const path = require('path');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const out = [];
let failed = 0;
const check = (n, p, d) => {
  if (!p) failed += 1;
  out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? `  :: ${JSON.stringify(d).slice(0, 260)}` : ''}`);
};

let poolPromise = null;
function db() {
  if (!poolPromise) {
    poolPromise = new (require(path.join(BE_ROOT, 'node_modules', 'pg')).Pool)({
      connectionString: require(path.join(BE_ROOT, 'dist', 'config', 'env.js')).env.databaseUrl,
      max: 8,
    });
  }
  return poolPromise;
}

const sql = async (q, p) => (await db()).query(q, p);
const scalar = async (q, p) => {
  const r = await sql(q, p);
  return r.rows[0] ? Object.values(r.rows[0])[0] : null;
};

async function api(method, route, { token, body } = {}) {
  const res = await fetch(API + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return {
    status: res.status,
    json,
    // Errors are `{ error: { code, message } }`; a top-level `code` is always undefined, which is
    // how a check written against it would pass for the wrong reason.
    code: json && json.error && json.error.code,
  };
}

/** The same call fired N times, all in flight at once. */
const fanOut = (n, make) => Promise.all(Array.from({ length: n }, () => make()));

/** A member session, the only way this stack issues one: OTP is mocked in development. */
async function member(phone, username) {
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error(`request-otp failed: ${JSON.stringify(challenge.json)}`);
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: '123456', username } });
  if (verified.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verified.json)}`);
  return { token: verified.json.token, id: verified.json.user.id };
}

/** One account's whole statement, page by page — the identity has to hold over the book, not a page. */
async function fullStatement(token, code) {
  const rows = [];
  let page = 1;
  for (;;) {
    const res = await api('GET', `/api/admin/accounts/${encodeURIComponent(code)}/movements?page=${page}&limit=200`, { token });
    if (res.status !== 200) throw new Error(`statement ${code} page ${page} -> ${res.status} ${res.code || ''}`);
    rows.push(...res.json.movements);
    if (rows.length >= res.json.total || res.json.movements.length === 0) return rows;
    page += 1;
  }
}

async function identity(token, code) {
  const detail = await api('GET', `/api/admin/accounts/${encodeURIComponent(code)}`, { token });
  if (detail.status !== 200) return { ok: false, reason: `detail ${detail.status}` };
  const a = detail.json.account;
  const rows = await fullStatement(token, code);
  const inSum = rows.filter((m) => m.direction === 'IN').reduce((s, m) => s + m.amount, 0);
  const outSum = rows.filter((m) => m.direction === 'OUT').reduce((s, m) => s + m.amount, 0);
  return { ok: a.opening + inSum - outSum === a.balance, account: a, inSum, outSum };
}

const codes = (res) => res.map((r) => `${r.status}${r.code ? `/${r.code}` : ''}`);

(async () => {
  const stamp = Date.now().toString().slice(-7);

  // ---------------------------------------------------------------- setup ----
  const admin = await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } });
  check('operator sign-in', admin.status === 200 && !!admin.json.token, { status: admin.status });
  const T = admin.json.token;

  const sender = await member(`+15558${stamp}01`, `cc_sender_${stamp.slice(-4)}`);
  const host = await member(`+15558${stamp}02`, `cc_host_${stamp.slice(-4)}`);
  const senderId = sender.id;
  const hostId = host.id;

  // A gift with a spread, so the tax leg is exercised too; the cheapest one that is not 1:1 keeps the
  // grant small enough that the affordability arithmetic stays readable.
  const catalogue = await api('GET', '/api/gifts', {});
  const gifts = (catalogue.json && (catalogue.json.gifts || catalogue.json.data)) || [];
  const gift = gifts.filter((g) => g.diamondPrice > 0 && g.rCoinValue !== g.diamondPrice)
    .sort((a, b) => a.diamondPrice - b.diamondPrice)[0] || gifts[0];
  const price = gift.diamondPrice;
  check(`setup: a spread-bearing gift was picked (${gift.name} at ${price} diamonds)`,
    !!gift && price > 0 && price * 6 <= 1_000_000, { name: gift.name, price, value: gift.rCoinValue });

  const grant = (userId, diamonds, rCoins, note) => api('POST', `/api/admin/users/${userId}/balance`, {
    token: T, body: { diamondDelta: diamonds, rCoinDelta: rCoins, note },
  });
  const balanceOf = async (userId) => ({
    d: Number(await scalar('select diamond_balance from users where id=$1', [userId])),
    r: Number(await scalar('select r_coin_balance from users where id=$1', [userId])),
  });

  // ---- A. six sends race a balance that affords exactly three --------------
  // The failure this rules out is the expensive one: two requests each read "30 diamonds left",
  // each decide it can pay, and the account ends at -30 or the receiver is paid for a gift that was
  // never afforded. `sendGift` locks both accounts in a stable order, so exactly three may win.
  const afforded = await grant(senderId, price * 3, 0, `concurrency-e2e-${stamp} fund three`);
  check('grant: an operator credit landed before the race', afforded.status === 200, { status: afforded.status });
  const beforeA = await balanceOf(senderId);

  const sent = await fanOut(6, () => api('POST', '/api/gifts/send', {
    token: sender.token,
    body: { giftId: gift.id, receiverId: hostId, quantity: 1, idempotencyKey: `cc-a-${stamp}-${Math.floor(Math.random() * 1e6)}` },
  }));
  const okA = sent.filter((r) => r.status === 201);
  const refusedA = sent.filter((r) => r.status >= 400);

  check('concurrent gifts: a balance that affords three admits exactly three',
    okA.length === 3 && refusedA.length === 3, { ok: okA.length, refused: codes(sent) });
  // The losers must be refused on the balance. A `retry` (PostgreSQL's 40P01) is a loss the server
  // chose for them: the row locks were taken in opposite orders and one transaction was killed to
  // free the other, which is exactly what the one-`FOR UPDATE`-per-account shape in `sendGift`
  // exists to prevent. A 500 is the same event before the error mapper got to it.
  check('concurrent gifts: the losers are told the balance is short, not that the server broke',
    refusedA.every((r) => r.status === 402) && !sent.some((r) => r.status >= 500 || r.code === 'retry'),
    codes(sent));

  const afterA = await balanceOf(senderId);
  check('concurrent gifts: the wallet spent three prices and no more',
    afterA.d === beforeA.d - price * 3 && afterA.d >= 0, { before: beforeA.d, after: afterA.d, price });
  const rowsA = Number(await scalar(
    `select count(*) from transactions where type='GIFT_SENT' and sender_id=$1 and created_at > now() - interval '2 minutes'`,
    [senderId],
  ));
  check('concurrent gifts: the ledger holds one row per gift that actually paid', rowsA === 3, { rows: rowsA });
  const hostAfter = await balanceOf(hostId);
  check('concurrent gifts: the receiver was paid for three, not six',
    hostAfter.r === gift.rCoinValue * 3, { rCoins: hostAfter.r, each: gift.rCoinValue });

  // The tax leg is per successful send, keyed on the transaction: six sends must not become six
  // entries, and three wins must not silently drop their spread out of the book.
  const taxed = gift.diamondPrice > gift.rCoinValue;
  const taxEntries = Number(await scalar(
    `select count(*) from fin_journal_entries e
      where e.source_kind='GIFT_TAX' and e.source_id in
        (select t.id::text from transactions t where t.type='GIFT_SENT' and t.sender_id=$1
           and t.created_at > now() - interval '2 minutes')`,
    [senderId],
  ));
  check(`concurrent gifts: the spread is booked once per paid gift${taxed ? '' : ' (this gift has none)'}`,
    taxEntries === (taxed ? 3 : 0), { entries: taxEntries, expected: taxed ? 3 : 0 });

  // ---- B. one idempotency key, six arms ------------------------------------
  // This is the race the `gift_requests` claim exists for: a phone that never saw the response taps
  // again, and the retry is in flight while the original is still committing. The claim is inserted
  // *before* the account locks, so the second arrives either as a replay of a committed gift or as
  // `gift_request_in_flight`; what it must never arrive as is a second debit.
  const keyB = `cc.b.${stamp}.once`;
  await grant(senderId, price * 10, 0, `concurrency-e2e-${stamp} fund the replay race`);
  const beforeB = await balanceOf(senderId);
  const rowsBeforeB = Number(await scalar(`select count(*) from transactions where type='GIFT_SENT' and sender_id=$1`, [senderId]));

  const replay = await fanOut(6, () => api('POST', '/api/gifts/send', {
    token: sender.token,
    body: { giftId: gift.id, receiverId: hostId, quantity: 1, idempotencyKey: keyB },
  }));
  const winnersB = replay.filter((r) => r.status === 201);
  const inFlightB = replay.filter((r) => r.code === 'gift_request_in_flight');

  check('one key, six arms: exactly one request paid', winnersB.length === 1, { status: codes(replay) });
  check('one key, six arms: a request that could not be answered as a replay is refused, never charged',
    inFlightB.every((r) => r.status === 409) && !replay.some((r) => r.status >= 500),
    { inFlight: inFlightB.length, codes: codes(replay) });
  const afterB = await balanceOf(senderId);
  const rowsAfterB = Number(await scalar(`select count(*) from transactions where type='GIFT_SENT' and sender_id=$1`, [senderId]));
  check('one key, six arms: one price left the wallet and one ledger row exists',
    afterB.d === beforeB.d - price && rowsAfterB === rowsBeforeB + 1,
    { spent: beforeB.d - afterB.d, rows: rowsAfterB - rowsBeforeB });
  check('one key, six arms: the key was claimed exactly once in the request table',
    Number(await scalar('select count(*) from gift_requests where sender_id=$1 and idempotency_key=$2', [senderId, keyB])) === 1,
    { key: keyB });

  // A sequential retry after the commit is the ordinary case, and it must answer the original
  // receipt rather than a fresh charge.
  const sequential = await api('POST', '/api/gifts/send', {
    token: sender.token,
    body: { giftId: gift.id, receiverId: hostId, quantity: 1, idempotencyKey: keyB },
  });
  const wrongBody = await api('POST', '/api/gifts/send', {
    token: sender.token,
    body: { giftId: gifts.find((g) => g.id !== gift.id).id, receiverId: hostId, quantity: 1, idempotencyKey: keyB },
  });
  check('a retry after the commit replays the original gift',
    (sequential.status === 201 || sequential.status === 200)
      && sequential.json.transaction && sequential.json.transaction.id === winnersB[0].json.transaction.id
      && (await balanceOf(senderId)).d === afterB.d,
    { status: sequential.status, sameRow: !!(sequential.json.transaction && winnersB[0].json.transaction)
      && sequential.json.transaction.id === winnersB[0].json.transaction.id });
  check('the same key with a different body is refused rather than replayed',
    wrongBody.status === 409 && wrongBody.code === 'idempotency_key_reused', { status: wrongBody.status, code: wrongBody.code });

  // ---- C. five withdrawals against a balance that escrows two --------------
  // Escrow leaves the wallet when the host *asks*, so the invariant is not "no balance goes
  // negative" alone — it is that the open requests can never add up to more than the wallet held.
  const R_WITHDRAW = 200_000;
  await grant(hostId, 0, R_WITHDRAW * 2 + 100_000, `concurrency-e2e-${stamp} fund three cash-outs`);
  const beforeC = await balanceOf(hostId);
  const wd = await fanOut(5, () => api('POST', '/api/wallet/withdraw', {
    token: host.token,
    body: {
      amountRCoins: R_WITHDRAW,
      payoutMethod: 'BANK',
      payoutDetails: { account: `CC-ACCT-${stamp}`, holder: 'Concurrency E2E', currency: 'USD' },
    },
  }));
  const okC = wd.filter((r) => r.status === 201);
  const afterC = await balanceOf(hostId);
  // The refusal is a 400 `insufficient_earnings`, not a 402: R-coins are earned, not bought, so
  // there is nothing to top up and the money path has no "insufficient balance" shape for them.
  check('concurrent withdrawals: a balance that escrows two admits exactly two',
    okC.length === 2 && wd.filter((r) => r.status === 400 && r.code === 'insufficient_earnings').length === 3,
    { ok: okC.length, codes: codes(wd) });
  check('concurrent withdrawals: the wallet gave up the gross of two and nothing else',
    afterC.r === beforeC.r - R_WITHDRAW * 2 && afterC.r >= 0, { before: beforeC.r, after: afterC.r });

  const escrow = Number(await scalar(
    `select coalesce(sum(amount_r_coins),0) from withdrawal_requests
      where user_id=$1 and status in ('PENDING','APPROVED')`,
    [hostId],
  ));
  const pending = Number(await scalar(
    `select coalesce(sum(amount_r_coins),0) from withdrawal_requests where user_id=$1`,
    [hostId],
  ));
  check('concurrent withdrawals: open escrow equals what left the wallet', escrow === R_WITHDRAW * 2, {
    escrow, left: beforeC.r - afterC.r, allRequests: pending,
  });
  const hostAccount = await identity(T, `HOST_RCOIN:${hostId}`);
  check('concurrent withdrawals: the host account still reconstructs from its entries',
    hostAccount.ok === true && Number(hostAccount.account.pending) === escrow,
    { balance: hostAccount.account && hostAccount.account.balance, pending: hostAccount.account && hostAccount.account.pending });

  // ---- D. two operators pay the same withdrawal at once -------------------
  // The queue's second gate: a row lock plus the state machine must let exactly one payout through,
  // because a double PAID is a double payment on rails this stack cannot see.
  const withdrawalId = okC[0].json.withdrawal.id;
  const approved = await api('POST', `/api/admin/withdrawals/${withdrawalId}/review`, {
    token: T, body: { approve: true, note: `concurrency-e2e-${stamp}` },
  });
  check('a withdrawal can be approved before it is raced', approved.status === 200, { status: approved.status });

  const paid = await fanOut(4, (i) => api('POST', `/api/admin/withdrawals/${withdrawalId}/pay`, {
    token: T, body: { payoutReference: `CC-PAY-${stamp}-${i}` },
  }));
  const paidOk = paid.filter((r) => r.status === 200);
  check('four parallel payouts: only one is booked', paidOk.length === 1, { ok: paidOk.length, codes: codes(paid) });
  check('four parallel payouts: the losers are refused on state, not swallowed',
    paid.filter((r) => r.status >= 400).every((r) => r.status === 409) && !paid.some((r) => r.status >= 500),
    codes(paid));
  const paidRow = await sql('select status, payout_reference, paid_at from withdrawal_requests where id=$1', [withdrawalId]);
  // `withdrawal_requests` has no column back to the ledger; the request's id travels inside the
  // transaction's `meta`, which is also how the reconciler joins the two.
  const ledgerCompleted = Number(await scalar(
    `select count(*) from transactions where type='WITHDRAWAL' and meta->>'withdrawalId' = $1 and status='COMPLETED'`,
    [withdrawalId],
  ));
  check('four parallel payouts: the row is PAID once, with one reference and one completed ledger row',
    paidRow.rows.length === 1 && paidRow.rows[0].status === 'PAID' && !!paidRow.rows[0].payout_reference
      && !!paidRow.rows[0].paid_at && ledgerCompleted === 1,
    { status: paidRow.rows[0] && paidRow.rows[0].status, ledgerCompleted });
  check('four parallel payouts: a zero-fee withdrawal books no fee entry',
    Number(await scalar(`select count(*) from fin_journal_entries where source_kind='WITHDRAWAL_FEE' and source_id=$1`, [withdrawalId])) === 0,
    { feeBps: await scalar(`select value->>'feeBps' from system_config where key='accounts.withdrawal'`) });

  // ---- E. the same hold key, six operators pressing it --------------------
  // Holds are the book's own write, and their claim is the same shape as the gift one: a key may
  // produce one hold, and a retry must answer it rather than freeze the money twice.
  const diamondAccount = `USER_DIAMOND:${senderId}`;
  const holdKey = `cc-hold-${stamp}`;
  const holdReason = `concurrency-e2e-${stamp}`;
  // A person's purpose accounts open on the first read of them, not at signup — that is what
  // `ensureUserAccounts` documents — and `createHold` refuses a code with no `fin_accounts` row. So
  // the account is read once, exactly as an operator's screen reads it, before anything is frozen.
  const opened = await api('GET', `/api/admin/accounts/${encodeURIComponent(diamondAccount)}`, { token: T });
  check('setup: the sender\'s diamond account is open before it is frozen',
    opened.status === 200, { status: opened.status, code: opened.code });
  const holds = await fanOut(6, () => api('POST', `/api/admin/accounts/${encodeURIComponent(diamondAccount)}/holds`, {
    token: T,
    body: { kind: 'FROZEN', amount: 4, reason: holdReason, idempotencyKey: holdKey },
  }));
  const holdRows = Number(await scalar('select count(*) from account_holds where reason=$1', [holdReason]));
  const holdIds = [...new Set(holds.filter((r) => r.json && r.json.hold).map((r) => r.json.hold.id))];
  check('one hold key, six arms: one hold exists and every answer names it',
    holdRows === 1 && holdIds.length === 1 && holds.every((r) => r.status === 201 || r.status === 200 || r.status === 409)
      && !holds.some((r) => r.status >= 500),
    { rows: holdRows, ids: holdIds.length, codes: codes(holds) });

  // ---- F. nothing anywhere went negative, and the schema says so ----------
  const negatives = await sql(
    `select count(*)::int as n from users where diamond_balance < 0 or r_coin_balance < 0`,
  );
  const guardRows = await sql(
    `select conname from pg_constraint
      where conrelid = 'users'::regclass and contype = 'c'
        and conname in ('users_diamond_balance_check', 'users_r_coin_balance_check')`,
  );
  check('no account anywhere holds a negative balance', negatives.rows[0].n === 0, { negative: negatives.rows[0].n });
  check('the two CHECK clauses that make that impossible are still on the table',
    guardRows.rows.length === 2, { present: guardRows.rows.map((r) => r.conname) });

  // A wallet is only trustworthy if its balance is the sum of its own rows. The sums are read from
  // `coin_movements` rather than hand-filtered from `transactions`, because that view is where the
  // awkward legs are already resolved once — GIFT_SENT's cross-leg, ADMIN_ADJUSTMENT's signed meta,
  // AGENCY_COMMISSION's notional zero — so this check tests the same rules the projection uses
  // instead of inventing a second set that could pass while the book is wrong.
  const flows = async (userId, unit) => Number(await scalar(
    `select coalesce(sum(case when direction = 'IN' then amount_minor else -amount_minor end), 0)
       from coin_movements where owner_id = $1 and unit = $2 and status = 'COMPLETED'`,
    [userId, unit],
  ));
  // A PENDING or APPROVED withdrawal has already left `r_coin_balance` as escrow while its ledger
  // row is not yet COMPLETED, so it is subtracted here the same way `purpose_account_balances`
  // reports it as `pending`. If escrow and wallet ever drift, this is the line that says so.
  const escrowedR = Number(await scalar(
    `select coalesce(sum(amount_r_coins), 0) from withdrawal_requests
      where user_id = $1 and status in ('PENDING','APPROVED')`,
    [hostId],
  ));
  const finalS = await balanceOf(senderId);
  const finalH = await balanceOf(hostId);
  const flowsS = await flows(senderId, 'dmn');
  const flowsH = await flows(hostId, 'rcn');
  check('the sender\'s wallet is exactly its completed diamond flows',
    finalS.d === flowsS, { balance: finalS.d, ledgerFlows: flowsS });
  check('the host\'s wallet is its completed R-coin flows minus the escrow still held',
    finalH.r === flowsH - escrowedR, { balance: finalH.r, ledgerFlows: flowsH, escrowedR });

  // ---- G. the reconciler, over the whole book -----------------------------
  const recon = await api('GET', '/api/admin/accounts/reconcile', { token: T });
  const findings = (recon.json && recon.json.findings) || [];
  const bySeverity = findings.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }), {});
  check('the account book reconciles after every race above',
    recon.status === 200 && findings.filter((f) => f.severity === 'ERROR').length === 0,
    { findings: findings.length, bySeverity });

  const tieouts = await api('GET', '/api/admin/business/finance/reconciliation', { token: T });
  check('every tie-out in the finance report passes over the same database',
    tieouts.status === 200 && tieouts.json.breached === 0,
    { checks: tieouts.json.checks && tieouts.json.checks.length, breached: tieouts.json.breached });

  const unbalanced = await scalar(
    `select count(*) from (
       select e.id, sum(l.amount_cents) filter (where l.direction='DEBIT') d,
              sum(l.amount_cents) filter (where l.direction='CREDIT') c
         from fin_journal_entries e join fin_journal_lines l on l.entry_id = e.id
        group by e.id having sum(l.amount_cents) filter (where l.direction='DEBIT')
                        <> sum(l.amount_cents) filter (where l.direction='CREDIT')) x`,
  );
  check('not one journal entry in the book is unbalanced', Number(unbalanced) === 0, { unbalanced });

  const diamondAcct = await identity(T, diamondAccount);
  check('the account that was raced still reconstructs from opening plus entries',
    diamondAcct.ok === true, { balance: diamondAcct.account && diamondAcct.account.balance });

  // ---- cleanup: leave no escrow and no freeze behind ----------------------
  // Matched by the names this suite gives its own throwaway accounts, not by this run's ids: a run
  // that dies part-way through its checks never reaches this line, and its escrows and holds would
  // otherwise sit open in the development book forever — five stranded holds were there when this
  // was written. The prefixes belong to this file, so no other suite's fixtures are touched.
  const testWithdrawals = `select w.id from withdrawal_requests w join users u on u.id = w.user_id
     where u.username like 'cc\\_%' and w.status in ('PENDING','APPROVED')`;
  for (const row of (await sql(testWithdrawals)).rows) {
    await api('POST', `/api/admin/withdrawals/${row.id}/review`, {
      token: T, body: { approve: false, note: `concurrency-e2e-${stamp}: test escrow released` },
    });
  }
  const stillOpen = Number(await scalar(
    `select count(*) from withdrawal_requests w join users u on u.id = w.user_id
      where u.username like 'cc\\_%' and w.status in ('PENDING','APPROVED')`,
  ));
  const stuckHolds = await sql(
    `select id from account_holds where reason like 'concurrency-e2e-%' and status = 'OPEN'`,
  );
  let holdRelease = { status: 200, left: 0 };
  for (const row of stuckHolds.rows) {
    const released = await api('POST', `/api/admin/holds/${row.id}/release`, {
      token: T, body: { idempotencyKey: `cc-unhold-${stamp}-${row.id}` },
    });
    holdRelease = { status: released.status, left: released.status === 200 ? holdRelease.left : holdRelease.left + 1 };
  }
  check('cleanup: no test escrow stays open and no test hold stays frozen',
    stillOpen === 0 && holdRelease.status === 200 && holdRelease.left === 0, {
      stillOpen, heldBack: holdRelease.left,
      rCoins: (await balanceOf(hostId)).r, funded: beforeC.r,
    });

  process.stdout.write(`${out.join('\n')}\n`);
  process.stdout.write(`\n${out.length - failed}/${out.length} checks passed\n`);
  await db().end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  process.stdout.write(`${out.join('\n')}\n`);
  console.error('\nconcurrency-e2e crashed:', e && e.stack ? e.stack : e);
  try { await db().end(); } catch { /* pool never opened, or already closed */ }
  process.exit(2);
});
