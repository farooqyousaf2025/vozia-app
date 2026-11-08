/* End-to-end tests for the earning rules engine (migration 0038, README "Earning rules").
   Drives the compiled services directly — the member and admin routes land in #98 — and asserts on
   database state through its own pg pool. No mocks, no fixtures.

     1. boot the stack (README) — the API itself is not needed; this runs in-process
     2. npm run build && node scripts/earning-e2e.cjs

   Runs against a development database only: it publishes campaigns, mints bonus diamonds and awards XP
   for throwaway accounts. Every rule it creates is retired and every campaign it opens is closed before
   it exits, so nothing left behind can pay a real member; the rows stay, because a payout trail that
   vanishes with its test run is not a trail.

   The checks worth reading first are the ones guarding the two things this engine can get wrong in a
   way that costs money twice or never: the caps hold under a reprice because an attempt keeps the price
   it was shown (so raising a reward cannot hand out a second allowance), and nothing is minted until the
   attempt itself is claimed by a conditional UPDATE (so two racing paths pay once). The budget test is
   the third: a campaign that ran dry pays as soon as it is topped up, and a campaign an operator closed
   never pays again. */
const path = require('path');

const BE_ROOT = path.resolve(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const out = [];
let failed = 0;
function report(name, pass, detail) {
  if (!pass) failed += 1;
  const line = `${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 320)}` : ''}`;
  out.push(line);
  console.log(line);
}
function section(title) {
  out.push(`\n--- ${title} ---`);
  console.log(`\n--- ${title} ---`);
}

const Pool = require(path.join(BE_ROOT, 'node_modules', 'pg')).Pool;
const pool = new Pool({ connectionString: require(path.join(BE_ROOT, 'dist', 'config', 'env.js')).env.databaseUrl, max: 6 });

const ruleApi = require(path.join(BE_ROOT, 'dist', 'services', 'earning-rule.service.js'));
const engine = require(path.join(BE_ROOT, 'dist', 'services', 'earning.service.js'));
const db = require(path.join(BE_ROOT, 'dist', 'config', 'db.js'));
const redisMod = require(path.join(BE_ROOT, 'dist', 'config', 'redis.js'));

const sql = async (q, p) => (await pool.query(q, p)).rows;
const row0 = async (q, p) => ((await sql(q, p)) ?? [])[0] ?? null;
const scalar = async (q, p) => Number(((await sql(q, p))[0] || {}).n ?? 0);

/** Run the hook surface the way a gift send does: inside the caller's own transaction. */
const earn = (userId, events) => db.withTransaction((client) => engine.earnWithin(client, userId, events));

/** ApiError carries `code`; a check that expects a refusal is a check on that code. */
async function expectCode(name, code, fn) {
  try {
    await fn();
    report(name, false, { expected: code, got: 'no error' });
  } catch (e) {
    report(name, e.code === code, { expected: code, got: e.code, message: e.message });
  }
}

const stamp = Date.now().toString().slice(-6);
const K = (name) => `e2e-${stamp}-${name}`;

const findRule = async (key, version) =>
  row0(
    version === undefined
      ? 'SELECT id, rule_version, is_active, ends_at, max_per_period, max_total, reward_amount, reward_currency FROM earning_rules WHERE key = $1 ORDER BY rule_version DESC'
      : 'SELECT id, rule_version, is_active, ends_at, max_per_period, max_total, reward_amount, reward_currency FROM earning_rules WHERE key = $1 AND rule_version = $2',
    version === undefined ? [key] : [key, version],
  );

const attempts = (userId, key) =>
  sql(
    `SELECT a.id, a.occurrence, a.bucket, a.progress, a.target, a.status, a.reward_amount, a.rule_version, a.evidence
       FROM earning_activities a JOIN earning_rules r ON r.id = a.rule_id
      WHERE a.user_id = $1 AND r.key = $2 ORDER BY a.occurrence, a.created_at`,
    [userId, key],
  );

const payoutRows = (userId, key) =>
  sql(
    `SELECT p.id, p.rule_version, p.bucket, p.occurrence, p.currency, p.amount, p.metric, p.promo_grant_id
       FROM earning_payouts p JOIN earning_rules r ON r.id = p.rule_id
      WHERE p.user_id = $1 AND r.key = $2 ORDER BY p.created_at`,
    [userId, key],
  );

const xpOf = (id) => scalar('SELECT xp::text AS n FROM users WHERE id = $1', [id]);
const pocketOf = async (id) => {
  const r = await row0('SELECT diamond_balance AS bought, promo_diamond_balance AS bonus FROM users WHERE id = $1', [id]);
  return { bought: Number(r.bought), bonus: Number(r.bonus) };
};

/** The payouts one event batch made for a single rule key — other live rules hear the same event. */
const paidOf = (outcomes, key) => outcomes.filter((p) => p.ruleKey === key);

(async () => {
  const admin = await row0('SELECT id FROM admins ORDER BY created_at LIMIT 1');
  if (!admin) throw new Error('no admin row to sign the audit entries — seed the backend first');
  const A = admin.id;

  const face = Number((await row0(`SELECT value->>'minorPerCoin' AS n FROM system_config WHERE key = 'accounts.coinValue'`))?.n ?? 0);
  const today = (await row0(
    `SELECT to_char(now() AT TIME ZONE (SELECT reset_timezone FROM quest_settings WHERE singleton), 'YYYY-MM-DD') AS bucket`,
  )).bucket;

  // An interrupted run must not leave a live campaign behind. Anything an earlier `e2e-` run published and
  // never switched off is closed here, before this run adds rules of its own — the alternative is a fixture
  // that pays real members after the test that made it stopped halfway.
  const orphanRules = await sql(`SELECT key FROM earning_rules WHERE key LIKE 'e2e-%' AND is_active`);
  for (const orphan of orphanRules) await ruleApi.setRuleActive(A, orphan.key, false, 'suite cleanup: earlier run interrupted');
  const orphanCampaigns = await sql(`SELECT key FROM earning_campaigns WHERE key LIKE 'e2e-%' AND status = 'LIVE'`);
  for (const orphan of orphanCampaigns) await ruleApi.updateCampaign(A, orphan.key, { status: 'CLOSED' });
  if (orphanRules.length || orphanCampaigns.length) {
    report(`${orphanRules.length} rule(s) and ${orphanCampaigns.length} campaign(s) left live by an earlier run switched off`, true, {
      rules: orphanRules.map((r) => r.key), campaigns: orphanCampaigns.map((c) => c.key),
    });
  }

  // ---------------------------------------------------------------------------
  // the accounts this run pays
  // ---------------------------------------------------------------------------

  async function member(label, extra = {}) {
    const rows = await sql(
      `INSERT INTO users (phone, username, status, user_type, vip_level, country_code, xp, diamond_balance, promo_diamond_balance, r_coin_balance)
       VALUES ($1,$2,'ACTIVE',$3,$4,$5,0,0,0,0) RETURNING id, username`,
      [`88${stamp}${label}`, `en${stamp}${label}`, extra.userType || 'USER', extra.vipLevel || 0, extra.country || 'IN'],
    );
    return { id: rows[0].id, username: rows[0].username };
  }

  const m = await member('0');
  const gift = await member('1');
  const host = await member('2', { userType: 'HOST' });
  const spender = await member('3');
  const claimer = await member('4');
  const priced = await member('5');
  const stale = await member('6');
  const banned = await member('7');

  // ---------------------------------------------------------------------------
  section('campaigns and rule publishing');
  // ---------------------------------------------------------------------------

  const c1 = await ruleApi.createCampaign(A, { key: K('main'), title: 'E2E main', status: 'LIVE', description: 'the run\'s campaign' });
  const c1Card = await ruleApi.getCampaign(c1.key);
  report('a live campaign reads back', c1.status === 'LIVE' && c1Card.spentDiamonds === 0 && c1Card.ruleCount === 0, {
    status: c1.status, spent: c1Card.spentDiamonds, rules: c1Card.ruleCount,
  });

  const cBudget = await ruleApi.createCampaign(A, { key: K('budget'), title: 'E2E budgeted', status: 'LIVE', budgetDiamonds: 20 });
  const cDraft = await ruleApi.createCampaign(A, { key: K('draft'), title: 'E2E draft', status: 'DRAFT' });
  const cClose = await ruleApi.createCampaign(A, { key: K('close'), title: 'E2E closing', status: 'LIVE' });
  const cSpare = await ruleApi.createCampaign(A, { key: K('spare'), title: 'E2E deletable', status: 'DRAFT' });

  await expectCode('a campaign key is lower-case and dashed', 'earning_key_invalid', () =>
    ruleApi.createCampaign(A, { key: `E2E-${stamp}-Bad`, title: 'nope' }));
  await expectCode('endsAt before startsAt is refused', 'earning_window_invalid', () =>
    ruleApi.createCampaign(A, {
      key: K('window'), title: 'nope', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() - 86_400_000).toISOString(),
    }));

  const loginKey = K('login');
  const r1 = await ruleApi.putEarningRule(A, {
    key: loginKey, title: 'Daily logins', metric: 'DAILY_LOGIN', purpose: 'QUEST', campaignKey: c1.key,
    target: 3, rewardAmount: 10, rewardCurrency: 'XP', reset: 'DAY', maxPerPeriod: 1,
  });
  report('rule v1 publishes live and priced', r1.ruleVersion === 1 && r1.isActive && r1.maxPerPeriod === 1 && r1.countedBy === 'SERVER', {
    version: r1.ruleVersion, active: r1.isActive, countedBy: r1.countedBy,
  });

  await expectCode('a condition the metric cannot answer is refused', 'earning_restriction_unknown', () =>
    ruleApi.putEarningRule(A, {
      key: K('badfilter'), title: 'nope', metric: 'GIFT_SENT', purpose: 'CAMPAIGN', target: 1,
      rewardAmount: 5, rewardCurrency: 'XP', restrictions: { gameKey: 'TIC_TAC_TOE' },
    }));
  await expectCode('an approval step on a server-counted metric is refused', 'earning_approval_needs_submission', () =>
    ruleApi.putEarningRule(A, {
      key: K('badapproval'), title: 'nope', metric: 'CHAT_MESSAGE', purpose: 'CAMPAIGN', target: 1,
      rewardAmount: 5, rewardCurrency: 'XP', requiresApproval: true,
    }));
  await expectCode('a bonus reward above the mint bound is refused', 'bad_request', () =>
    ruleApi.putEarningRule(A, {
      key: K('bigmint'), title: 'nope', metric: 'CHAT_MESSAGE', purpose: 'CAMPAIGN', target: 1,
      rewardAmount: 20_000_000, rewardCurrency: 'BONUS_DIAMOND',
    }));

  const submissionTarget = await ruleApi.putEarningRule(A, {
    key: K('forced'), title: 'Target is not a choice', metric: 'SUBMISSION', purpose: 'ACHIEVEMENT',
    target: 5, rewardAmount: 2, rewardCurrency: 'XP', requiresApproval: false,
  });
  report('a claim\'s target is one submission, whatever the body said', submissionTarget.target === 1, { target: submissionTarget.target });
  await ruleApi.setRuleActive(A, submissionTarget.key, false, 'suite: fixture retired');

  await expectCode('a rule cannot be added to a closed campaign', 'earning_campaign_closed', async () => {
    await ruleApi.updateCampaign(A, cSpare.key, { status: 'CLOSED' });
    await ruleApi.putEarningRule(A, {
      key: K('late'), title: 'nope', metric: 'ROOM_JOIN', purpose: 'CAMPAIGN', target: 1, rewardAmount: 1, rewardCurrency: 'XP', campaignKey: cSpare.key,
    });
  });

  // A rule under a DRAFT campaign is written but cannot start: the advance reads the campaign too.
  const draftKey = K('ondraft');
  await ruleApi.putEarningRule(A, {
    key: draftKey, title: 'Waiting on the draft', metric: 'GAME_PLAY', purpose: 'CAMPAIGN', campaignKey: cDraft.key,
    target: 1, rewardAmount: 9, rewardCurrency: 'XP',
  });
  const onDraft = await earn(m.id, [{ metric: 'GAME_PLAY', amount: 1 }]);
  report('a draft campaign starts no attempt', onDraft.length === 0 && (await attempts(m.id, draftKey)).length === 0, { paid: onDraft.length });

  // ---------------------------------------------------------------------------
  section('advancing a rule and paying it');
  // ---------------------------------------------------------------------------

  const first = await earn(m.id, [{ metric: 'DAILY_LOGIN', amount: 1 }]);
  const opened = (await attempts(m.id, loginKey))[0];
  report('one event opens the bucket', first.length === 0 && opened && opened.status === 'OPEN' && opened.progress === 1, opened);
  report('the bucket is today in the platform timezone', opened.bucket === today, { bucket: opened.bucket, today });

  await earn(m.id, [{ metric: 'DAILY_LOGIN', amount: 1 }]);
  const after = await earn(m.id, [{ metric: 'DAILY_LOGIN', amount: 1 }]);
  const done = (await attempts(m.id, loginKey))[0];
  const loginPaid = await payoutRows(m.id, loginKey);
  report('the third event completes and pays once', after.length === 1 && done.status === 'PAID' && done.progress === 3, {
    paid: after.length, status: done.status,
  });
  report('an XP payout is one ledger row at the rule price', loginPaid.length === 1 && loginPaid[0].amount === 10 && loginPaid[0].metric === 'DAILY_LOGIN', loginPaid[0]);
  report('XP moved and no bonus pocket appeared', (await xpOf(m.id)) === 10 && (await pocketOf(m.id)).bonus === 0, { xp: await xpOf(m.id) });
  report('the paid row is frozen at its occurrence', done.occurrence === 1 && done.bucket === today, { occurrence: done.occurrence });

  const nothing = await earn(m.id, [{ metric: 'DAILY_LOGIN', amount: 0 }, { metric: 'SUBMISSION', amount: 3 }]);
  report('a zero event and a member-counted metric advance nothing', nothing.length === 0 && (await attempts(m.id, loginKey)).length === 1, nothing);

  const dailyCap = await earn(m.id, [{ metric: 'DAILY_LOGIN', amount: 1 }]);
  report('the period cap answers rather than starting a second round', dailyCap.length === 0 && (await attempts(m.id, loginKey)).length === 1, { paid: dailyCap.length });

  // ---------------------------------------------------------------------------
  section('the two caps are different numbers');
  // ---------------------------------------------------------------------------

  const periodKey = K('periodcap');
  await ruleApi.putEarningRule(A, {
    key: periodKey, title: 'Three games a day', metric: 'GAME_PLAY', purpose: 'EVENT', campaignKey: c1.key,
    target: 1, rewardAmount: 5, rewardCurrency: 'XP', reset: 'DAY', maxPerPeriod: 3,
  });
  const xpBeforeGames = await xpOf(m.id);
  const gameOutcomes = [];
  for (let i = 0; i < 4; i += 1) gameOutcomes.push(await earn(m.id, [{ metric: 'GAME_PLAY', amount: 1 }]));
  const gameRows = await attempts(m.id, periodKey);
  report('three payouts then the cap', gameOutcomes.filter((r) => r.length === 1).length === 3 && gameOutcomes[3].length === 0, {
    payouts: gameOutcomes.map((r) => r.length),
  });
  report('the cap starts a new occurrence rather than reopening a paid one',
    gameRows.length === 3 && gameRows.map((r) => r.occurrence).join() === '1,2,3' && gameRows.every((r) => r.status === 'PAID'),
    gameRows.map((r) => ({ o: r.occurrence, s: r.status })));
  report('XP is the sum of three payouts', (await xpOf(m.id)) === xpBeforeGames + 15, { xp: await xpOf(m.id) });

  const lifeKey = K('lifecap');
  await ruleApi.putEarningRule(A, {
    key: lifeKey, title: 'Twice in its life', metric: 'STORE_PURCHASE', purpose: 'ACHIEVEMENT', campaignKey: c1.key,
    target: 1, rewardAmount: 4, rewardCurrency: 'XP', reset: 'NEVER', maxPerPeriod: 10, maxTotal: 2,
  });
  const lifeOutcomes = [];
  for (let i = 0; i < 3; i += 1) lifeOutcomes.push(await earn(m.id, [{ metric: 'STORE_PURCHASE', amount: 1 }]));
  const lifeRows = await attempts(m.id, lifeKey);
  const lifePaid = await payoutRows(m.id, lifeKey);
  report('a lifetime cap stops at max_total', lifeOutcomes.slice(0, 2).every((r) => r.length === 1) && lifeOutcomes[2].length === 0, {
    payouts: lifeOutcomes.map((r) => r.length),
  });
  report('NEVER reset files one bucket, and a capped event files no third attempt',
    lifeRows.length === 2 && lifeRows.every((r) => r.bucket === 'ALL'), {
    buckets: [...new Set(lifeRows.map((r) => r.bucket))], rows: lifeRows.length, paid: lifePaid.length,
  });

  // ---------------------------------------------------------------------------
  section('ADD versus MAX: what one event is worth');
  // ---------------------------------------------------------------------------

  const checkinKey = K('checkin');
  await ruleApi.putEarningRule(A, {
    key: checkinKey, title: 'Check in three times', metric: 'CHECKIN', purpose: 'CHECKIN', campaignKey: c1.key,
    target: 3, rewardAmount: 7, rewardCurrency: 'BONUS_DIAMOND', reset: 'DAY',
  });
  const streakKey = K('streak');
  await ruleApi.putEarningRule(A, {
    key: streakKey, title: 'Reach a three-day streak', metric: 'CHECKIN_STREAK', purpose: 'CHECKIN', campaignKey: c1.key,
    target: 3, rewardAmount: 20, rewardCurrency: 'XP', reset: 'DAY',
  });
  const bonusBefore = await pocketOf(m.id);
  const xpBeforeStreak = await xpOf(m.id);
  for (const day of [1, 1, 1]) {
    await earn(m.id, [{ metric: 'CHECKIN', amount: day }, { metric: 'CHECKIN_STREAK', amount: day }]);
  }
  const checkinRow = (await attempts(m.id, checkinKey))[0];
  const streakRow = (await attempts(m.id, streakKey))[0];
  report('a counter sums its events', checkinRow.status === 'PAID' && checkinRow.progress === 3, checkinRow);
  report('a level records the largest, so three day-1s never finish it',
    streakRow.status === 'OPEN' && streakRow.progress === 1, streakRow);
  const streakPaid = await earn(m.id, [{ metric: 'CHECKIN_STREAK', amount: 5 }]);
  report('the streak pays when the level itself passes the target',
    streakPaid.length === 1 && (await attempts(m.id, streakKey))[0].progress === 5, { progress: (await attempts(m.id, streakKey))[0].progress });
  report('a streak never sums the days it was told', (await xpOf(m.id)) === xpBeforeStreak + 20, { xp: await xpOf(m.id) });

  // ---------------------------------------------------------------------------
  section('a bonus payout is a grant, and a grant is a journal entry');
  // ---------------------------------------------------------------------------

  const checkinPaid = (await payoutRows(m.id, checkinKey))[0];
  const grant = await row0('SELECT id, amount, remaining, source_kind, source_id, reason FROM promo_grants WHERE id = $1', [checkinPaid.promo_grant_id]);
  const afterBonus = await pocketOf(m.id);
  report('the bonus pocket grew and the purchased one did not',
    afterBonus.bonus === bonusBefore.bonus + 7 && afterBonus.bought === bonusBefore.bought, afterBonus);
  report('the payout names the grant it minted', !!checkinPaid.promo_grant_id && grant.amount === 7 && grant.remaining === 7, {
    amount: grant && grant.amount,
  });
  report('the grant is keyed on the attempt and carries its purpose',
    grant.source_kind === 'CHECKIN' && grant.source_id === checkinRow.id, { kind: grant.source_kind, source: grant.source_id });
  const legs = await sql(
    `SELECT l.direction, l.account_code, l.amount_cents FROM fin_journal_entries e
       JOIN fin_journal_lines l ON l.entry_id = e.id
      WHERE e.source_kind = 'PROMO_GRANT' AND e.source_id = $1 ORDER BY l.direction`,
    [grant.id],
  );
  // `ORDER BY direction` is the enum's own label order, not alphabetical, so the legs are named here
  // rather than counted by index.
  const debit = legs.find((l) => l.direction === 'DEBIT');
  const credit = legs.find((l) => l.direction === 'CREDIT');
  report('the mint is booked out of the budget into the liability at face value',
    legs.length === 2 && credit && credit.account_code === 'COIN_LIABILITY'
      && debit && debit.account_code === 'PROMOTIONAL:PLATFORM'
      && Number(credit.amount_cents) === 7 * face && Number(debit.amount_cents) === Number(credit.amount_cents),
    legs);

  // ---------------------------------------------------------------------------
  section('eligibility: who the rule is for');
  // ---------------------------------------------------------------------------

  const gates = {
    usertype: { eligibleUserTypes: ['HOST'] },
    country: { eligibleCountries: ['PK'] },
    vip: { minVipLevel: 5 },
    age: { minAccountAgeDays: 7 },
  };
  for (const [name, body] of Object.entries(gates)) {
    await ruleApi.putEarningRule(A, {
      key: K(`gate-${name}`), title: `Gate ${name}`, metric: 'CHAT_MESSAGE', purpose: 'CAMPAIGN', campaignKey: c1.key,
      target: 1, rewardAmount: 3, rewardCurrency: 'XP', ...body,
    });
  }
  const gateRun = await earn(m.id, [{ metric: 'CHAT_MESSAGE', amount: 1 }]);
  const gateRows = await sql(
    `SELECT COUNT(*)::text AS n FROM earning_activities a JOIN earning_rules r ON r.id = a.rule_id WHERE r.key LIKE $1`,
    [`%gate-%`],
  );
  report('four gated rules advance no one who fails them', gateRun.length === 0 && Number(gateRows[0].n) === 0, { rows: gateRows[0].n });

  const board = await engine.memberEarnings(m.id);
  const reasons = Object.fromEntries(board.rules.filter((r) => r.ruleKey.includes('gate-')).map((r) => [r.ruleKey.split('gate-')[1], r.reason]));
  report('the member read says why each one refused',
    reasons.usertype === 'USER_TYPE' && reasons.country === 'COUNTRY' && reasons.vip === 'VIP_LEVEL' && reasons.age === 'ACCOUNT_AGE', reasons);

  const hostBoard = await engine.memberEarnings(host.id);
  const hostType = hostBoard.rules.find((r) => r.ruleKey.endsWith('gate-usertype'));
  report('the same rule is open to the account it names', hostType.eligible === true && hostType.reason === null, hostType);

  await sql(`UPDATE users SET status = 'BANNED' WHERE id = $1`, [banned.id]);
  const openKey = K('open');
  await ruleApi.putEarningRule(A, {
    key: openKey, title: 'Anyone active', metric: 'ROOM_JOIN', purpose: 'CAMPAIGN', campaignKey: c1.key,
    target: 1, rewardAmount: 1, rewardCurrency: 'XP',
  });
  const bannedRun = await earn(banned.id, [{ metric: 'ROOM_JOIN', amount: 1 }]);
  const bannedBoard = await engine.memberEarnings(banned.id);
  const bannedRule = bannedBoard.rules.find((r) => r.ruleKey === openKey);
  report('a banned account is told so rather than credited',
    bannedRun.length === 0 && (await attempts(banned.id, openKey)).length === 0 && bannedRule.reason === 'ACCOUNT_STATUS', {
      reason: bannedRule && bannedRule.reason,
    });

  // ---------------------------------------------------------------------------
  section('restrictions: which event the rule counts');
  // ---------------------------------------------------------------------------

  const giftKey = K('giftmin');
  await ruleApi.putEarningRule(A, {
    key: giftKey, title: 'Two big roses', metric: 'GIFT_SENT', purpose: 'CAMPAIGN', campaignKey: c1.key,
    target: 2, rewardAmount: 15, rewardCurrency: 'BONUS_DIAMOND', reset: 'DAY',
    restrictions: { minDiamonds: 50, giftCategory: 'ROSE' },
  });
  await earn(gift.id, [{ metric: 'GIFT_SENT', amount: 1, context: { diamonds: 10, giftCategory: 'ROSE' } }]);
  await earn(gift.id, [{ metric: 'GIFT_SENT', amount: 1, context: { diamonds: 60, giftCategory: 'ROSE' } }]);
  await earn(gift.id, [{ metric: 'GIFT_SENT', amount: 1, context: { diamonds: 60, giftCategory: 'TIGER' } }]);
  let giftRow = (await attempts(gift.id, giftKey))[0];
  report('an event that fails a condition leaves no trace', giftRow.progress === 1 && giftRow.status === 'OPEN', { progress: giftRow.progress });
  await earn(gift.id, [{ metric: 'GIFT_SENT', amount: 1, context: { diamonds: 500, giftCategory: 'ROSE' } }]);
  giftRow = (await attempts(gift.id, giftKey))[0];
  report('the matching events finish it', giftRow.status === 'PAID' && giftRow.progress === 2, giftRow);
  report('the payout is a grant on the gift rule too',
    (await payoutRows(gift.id, giftKey)).length === 1 && (await pocketOf(gift.id)).bonus === 15, await pocketOf(gift.id));

  // ---------------------------------------------------------------------------
  section('a reprice keeps the price the member was shown');
  // ---------------------------------------------------------------------------

  const priceKey = K('repriced');
  await ruleApi.putEarningRule(A, {
    key: priceKey, title: 'Spend to earn', metric: 'DIAMONDS_SPENT', purpose: 'QUEST', campaignKey: c1.key,
    target: 3, rewardAmount: 10, rewardCurrency: 'XP', reset: 'DAY', maxPerPeriod: 1,
  });
  await earn(priced.id, [{ metric: 'DIAMONDS_SPENT', amount: 2 }]);
  const xpBeforeReprice = await xpOf(priced.id);
  const v2 = await ruleApi.putEarningRule(A, {
    key: priceKey, title: 'Spend to earn (better)', metric: 'DIAMONDS_SPENT', purpose: 'QUEST', campaignKey: c1.key,
    target: 3, rewardAmount: 99, rewardCurrency: 'XP', reset: 'DAY', maxPerPeriod: 1,
  });
  const v1row = await findRule(priceKey, 1);
  report('the new version supersedes the old one', v2.ruleVersion === 2 && v2.isActive && !(await findRule(priceKey, 2)).ends_at, {
    v1active: v1row.is_active, v1ends: v1row.ends_at,
  });
  report('superseding closes the old version without ending it',
    v1row.is_active === false && v1row.ends_at === null, { active: v1row.is_active, ends_at: v1row.ends_at });

  const repriced = await earn(priced.id, [{ metric: 'DIAMONDS_SPENT', amount: 1 }]);
  const priceRows = await attempts(priced.id, priceKey);
  const pricePaid = await payoutRows(priced.id, priceKey);
  report('in-flight progress continues under the price it started at',
    repriced.length === 1 && repriced[0].amount === 10 && priceRows.length === 1 && priceRows[0].rule_version === 1, {
      paid: repriced, attempts: priceRows.length,
    });
  report('the reprice neither doubled the allowance nor moved it',
    (await xpOf(priced.id)) === xpBeforeReprice + 10 && pricePaid[0].rule_version === 1 && pricePaid[0].amount === 10, {
      xp: await xpOf(priced.id),
    });
  const afterPrice = await earn(priced.id, [{ metric: 'DIAMONDS_SPENT', amount: 3 }]);
  report('the day\'s allowance is still one payout after a reprice',
    afterPrice.length === 0 && (await attempts(priced.id, priceKey)).length === 1, { paid: afterPrice.length });

  const history = await ruleApi.getRule(priceKey);
  report('the timeline of a key is readable', history.ruleVersion === 2 && history.history.length === 2 && history.history[0].ruleVersion === 2, {
    versions: history.history.map((r) => r.ruleVersion),
  });

  // ---------------------------------------------------------------------------
  section('retiring a rule freezes it instead of destroying it');
  // ---------------------------------------------------------------------------

  const retireKey = K('retired');
  await ruleApi.putEarningRule(A, {
    key: retireKey, title: 'Chat a lot', metric: 'CHAT_MESSAGE', purpose: 'CAMPAIGN', campaignKey: c1.key,
    target: 3, rewardAmount: 12, rewardCurrency: 'XP', reset: 'DAY',
  });
  await earn(m.id, [{ metric: 'CHAT_MESSAGE', amount: 2 }]);
  await ruleApi.setRuleActive(A, retireKey, false, 'incident: pause the campaign');
  const xpBeforeRetire = await xpOf(m.id);
  const duringRetire = await earn(m.id, [{ metric: 'CHAT_MESSAGE', amount: 1 }]);
  const frozen = (await attempts(m.id, retireKey))[0];
  report('nothing advances while it is off', duringRetire.length === 0 && frozen.progress === 2 && frozen.status === 'OPEN', frozen);
  const swept = await engine.expireStaleActivities(500);
  const stillFrozen = (await attempts(m.id, retireKey))[0];
  report('a sweep leaves a retired rule\'s progress alone',
    stillFrozen.status === 'OPEN' && stillFrozen.progress === 2, { expired: swept.expired, row: stillFrozen.status });
  await ruleApi.setRuleActive(A, retireKey, true);
  const revived = await earn(m.id, [{ metric: 'CHAT_MESSAGE', amount: 1 }]);
  report('switching it back on finishes the same attempt at the same price',
    revived.length === 1 && revived[0].amount === 12 && (await attempts(m.id, retireKey))[0].occurrence === 1, { paid: revived });
  report('XP moved only on the resume', (await xpOf(m.id)) === xpBeforeRetire + 12, { xp: await xpOf(m.id) });
  await expectCode('retiring without a reason is refused', 'earning_reason_required', () =>
    ruleApi.setRuleActive(A, openKey, false, 'no'));

  // ---------------------------------------------------------------------------
  section('a campaign budget is a ceiling, not a switch');
  // ---------------------------------------------------------------------------

  const budgetKey = K('budgeted');
  await ruleApi.putEarningRule(A, {
    key: budgetKey, title: 'Fifteen diamonds a round', metric: 'STORE_PURCHASE', purpose: 'CAMPAIGN', campaignKey: cBudget.key,
    target: 1, rewardAmount: 15, rewardCurrency: 'BONUS_DIAMOND', reset: 'DAY', maxPerPeriod: 5,
  });
  const bonusBeforeBudget = await pocketOf(spender.id);
  const round1 = paidOf(await earn(spender.id, [{ metric: 'STORE_PURCHASE', amount: 1 }]), budgetKey);
  const round2 = paidOf(await earn(spender.id, [{ metric: 'STORE_PURCHASE', amount: 1 }]), budgetKey);
  const budgetRows = await attempts(spender.id, budgetKey);
  report('the first payout fits inside the budget', round1.length === 1 && (await pocketOf(spender.id)).bonus === bonusBeforeBudget.bonus + 15, {
    paid: round1, pocket: await pocketOf(spender.id),
  });
  report('a short budget waits rather than voiding the attempt',
    round2.length === 0 && budgetRows[1].status === 'OPEN' && budgetRows[1].progress === 1,
    { rows: budgetRows.map((r) => `${r.occurrence}:${r.status}`), paid: round2 });
  report('the campaign reports what it minted', (await ruleApi.getCampaign(cBudget.key)).spentDiamonds === 15, {
    spent: (await ruleApi.getCampaign(cBudget.key)).spentDiamonds,
  });
  await expectCode('a budget cannot drop below what the campaign minted', 'earning_budget_below_spend', () =>
    ruleApi.updateCampaign(A, cBudget.key, { budgetDiamonds: 5 }));

  await ruleApi.updateCampaign(A, cBudget.key, { budgetDiamonds: 100 });
  const round3 = paidOf(await earn(spender.id, [{ metric: 'STORE_PURCHASE', amount: 1 }]), budgetKey);
  const afterTopUp = await attempts(spender.id, budgetKey);
  report('the same attempt pays after the top-up', round3.length === 1 && round3[0].amount === 15 && afterTopUp[1].status === 'PAID', {
    paid: round3, statuses: afterTopUp.map((r) => r.status),
  });
  report('no attempt was skipped by waiting', afterTopUp.length === 2 && afterTopUp.every((r) => r.status === 'PAID'), afterTopUp.map((r) => r.occurrence));

  // ---------------------------------------------------------------------------
  section('closing a campaign is the terminal verb');
  // ---------------------------------------------------------------------------

  const closeKey = K('closing');
  await ruleApi.putEarningRule(A, {
    key: closeKey, title: 'Two joins', metric: 'ROOM_JOIN', purpose: 'EVENT', campaignKey: cClose.key,
    target: 2, rewardAmount: 6, rewardCurrency: 'XP', reset: 'DAY',
  });
  await earn(stale.id, [{ metric: 'ROOM_JOIN', amount: 1 }]);
  await ruleApi.updateCampaign(A, cClose.key, { status: 'CLOSED' });
  const closedRun = await earn(stale.id, [{ metric: 'ROOM_JOIN', amount: 1 }]);
  const closedRow = (await attempts(stale.id, closeKey))[0];
  report('a closed campaign neither starts nor continues', closedRun.length === 0 && closedRow.progress === 1 && closedRow.status === 'OPEN', closedRow);
  await engine.expireStaleActivities(500);
  const sweptClosed = (await attempts(stale.id, closeKey))[0];
  report('the sweep ages out what no approval can pay', sweptClosed.status === 'EXPIRED', sweptClosed);
  await expectCode('a closed campaign refuses a new rule', 'earning_campaign_closed', () =>
    ruleApi.putEarningRule(A, {
      key: K('afterclose'), title: 'nope', metric: 'ROOM_JOIN', purpose: 'EVENT', campaignKey: cClose.key,
      target: 1, rewardAmount: 1, rewardCurrency: 'XP',
    }));

  // A row whose rule window has genuinely ended is voided at pay time, not frozen.
  const windowKey = K('windowed');
  await ruleApi.putEarningRule(A, {
    key: windowKey, title: 'Submit with a deadline', metric: 'SUBMISSION', purpose: 'EVENT', campaignKey: c1.key,
    target: 1, rewardAmount: 40, rewardCurrency: 'XP', reset: 'DAY', requiresApproval: true,
  });
  const filed = await engine.claimEarning(claimer.id, { rule: windowKey, evidence: { note: 'did the thing' }, claimKey: `${stamp}-window` });
  report('a reviewed claim lands in the queue unpaid', filed.status === 'PENDING' && (await xpOf(claimer.id)) === 0, filed);
  // The row keeps its `ends_at > starts_at` CHECK, so closing the window for real means moving both
  // edges into the past rather than stamping a deadline before the rule's own start.
  await sql(`UPDATE earning_rules SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 minute' WHERE key = $1`, [windowKey]);
  const late = await engine.decideClaim(A, filed.activityId, true, 'approve after the deadline');
  report('approval cannot outlive the rule\'s own window',
    late.status === 'EXPIRED' && late.refusal === 'WINDOW_CLOSED' && (await payoutRows(claimer.id, windowKey)).length === 0 && (await xpOf(claimer.id)) === 0, late);

  // ---------------------------------------------------------------------------
  section('member claims: auto-paid, reviewed, replayed');
  // ---------------------------------------------------------------------------

  await expectCode('a server-counted rule has nothing to claim', 'earning_not_claimable', () =>
    engine.claimEarning(claimer.id, { rule: checkinKey, evidence: {} }));

  const autoKey = K('auto-claim');
  await ruleApi.putEarningRule(A, {
    key: autoKey, title: 'No review needed', metric: 'SUBMISSION', purpose: 'EVENT', campaignKey: c1.key,
    target: 1, rewardAmount: 5, rewardCurrency: 'BONUS_DIAMOND', reset: 'DAY',
  });
  const bonusBeforeClaim = await pocketOf(claimer.id);
  const autoClaim = await engine.claimEarning(claimer.id, { rule: autoKey, evidence: { screenshot: 'a.png' } });
  const autoRow = (await attempts(claimer.id, autoKey))[0];
  report('a claim without a review step pays on the spot',
    autoClaim.status === 'PAID' && autoClaim.payout.amount === 5 && (await pocketOf(claimer.id)).bonus === bonusBeforeClaim.bonus + 5, {
      status: autoClaim.status, pocket: await pocketOf(claimer.id),
    });
  report('the evidence is stored with the attempt it was filed with',
    autoRow.evidence && autoRow.evidence.screenshot === 'a.png' && autoRow.status === 'PAID', autoRow.evidence);

  const claimAgain = await engine.claimEarning(claimer.id, { rule: autoKey, evidence: {} });
  report('the same bucket cannot be claimed twice',
    claimAgain.status === 'PAID' && claimAgain.refusal === 'ALREADY_CLAIMED' && (await attempts(claimer.id, autoKey)).length === 1, claimAgain);

  await expectCode('evidence is a short flat object', 'earning_evidence_invalid', () =>
    engine.claimEarning(claimer.id, { rule: autoKey, evidence: ['one', 'two'] }));

  const reviewKey = K('reviewed');
  await ruleApi.putEarningRule(A, {
    key: reviewKey, title: 'Needs a person', metric: 'SUBMISSION', purpose: 'CAMPAIGN', campaignKey: c1.key,
    target: 1, rewardAmount: 30, rewardCurrency: 'XP', reset: 'DAY', requiresApproval: true,
  });
  const queued = await engine.claimEarning(claimer.id, { rule: reviewKey, evidence: { url: 'https://example/one' } });
  const queue = await engine.listPendingClaims(50);
  const mine = queue.find((c) => c.activityId === queued.activityId);
  report('the review queue shows the claim with its evidence',
    queued.status === 'PENDING' && !!mine && mine.evidence.url === 'https://example/one' && mine.ruleKey === reviewKey, mine);
  await expectCode('a refusal needs a note', 'earning_note_required', () => engine.decideClaim(A, queued.activityId, false, ''));
  const refused = await engine.decideClaim(A, queued.activityId, false, 'The screenshot is of a different campaign');
  report('refusal is recorded and pays nothing',
    refused.status === 'REFUSED' && (await xpOf(claimer.id)) === 0 && (await engine.listPendingClaims(50)).every((c) => c.activityId !== queued.activityId), refused);
  const retry = await engine.claimEarning(claimer.id, { rule: reviewKey, evidence: {} });
  report('a refused claim is not retryable by filing it again',
    retry.refusal === 'ALREADY_CLAIMED' && retry.status === 'REFUSED', retry);

  const reviewKey2 = K('approved');
  await ruleApi.putEarningRule(A, {
    key: reviewKey2, title: 'Approve me', metric: 'SUBMISSION', purpose: 'ACHIEVEMENT', campaignKey: c1.key,
    target: 1, rewardAmount: 40, rewardCurrency: 'XP', reset: 'DAY', requiresApproval: true,
  });
  const pending = await engine.claimEarning(claimer.id, { rule: reviewKey2, evidence: {} });
  const xpBeforeApprove = await xpOf(claimer.id);
  const approved = await engine.decideClaim(A, pending.activityId, true, 'verified by hand');
  const approvedPaid = await payoutRows(claimer.id, reviewKey2);
  report('approval pays the snapshot price once',
    approved.status === 'PAID' && approved.payout.amount === 40 && (await xpOf(claimer.id)) === xpBeforeApprove + 40 && approvedPaid.length === 1, approved);
  const decided = (await attempts(claimer.id, reviewKey2))[0];
  report('the decision is stamped on the claim', decided.status === 'PAID', decided);
  await expectCode('one claim is decided once', 'earning_claim_decided', () => engine.decideClaim(A, pending.activityId, true, 'again'));

  await ruleApi.setRuleActive(A, reviewKey2, false, 'suite: retiring to check the claim gate');
  await expectCode('a retired rule tells the member in words', 'earning_rule_retired', () =>
    engine.claimEarning(claimer.id, { rule: reviewKey2, evidence: {} }));

  const idemKey = K('replayed');
  await ruleApi.putEarningRule(A, {
    key: idemKey, title: 'Idempotent', metric: 'SUBMISSION', purpose: 'EVENT', campaignKey: c1.key,
    target: 1, rewardAmount: 3, rewardCurrency: 'XP', reset: 'DAY', maxPerPeriod: 5,
  });
  const key = `${stamp}-idem`;
  const firstClaim = await engine.claimEarning(claimer.id, { rule: idemKey, evidence: {}, claimKey: key });
  const xpAfterFirst = await xpOf(claimer.id);
  const secondClaim = await engine.claimEarning(claimer.id, { rule: idemKey, evidence: { other: 'body' }, claimKey: key });
  report('a retry with the same key gets the first answer',
    secondClaim.replay === true && secondClaim.status === 'PAID' && secondClaim.activityId === firstClaim.activityId && firstClaim.replay === false, {
      replay: secondClaim.replay, same: secondClaim.activityId === firstClaim.activityId,
    });
  report('and it moves no money', (await xpOf(claimer.id)) === xpAfterFirst && (await attempts(claimer.id, idemKey)).length === 1, {
    xp: await xpOf(claimer.id),
  });

  const raced = await Promise.all([
    engine.claimEarning(claimer.id, { rule: idemKey, evidence: {} }),
    engine.claimEarning(claimer.id, { rule: idemKey, evidence: {} }),
    engine.claimEarning(claimer.id, { rule: idemKey, evidence: {} }),
  ]);
  const raceRows = await attempts(claimer.id, idemKey);
  const racePaid = await payoutRows(claimer.id, idemKey);
  report('three racing claims serialise into distinct occurrences',
    raceRows.length === 4 && new Set(raceRows.map((r) => r.occurrence)).size === 4, raceRows.map((r) => r.occurrence));
  report('one payout per occurrence, no double-mint',
    racePaid.length === 4 && raced.filter((r) => r.status === 'PAID').length === 3, { payouts: racePaid.length });

  await sql(
    `INSERT INTO earning_activities (user_id, rule_id, rule_version, bucket, occurrence, target, reward_amount, reward_currency, purpose, progress, status)
     SELECT a.user_id, a.rule_id, a.rule_version, a.bucket, a.occurrence, a.target, a.reward_amount, a.reward_currency, a.purpose, a.target, 'OPEN'
       FROM earning_activities a
      WHERE a.id = (SELECT id FROM earning_activities WHERE user_id = $1 AND status = 'PAID' LIMIT 1)`,
    [claimer.id],
  ).then(
    () => report('the unique key refuses a duplicate attempt', false, 'insert succeeded'),
    (e) => report('the unique key refuses a duplicate attempt', e.code === '23505', { code: e.code }),
  );

  // ---------------------------------------------------------------------------
  section('reads, refusal-only edits and deletions');
  // ---------------------------------------------------------------------------

  const boardAfter = await engine.memberEarnings(m.id);
  const loginCard = boardAfter.rules.find((r) => r.ruleKey === loginKey);
  const claimCard = boardAfter.rules.find((r) => r.ruleKey === reviewKey);
  report('the board carries progress, period and price',
    loginCard && loginCard.progress === 3 && loginCard.status === 'PAID' && loginCard.bucket === today && loginCard.rewardAmount === 10, loginCard);
  report('only a submitted rule is offered as a claim',
    claimCard.claimable === true && loginCard.claimable === false, { claim: claimCard.claimable, login: loginCard.claimable });
  report('the board is bucketed from one clock', boardAfter.buckets.DAY === today, boardAfter.buckets);

  const byCampaign = await engine.adminPayouts({ campaignKey: cBudget.key, limit: 50 });
  report('an admin payout read filters by campaign',
    byCampaign.length === 2 && byCampaign.every((p) => p.purpose === 'CAMPAIGN' && p.currency === 'BONUS_DIAMOND'), byCampaign);
  const byMetric = await engine.adminPayouts({ campaignKey: c1.key, metric: 'CHECKIN_STREAK', limit: 50 });
  report('and by metric', byMetric.length === 1 && byMetric[0].amount === 20, byMetric);
  const listed = await ruleApi.listRules({ metric: 'SUBMISSION' });
  report('the catalogue lists a metric\'s rules newest first',
    listed.every((r) => r.metric === 'SUBMISSION') && listed.some((r) => r.key === idemKey), { count: listed.length });

  await expectCode('a rule with attempts is not deletable', 'earning_rule_in_use', () => ruleApi.deleteEarningRule(A, priceKey));
  await expectCode('a campaign with rules is not deletable', 'earning_campaign_in_use', () => ruleApi.deleteCampaign(A, c1.key));
  const unusedKey = K('unused');
  await ruleApi.putEarningRule(A, {
    key: unusedKey, title: 'Delete me', metric: 'CHAT_MESSAGE', purpose: 'QUEST', target: 1, rewardAmount: 1, rewardCurrency: 'XP',
  });
  const deleted = await ruleApi.deleteEarningRule(A, unusedKey);
  const deletedCampaign = await ruleApi.deleteCampaign(A, cSpare.key);
  report('a rule and a campaign nobody used do delete', deleted.key === unusedKey && deletedCampaign.key === cSpare.key, { deleted: deleted.key });
  await expectCode('an unknown rule key says so', 'earning_rule_not_found', () => ruleApi.getRule(K('never-existed')));

  // ---------------------------------------------------------------------------
  section('the sweep: yesterday is not today');
  // ---------------------------------------------------------------------------

  const yesterday = await row0(
    `SELECT to_char((now() AT TIME ZONE (SELECT reset_timezone FROM quest_settings WHERE singleton)) - interval '1 day', 'YYYY-MM-DD') AS bucket`,
  );
  const staleRule = await findRule(retireKey);
  const before = await engine.expireStaleActivities(500);
  await sql(
    `INSERT INTO earning_activities (user_id, rule_id, rule_version, campaign_id, bucket, occurrence, target, reward_amount, reward_currency, purpose, progress, status)
     VALUES ($1,$2,$3,$4,$5,1,3,12,'XP','CAMPAIGN',1,'OPEN')`,
    [stale.id, staleRule.id, staleRule.rule_version, staleRule.campaign_id, yesterday.bucket],
  );
  const swept2 = await engine.expireStaleActivities(500);
  const oldRow = await row0(
    `SELECT a.status FROM earning_activities a JOIN earning_rules r ON r.id = a.rule_id
      WHERE a.user_id = $1 AND a.bucket = $2 AND r.key = $3`,
    [stale.id, yesterday.bucket, retireKey],
  );
  const todayRow = (await attempts(m.id, retireKey))[0];
  report('a rolled-over bucket is aged out', swept2.expired > before.expired && oldRow.status === 'EXPIRED', {
    before: before.expired, after: swept2.expired, row: oldRow && oldRow.status,
  });
  report('the current bucket keeps its progress', todayRow.status === 'PAID' && todayRow.bucket === today, todayRow);

  // ---------------------------------------------------------------------------
  // nothing live is left behind: every rule this run published is retired and every
  // campaign it opened is closed, so a later member read cannot be answered by a fixture.
  // ---------------------------------------------------------------------------

  const leftovers = await sql('SELECT key FROM earning_rules WHERE key LIKE $1 AND is_active', [`e2e-${stamp}-%`]);
  for (const row of leftovers) await ruleApi.setRuleActive(A, row.key, false, 'suite cleanup');
  const openCampaigns = await sql('SELECT key FROM earning_campaigns WHERE key LIKE $1 AND status = \'LIVE\'', [`e2e-${stamp}-%`]);
  for (const row of openCampaigns) await ruleApi.updateCampaign(A, row.key, { status: 'CLOSED' });
  const stillLive = await sql(
    `SELECT (SELECT COUNT(*) FROM earning_rules WHERE key LIKE $1 AND is_active) AS rules,
            (SELECT COUNT(*) FROM earning_campaigns WHERE key LIKE $1 AND status = 'LIVE') AS campaigns`,
    [`e2e-${stamp}-%`],
  );
  report('the run leaves nothing live behind', Number(stillLive[0].rules) === 0 && Number(stillLive[0].campaigns) === 0, stillLive[0]);

  const decks = await ruleApi.listCampaigns(true);
  report('the run leaves no campaign switchable on',
    decks.filter((c) => c.key.startsWith(`e2e-${stamp}`)).every((c) => c.status !== 'LIVE'), {
      made: decks.filter((c) => c.key.startsWith(`e2e-${stamp}`)).length,
    });
})()
  .catch((e) => {
    failed += 1;
    const line = `THREW  ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)}`;
    out.push(line);
    console.log(line);
  })
  .finally(async () => {
    console.log(`\n${out.filter((l) => l.startsWith('PASS')).length} passed, ${failed} failed`);
    // Every handle the engine opened is closed before this exits: `dist/config/db` and `dist/config/redis`
    // both connect at import time, so a suite that printed its verdict and stayed running looks exactly
    // like one that hung.
    await Promise.all([pool.end(), db.closePool(), redisMod.redis.quit().catch(() => undefined)]);
    process.exitCode = failed ? 1 : 0;
  });
