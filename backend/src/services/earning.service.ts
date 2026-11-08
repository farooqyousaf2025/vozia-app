import { PoolClient } from 'pg';
import { many, one, pool, withTransaction } from '../config/db';
import { ApiError, requireString } from '../utils/http';
import { iso } from '../utils/serialize';
import { grantPromoDiamonds, PromoSourceKind } from './promo-diamond.service';
import { awardXp } from './rank.service';
import { emitToUser } from './socket.service';
import { recordAudit } from './audit.service';
import { claimIdempotency, completeIdempotency } from './purpose-account.service';
import {
  EARNING_METRIC_CATALOGUE,
  EarningMetric,
  EarningReset,
  RuleDto,
  latestRuleOn,
  liveRulesFor,
} from './earning-rule.service';

/**
 * The earning engine: it counts what members do, decides whether that earns anything, and pays it.
 *
 * 0038 put the tables in place; this file is the only path that may write them. Four rules hold the
 * whole design together, and each one is here because the obvious alternative is a bug in a wallet:
 *
 *   * **Numbers come from rows, never from a request.** A claim names a rule and attaches evidence.
 *     `target`, `reward_amount`, currency and the caps are read off the live rule version inside the
 *     transaction that pays, exactly as `commission.service` refuses a client-supplied rate.
 *   * **Progress is written by a server hook or by a claim, and the two are not interchangeable.**
 *     `EARNING_METRIC_CATALOGUE` says which metrics the platform can observe for itself; a member may
 *     only submit the one metric the catalogue marks as theirs, and only into a rule that an operator
 *     chose to make reviewable. Everything else would be a payout on the phone's say-so.
 *   * **The caps are answered with unique keys, not with counts.** `earning_activities` is keyed on
 *     `(user_id, rule_id, bucket, occurrence)` and `earning_payouts` on `activity_id`, so "twice a day"
 *     and "never twice for the same attempt" are both constraints Postgres enforces while two requests
 *     race, rather than a `COUNT(*)` each of them can pass.
 *   * **An attempt is claimed before it is paid.** `payActivity` flips the row to PAID with a
 *     conditional UPDATE and mints only if that flip took. Two transactions on one attempt therefore
 *     cannot both mint; the loser finds the row already terminal and does nothing.
 *
 * The reset period is a bucket string computed by PostgreSQL in `quest_settings.reset_timezone` — the
 * same definition of "today" the daily quests already use — so a new day needs no midnight job to be
 * counted correctly. The sweep at the bottom only ages rows out of the review queue; it is not what
 * makes the caps hold.
 */

export type ActivityStatus = 'OPEN' | 'PENDING' | 'PAID' | 'REFUSED' | 'EXPIRED';

