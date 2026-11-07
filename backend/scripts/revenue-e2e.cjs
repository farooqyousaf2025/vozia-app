/* End-to-end for the coin-spread entries migration 0031 put in the finance book.

   `account-e2e.cjs` proves the purpose-account reads and `gift-e2e.cjs` proves the gift engine's
   behaviour. This suite proves the thing neither of them looks at: that the gap between the coins a
   flow takes and the coins it hands over now appears in `fin_journal_lines`, at the face value the
   operator configured, keyed on the row that produced it.

     1. boot the stack and the API (README), then `npm run build`
     2. node scripts/revenue-e2e.cjs

   The checks worth reading first are the two that bookkeeping lives or dies on: that a gift the
   sender could not afford leaves no entry behind (the header used to be written on a second pool
   connection, so a rolled-back send could strand a line-less entry), and that a lucky box's entry is
   derived from the roll the ledger row records rather than from the box's advertised average.

   Two probe gifts are created and deleted by name, and a throwaway pair of accounts sends from a
   time-stamped phone number, so run it against a development database. */
const path = require('path');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD || 'voiza-admin';
const OTP = process.env.E2E_OTP || '123456';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const out = [];
let failed = 0;
const report = (n, p, d) => {
  if (!p) failed += 1;
  out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? `  :: ${JSON.stringify(d).slice(0, 260)}` : ''}`);
};

let poolPromise = null;
function db() {
  if (!poolPromise) {
    poolPromise = new (require(path.join(BE_ROOT, 'node_modules', 'pg')).Pool)({
      connectionString: require(path.join(BE_ROOT, 'dist', 'config', 'env.js')).env.databaseUrl,
      max: 4,
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
  const json = await res.json().catch(() => null);
  return { status: res.status, json, code: json && json.error && json.error.code };
}

async function memberToken(phone, username) {
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error(`request-otp failed: ${JSON.stringify(challenge.json)}`);
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: OTP, username } });
  if (verified.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verified.json)}`);
  return verified.json.token;
}

async function fund(token, diamonds) {
  const res = await api('POST', '/api/wallet/recharge', { token, body: { amountDiamonds: diamonds } });
  if (res.status !== 200) throw new Error(`recharge failed: ${JSON.stringify(res.json)}`);
}

const revenueBalance = async () =>
  Number((await sql("SELECT balance_minor FROM purpose_account_balances WHERE account_code = 'PLATFORM_REVENUE'")).rows[0]?.balance_minor ?? 0);

/** An entry and its lines, read the way the book keeps them: one header, three directions. */
async function readEntry(sourceKind, sourceId) {
  const rows = await sql(
    `SELECT e.id, e.reference, e.currency, e.source_kind,
            l.account_code, l.direction, l.amount_cents::bigint AS amount
       FROM fin_journal_entries e
       LEFT JOIN fin_journal_lines l ON l.entry_id = e.id
      WHERE e.source_kind = $1 AND e.source_id = $2
      ORDER BY l.direction, l.account_code`,
    [sourceKind, sourceId],
  );
  return rows.rows;
}

/** The three lines of a spread entry, as the amounts a caller has to agree with. */
function legs(lines) {
  const find = (account, direction) => Number(lines.find((l) => l.account_code === account && l.direction === direction)?.amount ?? 0);
  return {
    released: find('COIN_LIABILITY', 'DEBIT'),
    minted: find('COIN_LIABILITY', 'CREDIT'),
    revenue: find('PLATFORM_REVENUE', 'CREDIT'),
    loss: find('PLATFORM_REVENUE', 'DEBIT'),
    directions: lines.filter((l) => l.account_code).map((l) => `${l.account_code}:${l.direction}`).sort(),
  };
}

/**
 * What the book should say about one ledger row: the coins it took, the coins it minted, and the gap
 * between them priced at the configured face value. A positive gap is a revenue credit; a negative one
 * is a revenue debit, because a box that rolled past its pool really did cost the platform.
 */
function expectedLegs(diamonds, rCoins, face) {
  const spread = (diamonds - rCoins) * face;
  return { released: diamonds * face, minted: rCoins * face, revenue: Math.max(spread, 0), loss: Math.max(-spread, 0) };
}

