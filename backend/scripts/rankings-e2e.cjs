/* End-to-end tests for the landing rankings (migration 0045, /api/rankings).
   Drives a *running* backend over HTTP and asserts on database state through the backend's own pg
   pool — no mocks. Fixture transfers use the running product's routes.

     1. boot the stack and the API (README), then build the backend
     2. node scripts/rankings-e2e.cjs

   Development-only: each run creates four synthetic 555 accounts and funds and sends gifts
   through simulated product routes. Only its own backed-up transfer timestamps are moved into
   the settled window. A finally block restores the reward dial and marks all four accounts with
   unique QA references. Evidence and backups stay in D:\vozia-runtime, without phones or tokens. */
const fs = require('fs');
const path = require('path');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const { env } = require(path.join(BE_ROOT, 'dist', 'config', 'env.js'));
if (env.nodeEnv !== 'development' || env.sms.provider !== 'mock' || env.payments.provider !== 'simulated') {
  throw new Error('rankings-e2e requires development, mock SMS and simulated payments');
}
const databaseHost = new URL(env.databaseUrl).hostname;
if (!['localhost', '127.0.0.1', '[::1]'].includes(databaseHost) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(API).hostname)) {
  throw new Error('rankings-e2e requires a local API and database');
}
const evidenceDir = 'D:\\vozia-runtime\\qa-evidence';
const backupDir = 'D:\\vozia-runtime\\backups';

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
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, code: json && json.error && json.error.code };
}

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const qaRef = `QA-RANK-${RUN}`;

