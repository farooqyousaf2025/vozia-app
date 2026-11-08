/* End-to-end tests for the earning routes (migration 0038, README "Earning rules").
   Drives a *running* backend over HTTP — the member board, the claim, the operator controls — and
   reads the wallets back through the backend's own pg pool. No mocks, no fixtures.

     1. boot the stack and the API (README), then `npm run build`
     2. node scripts/earning-routes-e2e.cjs

   The engine's own behaviour is tested by `earning-e2e.cjs`, which calls the services directly. This
   file exists for what only the wire can prove:

     * who is allowed to ask. A reward rule decides what the platform will hand out, so publishing one
       holds `config:manage`, and approving a claim — a mint — holds `user:wallet`. Both are tested
       from a real operator of each role, not from a role name in a config file.
     * what a member can send. Nothing on `/api/earnings` carries a price, a target or a progress
       value, and the two routes that could (`claim` with an unknown rule, a claim against a
       server-counted rule) are refused with the engine's own code.
     * that a retry costs nothing. A claim sent twice with one idempotency key returns the first
       answer and files one attempt, because a phone that loses the response is the common case.

   Runs against a development database only. Everything it publishes is retired, its campaign closed,
   and the two temporary operators disabled before it exits. */
const path = require('path');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

let failed = 0;
function report(name, pass, detail) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
}
function section(title) {
  console.log(`\n--- ${title} ---`);
}

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

/** A member session, the only way this stack issues one: OTP is mocked in development. */
async function member(phone) {
  const username = `er${phone.slice(-8)}`;
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error(`request-otp failed: ${JSON.stringify(challenge.json)}`);
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: '123456', username } });
  if (verified.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verified.json)}`);
  const row = (await sql('SELECT id FROM users WHERE phone = $1', [phone])).rows[0];
  if (!row) throw new Error(`no account behind ${phone}`);
  return { token: verified.json.token, id: row.id, phone };
}

/** A temporary operator, so the permission matrix is tested from the roles the product actually has. */
async function operator(superToken, username, password, role) {
  const created = await api('POST', '/api/admin/operators', { token: superToken, body: { username, password, role } });
  if (created.status !== 201) throw new Error(`operator create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const signedIn = await api('POST', '/api/admin/login', { body: { username, password } });
  if (signedIn.status !== 200) throw new Error(`operator login failed: ${signedIn.status}`);
  return { token: signedIn.json.token, id: created.json.operator.id, username };
}