type ActivityRow = {
  id: string;
  user_id: string;
  rule_id: string;
  rule_version: number;
  campaign_id: string | null;
  bucket: string;
  occurrence: number;
  target: number;
  reward_amount: number;
  reward_currency: 'XP' | 'BONUS_DIAMOND';
  purpose: string;
  progress: number;
  status: ActivityStatus;
  evidence: Record<string, unknown>;
  submitted_at: Date | string | null;
  decided_by: string | null;
  decided_at: Date | string | null;
  decision_note: string | null;
  paid_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type MemberRow = {
  id: string;
  user_type: string;
  status: string;
  vip_level: number;
  country_code: string | null;
  created_at: Date | string;
};

/**
 * One observable thing that happened. `amount` is how much it moved the counter (default 1; a
 * diamonds-spent event passes the diamonds), and `context` is what a rule may be conditioned on.
 * Neither field is accepted from a client — the callers are the ledger, chat, store, game and check-in
 * paths, and they pass what their own rows just recorded.
 */
export type EarningEvent = { metric: EarningMetric; amount?: number; context?: Record<string, unknown> };

/** A payout this engine made, in the shape the advance path returns to its caller. */
export type PayoutSummary = {
  activityId: string;
  ruleKey: string;
  metric: EarningMetric;
  currency: 'XP' | 'BONUS_DIAMOND';
  amount: number;
  bucket: string;
  occurrence: number;
};

/** Why an award did not move, in the engine's own vocabulary. `null` from a gate means "pay it". */
export type RefusalReason =
  | 'RULE_RETIRED'
  | 'RULE_CLOSED'
  | 'CAMPAIGN_CLOSED'
  | 'BUDGET_SPENT'
  | 'LIFETIME_CAP'
  | 'PERIOD_CAP'
  | 'ALREADY_PAID'
  | 'NOT_LIVE_YET'
  | 'WINDOW_CLOSED'
  | 'USER_TYPE'
  | 'COUNTRY'
  | 'VIP_LEVEL'
  | 'ACCOUNT_AGE'
  | 'ACCOUNT_STATUS'
  | 'ALREADY_CLAIMED';

// ---------------------------------------------------------------------------
// the bucket — what "this period" means, from PostgreSQL
// ---------------------------------------------------------------------------

/**
 * The current bucket for each reset period, in the platform's own timezone.
 *
 * One statement answers all four because a member's rules span them, and `to_char` rather than Node's
 * `Date` because the day a quest resets is already defined by `quest_settings.reset_timezone`. Two
 * definitions of "today" in one platform is how a daily cap becomes a twice-daily cap.
 */
/** The bucket each reset period names right now. Keyed by `earning_reset`, so a new dial cannot be
 *  added to the enum without this map answering for it. */
type Buckets = Record<EarningReset, string>;

async function currentBuckets(client: PoolClient): Promise<Buckets> {
  const row = await client.query<{ day: string; week: string; month: string }>(
    `SELECT to_char(local_now, 'YYYY-MM-DD') AS day,
            to_char(local_now, 'IYYY-"W"IW')  AS week,
            to_char(local_now, 'YYYY-MM')     AS month
       FROM (SELECT now() AT TIME ZONE reset_timezone AS local_now
               FROM quest_settings WHERE singleton) t`,
  );
  const found = row.rows[0];
  if (!found) throw new Error('quest_settings has no row — run npm run db:migrate before starting the API');
  // `NEVER` is not a period: every attempt at a one-off achievement shares the one bucket 'ALL', which
  // is what makes `max_per_period` on such a rule a lifetime cap expressed twice.
  return { DAY: found.day, WEEK: found.week, MONTH: found.month, NEVER: 'ALL' };
}

function bucketOf(buckets: Buckets, reset: RuleDto['reset']): string {
  return buckets[reset];
}

// ---------------------------------------------------------------------------
// eligibility and restrictions — pure, so the reads can explain a refusal
// ---------------------------------------------------------------------------

/**
 * What the member's own account says about this rule.
 *
 * Measured at the moment of the question, which is why account age is compared to `users.created_at`
 * rather than to when the attempt started: a rule that needs seven days cannot be started on day 6 and
 * finished on day 8 by waiting.
 */
export function eligibilityFailure(rule: RuleDto, member: MemberRow): RefusalReason | null {
  if (member.status !== 'ACTIVE') return 'ACCOUNT_STATUS';
  if (rule.eligibleUserTypes.length > 0 && !rule.eligibleUserTypes.includes(member.user_type)) return 'USER_TYPE';
  if (rule.eligibleCountries.length > 0) {
    const code = member.country_code?.toUpperCase() ?? null;
    if (!code || !rule.eligibleCountries.includes(code)) return 'COUNTRY';
  }
  if (member.vip_level < rule.minVipLevel) return 'VIP_LEVEL';
  if (rule.minAccountAgeDays > 0) {
    const ageDays = Math.floor((Date.now() - new Date(member.created_at).getTime()) / 86_400_000);
    if (ageDays < rule.minAccountAgeDays) return 'ACCOUNT_AGE';
  }
  return null;
}

/**
 * Whether one event's context satisfies the rule's conditions.
 *
 * The key on the left is what the operator chose; the value on the right is what the server observed.
 * A condition the metric's context cannot answer — a `gameKey` on a gift rule, which the write-side
 * validation should have refused — fails closed: no match, no progress. The alternative is a campaign
 * that pays everyone for something nobody checked.
 *
 * The answer is the name of the condition that failed, so a log line and a support read can both say
 * which filter the event did not clear.
 */
export function restrictionFailure(restrictions: Record<string, unknown>, context: Record<string, unknown>): string | null {
  for (const [key, expected] of Object.entries(restrictions ?? {})) {
    switch (key) {
      case 'minDiamonds':
        if (numberOr(context.diamonds, -1) < Number(expected)) return key;
        break;
      case 'minStreakDay':
        if (numberOr(context.streakDay, -1) < Number(expected)) return key;
        break;
      case 'giftCategory':
      case 'roomCategory':
      case 'gameKey':
      case 'itemKind':
        if (String(context[key] ?? '') !== String(expected)) return key;
        break;
      case 'luckyBox':
        if (Boolean(context.luckyBox) !== Boolean(expected)) return key;
        break;
      default:
        return key;
    }
  }
  return null;
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// the single money path
// ---------------------------------------------------------------------------

type PayGate = {
  campaignStatus: 'DRAFT' | 'LIVE' | 'CLOSED' | null;
  budgetDiamonds: number | null;
  ruleWindowClosed: boolean;
  campaignWindowClosed: boolean;
};

async function readPayGate(client: PoolClient, activity: ActivityRow): Promise<PayGate> {
  const rule = await client.query<{ ends_at: Date | null }>(
    'SELECT ends_at FROM earning_rules WHERE id = $1',
    [activity.rule_id],
  );
  const found = rule.rows[0];
  const gate: PayGate = {
    campaignStatus: null,
    budgetDiamonds: null,
    // A version the row was taken under that no longer exists is not a gate anyone can lift.
    ruleWindowClosed: !found || (found.ends_at !== null && new Date(found.ends_at).getTime() <= Date.now()),
    campaignWindowClosed: false,
  };
  if (activity.campaign_id) {
    // Locked, because the budget is checked against a sum over `earning_payouts` and every payout
    // takes this same lock first. An unlocked read would let two concurrent claims each see a
    // campaign with room left.
    const row = await client.query<{ status: PayGate['campaignStatus']; budget_diamonds: number | null; ends_at: Date | null }>(
      'SELECT status, budget_diamonds, ends_at FROM earning_campaigns WHERE id = $1 FOR UPDATE',
      [activity.campaign_id],
    );
    const campaign = row.rows[0];
    gate.campaignStatus = campaign?.status ?? 'CLOSED';
    gate.budgetDiamonds = campaign?.budget_diamonds ?? null;
    gate.campaignWindowClosed = !campaign || (campaign.ends_at !== null && new Date(campaign.ends_at).getTime() <= Date.now());
  }
  return gate;
}

/**
 * Pay one attempt, or explain why it cannot be paid.
 *
 * The caller already holds the lock on the member's `users` row. The order from there — campaign, then
 * activity, then payout/grant — is the same one the gift and promo paths use, which is what keeps two
 * coin-moving requests on one account from deadlocking in opposite directions.
 *
 * A gate that fails does not throw, and answers in two different ways. An ended rule or a closed
 * campaign is the end of that reward, so the attempt goes `EXPIRED`; a spent budget is a number an
 * operator can raise, so the attempt stays where it is and pays after the top-up. Nothing here looks at
 * `is_active`: retiring or superseding a version decides what *starts*, and a member who finished at
 * 09:00 is owed the price they were shown even if the rule was switched off at 09:30.
 */
async function payActivity(
  client: PoolClient,
  activity: ActivityRow,
  ruleKey: string,
  rule: RuleDto | null,
): Promise<{ payout: PayoutSummary | null; refusal?: RefusalReason; status: ActivityStatus }> {
  const gate = await readPayGate(client, activity);
  let refusal: RefusalReason | null = null;
  let terminal = true;

  if (gate.ruleWindowClosed) refusal = 'WINDOW_CLOSED';
  else if (activity.campaign_id && (gate.campaignStatus !== 'LIVE' || gate.campaignWindowClosed)) refusal = 'CAMPAIGN_CLOSED';

  if (!refusal && gate.budgetDiamonds !== null && activity.reward_currency === 'BONUS_DIAMOND') {
    const spent = await client.query<{ n: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS n FROM earning_payouts
        WHERE campaign_id = $1 AND currency = 'BONUS_DIAMOND'`,
      [activity.campaign_id],
    );
    if (Number(spent.rows[0].n) + activity.reward_amount > gate.budgetDiamonds) {
      refusal = 'BUDGET_SPENT';
      terminal = false;
    }
  }

  if (!refusal) {
    // The lifetime cap belongs to the rule, not to the version: an operator repricing a campaign must
    // not hand every member their allowance back.
    const cap = rule?.maxTotal ?? null;
    if (cap !== null) {
      const paid = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM earning_payouts p
          JOIN earning_rules r ON r.id = p.rule_id
         WHERE p.user_id = $1 AND r.key = $2`,
        [activity.user_id, ruleKey],
      );
      if (Number(paid.rows[0].n) >= cap) refusal = 'LIFETIME_CAP';
    }
  }

  if (refusal) {
    if (terminal) {
      await client.query("UPDATE earning_activities SET status = 'EXPIRED', updated_at = now() WHERE id = $1 AND status IN ('OPEN','PENDING')", [activity.id]);
    }
    return { payout: null, refusal, status: terminal ? 'EXPIRED' : activity.status };
  }

  // Claim the attempt. A row that is already terminal answers with no rows, and nothing is minted —
  // this statement, not the unique index below, is the ordinary guard; the index is the one that holds
  // when two transactions are inside this function at the same instant.
  const claimed = await client.query<{ id: string }>(
    `UPDATE earning_activities SET status = 'PAID', paid_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('OPEN','PENDING') RETURNING id`,
    [activity.id],
  );
  if (!claimed.rows.length) {
    // Someone else paid this attempt first — a racing hook, or a review click that landed twice. Read
    // the status back rather than assert it, so the answer the member gets is the row's, not a guess.
    const after = await client.query<{ status: ActivityStatus }>('SELECT status FROM earning_activities WHERE id = $1', [activity.id]);
    return { payout: null, refusal: 'ALREADY_PAID', status: after.rows[0]?.status ?? 'PAID' };
  }

  let promoGrantId: string | null = null;
  if (activity.reward_currency === 'BONUS_DIAMOND') {
    // The mint goes through 0036's module rather than a second `UPDATE users`: the coins arrive as a
    // grant with its own expiry, its `PROMO_GRANT` journal line against `COIN_LIABILITY`, and its own
    // dedupe key. `source_id = activity.id` is also why a replayed payout cannot mint twice.
    const grant = await grantPromoDiamonds(
      {
        userId: activity.user_id,
        amount: activity.reward_amount,
        sourceKind: activity.purpose as PromoSourceKind,
        sourceId: activity.id,
        reason: `${ruleKey}: ${activity.reward_amount} bonus diamonds for bucket ${activity.bucket}`,
      },
      client,
    );
    promoGrantId = grant.grant.id;
  } else {
    await awardXp(client, activity.user_id, activity.reward_amount);
  }

  await client.query(
    `INSERT INTO earning_payouts
       (activity_id, user_id, rule_id, rule_version, campaign_id, bucket, occurrence, metric, purpose, currency, amount, promo_grant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text,$11,$12)`,
    [
      activity.id,
      activity.user_id,
      activity.rule_id,
      activity.rule_version,
      activity.campaign_id,
      activity.bucket,
      activity.occurrence,
      // The metric is not on the activity row — the rule is, and this function was reached either from
      // a hook that knows it or from a review read that joined it. `purpose` is snapshotted; the metric
      // is taken from the rule the row points at, so a payout row can be filtered by signal.
      rule?.metric ?? 'SUBMISSION',
      activity.purpose,
      activity.reward_currency,
      activity.reward_amount,
      promoGrantId,
    ],
  );

  return {
    payout: {
      activityId: activity.id,
      ruleKey,
      metric: rule?.metric ?? 'SUBMISSION',
      currency: activity.reward_currency,
      amount: activity.reward_amount,
      bucket: activity.bucket,
      occurrence: activity.occurrence,
    },
    status: 'PAID',
  };
}

// ---------------------------------------------------------------------------
// the counter
// ---------------------------------------------------------------------------

/**
 * The member's current attempt at this rule in this bucket, newest occurrence first.
 *
 * Keyed on the rule's `key`, not its id, so a version published mid-bucket continues the same
 * occurrence series instead of handing everyone a fresh allowance. `FOR UPDATE OF a` only: the join to
 * `earning_rules` is a read of a row other transactions may be publishing.
 */
async function currentAttempt(client: PoolClient, userId: string, ruleKey: string, bucket: string): Promise<ActivityRow | null> {
  const rows = await client.query<ActivityRow>(
    `SELECT a.* FROM earning_activities a
      JOIN earning_rules r ON r.id = a.rule_id
     WHERE a.user_id = $1 AND r.key = $2 AND a.bucket = $3
     ORDER BY a.occurrence DESC LIMIT 1
       FOR UPDATE OF a`,
    [userId, ruleKey, bucket],
  );
  return rows.rows[0] ?? null;
}

async function payoutCount(client: PoolClient, userId: string, ruleKey: string): Promise<number> {
  const row = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM earning_payouts p
      JOIN earning_rules r ON r.id = p.rule_id
     WHERE p.user_id = $1 AND r.key = $2`,
    [userId, ruleKey],
  );
  return Number(row.rows[0]?.n ?? 0);
}

/**
 * Advance every live rule listening to the event, and pay the ones that just finished.
 *
 * Must run on the client that is already inside the transaction which recorded the qualifying action —
 * the gift ledger, the chat insert, the store purchase, the game settlement — so an event that rolls
 * back leaves neither progress nor a payout behind. That is the same contract `recordQuestProgress`
 * has always had, and this function is called beside it.
 *
 * It never throws on business grounds. A campaign whose budget ran out must not fail a member's gift
 * send; the reason is returned so the caller can log it and the money path stays whole.
 */
export async function recordEarningProgress(
  client: PoolClient,
  userId: string,
  events: EarningEvent[],
): Promise<{ paid: PayoutSummary[]; skipped: Array<{ ruleKey: string; reason: RefusalReason }> }> {
  const paid: PayoutSummary[] = [];
  const skipped: Array<{ ruleKey: string; reason: RefusalReason }> = [];

  const usable = events
    .map((event) => ({ metric: event.metric, amount: Math.floor(event.amount ?? 1), context: event.context ?? {} }))
    .filter((event) => event.amount > 0 && EARNING_METRIC_CATALOGUE[event.metric]?.countedBy === 'SERVER');
  if (usable.length === 0) return { paid, skipped };

  // The account is locked first, in the order every coin path in this backend uses. Both the member's
  // purchased and bonus balances, their XP, and this engine's attempts hang off this one row.
  const member = await client.query<MemberRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const holder = member.rows[0];
  if (!holder) return { paid, skipped };

  const buckets = await currentBuckets(client);

  for (const event of usable) {
    const rules = await liveRulesFor(client, event.metric);
    // One rule *key* may only have one live version; `liveRulesFor` orders newest-first, so the first
    // row per key is the one that answers. Anything else is a hand-edited table, and paying both would
    // be paying twice for one event.
    const byKey = new Map<string, RuleDto>();
    for (const rule of rules) if (!byKey.has(rule.key)) byKey.set(rule.key, rule);

    for (const rule of byKey.values()) {
      if (eligibilityFailure(rule, holder)) continue;
      if (restrictionFailure(rule.restrictions, event.context)) continue;

      const bucket = bucketOf(buckets, rule.reset);
      const mode = progressModeOf(rule);
      // What one event is worth on a fresh row: a counter adds, a level records. Doing this on the
      // INSERT rather than as a follow-up UPDATE keeps one statement per new attempt — and a streak row
      // that SUMMED its days would reach a 7-day target in three check-ins.
      const opening = mode === 'MAX' ? event.amount : Math.min(rule.target, event.amount);

      const existing = await currentAttempt(client, userId, rule.key, bucket);
      let occurrence = 1;
      let row: ActivityRow | null = null;

      if (existing && existing.status === 'OPEN') {
        const progressed = await client.query<ActivityRow>(
          mode === 'MAX'
            ? `UPDATE earning_activities SET progress = GREATEST(progress, $2), updated_at = now()
                WHERE id = $1 RETURNING *`
            : `UPDATE earning_activities SET progress = LEAST(target, progress + $2), updated_at = now()
                WHERE id = $1 RETURNING *`,
          [existing.id, event.amount],
        );
        row = progressed.rows[0] ?? null;
      } else if (existing && existing.status === 'PAID') {
        // The bucket's allowance is spent up to this occurrence number. `max_per_period` is arithmetic
        // here only because the unique key below is what actually decides; a count that two racing
        // requests both pass would be a cap with a hole in it.
        if (existing.occurrence >= rule.maxPerPeriod) {
          skipped.push({ ruleKey: rule.key, reason: 'PERIOD_CAP' });
          continue;
        }
        occurrence = existing.occurrence + 1;
      } else if (existing) {
        // PENDING, REFUSED and EXPIRED are terminal for their occurrence, and a refused claim in
        // particular must not be retryable by simply doing the thing again.
        skipped.push({ ruleKey: rule.key, reason: 'ALREADY_CLAIMED' });
        continue;
      }

      if (!row) {
        if (rule.maxTotal !== null && (await payoutCount(client, userId, rule.key)) >= rule.maxTotal) {
          skipped.push({ ruleKey: rule.key, reason: 'LIFETIME_CAP' });
          continue;
        }
        const first = await client.query<ActivityRow>(
          `INSERT INTO earning_activities
             (user_id, rule_id, rule_version, campaign_id, bucket, occurrence, target, reward_amount,
              reward_currency, purpose, progress, status, evidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN','{}'::jsonb)
           ON CONFLICT (user_id, rule_id, bucket, occurrence) DO NOTHING
           RETURNING *`,
          [
            userId,
            rule.id,
            rule.ruleVersion,
            rule.campaignId,
            bucket,
            occurrence,
            rule.target,
            rule.rewardAmount,
            rule.rewardCurrency,
            rule.purpose,
            opening,
          ],
        );
        row = first.rows[0] ?? null;
        if (!row) continue;
      }

      if (row.progress < row.target) continue;

      const outcome = await payActivity(client, row, rule.key, rule);
      if (outcome.payout) paid.push(outcome.payout);
      else if (outcome.refusal && outcome.refusal !== 'ALREADY_PAID') skipped.push({ ruleKey: rule.key, reason: outcome.refusal });
    }
  }

  return { paid, skipped };
}

/**
 * The catalogue's answer for a rule's metric, needed by the advance path but owned by the rule file.
 * Derived rather than stored: `MAX` versus `ADD` is a fact about the signal, not a choice on the row.
 */
function progressModeOf(rule: RuleDto): 'ADD' | 'MAX' {
  return EARNING_METRIC_CATALOGUE[rule.metric].progress;
}

// ---------------------------------------------------------------------------
// the member's claim
// ---------------------------------------------------------------------------

/** Evidence is for a human, so it stays short, flat and readable in a queue. */
function validateEvidence(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('evidence must be an object of short answers', 'earning_evidence_invalid');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 8) throw ApiError.badRequest('evidence accepts at most 8 answers', 'earning_evidence_invalid');
  const out: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    const name = requireString(key, 'evidence key', { min: 1, max: 40 });
    if (typeof raw === 'number' && Number.isFinite(raw)) out[name] = raw;
    else if (typeof raw === 'boolean') out[name] = raw;
    else out[name] = requireString(raw, `evidence.${name}`, { min: 1, max: 200 });
  }
  if (JSON.stringify(out).length > 2000) throw ApiError.badRequest('evidence is too long', 'earning_evidence_invalid');
  return out;
}

/**
 * File a claim against a rule the member says they satisfied.
 *
 * Only a `SUBMISSION` rule can be claimed, and the amount is never in the body: the engine reads the
 * live version's price, its caps and its approval flag, then either pays inside this transaction or
 * puts the attempt in the review queue. An optional idempotency key uses the same
 * `idempotent_requests` claim the finance paths use, so a phone that retries gets the first answer
 * instead of a second refusal.
 */
export async function claimEarning(
  userId: string,
  input: { rule: string; evidence?: unknown; claimKey?: string },
): Promise<{ status: ActivityStatus | null; activityId: string | null; payout: PayoutSummary | null; refusal?: RefusalReason; replay: boolean }> {
  const result = await withTransaction(async (client) => {
    // The key is claimed and filled in the same transaction as the claim itself: a result recorded
    // after commit is a window in which the row exists with no answer, and every retry in that window
    // is told "still being processing" by a request that already finished.
    let claimKey: string | null = null;
    if (input.claimKey) {
      const claim = await claimIdempotency(client, 'EARNING_CLAIM', input.claimKey, null);
      if (claim.replay) {
        const body = (claim.response ?? {}) as Partial<ClaimOutcome>;
        return {
          status: body.status ?? null,
          activityId: body.activityId ?? null,
          payout: body.payout ?? null,
          refusal: body.refusal,
          replay: true,
        };
      }
      claimKey = input.claimKey;
    }
    const finish = async (outcome: ClaimOutcome): Promise<ClaimOutcome> => {
      if (claimKey && outcome.activityId) {
        await completeIdempotency(client, 'EARNING_CLAIM', claimKey, outcome.activityId, {
          status: outcome.status,
          activityId: outcome.activityId,
          payout: outcome.payout,
          refusal: outcome.refusal ?? null,
        });
      }
      return outcome;
    };

    const member = await client.query<MemberRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const holder = member.rows[0];
    if (!holder) throw ApiError.notFound('Account not found', 'user_not_found');

    const rule = await latestRuleOn(client, input.rule);
    if (!rule) throw ApiError.notFound('Earning rule not found', 'earning_rule_not_found');
    if (rule.countedBy !== 'MEMBER') {
      throw ApiError.badRequest(
        `${rule.metric} is counted by the platform, so there is nothing to claim — do the activity and the rule advances itself`,
        'earning_not_claimable',
      );
    }
    if (!rule.isActive) throw ApiError.forbidden('This reward has been retired', 'earning_rule_retired', { reason: 'RULE_RETIRED' });
    if (new Date(rule.startsAt).getTime() > Date.now()) throw ApiError.forbidden('This reward has not started yet', 'earning_not_started', { reason: 'NOT_LIVE_YET' });
    if (rule.endsAt && new Date(rule.endsAt).getTime() <= Date.now()) throw ApiError.forbidden('This reward has ended', 'earning_window_closed', { reason: 'WINDOW_CLOSED' });
    if (rule.campaignId && rule.campaignStatus !== 'LIVE') throw ApiError.forbidden('This campaign is not running', 'earning_campaign_closed', { reason: 'CAMPAIGN_CLOSED' });

    const reason = eligibilityFailure(rule, holder);
    if (reason) throw ApiError.forbidden('This account is not eligible for that reward', 'earning_not_eligible', { reason });

    const evidence = validateEvidence(input.evidence);
    const buckets = await currentBuckets(client);
    const bucket = bucketOf(buckets, rule.reset);
    const attempt = await currentAttempt(client, userId, rule.key, bucket);

    if (attempt) {
      // A claim is one submission, and a bucket holds one at a time. `PAID` is the friendly case — the
      // member already got this bucket's award — so it answers with that rather than a 403, and only
      // opens a further occurrence while the period cap leaves room for one.
      if (attempt.status !== 'PAID' || rule.maxPerPeriod <= attempt.occurrence) {
        return finish({ status: attempt.status, activityId: attempt.id, payout: null, refusal: 'ALREADY_CLAIMED', replay: false });
      }
    }
    if (rule.maxTotal !== null && (await payoutCount(client, userId, rule.key)) >= rule.maxTotal) {
      return finish({ status: null, activityId: null, payout: null, refusal: 'LIFETIME_CAP', replay: false });
    }
    const occurrence = attempt ? attempt.occurrence + 1 : 1;

    const inserted = await client.query<ActivityRow>(
      `INSERT INTO earning_activities
         (user_id, rule_id, rule_version, campaign_id, bucket, occurrence, target, reward_amount,
          reward_currency, purpose, progress, status, evidence, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::earning_activity_status,$13::jsonb,$14)
       ON CONFLICT (user_id, rule_id, bucket, occurrence) DO NOTHING
       RETURNING *`,
      [
        userId,
        rule.id,
        rule.ruleVersion,
        rule.campaignId,
        bucket,
        occurrence,
        rule.target,
        rule.rewardAmount,
        rule.rewardCurrency,
        rule.purpose,
        // The submission *is* the event: progress opens at the target, and what the attempt still
        // lacks is either an operator's decision or nothing at all.
        rule.target,
        rule.requiresApproval ? 'PENDING' : 'OPEN',
        JSON.stringify(evidence),
        rule.requiresApproval ? new Date() : null,
      ],
    );
    const row = inserted.rows[0];
    if (!row) {
      // Two phones filing the same bucket at the same instant. The unique key decides, and the loser
      // reads back the winner's row instead of surfacing a duplicate-key error from a money path.
      const raced = await client.query<ActivityRow>(
        `SELECT * FROM earning_activities WHERE user_id = $1 AND rule_id = $2 AND bucket = $3 AND occurrence = $4`,
        [userId, rule.id, bucket, occurrence],
      );
      const winner = raced.rows[0] ?? null;
      return finish({
        status: winner?.status ?? null,
        activityId: winner?.id ?? null,
        payout: null,
        refusal: 'ALREADY_CLAIMED',
        replay: false,
      });
    }

    if (rule.requiresApproval) {
      return finish({ status: 'PENDING', activityId: row.id, payout: null, replay: false });
    }
    // `payActivity` answers with the row's real status: a claim the campaign's budget is short of stays
    // `OPEN` and pays after a top-up, while one under an ended rule or a closed campaign goes `EXPIRED`.
    const outcome = await payActivity(client, row, rule.key, rule);
    return finish({
      status: outcome.status,
      activityId: row.id,
      payout: outcome.payout,
      refusal: outcome.refusal,
      replay: false,
    });
  });

  if (result.payout?.currency === 'BONUS_DIAMOND') await announceBonusChange([userId]);
  return result;
}

type ClaimOutcome = {
  /** The attempt's status, or null when no attempt was filed — a capped member has nothing on record. */
  status: ActivityStatus | null;
  activityId: string | null;
  payout: PayoutSummary | null;
  refusal?: RefusalReason;
  replay: boolean;
};

// ---------------------------------------------------------------------------
// the review queue
// ---------------------------------------------------------------------------

export type PendingClaimDto = {
  activityId: string;
  userId: string;
  username: string | null;
  ruleKey: string;
  ruleTitle: string;
  ruleVersion: number;
  campaignKey: string | null;
  bucket: string;
  occurrence: number;
  rewardAmount: number;
  rewardCurrency: 'XP' | 'BONUS_DIAMOND';
  evidence: Record<string, unknown>;
  submittedAt: string;
};

export async function listPendingClaims(limit = 50): Promise<PendingClaimDto[]> {
  const rows = await many<ActivityRow & { username: string | null; rule_key: string; rule_title: string; rule_version_col: number; campaign_key: string | null }>(
    `SELECT a.*, u.username, r.key AS rule_key, r.title AS rule_title, r.rule_version AS rule_version_col, c.key AS campaign_key
       FROM earning_activities a
       JOIN users u ON u.id = a.user_id
       JOIN earning_rules r ON r.id = a.rule_id
       LEFT JOIN earning_campaigns c ON c.id = a.campaign_id
      WHERE a.status = 'PENDING'
      ORDER BY a.submitted_at
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((row) => ({
    activityId: row.id,
    userId: row.user_id,
    username: row.username,
    ruleKey: row.rule_key,
    ruleTitle: row.rule_title,
    ruleVersion: row.rule_version_col,
    campaignKey: row.campaign_key,
    bucket: row.bucket,
    occurrence: row.occurrence,
    rewardAmount: row.reward_amount,
    rewardCurrency: row.reward_currency,
    evidence: row.evidence ?? {},
    submittedAt: iso(row.submitted_at ?? row.created_at),
  }));
}

/**
 * Approve or refuse a queued claim.
 *
 * Approval goes through `payActivity`, which re-checks the campaign budget, the lifetime cap and the
 * rule's window at the moment of the click: a claim that sat in the queue for a week is not owed its
 * price just because the campaign was open when it was filed. Refusal requires a note — the schema
 * allows a blank one, and the queue should not offer an unanswerable "no".
 */
export async function decideClaim(
  adminId: string,
  activityId: string,
  approve: boolean,
  note: string,
): Promise<{ status: ActivityStatus; payout: PayoutSummary | null; refusal: RefusalReason | null }> {
  const reason = note.trim();
  if (!approve && reason.length < 3) {
    throw ApiError.badRequest('A refusal needs a note the member can be shown', 'earning_note_required');
  }
  const outcome = await withTransaction(async (client) => {
    const found = await client.query<ActivityRow & { rule_key: string }>(
      `SELECT a.*, r.key AS rule_key FROM earning_activities a
        JOIN earning_rules r ON r.id = a.rule_id
       WHERE a.id = $1
         FOR UPDATE OF a`,
      [activityId],
    );
    const activity = found.rows[0];
    if (!activity) throw ApiError.notFound('Claim not found', 'earning_activity_not_found');
    if (activity.status !== 'PENDING') {
      throw ApiError.conflict(`That claim is already ${activity.status.toLowerCase()}`, 'earning_claim_decided');
    }
    // The lock order the money paths use: member, then campaign, then attempt. Reading the member here
    // also gives the review the same eligibility re-check the claim got.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [activity.user_id]);

    if (!approve) {
      await client.query(
        `UPDATE earning_activities
            SET status = 'REFUSED', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now()
          WHERE id = $1`,
        [activity.id, adminId, reason.slice(0, 300)],
      );
      return { status: 'REFUSED' as ActivityStatus, payout: null as PayoutSummary | null, refusal: null as RefusalReason | null };
    }

    const rule = await latestRuleOn(client, activity.rule_id);
    const paid = await payActivity(client, activity, activity.rule_key, rule);
    // Only a decided claim gets a decision stamp. One the budget is currently short of stays in the
    // queue, unsigned, so the operator who tops the campaign up sees it again and approves it then.
    if (paid.status !== 'PENDING') {
      await client.query(
        `UPDATE earning_activities
            SET decided_by = $2, decided_at = now(), decision_note = $3
          WHERE id = $1`,
        [activity.id, adminId, reason ? reason.slice(0, 300) : null],
      );
    }
    return {
      status: paid.status,
      payout: paid.payout,
      refusal: paid.refusal ?? null,
    };
  });

  await recordAudit({
    adminId,
    action: approve ? 'EARNING_APPROVE' : 'EARNING_REFUSE',
    targetType: 'earning_activity',
    targetId: activityId,
    summary: approve
      ? `Claim ${activityId} approved: ${outcome.payout ? `${outcome.payout.amount} ${outcome.payout.currency}` : `not paid (${outcome.refusal})`}`
      : `Claim ${activityId} refused: ${reason}`,
    details: { approve, note: reason || null, payout: outcome.payout, refusal: outcome.refusal },
  });

  if (outcome.payout?.currency === 'BONUS_DIAMOND') {
    const row = await one<ActivityRow>('SELECT user_id FROM earning_activities WHERE id = $1', [activityId]);
    if (row) await announceBonusChange([row.user_id]);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export type MemberEarningRuleDto = {
  ruleKey: string;
  title: string;
  description: string;
  metric: EarningMetric;
  purpose: string;
  campaignKey: string | null;
  target: number;
  progress: number;
  occurrence: number | null;
  status: ActivityStatus | null;
  rewardAmount: number;
  rewardCurrency: 'XP' | 'BONUS_DIAMOND';
  reset: RuleDto['reset'];
  bucket: string;
  maxPerPeriod: number;
  requiresApproval: boolean;
  endsAt: string | null;
  /** Whether this account may advance the rule at all, with the reason when it may not. */
  eligible: boolean;
  reason: RefusalReason | null;
  /** A rule the member can submit against, rather than do. The app shows a button only here. */
  claimable: boolean;
};

export type PayoutDto = {
  id: string;
  ruleKey: string;
  campaignKey: string | null;
  metric: string;
  purpose: string;
  bucket: string;
  occurrence: number;
  currency: 'XP' | 'BONUS_DIAMOND';
  amount: number;
  createdAt: string;
};

/**
 * What the member's earnings screen reads: every live rule, this account's attempt in the current
 * bucket, and what the engine has actually paid recently.
 *
 * The rule list comes from the live read rather than from the member's history, because "what could I
 * still earn today" is the question the screen answers — and an ineligible rule is returned with the
 * reason instead of being dropped, so the app can say why a card is greyed rather than showing a
 * reward that never appears.
 */
export async function memberEarnings(userId: string): Promise<{ buckets: Record<string, string>; rules: MemberEarningRuleDto[]; payouts: PayoutDto[] }> {
  return withTransaction(async (client) => {
    const member = await client.query<MemberRow>('SELECT * FROM users WHERE id = $1', [userId]);
    const holder = member.rows[0];
    if (!holder) throw ApiError.notFound('Account not found', 'user_not_found');

    const buckets = await currentBuckets(client);
    // `liveRulesFor` is per metric because that is the index the advance path uses; the member read
    // wants every metric at once, so the ten small reads happen here rather than adding an unindexed
    // scan to the hot path. Rule tables stay in the dozens of rows — this is a config read, not a feed.
    const rules = new Map<string, RuleDto>();
    for (const metric of Object.keys(EARNING_METRIC_CATALOGUE) as EarningMetric[]) {
      for (const rule of await liveRulesFor(client, metric)) {
        if (!rules.has(rule.key)) rules.set(rule.key, rule);
      }
    }

    const attempts = await client.query<ActivityRow & { rule_key: string }>(
      `SELECT a.*, r.key AS rule_key FROM earning_activities a
        JOIN earning_rules r ON r.id = a.rule_id
       WHERE a.user_id = $1
         AND a.bucket IN ($2,$3,$4,'ALL')
       ORDER BY a.bucket DESC, a.occurrence DESC`,
      [userId, buckets.DAY, buckets.WEEK, buckets.MONTH],
    );
    const latest = new Map<string, ActivityRow & { rule_key: string }>();
    for (const row of attempts.rows) if (!latest.has(row.rule_key)) latest.set(row.rule_key, row);

    const rulesDto: MemberEarningRuleDto[] = [...rules.values()].map((rule) => {
      const bucket = bucketOf(buckets, rule.reset);
      const attempt = latest.get(rule.key);
      const reason = eligibilityFailure(rule, holder);
      return {
        ruleKey: rule.key,
        title: rule.title,
        description: rule.description,
        metric: rule.metric,
        purpose: rule.purpose,
        campaignKey: rule.campaignKey,
        target: attempt?.target ?? rule.target,
        progress: attempt?.progress ?? 0,
        occurrence: attempt?.occurrence ?? null,
        status: attempt?.status ?? null,
        rewardAmount: attempt?.reward_amount ?? rule.rewardAmount,
        rewardCurrency: attempt?.reward_currency ?? rule.rewardCurrency,
        reset: rule.reset,
        bucket,
        maxPerPeriod: rule.maxPerPeriod,
        requiresApproval: rule.requiresApproval,
        endsAt: rule.endsAt,
        eligible: reason === null,
        reason,
        claimable: rule.countedBy === 'MEMBER' && (attempt === undefined || (attempt.status === 'PAID' && attempt.occurrence < rule.maxPerPeriod)),
      };
    });

    const payouts = await listPayouts(client, { userId, limit: 20 });
    return { buckets, rules: rulesDto, payouts };
  });
}

export async function listPayouts(
  client: PoolClient,
  opts: { userId?: string; campaignKey?: string; metric?: string; limit?: number },
): Promise<PayoutDto[]> {
  const rows = await client.query<{
    id: string;
    rule_key: string;
    campaign_key: string | null;
    metric: string;
    purpose: string;
    bucket: string;
    occurrence: number;
    currency: 'XP' | 'BONUS_DIAMOND';
    amount: number;
    created_at: Date;
  }>(
    `SELECT p.id, r.key AS rule_key, c.key AS campaign_key, p.metric, p.purpose, p.bucket, p.occurrence,
            p.currency, p.amount, p.created_at
       FROM earning_payouts p
       JOIN earning_rules r ON r.id = p.rule_id
       LEFT JOIN earning_campaigns c ON c.id = p.campaign_id
      WHERE ($1::uuid IS NULL OR p.user_id = $1)
        AND ($2::text IS NULL OR c.key = $2)
        AND ($3::text IS NULL OR p.metric = $3)
      ORDER BY p.created_at DESC
      LIMIT $4`,
    [opts.userId ?? null, opts.campaignKey ?? null, opts.metric ?? null, Math.min(opts.limit ?? 50, 200)],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    ruleKey: row.rule_key,
    campaignKey: row.campaign_key,
    metric: row.metric,
    purpose: row.purpose,
    bucket: row.bucket,
    occurrence: row.occurrence,
    currency: row.currency,
    amount: row.amount,
    createdAt: iso(row.created_at),
  }));
}

/** The same read, for the back office, without a member bound to it. */
export async function adminPayouts(opts: { campaignKey?: string; metric?: string; limit?: number }): Promise<PayoutDto[]> {
  return withTransaction((client) => listPayouts(client, opts));
}

// ---------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------

/**
 * Age out the attempts that can no longer be paid.
 *
 * Three deaths, and none of them is what makes the caps hold: a row whose bucket has already rolled over
 * (yesterday's DAY attempt is not today's, and a new bucket simply gets a new row), a row whose rule
 * window has closed, and a row whose campaign has been CLOSED. The last two are what an operator does
 * when a reward is finished — no approval can pay them, so they leave the member's list.
 *
 * `is_active = false` is deliberately *not* one of them: retiring or superseding a version decides what
 * *starts*, an operator reverses it without repricing anything, and members who were three gifts in
 * should find the same progress — at the same snapshot price — when it comes back.
 */
export async function expireStaleActivities(limit = 500): Promise<{ expired: number }> {
  return withTransaction(async (client) => {
    const buckets = await currentBuckets(client);
    const rows = await client.query<{ id: string }>(
      `UPDATE earning_activities
          SET status = 'EXPIRED', updated_at = now()
        WHERE id IN (
          SELECT a.id FROM earning_activities a
            JOIN earning_rules r ON r.id = a.rule_id
            LEFT JOIN earning_campaigns c ON c.id = a.campaign_id
           WHERE a.status IN ('OPEN','PENDING')
             AND (r.ends_at <= now()
                  OR c.status = 'CLOSED'
                  OR a.bucket < CASE r.reset
                                  WHEN 'DAY' THEN $1
                                  WHEN 'WEEK' THEN $2
                                  WHEN 'MONTH' THEN $3
                                  ELSE 'ALL'
                                END)
           ORDER BY a.created_at
           LIMIT $4)
        RETURNING id`,
      [buckets.DAY, buckets.WEEK, buckets.MONTH, Math.min(limit, 5000)],
    );
    return { expired: rows.rowCount ?? rows.rows.length };
  });
}

// ---------------------------------------------------------------------------
// the socket, after the money
// ---------------------------------------------------------------------------

/**
 * Whether a hook must go looking for a fact no rule asked for.
 *
 * `CHAT_MESSAGE` is the metric whose condition — the room's category — costs an extra read on the
 * hottest path in the service. A hook that always paid it would slow down every message to satisfy a
 * filter only some campaigns use, so the question is asked first and answered from the live rules.
 */
export async function needsContext(metric: EarningMetric): Promise<boolean> {
  const client = await pool.connect();
  try {
    const rules = await liveRulesFor(client, metric);
    return rules.some((rule) => Object.keys(rule.restrictions ?? {}).length > 0);
  } finally {
    client.release();
  }
}

/**
 * Tell the phone its bonus pocket changed.
 *
 * After commit, and read back from the database rather than added up from the payouts: `wallet:update`
 * carries a balance, and a balance the server assembled from its own arithmetic is the one the app can
 * trust. XP payouts need no event — the profile read carries XP, and there is no wallet to redraw.
 */
export async function announceBonusChange(userIds: readonly string[]): Promise<void> {
  for (const userId of userIds) {
    const row = await one<{ promo_diamond_balance: number }>('SELECT promo_diamond_balance FROM users WHERE id = $1', [userId]);
    if (row) emitToUser(userId, 'wallet:update', { promoDiamondBalance: row.promo_diamond_balance });
  }
}

/** The hook surface for callers that are not in a transaction and must not fail because of it. */
export async function recordEarningProgressOutside(userId: string, events: EarningEvent[]): Promise<void> {
  const { paid } = await withTransaction((client) => recordEarningProgress(client, userId, events));
  if (paid.some((payout) => payout.currency === 'BONUS_DIAMOND')) {
    await announceBonusChange([userId]);
  }
}

/**
 * The wrapper the gift, chat, store, game and check-in paths call from inside their own transaction.
 * Returns what was paid so the caller can emit after commit; a business refusal is reported in the
 * value, never thrown, because an expired campaign must not fail the request that earned it.
 */
export async function earnWithin(client: PoolClient, userId: string, events: EarningEvent[]): Promise<PayoutSummary[]> {
  const { paid } = await recordEarningProgress(client, userId, events);
  return paid;
}