/** A member session the same way a client gets one: OTP is mocked in development. */
async function memberByPhone(phone, username) {
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error(`request-otp failed: ${JSON.stringify(challenge.json)}`);
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: challenge.json.devCode, username } });
  if (verified.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verified.json)}`);
  return verified.json.token;
}

const board = (q, token) => api('GET', `/api/rankings?${q}`, { token });

(async () => {
  const login = await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } });
  if (login.status !== 200 || !login.json?.token) throw new Error(`admin login failed: ${JSON.stringify(login.json)}`);
  const T = login.json.token;
  const adminId = (await sql("SELECT id FROM admins WHERE username = 'admin'")).rows[0].id;
  const proofAccounts = [];
  let dialBefore;
  let dialChanged = false;
  const mark = (account) => api('POST', '/api/admin/qa/identities/mark', {
    token: T, body: { ownerKind: 'USER', ownerId: account.id, isTest: true, qaRef: account.qaRef },
  });
  const createMember = async (phone, username, role) => {
    const token = await memberByPhone(phone, username);
    const row = (await sql('SELECT id, username FROM users WHERE username = $1', [username])).rows[0];
    const account = { ...row, token, qaRef: `${qaRef}-${role}` };
    proofAccounts.push(account);
    return account;
  };

  try {
  // --- Window math, straight from the compiled service ----------------------
  const svc = require(path.join(BE_ROOT, 'dist', 'services', 'rankings.service.js'));
  const at = (s) => new Date(s);
  const y = svc.settledWindow('day', at('2026-11-17T12:00:00Z'));
  report('settled day is yesterday UTC', y.key === 'day:2026-11-16' && y.label === 'Yesterday', { key: y.key });
  const lw = svc.settledWindow('week', at('2026-11-17T12:00:00Z'));
  report('settled week is the last completed ISO week', lw.key === 'week:2026-11-09' && lw.label === 'Last week', { key: lw.key });
  const lm = svc.settledWindow('month', at('2026-01-05T12:00:00Z'));
  report('settled month crosses the year boundary', lm.key === 'month:2025-12' && lm.to.toISOString() === '2026-01-01T00:00:00.000Z', { key: lm.key });
  const td = svc.currentWindow('day', at('2026-11-17T12:00:00Z'));
  report('live day is today UTC', td.key === 'day:2026-11-17' && td.label === 'Today', { key: td.key });
  const tw = svc.currentWindow('week', at('2026-11-17T12:00:00Z'));
  report('live week starts on Monday', tw.key === 'week:2026-11-16' && tw.label === 'This week', { key: tw.key });
  const tm = svc.currentWindow('month', at('2026-12-31T23:59:59Z'));
  report('live month ends at the next first-of-month', tm.key === 'month:2026-12' && tm.to.toISOString() === '2027-01-01T00:00:00.000Z', { key: tm.key });

  // --- The public board ------------------------------------------------------
  const live = await board('board=host&period=month');
  report('the live monthly board is public and populated', live.status === 200 && live.json.settled === false && live.json.leaders.length > 3,
    { status: live.status, leaders: live.json?.leaders?.length });
  report('positions are a contiguous 1..n ladder',
    live.json.leaders.every((l, i) => l.position === i + 1));
  report('scores descend and stay positive',
    live.json.leaders.every((l, i) => l.earned > 0 && (i === 0 || live.json.leaders[i - 1].earned >= l.earned)));
  const liveText = JSON.stringify(live.json);
  report('the board payload carries no QA internals', !liveText.includes('qa_ref') && !liveText.includes('is_test') && !liveText.includes('QA-'));
  const badBoard = await board('board=poker&period=day');
  const badPeriod = await board('board=host&period=hour');
  report('unknown boards and periods are refused', badBoard.status === 400 && badPeriod.status === 400,
    { board: badBoard.status, period: badPeriod.status });

  const settled = await board('board=rich&period=week&settled=true');
  report('the settled view names the finished window', settled.status === 200 && settled.json.settled === true && settled.json.window.label === 'Last week',
    { key: settled.json?.window?.key });

  // --- The identities this proof uses ---------------------------------------
  // Fresh synthetic 555 accounts every run: a claim is a one-shot act, so a suite that reuses
  // fixed accounts can only ever pass once.
  const stamp = Date.now().toString().slice(-8);
  const claimerName = `rank_claim_${RUN}`;
  const spareName = `rank_spare_${RUN}`;
  const qaName = `rank_qa_${RUN}`;
  const claimerRow = await createMember(`+1555${stamp}01`, claimerName, 'CLAIM');
  const spareRow = await createMember(`+1555${stamp}02`, spareName, 'SPARE');
  const qaRow = await createMember(`+1555${stamp}03`, qaName, 'QA');
  const receiverRow = await createMember(`+1555${stamp}04`, `rank_receiver_${RUN}`, 'RECEIVER');
  const claimerToken = claimerRow.token;
  const spareToken = spareRow.token;
  const qaToken = qaRow.token;

  // --- Seed a settled-week score through the product's own routes -------------
  // Real gift sends, so the ledger rows carry their journal entries and the reconcilers stay
  // whole; only the timestamps of these suite-owned rows move into the finished window.
  const week = svc.settledWindow('week');
  const topScore = settled.json.leaders[0]?.earned ?? 0;
  const catalogue = await api('GET', '/api/gifts', { token: claimerToken });
  const gift = [...(catalogue.json?.gifts ?? [])]
    .filter((g) => !g.isLuckyBox && (g.minVipLevel ?? 0) === 0)
    .sort((a, b) => a.diamondPrice - b.diamondPrice)[0];
  if (!gift) throw new Error('no spendable gift in the catalogue');
  const batches = Math.ceil((topScore + 2000) / (gift.diamondPrice * 999));
  const fixtureTotal = batches * 999 * gift.diamondPrice;
  const fixtureIds = [];
  for (const [role, token] of [['claim', claimerToken], ['spare', spareToken], ['qa', qaToken]]) {
    const funded = await api('POST', '/api/wallet/recharge', { token, body: { amountDiamonds: fixtureTotal + 1000 } });
    if (funded.status !== 200) throw new Error(`recharge failed for ${role}: ${JSON.stringify(funded.json)}`);
    for (let i = 0; i < batches; i += 1) {
      const sent = await api('POST', '/api/gifts/send', {
        token,
        body: { giftId: gift.id, receiverId: receiverRow.id, quantity: 999, idempotencyKey: `QA-RANK-${RUN}-${role}-${i}` },
      });
      if (sent.status !== 201 || !sent.json?.transaction?.id) throw new Error(`fixture send failed for ${role}: ${JSON.stringify(sent.json)}`);
      fixtureIds.push(sent.json.transaction.id);
    }
  }
  report('the fixture score is paid through the product route', fixtureIds.length === batches * 3, { sends: fixtureIds.length, total: fixtureTotal });
  const fixtureBefore = (await sql('SELECT id, created_at FROM transactions WHERE id = ANY($1::uuid[])', [fixtureIds])).rows;
  fs.writeFileSync(path.join(backupDir, `rankings-fixture-${RUN}.json`), JSON.stringify(fixtureBefore, null, 2));
  await sql('UPDATE transactions SET created_at = $1 WHERE id = ANY($2::uuid[])',
    [new Date(week.from.getTime() + 3_600_000), fixtureIds]);

  const seeded = await board('board=rich&period=week&settled=true');
  const onPodium = seeded.json.leaders.find((l) => l.id === claimerRow.id);
  report('the seeded claimer holds a settled podium place', !!onPodium && onPodium.position <= 3 && onPodium.earned > topScore,
    { position: onPodium?.position, earned: onPodium?.earned, previousTop: topScore });

  // The third account is marked up front: it carries the same fixture score, so the exclusion
  // checks below prove a marked account is kept off a podium it would otherwise share.
  const qaMark = await mark(qaRow);
  if (qaMark.status !== 200) throw new Error(`qa mark failed: ${JSON.stringify(qaMark.json)}`);

  // --- QA exclusion ----------------------------------------------------------
  const qaView = await board('board=rich&period=week&settled=true', qaToken);
  report('a marked account has no standing and no reward', qaView.status === 200 && qaView.json.self === null && qaView.json.reward === null);
  report('a marked account never appears on the board', !qaView.json.leaders.some((l) => l.id === qaRow.id));
  const qaClaim = await api('POST', '/api/rankings/claim', { token: qaToken, body: { board: 'rich', period: 'week' } });
  report('a marked account cannot claim', qaClaim.status === 403 && qaClaim.code === 'qa_excluded', { status: qaClaim.status, code: qaClaim.code });
  const anonClaim = await api('POST', '/api/rankings/claim', { body: { board: 'rich', period: 'week' } });
  report('claiming without a session is refused', anonClaim.status === 401, { status: anonClaim.status });

  // --- The eligible claim ----------------------------------------------------
  const mine = await board('board=rich&period=week&settled=true', claimerToken);
  report('the claimer sees its own place and a claimable reward',
    mine.json.self?.position === onPodium.position && mine.json.reward?.claimable === true && mine.json.reward?.claimed === false,
    { self: mine.json.self, reward: mine.json.reward });
  const spareStanding = await board('board=rich&period=week&settled=true', spareToken);
  const sparePlace = spareStanding.json.leaders.find((l) => l.id === spareRow.id)?.position;
  report('tied scores have the same displayed, self and reward positions',
    mine.json.self?.position === 1 && sparePlace === 2 && spareStanding.json.self?.position === sparePlace &&
    spareStanding.json.reward?.position === sparePlace,
    { claimer: mine.json.self?.position, spare: spareStanding.json.self?.position, displayedSpare: sparePlace });
  const offPodium = await api('POST', '/api/rankings/claim', { token: claimerToken, body: { board: 'host', period: 'day' } });
  report('a window with no place for the caller refuses the claim', offPodium.status === 400 && offPodium.code === 'not_on_podium',
    { status: offPodium.status, code: offPodium.code });

  const face = Number((await sql("SELECT (value->>'minorPerCoin')::int AS f FROM system_config WHERE key = 'accounts.coinValue'")).rows[0]?.f ?? 0);
  dialBefore = (await sql("SELECT value FROM system_config WHERE key = 'rankings.rewards'")).rows[0]?.value;
  const ladder = dialBefore?.rewards ?? [{ position: 1, amount: 500 }, { position: 2, amount: 300 }, { position: 3, amount: 200 }];
  const expectedAmount = ladder.find((r) => r.position === onPodium.position)?.amount;
  const spareExpectedAmount = ladder.find((r) => r.position === sparePlace)?.amount;
  const promoBefore = Number((await sql('SELECT promo_diamond_balance AS b FROM users WHERE id = $1', [claimerRow.id])).rows[0].b);

  const raced = await Promise.all([1, 2].map(() => api('POST', '/api/rankings/claim', {
    token: claimerToken, body: { board: 'rich', period: 'week' },
  })));
  const claimed = raced.find((r) => r.json?.alreadyClaimed === false) ?? raced[0];
  report('simultaneous claims mint once and return the same claim',
    raced.every((r) => r.status === 200 && r.json.claim?.id === claimed.json.claim?.id) &&
    raced.filter((r) => r.json?.alreadyClaimed === false).length === 1 &&
    raced.filter((r) => r.json?.grant != null).length === 1);
  report('the claim pays the configured podium amount', claimed.status === 200 && claimed.json.claim?.amount === expectedAmount && claimed.json.alreadyClaimed === false,
    { status: claimed.status, amount: claimed.json?.claim?.amount, expected: expectedAmount });
  const grant = claimed.json.grant;
  report('the reward is a RANKING promo grant', grant?.sourceKind === 'RANKING' && grant?.amount === expectedAmount && grant?.remaining === expectedAmount,
    { sourceKind: grant?.sourceKind });
  report('the grant reason uses a readable window, not a period key',
    grant?.reason?.includes('Rich board, Last week (') && !grant.reason.includes(week.key), { reason: grant?.reason });
  const promoAfter = Number((await sql('SELECT promo_diamond_balance AS b FROM users WHERE id = $1', [claimerRow.id])).rows[0].b);
  report('the bonus pocket grew by exactly the reward', promoAfter - promoBefore === expectedAmount, { before: promoBefore, after: promoAfter });

  const claimRow = (await sql('SELECT id, grant_id, position, amount FROM ranking_reward_claims WHERE user_id = $1 AND board = $2', [claimerRow.id, 'rich'])).rows[0];
  report('the claim row points at its grant', claimRow?.grant_id === grant?.id && claimRow?.position === onPodium.position);
  const grantRow = (await sql('SELECT source_kind, source_id, remaining FROM promo_grants WHERE id = $1', [grant.id])).rows[0];
  report('the grant is keyed on the claim for idempotency', grantRow?.source_kind === 'RANKING' && grantRow?.source_id === claimRow.id);

  if (face > 0) {
    const entry = (await sql("SELECT id, memo FROM fin_journal_entries WHERE source_kind = 'PROMO_GRANT' AND source_id = $1", [grant.id])).rows[0];
    report('the mint posted one journal entry', !!entry, { entry: entry?.id });
    const lines = (await sql('SELECT account_code, direction, amount_cents FROM fin_journal_lines WHERE entry_id = $1', [entry.id])).rows;
    const debit = lines.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + Number(l.amount_cents), 0);
    const credit = lines.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s + Number(l.amount_cents), 0);
    report('the entry balances at the operator face value', debit === credit && debit === expectedAmount * face,
      { debit, credit, expected: expectedAmount * face });
  } else {
    report('the mint posted one journal entry', false, 'accounts.coinValue.minorPerCoin is not configured');
  }

  // --- Idempotency -----------------------------------------------------------
  const again = await api('POST', '/api/rankings/claim', { token: claimerToken, body: { board: 'rich', period: 'week' } });
  report('a second tap answers with the first claim', again.status === 200 && again.json.alreadyClaimed === true && again.json.grant === null,
    { status: again.status, alreadyClaimed: again.json?.alreadyClaimed });
  const promoReplay = Number((await sql('SELECT promo_diamond_balance AS b FROM users WHERE id = $1', [claimerRow.id])).rows[0].b);
  report('the replay minted nothing', promoReplay === promoAfter, { balance: promoReplay });
  report('exactly one claim row exists', (await scalar('SELECT COUNT(*) AS n FROM ranking_reward_claims WHERE user_id = $1', [claimerRow.id])) === 1);
  const afterView = await board('board=rich&period=week&settled=true', claimerToken);
  report('the reward now reads as claimed', afterView.json.reward?.claimed === true && afterView.json.reward?.claimable === false);
  const liveReward = await board('board=rich&period=week', claimerToken);
  report('the live view still surfaces the settled reward state', liveReward.json.reward?.claimed === true && liveReward.json.window.label === 'This week',
    { reward: liveReward.json.reward, label: liveReward.json?.window?.label });

  // --- The operator dial -----------------------------------------------------
  const configRead = await api('GET', '/api/admin/business/config/rankings.rewards', { token: T });
  report('the operator can read the podium dial', configRead.status === 200, { status: configRead.status });
  fs.writeFileSync(path.join(backupDir, `rankings-dial-${RUN}.json`), JSON.stringify({ value: dialBefore }, null, 2));
  dialChanged = true;
  const gapped = await api('PUT', '/api/admin/business/config/rankings.rewards', {
    token: T, body: { value: { rewards: [{ position: 1, amount: 700 }, { position: 3, amount: 999 }] } },
  });
  report('the dial accepts a write with an audit row', gapped.status === 200 &&
    (await scalar("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'SYSTEM_CONFIG_UPDATE' AND target_id = 'rankings.rewards' AND admin_id = $1", [adminId])) > 0);
  const spareView = await board('board=rich&period=week&settled=true', spareToken);
  report('a hole at position 2 pays only the provable prefix', spareView.json.reward === null, { reward: spareView.json.reward });
  const gappedClaim = await api('POST', '/api/rankings/claim', { token: spareToken, body: { board: 'rich', period: 'week' } });
  report('an omitted second place cannot claim the first-place reward', gappedClaim.status === 400 && gappedClaim.code === 'not_on_podium');
  await api('PUT', '/api/admin/business/config/rankings.rewards', {
    token: T, body: { value: { rewards: [{ position: 1, amount: -5 }, { position: 2, amount: 300 }] } },
  });
  const fallbackView = await board('board=rich&period=week&settled=true', spareToken);
  report('an invalid ladder falls back to the shipped defaults', fallbackView.json.reward?.amount === 300, { reward: fallbackView.json.reward });
  const resetDial = await api('PUT', '/api/admin/business/config/rankings.rewards', { token: T, body: { value: dialBefore } });
  if (resetDial.status !== 200) throw new Error(`reward dial restore failed: ${resetDial.status}`);
  dialChanged = false;
  const restored = await board('board=rich&period=week&settled=true', spareToken);
  report('the dial is restored to its original value', restored.json.reward?.amount === spareExpectedAmount, { reward: restored.json.reward });

  // --- Mark the proof account, keep the mint identifiable --------------------
  const marked = await mark(claimerRow);
  report('the proof account is marked through the product route', marked.status === 200 && marked.json?.isTest === true,
    { status: marked.status, qaRef: claimerRow.qaRef });
  const afterMark = await board('board=rich&period=week&settled=true');
  report('the marked account leaves the public board', !afterMark.json.leaders.some((l) => l.id === claimerRow.id));
  const markedClaim = await api('POST', '/api/rankings/claim', { token: claimerToken, body: { board: 'rich', period: 'week' } });
  report('the marked account can no longer claim', markedClaim.status === 403 && markedClaim.code === 'qa_excluded');
  report('the claim and its grant survive the marking',
    (await scalar('SELECT COUNT(*) AS n FROM ranking_reward_claims WHERE user_id = $1', [claimerRow.id])) === 1 &&
    (await scalar('SELECT COUNT(*) AS n FROM promo_grants WHERE id = $1', [grant.id])) === 1);
  const spareMarked = await mark(spareRow);
  report('the spare proof account is marked through the product route', spareMarked.status === 200 && spareMarked.json?.isTest === true,
    { status: spareMarked.status });
  report('the spare never claimed', (await scalar('SELECT COUNT(*) AS n FROM ranking_reward_claims WHERE user_id = $1', [spareRow.id])) === 0);
  const receiverMarked = await mark(receiverRow);
  report('the receiver is marked through the product route', receiverMarked.status === 200 && receiverMarked.json?.isTest === true);
  const afterBoth = await board('board=rich&period=week&settled=true');
  const afterHost = await board('board=host&period=week&settled=true');
  report('the fixture traffic leaves the public boards',
    !afterBoth.json.leaders.some((l) => [claimerRow.id, spareRow.id, qaRow.id].includes(l.id)) &&
    !afterHost.json.leaders.some((l) => l.id === receiverRow.id));

  // --- Evidence ---------------------------------------------------------------
  const evidence = {
    suite: 'rankings-e2e',
    ranAt: new Date().toISOString(),
    qaRef,
    checks: out.length,
    failed,
    claimer: { id: claimerRow.id, username: claimerName, qaRef: claimerRow.qaRef, markedTest: true },
    spare: { id: spareRow.id, username: spareName, qaRef: spareRow.qaRef, markedTest: true },
    qaExclusion: { id: qaRow.id, username: qaName, qaRef: qaRow.qaRef, markedTest: true },
    receiver: { id: receiverRow.id, username: receiverRow.username, qaRef: receiverRow.qaRef, markedTest: true },
    fixture: { sends: fixtureIds.length, totalPerAccount: fixtureTotal, windowKey: week.key },
    claim: { id: claimRow.id, board: 'rich', periodKey: settled.json.window.key, position: claimRow.position, amount: claimRow.amount, grantId: grant.id },
    results: out,
  };
  return evidence;
  } finally {
    const cleanupErrors = [];
    if (dialChanged) {
      try {
        const reset = await api('PUT', '/api/admin/business/config/rankings.rewards', { token: T, body: { value: dialBefore } });
        if (reset.status !== 200) throw new Error(`reward dial restore failed: ${reset.status}`);
      } catch (e) { cleanupErrors.push(e); }
    }
    for (const account of proofAccounts) {
      try {
        const row = (await sql('SELECT is_test FROM users WHERE id = $1', [account.id])).rows[0];
        if (!row.is_test) {
          const marked = await mark(account);
          if (marked.status !== 200) throw new Error(`QA cleanup failed for ${account.username}: ${marked.status}`);
        }
      } catch (e) { cleanupErrors.push(e); }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'rankings-e2e cleanup failed');
  }
})().then(async (evidence) => {
  const evidencePath = path.join(evidenceDir, `rankings-e2e-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${RUN}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(out.join('\n'));
  console.log(`\n${out.length - failed}/${out.length} checks passed; evidence: ${evidencePath}`);
  await db().end();
  process.exit(failed ? 1 : 0);
}).catch(async (e) => {
  console.error('RANKINGS E2E CRASH', e);
  console.log(out.join('\n'));
  try { await db().end(); } catch {}
  process.exit(1);
});