(async () => {
  const stamp = Date.now().toString().slice(-6);
  const K = (name) => `rt${stamp}-${name}`;

  const login = await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } });
  report('operator sign-in', login.status === 200 && !!login.json.token, { status: login.status });
  const SUPER = login.json.token;

  // ---------------------------------------------------------------------------
  section('the catalogue the panel builds its forms from');
  // ---------------------------------------------------------------------------

  const cat = await api('GET', '/api/admin/earning/catalogue', { token: SUPER });
  const submission = (cat.json?.metrics ?? []).find((m) => m.metric === 'SUBMISSION');
  report('every metric arrives with who counts it and what it can be conditioned on',
    cat.status === 200 && cat.json.metrics.length === 10
      && cat.json.metrics.every((m) => m.countedBy && m.progress && m.restrictions),
    { status: cat.status, metrics: cat.json?.metrics?.length });
  report('the member-asserted metric is the only one a claim can use',
    submission && submission.countedBy === 'MEMBER'
      && cat.json.metrics.filter((m) => m.countedBy === 'MEMBER').length === 1, submission);
  report('the enums the form needs are the server enums',
    cat.json.purposes.length === 5 && cat.json.resets.join() === 'DAY,WEEK,MONTH,NEVER'
      && cat.json.currencies.join() === 'XP,BONUS_DIAMOND',
    { purposes: cat.json.purposes, resets: cat.json.resets, currencies: cat.json.currencies });

  // ---------------------------------------------------------------------------
  section('campaigns and rules over HTTP');
  // ---------------------------------------------------------------------------

  const deck = await api('POST', '/api/admin/earning/campaigns', {
    token: SUPER,
    body: { key: K('deck'), title: 'Routes deck', status: 'LIVE', budgetDiamonds: 50 },
  });
  report('a live campaign is created and reads back with its spend',
    deck.status === 201 && deck.json.campaign.status === 'LIVE' && deck.json.campaign.budgetDiamonds === 50,
    { status: deck.status, code: deck.code });
  const readDeck = await api('GET', `/api/admin/earning/campaigns/${K('deck')}`, { token: SUPER });
  report('a campaign is readable by key', readDeck.status === 200 && readDeck.json.campaign.key === K('deck'), {
    spent: readDeck.json?.campaign?.spentDiamonds, rules: readDeck.json?.campaign?.ruleCount,
  });

  const badKey = await api('POST', '/api/admin/earning/campaigns', { token: SUPER, body: { key: 'Not A Key', title: 'x' } });
  report('a campaign key is refused on the wire with the engine code',
    badKey.status === 400 && badKey.code === 'earning_key_invalid', { status: badKey.status, code: badKey.code });
  const badWindow = await api('POST', '/api/admin/earning/campaigns', {
    token: SUPER,
    body: { key: K('window'), title: 'Backwards', startsAt: new Date(Date.now() + 8.64e7).toISOString(), endsAt: new Date().toISOString() },
  });
  report('a window that ends before it starts is refused',
    badWindow.status === 400 && badWindow.code === 'earning_window_invalid', { code: badWindow.code });

  const chatKey = K('chat');
  const publish = await api('POST', '/api/admin/earning/rules', {
    token: SUPER,
    body: { key: chatKey, title: 'Two messages', metric: 'CHAT_MESSAGE', purpose: 'CAMPAIGN', campaignKey: K('deck'),
      target: 2, rewardAmount: 5, rewardCurrency: 'XP', reset: 'DAY' },
  });
  report('a rule publishes as version 1 and is live',
    publish.status === 201 && publish.json.rule.ruleVersion === 1 && publish.json.rule.isActive, {
      status: publish.status, code: publish.code, version: publish.json?.rule?.ruleVersion,
    });

  const badRestriction = await api('POST', '/api/admin/earning/rules', {
    token: SUPER,
    body: { key: K('bad-cond'), title: 'Wrong condition', metric: 'CHAT_MESSAGE', purpose: 'CAMPAIGN',
      target: 1, rewardAmount: 1, rewardCurrency: 'XP', restrictions: { gameKey: 'TIC_TAC_TOE' } },
  });
  report('a condition the metric cannot answer is refused by name',
    badRestriction.status === 400 && badRestriction.code === 'earning_restriction_unknown', { code: badRestriction.code });
  const badApproval = await api('POST', '/api/admin/earning/rules', {
    token: SUPER,
    body: { key: K('bad-review'), title: 'Reviewed chat rule', metric: 'CHAT_MESSAGE', purpose: 'CAMPAIGN',
      target: 1, rewardAmount: 1, rewardCurrency: 'XP', requiresApproval: true },
  });
  report('a review step on a server-counted metric is refused',
    badApproval.status === 400 && badApproval.code === 'earning_approval_needs_submission', { code: badApproval.code });

  const reprice = await api('POST', '/api/admin/earning/rules', {
    token: SUPER,
    body: { key: chatKey, title: 'Two messages', metric: 'CHAT_MESSAGE', purpose: 'CAMPAIGN', campaignKey: K('deck'),
      target: 2, rewardAmount: 8, rewardCurrency: 'XP', reset: 'DAY' },
  });
  const timeline = await api('GET', `/api/admin/earning/rules/${chatKey}`, { token: SUPER });
  report('a changed body is a new version, not an edit',
    reprice.status === 201 && reprice.json.rule.ruleVersion === 2
      && timeline.status === 200 && timeline.json.rule.history.map((h) => h.ruleVersion).join() === '2,1', {
      version: reprice.json?.rule?.ruleVersion, history: timeline.json?.rule?.history?.map((h) => h.ruleVersion),
    });
  const liveList = await api('GET', `/api/admin/earning/rules?metric=CHAT_MESSAGE&activeOnly=true`, { token: SUPER });
  const forThisKey = (liveList.json?.rules ?? []).filter((r) => r.key === chatKey);
  report('only the newest version of a key is live', liveList.status === 200 && forThisKey.length === 1
    && forThisKey[0].ruleVersion === 2 && forThisKey[0].rewardAmount === 8, { versions: forThisKey.map((r) => r.ruleVersion) });

  // ---------------------------------------------------------------------------
  section('the member reads the board it is offered');
  // ---------------------------------------------------------------------------

  const me = await member(`89${stamp}0`);
  const board = await api('GET', '/api/earnings', { token: me.token });
  const card = (board.json?.rules ?? []).find((r) => r.ruleKey === chatKey);
  report('the board lists the rule with its live price and no attempt yet',
    board.status === 200 && card && card.eligible && card.rewardAmount === 8 && card.status === null, {
      status: board.status, code: board.code, card: card && { price: card.rewardAmount, status: card.status, reason: card.reason },
    });
  report('the board buckets from one clock, so a DAY card and the sweep agree',
    board.json.buckets && /^\d{4}-\d{2}-\d{2}$/.test(board.json.buckets.DAY) && board.json.buckets.NEVER === 'ALL',
    board.json?.buckets);

  const anonymous = await api('GET', '/api/earnings');
  report('the board is not public', anonymous.status === 401 && anonymous.code === 'unauthorized', {
    status: anonymous.status, code: anonymous.code,
  });

  const claimServerRule = await api('POST', '/api/earnings/claim', { token: me.token, body: { rule: chatKey, evidence: { note: 'i chatted' } } });
  report('a server-counted rule has nothing for a member to claim',
    claimServerRule.status === 400 && claimServerRule.code === 'earning_not_claimable', {
      status: claimServerRule.status, code: claimServerRule.code,
    });
  const claimUnknown = await api('POST', '/api/earnings/claim', { token: me.token, body: { rule: K('nobody'), evidence: {} } });
  report('a claim against a rule that does not exist is refused',
    claimUnknown.status === 404 && claimUnknown.code === 'earning_rule_not_found', {
      status: claimUnknown.status, code: claimUnknown.code,
    });

  const submitKey = K('proof');
  const reviewRule = await api('POST', '/api/admin/earning/rules', {
    token: SUPER,
    body: { key: submitKey, title: 'Show the screenshot', metric: 'SUBMISSION', purpose: 'EVENT', campaignKey: K('deck'),
      target: 1, rewardAmount: 3, rewardCurrency: 'BONUS_DIAMOND', reset: 'DAY', requiresApproval: true },
  });
  report('a reviewed submission rule publishes', reviewRule.status === 201 && reviewRule.json.rule.requiresApproval, {
    status: reviewRule.status, code: reviewRule.code,
  });

  const first = await api('POST', '/api/earnings/claim', {
    token: me.token,
    body: { rule: submitKey, evidence: { screenshot: 'proof.png' }, idempotencyKey: `rt${stamp}-claim-1` },
  });
  report('a claim is filed unpaid and lands in the queue',
    first.status === 201 && first.json.status === 'PENDING' && first.json.payout === null && first.json.replay === false,
    { status: first.status, outcome: first.json && { s: first.json.status, refusal: first.json.refusal }, code: first.code });

  const again = await api('POST', '/api/earnings/claim', {
    token: me.token,
    body: { rule: submitKey, evidence: { screenshot: 'proof.png' }, idempotencyKey: `rt${stamp}-claim-1` },
  });
  report('the same key gets the first answer rather than a second attempt',
    again.status === 200 && again.json.replay === true && again.json.activityId === first.json.activityId, {
      status: again.status, replay: again.json?.replay, same: again.json?.activityId === first.json?.activityId,
    });
  const queued = await api('GET', '/api/admin/earning/claims', { token: SUPER });
  const mine = (queued.json?.claims ?? []).filter((c) => c.userId === me.id);
  report('one retry files one claim, with its evidence readable in the queue',
    queued.status === 200 && mine.length === 1 && mine[0].evidence.screenshot === 'proof.png'
      && mine[0].rewardAmount === 3 && mine[0].rewardCurrency === 'BONUS_DIAMOND', {
      count: mine.length, evidence: mine[0] && mine[0].evidence,
    });

  // ---------------------------------------------------------------------------
  section('permissions: who may mint, who may publish');
  // ---------------------------------------------------------------------------

  const finance = await operator(SUPER, `rt${stamp}fin`, 'Voiza#fin2026', 'FINANCE_ADMIN');
  const operations = await operator(SUPER, `rt${stamp}ops`, 'Voiza#ops2026', 'OPERATIONS_ADMIN');

  const financePublishes = await api('POST', '/api/admin/earning/rules', {
    token: finance.token,
    body: { key: K('finance-rule'), title: 'Should not exist', metric: 'CHAT_MESSAGE', purpose: 'CAMPAIGN',
      target: 1, rewardAmount: 1, rewardCurrency: 'XP' },
  });
  report('publishing a rule is not a finance permission',
    financePublishes.status === 403 && financePublishes.code === 'permission_denied', {
      status: financePublishes.status, code: financePublishes.code,
    });
  const financeSeesQueue = await api('GET', '/api/admin/earning/claims', { token: finance.token });
  report('finance may read the queue it is about to sign', financeSeesQueue.status === 200, { status: financeSeesQueue.status });

  const opsApproves = await api('POST', `/api/admin/earning/claims/${first.json.activityId}/approve`, {
    token: operations.token, body: { note: 'looks fine to operations' },
  });
  report('approving a claim is not an operations permission',
    opsApproves.status === 403 && opsApproves.code === 'permission_denied', { status: opsApproves.status, code: opsApproves.code });
  const opsPublishes = await api('POST', `/api/admin/earning/rules/${chatKey}/active`, {
    token: operations.token, body: { isActive: false, note: 'operations cannot retire a rule' },
  });
  report('nor is retiring one', opsPublishes.status === 403, { status: opsPublishes.status, code: opsPublishes.code });

  const memberOnAdmin = await api('GET', '/api/admin/earning/rules', { token: me.token });
  report("a member's token cannot reach the operator router at all",
    memberOnAdmin.status === 401 || memberOnAdmin.status === 403, { status: memberOnAdmin.status, code: memberOnAdmin.code });

  const approve = await api('POST', `/api/admin/earning/claims/${first.json.activityId}/approve`, {
    token: finance.token, body: { note: 'verified the screenshot' },
  });
  const bonusRow = (await sql('SELECT promo_diamond_balance AS bonus, diamond_balance AS bought FROM users WHERE id = $1', [me.id])).rows[0];
  report('approval mints into the bonus pocket and leaves the purchased one alone',
    approve.status === 200 && approve.json.status === 'PAID' && approve.json.payout.amount === 3
      && Number(bonusRow.bonus) === 3 && Number(bonusRow.bought) === 0,
    { status: approve.json?.status, pocket: bonusRow, code: approve.code });
  const doubleSign = await api('POST', `/api/admin/earning/claims/${first.json.activityId}/approve`, {
    token: finance.token, body: { note: 'the same claim again' },
  });
  report('one claim is signed once, whoever clicks twice',
    doubleSign.status === 409 && doubleSign.code === 'earning_claim_decided', {
      status: doubleSign.status, code: doubleSign.code,
    });
  const afterApprove = await api('GET', '/api/admin/earning/claims', { token: SUPER });
  report('a paid claim leaves the queue',
    afterApprove.status === 200 && !(afterApprove.json.claims ?? []).some((c) => c.userId === me.id), {
      still: (afterApprove.json?.claims ?? []).filter((c) => c.userId === me.id).length,
    });

  const refuseNoNote = await api('POST', `/api/admin/earning/claims/${first.json.activityId}/refuse`, { token: SUPER, body: {} });
  report('a refusal without a note is refused even on a decided claim',
    refuseNoNote.status === 400 && refuseNoNote.code === 'earning_note_required', {
      status: refuseNoNote.status, code: refuseNoNote.code,
    });

  // ---------------------------------------------------------------------------
  section('the trail both sides read');
  // ---------------------------------------------------------------------------

  const myPayouts = await api('GET', '/api/earnings/payouts', { token: me.token });
  report('the member sees the payout the engine made',
    myPayouts.status === 200 && myPayouts.json.payouts.length === 1
      && myPayouts.json.payouts[0].ruleKey === submitKey && myPayouts.json.payouts[0].amount === 3
      && myPayouts.json.payouts[0].currency === 'BONUS_DIAMOND', myPayouts.json?.payouts);

  const byCampaign = await api('GET', `/api/admin/earning/payouts?campaign=${K('deck')}`, { token: SUPER });
  const byMetric = await api('GET', '/api/admin/earning/payouts?metric=SUBMISSION', { token: SUPER });
  report('the payout trail filters by campaign and by metric',
    byCampaign.status === 200 && byCampaign.json.payouts.every((p) => p.campaignKey === K('deck'))
      && byMetric.status === 200 && byMetric.json.payouts.every((p) => p.metric === 'SUBMISSION')
      && byMetric.json.payouts.length >= 1, {
      campaign: byCampaign.json?.payouts?.length, metric: byMetric.json?.payouts?.length,
    });
  const badMetric = await api('GET', '/api/admin/earning/payouts?metric=NOT_A_METRIC', { token: SUPER });
  report('a filter the catalogue does not know is refused rather than ignored',
    badMetric.status === 400 && badMetric.code === 'bad_request', { status: badMetric.status, code: badMetric.code });

  const sweep = await api('POST', '/api/admin/earning/sweep', { token: SUPER, body: {} });
  report('the sweep is callable and reports what it aged out',
    sweep.status === 200 && Number.isInteger(Number(sweep.json.expired)), sweep.json);

  // ---------------------------------------------------------------------------
  section('teardown: nothing left live, nobody left signed up');
  // ---------------------------------------------------------------------------

  const retireChat = await api('POST', `/api/admin/earning/rules/${chatKey}/active`, {
    token: SUPER, body: { isActive: false, note: 'suite teardown' },
  });
  const retireSubmit = await api('POST', `/api/admin/earning/rules/${submitKey}/active`, {
    token: SUPER, body: { isActive: false, note: 'suite teardown' },
  });
  const closeDeck = await api('PUT', `/api/admin/earning/campaigns/${K('deck')}`, { token: SUPER, body: { status: 'CLOSED' } });
  report('the run leaves no live rule and no open campaign',
    retireChat.status === 200 && retireChat.json.rule.isActive === false
      && retireSubmit.status === 200 && retireSubmit.json.rule.isActive === false
      && closeDeck.status === 200 && closeDeck.json.campaign.status === 'CLOSED', {
      chat: retireChat.json?.rule?.isActive, submission: retireSubmit.json?.rule?.isActive,
      deck: closeDeck.json?.campaign?.status,
    });
  const budgetRefused = await api('PUT', `/api/admin/earning/campaigns/${K('deck')}`, { token: SUPER, body: { budgetDiamonds: 1 } });
  report('a campaign that minted cannot be repriced below its spend, even after closing',
    budgetRefused.status === 409 && budgetRefused.code === 'earning_budget_below_spend', {
      status: budgetRefused.status, code: budgetRefused.code,
    });

  const offFinance = await api('POST', `/api/admin/operators/${finance.id}/disable`, { token: SUPER, body: { reason: 'suite teardown' } });
  const offOps = await api('POST', `/api/admin/operators/${operations.id}/disable`, { token: SUPER, body: { reason: 'suite teardown' } });
  report('the two temporary operators are disabled',
    offFinance.status === 200 && offOps.status === 200, { finance: offFinance.status, ops: offOps.status });

  await db().end().catch(() => undefined);
  console.log(`\n${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch(async (e) => {
  console.log(`THREW  ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)}`);
  failed += 1;
  await db().end().catch(() => undefined);
  console.log(`\n${failed} failed`);
  process.exitCode = 1;
});