(async () => {
  const admin = await api('POST', '/api/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASS } });
  report('operator sign-in', admin.status === 200 && !!admin.json.token, { status: admin.status });
  const T = admin.json.token;
  if (!T) throw new Error('no admin token; cannot continue');

  // ---------------------------------------------------------------- the dial
  const face = Number(
    (await sql("SELECT (value->>'minorPerCoin')::int AS f FROM system_config WHERE key = 'accounts.coinValue'")).rows[0]?.f ?? 0,
  );
  report('the book has a coin face value to price a spread with', Number.isInteger(face) && face > 0, { face });

  const stamp = String(Date.now());
  const sender = await memberToken(`+1000${stamp.slice(-7)}`, `rvSend${stamp.slice(-7)}`);
  const receiver = await memberToken(`+1001${stamp.slice(-7)}`, `rvRecv${stamp.slice(-7)}`);
  const receiverId = (await api('GET', '/api/auth/me', { token: receiver })).json?.user?.id;
  await fund(sender, 200_000);
  const catalogue = (await api('GET', '/api/gifts')).json.gifts ?? [];
  const even = catalogue.find((g) => g.name === 'Rose');
  const spread = catalogue.find((g) => g.name === 'Teddy');
  report('the catalogue has a 1:1 gift and a taxed one to test against', !!even && !!spread && !!receiverId, {
    rose: even && even.id, teddy: spread && spread.id, receiverId,
  });
  if (!even || !spread || !receiverId) throw new Error('missing fixtures; cannot continue');

  const sendGift = (giftId, quantity, key) =>
    api('POST', '/api/gifts/send', {
      token: sender,
      body: { giftId, receiverId, quantity, ...(key ? { idempotencyKey: key } : {}) },
    });

  // ------------------------------------------------------- a gift that takes a cut
  const beforeSpread = await revenueBalance();
  const teddy = await sendGift(spread.id, 1);
  report('a taxed gift still sends', teddy.status === 201 && !!teddy.json.transaction?.id, { status: teddy.status, code: teddy.code });
  const teddyTx = teddy.json.transaction;
  if (!teddyTx) throw new Error('the taxed gift did not post; cannot continue');
  // The receipt is checked against the catalogue rather than against itself: an entry whose amounts
  // were derived from the same ledger row it describes would prove only that one bug repeated twice.
  report('and the row it wrote is the price the catalogue advertises',
    teddyTx.amountDiamonds === spread.diamondPrice && teddyTx.amountRCoins === spread.rCoinValue,
    { paid: teddyTx.amountDiamonds, banked: teddyTx.amountRCoins, price: spread.diamondPrice, value: spread.rCoinValue });
  const teddyEntry = await readEntry('GIFT_TAX', teddyTx.id);
  const teddyLegs = legs(teddyEntry);
  const wantTeddy = expectedLegs(spread.diamondPrice, spread.rCoinValue, face);
  report(
    'the gift wrote exactly one entry, keyed on the ledger row that paid for it',
    teddyEntry.length === 3 && teddyEntry[0].source_kind === 'GIFT_TAX' && teddyEntry[0].currency === 'pkr',
    { lines: teddyEntry.length, reference: teddyEntry[0]?.reference },
  );
  report(
    'its three lines are the diamonds released, the R-coins minted and the gap booked as revenue',
    teddyLegs.released === wantTeddy.released && teddyLegs.minted === wantTeddy.minted
      && teddyLegs.revenue === wantTeddy.revenue && teddyLegs.loss === 0,
    { got: teddyLegs, want: wantTeddy, face },
  );
  report('the revenue account moved by the spread and nothing else', (await revenueBalance()) - beforeSpread === wantTeddy.revenue, {
    before: beforeSpread, after: await revenueBalance(), want: wantTeddy.revenue,
  });

  // --------------------------------------------------- a gift that takes nothing
  const beforeEven = await revenueBalance();
  const rose = await sendGift(even.id, 4);
  const roseLines = await readEntry('GIFT_TAX', rose.json.transaction?.id ?? 'missing');
  report(
    'an even swap books no entry: its two liability lines would only cancel each other',
    rose.status === 201 && roseLines.length === 0 && roseLines[0]?.id === undefined,
    { status: rose.status, lines: roseLines.length },
  );
  report('and the revenue account does not move', (await revenueBalance()) === beforeEven, {
    before: beforeEven, after: await revenueBalance(),
  });

  // --------------------------------------------- quantity, and a retried request
  const beforeBulk = await revenueBalance();
  const bulkKey = `rev-bulk-${stamp}`;
  const bulk = await sendGift(spread.id, 3, bulkKey);
  const bulkLines = await readEntry('GIFT_TAX', bulk.json.transaction?.id ?? 'missing');
  const bulkLegs = legs(bulkLines);
  const wantBulk = expectedLegs(spread.diamondPrice * 3, spread.rCoinValue * 3, face);
  report('a three-gift tap books one entry for the whole send', bulkLegs.released === wantBulk.released && bulkLegs.revenue === wantBulk.revenue, {
    got: bulkLegs, want: wantBulk, diamonds: bulk.json.transaction.amountDiamonds,
  });
  const replay = await sendGift(spread.id, 3, bulkKey);
  const replayLines = await readEntry('GIFT_TAX', replay.json.transaction?.id ?? 'missing');
  report(
    'a retry of that key answers the same gift and does not book it twice',
    // A replay answers 200, not 201: the gift was created by the first call, so the retry only
    // describes it. What the book has to guarantee is that describing it does not price it again.
    replay.status === 200 && replay.json.replayed === true && replay.json.transaction.id === bulk.json.transaction.id
      && replayLines.length === 3 && (await revenueBalance()) === beforeBulk + wantBulk.revenue,
    { replayed: replay.json.replayed, lines: replayLines.length, moved: (await revenueBalance()) - beforeBulk },
  );

  // ------------------------------------------------------- a send that does not pay
  // The header used to be inserted over the pool while the lines went through the caller's client, so
  // a rollback could strand an entry with nothing in it. Every GIFT_TAX row in the whole book has to
  // name a gift that exists — which is only provable if the writer is atomic.
  const orphans = Number(
    (await sql(
      `SELECT COUNT(*)::int AS n FROM fin_journal_entries e
        WHERE e.source_kind = 'GIFT_TAX'
          AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id::text = e.source_id)`,
    )).rows[0].n,
  );
  await api('POST', '/api/gifts/send', { token: receiver, body: { giftId: spread.id, quantity: 1, receiverId: (await api('GET', '/api/auth/me', { token: sender })).json.user.id } });
  const orphansAfterRefusal = Number(
    (await sql(
      `SELECT COUNT(*)::int AS n FROM fin_journal_entries e
        WHERE e.source_kind = 'GIFT_TAX'
          AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id::text = e.source_id)`,
    )).rows[0].n,
  );
  report('a send that cannot be afforded leaves no entry, orphan header included', orphans === 0 && orphansAfterRefusal === 0, {
    before: orphans, after: orphansAfterRefusal,
  });

  // ------------------------------------------- a gift that pays out more than it took
  const probeName = `Revenue Probe ${stamp}`;
  const probe = await api('POST', '/api/admin/gifts', {
    token: T,
    body: { name: probeName, iconUrl: '/gifts/rose.png', diamondPrice: 10, rCoinValue: 25, sortOrder: 900 },
  });
  report('a probe gift that banks more than it costs can be created', probe.status === 201 && !!probe.json.gift?.id, {
    status: probe.status, code: probe.code,
  });
  const loss = await sendGift(probe.json.gift.id, 2);
  const lossLegs = legs(await readEntry('GIFT_TAX', loss.json.transaction?.id ?? 'missing'));
  const wantLoss = expectedLegs(10 * 2, 25 * 2, face);
  report(
    'the overpayment is booked as a loss, not dropped',
    lossLegs.loss === wantLoss.loss && lossLegs.revenue === 0 && lossLegs.released === wantLoss.released && lossLegs.minted === wantLoss.minted,
    { got: lossLegs, want: wantLoss },
  );

  // ------------------------------------------------------- the box that draws its own
  const boxName = `Revenue Probe Box ${stamp}`;
  const box = await api('POST', '/api/admin/gifts', {
    token: T,
    body: {
      name: boxName, iconUrl: '/gifts/fireworks.png', diamondPrice: 100, rCoinValue: 90, sortOrder: 901,
      isLuckyBox: true, receiverShareBps: 4000,
      boxOutcomes: [
        { label: '0.5x', multiplierBps: 5000, weight: 9000 },
        { label: '20x', multiplierBps: 200000, weight: 1000 },
      ],
    },
  });
  report('a probe box can be created with a tail that overpays', box.status === 201 && !!box.json.gift?.id, {
    status: box.status, code: box.code,
  });
  let boxSigns = [];
  for (let draw = 0; draw < 12; draw += 1) {
    const sent = await sendGift(box.json.gift.id, 1);
    if (sent.status !== 201) {
      report('a box send goes through', false, { status: sent.status, code: sent.code });
      break;
    }
    const tx = sent.json.transaction;
    const entry = await readEntry('GIFT_TAX', tx.id);
    const got = legs(entry);
    const want = expectedLegs(tx.amountDiamonds, tx.amountRCoins, face);
    const matches = got.released === want.released && got.minted === want.minted && got.revenue === want.revenue && got.loss === want.loss;
    // The prize is the point: the entry has to follow the roll in the receipt, because the box's
    // advertised average is a marketing number and this is the one the platform keeps.
    const rolled = sent.json.lucky?.receiverRCoins;
    if (!matches || rolled !== tx.amountRCoins) {
      report('every box roll books the spread that roll actually paid', false, { tx: tx.id, got, want, rolled, banked: tx.amountRCoins });
      break;
    }
    boxSigns.push(want.loss > 0 ? 'DEBIT' : 'CREDIT');
    if (draw === 11) report('twelve box draws each booked one entry that matches their own receipt', true, { signs: boxSigns.join('/') });
  }
  report(
    'a box entry names the roll, and the ledger row is the only source of its numbers',
    boxSigns.length === 12 && boxSigns.every((s) => s === 'CREDIT' || s === 'DEBIT'),
    { draws: boxSigns.length },
  );

  // ------------------------------------------------------- the book and the ledger agree
  const unbookedGifts = Number(
    (await sql(
      `SELECT COUNT(*)::int AS n FROM transactions t
        WHERE t.type = 'GIFT_SENT' AND t.status = 'COMPLETED' AND t.amount_diamonds <> t.amount_r_coins
          AND NOT EXISTS (SELECT 1 FROM fin_journal_entries e WHERE e.source_kind = 'GIFT_TAX' AND e.source_id = t.id::text)`,
    )).rows[0].n,
  );
  const unbookedGames = Number(
    (await sql(
      `SELECT COUNT(*)::int AS n FROM game_settlements gs
        WHERE gs.status = 'SETTLED' AND gs.gross_pool <> gs.distributed
          AND NOT EXISTS (SELECT 1 FROM fin_journal_entries e WHERE e.source_kind = 'GAME_TAKE' AND e.source_id = gs.session_id::text)`,
    )).rows[0].n,
  );
  report('every spread the ledger shows has an entry, gifts and games both', unbookedGifts === 0 && unbookedGames === 0, {
    unbookedGifts, unbookedGames,
  });
  const bookedCoins = Number(
    (await sql(
      `SELECT COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'CREDIT'), 0)
               - COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'DEBIT'), 0) AS n
         FROM fin_journal_entries e JOIN fin_journal_lines l ON l.entry_id = e.id
        WHERE e.source_kind IN ('GIFT_TAX','GAME_TAKE') AND l.account_code = 'PLATFORM_REVENUE'`,
    )).rows[0].n,
  );
  const ledgerCoins = Number(
    (await sql(
      `SELECT (COALESCE((SELECT SUM(amount_diamonds - amount_r_coins) FROM transactions
                          WHERE type = 'GIFT_SENT' AND status = 'COMPLETED'), 0)
              + COALESCE((SELECT SUM(gross_pool - distributed) FROM game_settlements WHERE status = 'SETTLED'), 0)) * $1 AS n`,
      [face],
    )).rows[0].n,
  );
  report('and the revenue the book holds is the ledger total at the configured face value', bookedCoins === ledgerCoins, {
    bookedCoins, ledgerCoins, face,
  });

  const rec = await api('GET', '/api/admin/accounts/reconcile', { token: T });
  const revenue = (rec.json.findings ?? []).filter((f) => f.code === 'platform_revenue_not_booked');
  report('the reconciler has nothing to say about unbilled revenue', rec.status === 200 && revenue.length === 0, {
    status: rec.status, findings: revenue.map((f) => f.detail),
  });

  const trial = (await sql(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'DEBIT'), 0) AS d,
            COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'CREDIT'), 0) AS c FROM fin_journal_lines`,
  )).rows[0];
  report('the whole book still balances', Number(trial.d) === Number(trial.c), { debits: trial.d, credits: trial.c });

  // The read surface #56 shipped: an account statement a human can hand to an auditor has to contain
  // the entries the new writers made, not only the recharges that were always there.
  const statement = await api('GET', '/api/admin/accounts/PLATFORM_REVENUE/movements?limit=200', { token: T });
  const rows = statement.json?.movements ?? [];
  report(
    'the revenue account statement carries the gift entries',
    statement.status === 200 && rows.some((m) => m.reference === teddyEntry[0]?.reference),
    { status: statement.status, movements: rows.length, want: teddyEntry[0]?.reference },
  );

  // ------------------------------------------------------------------ cleanup
  const removed = await api('DELETE', `/api/admin/gifts/${probe.json.gift.id}`, { token: T });
  const removedBox = await api('DELETE', `/api/admin/gifts/${box.json.gift.id}`, { token: T });
  report('both probe gifts are removed from the catalogue again', removed.status === 200 && removedBox.status === 200, {
    probe: removed.status, box: removedBox.status,
  });
  const probesLeft = Number(
    (await sql("SELECT COUNT(*)::int AS n FROM gifts WHERE name LIKE 'Revenue Probe%'")).rows[0].n,
  );
  report('and no probe row survives the run', probesLeft === 0, { probesLeft });

  out.push('');
  out.push(`${out.filter((l) => l.startsWith('PASS')).length}/${out.length - 1} coin-spread checks passed`);
  process.stdout.write(out.join('\n') + '\n');
  await db().end();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  process.stdout.write(out.join('\n') + '\n');
  console.error('REVENUE E2E CRASH', e?.stack ?? e);
  process.exitCode = 1;
});
