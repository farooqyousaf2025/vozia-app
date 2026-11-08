import { PoolClient } from 'pg';
import { many, one, withTransaction } from '../config/db';
import { ApiError, requireBoolean, requireEnum, requireInt, requireString } from '../utils/http';
import { iso } from '../utils/serialize';
import { recordAudit } from './audit.service';

/**
 * The earning rules and campaigns an operator writes, and the vocabulary the engine pays from.
 *
 * This file owns the *catalogue*: the closed list of metrics, which of them a server hook can be
 * trusted to count and which one the member has to submit, and what conditions each metric is able
 * to answer. That split is the reason the file exists at all. A rule whose metric nothing increments
 * can never pay, and a rule whose metric the phone increments is a payout on the member's own
 * say-so — so the answer cannot live on the row, where an operator could pick it, it has to live
 * here, where only a release can change it. `earning.service.ts` reads the same catalogue to decide
 * whether an advance is a counter or a claim.
 *
 * Two other decisions:
 *
 *   * **Restrictions are whitelisted per metric.** `restrictions` is a JSONB column because the
 *     schema cannot know that `GIFT_SENT` can speak about gift categories and `DAILY_LOGIN` cannot.
 *     Validation against the catalogue is what stops a rule carrying `gameKey` under a login metric —
 *     a condition no context object will ever supply, so the rule looks live and pays nobody.
 *   * **Rules are versioned like `commission_rules`** (0004): one row per `(key, rule_version)`,
 *     publishing closes the previous version's window rather than editing it. An attempt row carries
 *     `rule_id` and `rule_version`, so repricing a campaign at noon cannot change what the morning's
 *     work is worth, and a support answer and a finance report read the same number.
 */

export const EARNING_METRICS = [
  'GIFT_SENT',
  'DIAMONDS_SPENT',
  'CHAT_MESSAGE',
  'CHECKIN',
  'CHECKIN_STREAK',
  'DAILY_LOGIN',
  'ROOM_JOIN',
  'GAME_PLAY',
  'STORE_PURCHASE',
  'SUBMISSION',
] as const;
export type EarningMetric = (typeof EARNING_METRICS)[number];

export const EARNING_PURPOSES = ['CHECKIN', 'QUEST', 'CAMPAIGN', 'EVENT', 'ACHIEVEMENT'] as const;
export type EarningPurpose = (typeof EARNING_PURPOSES)[number];

export const EARNING_RESETS = ['DAY', 'WEEK', 'MONTH', 'NEVER'] as const;
export type EarningReset = (typeof EARNING_RESETS)[number];

export const REWARD_CURRENCIES = ['XP', 'BONUS_DIAMOND'] as const;
export type RewardCurrency = (typeof REWARD_CURRENCIES)[number];

/** The account types a rule may name, copied from `users.user_type`. */
export const ELIGIBLE_USER_TYPES = ['HOST', 'USER', 'AGENCY_ADMIN'] as const;

/** Matches the CHECK on both `key` columns; validated here so the refusal names the field. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
/** ISO-3166-1 alpha-2, uppercase. There is no catalogue of them in Postgres to contain a CHECK. */
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
/** A `key` column is TEXT but `id` is UUID, and Postgres answers 22P02 rather than "not found". */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RestrictionSpec = {
  type: 'int' | 'text' | 'bool';
  min?: number;
  max?: number;
};

type MetricDefinition = {
  /**
   * Who supplies the events. `SERVER` metrics are advanced by a hook inside the transaction that
   * recorded the qualifying action; `MEMBER` is the one metric where the phone says something
   * happened, which is why it is the only one that can require an operator's approval.
   */
  countedBy: 'SERVER' | 'MEMBER';
  /**
   * `ADD` sums each event's amount into progress; `MAX` records the highest value seen, which is what
   * a streak is — a day that repeats must not raise it twice, and the row it is set on is the answer.
   */
  progress: 'ADD' | 'MAX';
  /** What this metric can be conditioned on, and the shape each condition has. */
  restrictions: Record<string, RestrictionSpec>;
};

export const EARNING_METRIC_CATALOGUE: Record<EarningMetric, MetricDefinition> = {
  GIFT_SENT: {
    countedBy: 'SERVER',
    progress: 'ADD',
    restrictions: {
      minDiamonds: { type: 'int', min: 1, max: 1_000_000 },
      giftCategory: { type: 'text', max: 40 },
      luckyBox: { type: 'bool' },
    },
  },
  DIAMONDS_SPENT: {
    countedBy: 'SERVER',
    progress: 'ADD',
    restrictions: {
      minDiamonds: { type: 'int', min: 1, max: 1_000_000 },
      giftCategory: { type: 'text', max: 40 },
      luckyBox: { type: 'bool' },
    },
  },
  CHAT_MESSAGE: {
    countedBy: 'SERVER',
    progress: 'ADD',
    restrictions: { roomCategory: { type: 'text', max: 40 } },
  },
  CHECKIN: {
    countedBy: 'SERVER',
    progress: 'ADD',
    restrictions: { minStreakDay: { type: 'int', min: 1, max: 365 } },
  },
  CHECKIN_STREAK: {
    countedBy: 'SERVER',
    progress: 'MAX',
    restrictions: { minStreakDay: { type: 'int', min: 1, max: 365 } },
  },
  DAILY_LOGIN: { countedBy: 'SERVER', progress: 'ADD', restrictions: {} },
  ROOM_JOIN: {
    countedBy: 'SERVER',
    progress: 'ADD',
    restrictions: { roomCategory: { type: 'text', max: 40 } },
  },
  GAME_PLAY: {
    countedBy: 'SERVER',
    progress: 'ADD',
    restrictions: { gameKey: { type: 'text', max: 60 } },
  },
  STORE_PURCHASE: {
    countedBy: 'SERVER',
    progress: 'ADD',
    restrictions: { itemKind: { type: 'text', max: 40 } },
  },
  // The member's own claim: "I did the thing, here is the evidence." Nothing on the server counts it,
  // so it carries no conditions — an unattended rule with a filter would be a queue nobody can read.
  SUBMISSION: { countedBy: 'MEMBER', progress: 'ADD', restrictions: {} },
};

/** Every key any metric accepts, for the error message that names what was actually allowed. */
export function allowedRestrictionKeys(metric: EarningMetric): string[] {
  return Object.keys(EARNING_METRIC_CATALOGUE[metric].restrictions);
}

// ---------------------------------------------------------------------------
// row types and DTOs
// ---------------------------------------------------------------------------

type CampaignRow = {
  id: string;
  key: string;
  title: string;
  description: string;
  status: 'DRAFT' | 'LIVE' | 'CLOSED';
  starts_at: Date | string;
  ends_at: Date | string | null;
  budget_diamonds: number | null;
  created_by: string | null;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type CampaignDto = {
  id: string;
  key: string;
  title: string;
  description: string;
  status: CampaignRow['status'];
  startsAt: string;
  endsAt: string | null;
  budgetDiamonds: number | null;
  note: string | null;
  createdAt: string;
  /** Filled by the reads that need it: what the campaign has already minted, and how many rules point at it. */
  spentDiamonds?: number;
  ruleCount?: number;
};

type RuleRow = {
  id: string;
  key: string;
  rule_version: number;
  title: string;
  description: string;
  campaign_id: string | null;
  metric: EarningMetric;
  purpose: EarningPurpose;
  target: number;
  reward_amount: number;
  reward_currency: RewardCurrency;
  reset: EarningReset;
  max_per_period: number | null;
  max_total: number | null;
  min_account_age_days: number;
  min_vip_level: number;
  eligible_user_types: string[];
  eligible_countries: string[];
  restrictions: Record<string, unknown>;
  requires_approval: boolean;
  starts_at: Date | string;
  ends_at: Date | string | null;
  is_active: boolean;
  created_by: string | null;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type CampaignStatus = 'DRAFT' | 'LIVE' | 'CLOSED';

export type RuleDto = {
  id: string;
  key: string;
  ruleVersion: number;
  title: string;
  description: string;
  campaignId: string | null;
  campaignKey: string | null;
  /**
   * What the parent campaign says right now. Carried on the read because the payout gate is not the
   * same question as the availability gate: a rule can be in date, active and still unpayable because
   * its campaign was closed this morning, and the engine has to be able to say that without a second
   * query in the transaction that moves coins.
   */
  campaignStatus: CampaignStatus | null;
  metric: EarningMetric;
  purpose: EarningPurpose;
  /** Derived from the catalogue, never stored: whether the phone can advance this rule at all. */
  countedBy: 'SERVER' | 'MEMBER';
  target: number;
  rewardAmount: number;
  rewardCurrency: RewardCurrency;
  reset: EarningReset;
  maxPerPeriod: number;
  maxTotal: number | null;
  minAccountAgeDays: number;
  minVipLevel: number;
  eligibleUserTypes: string[];
  eligibleCountries: string[];
  restrictions: Record<string, unknown>;
  requiresApproval: boolean;
  startsAt: string;
  endsAt: string | null;
  isActive: boolean;
  note: string | null;
  createdAt: string;
};

function toCampaignDto(row: CampaignRow): CampaignDto {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    description: row.description,
    status: row.status,
    startsAt: iso(row.starts_at),
    endsAt: row.ends_at ? iso(row.ends_at) : null,
    budgetDiamonds: row.budget_diamonds,
    note: row.note ?? null,
    createdAt: iso(row.created_at),
  };
}

function toRuleDto(row: RuleRow, campaignKey: string | null = null, campaignStatus: CampaignStatus | null = null): RuleDto {
  return {
    id: row.id,
    key: row.key,
    ruleVersion: row.rule_version,
    title: row.title,
    description: row.description,
    campaignId: row.campaign_id,
    campaignKey,
    campaignStatus: row.campaign_id ? campaignStatus : null,
    metric: row.metric,
    purpose: row.purpose,
    countedBy: EARNING_METRIC_CATALOGUE[row.metric].countedBy,
    target: row.target,
    rewardAmount: row.reward_amount,
    rewardCurrency: row.reward_currency,
    reset: row.reset,
    // NULL in the column is 0038's "the operator did not say", and the code's reading of that is one.
    // An unlimited repeat would need a deliberate `maxPerPeriod: 0`, which is refused below.
    maxPerPeriod: row.max_per_period ?? 1,
    maxTotal: row.max_total,
    minAccountAgeDays: row.min_account_age_days,
    minVipLevel: row.min_vip_level,
    eligibleUserTypes: row.eligible_user_types,
    eligibleCountries: row.eligible_countries,
    restrictions: row.restrictions ?? {},
    requiresApproval: row.requires_approval,
    startsAt: iso(row.starts_at),
    endsAt: row.ends_at ? iso(row.ends_at) : null,
    isActive: row.is_active,
    note: row.note ?? null,
    createdAt: iso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// validators — every one of them answers "what did the operator actually type"
// ---------------------------------------------------------------------------

function readKey(value: unknown, field: 'key' | 'campaignKey'): string {
  const key = requireString(value, field, { min: 2, max: 40 });
  if (!KEY_PATTERN.test(key)) {
    throw ApiError.badRequest(`${field} must be lowercase letters, digits and dashes, e.g. weekend-bonus`, 'earning_key_invalid');
  }
  return key;
}

function readText(value: unknown, field: string, max: number): string {
  return requireString(value, field, { min: 0, max }).trim();
}

/** ISO-2 uppercase, de-duplicated, at most 200. An empty list means everyone, so `[]` is legal. */
function readCountries(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw ApiError.badRequest('eligibleCountries must be an array of ISO-3166-1 alpha-2 codes', 'earning_countries_invalid');
  const codes = value.map((entry) => {
    if (typeof entry !== 'string' || !COUNTRY_PATTERN.test(entry.toUpperCase())) {
      throw ApiError.badRequest(`"${entry}" is not a two-letter country code`, 'earning_countries_invalid');
    }
    return entry.toUpperCase();
  });
  const unique = [...new Set(codes)];
  if (unique.length > 200) throw ApiError.badRequest('eligibleCountries accepts at most 200 codes', 'earning_countries_invalid');
  return unique;
}

function readUserTypes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw ApiError.badRequest('eligibleUserTypes must be an array', 'earning_user_types_invalid');
  return value.map((entry) => requireEnum(entry, 'eligibleUserTypes', ELIGIBLE_USER_TYPES));
}

function readDate(value: unknown, field: string, opts: { required?: boolean } = {}): Date | null {
  if (value === undefined || value === null || value === '') {
    if (opts.required) throw ApiError.badRequest(`${field} is required`, 'earning_date_required');
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw ApiError.badRequest(`${field} must be an ISO-8601 timestamp`, 'earning_date_invalid');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw ApiError.badRequest(`${field} is not a readable timestamp`, 'earning_date_invalid');
  }
  return parsed;
}

/**
 * Reject a condition the metric cannot answer, and normalise the ones it can.
 *
 * The refusal is the whole point. A restriction key that no context object carries is not inert — it is
 * a rule that matches nothing, so the campaign reads as live, the member never sees progress, and the
 * operator finds out from a complaint rather than from a validation error.
 */
export function validateRestrictions(metric: EarningMetric, value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('restrictions must be an object', 'earning_restrictions_invalid');
  }
  const specs = EARNING_METRIC_CATALOGUE[metric].restrictions;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) throw ApiError.badRequest('restrictions accepts at most 16 conditions', 'earning_restrictions_invalid');

  const out: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    const spec = specs[key];
    if (!spec) {
      const allowed = Object.keys(specs);
      throw ApiError.badRequest(
        `${metric} has no condition "${key}" — ${allowed.length ? `it accepts ${allowed.join(', ')}` : 'it accepts none'}`,
        'earning_restriction_unknown',
      );
    }
    if (spec.type === 'int') {
      out[key] = requireInt(raw, `restrictions.${key}`, { min: spec.min, max: spec.max });
    } else if (spec.type === 'bool') {
      out[key] = requireBoolean(raw, `restrictions.${key}`);
    } else {
      out[key] = requireString(raw, `restrictions.${key}`, { min: 1, max: spec.max ?? 60 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// campaign CRUD
// ---------------------------------------------------------------------------

export async function listCampaigns(includeClosed = false): Promise<CampaignDto[]> {
  const rows = await many<CampaignRow & { spent: string; rules: string }>(
    `SELECT c.*,
            COALESCE((SELECT SUM(p.amount) FROM earning_payouts p
                       WHERE p.campaign_id = c.id AND p.currency = 'BONUS_DIAMOND'), 0)::text AS spent,
            (SELECT COUNT(*) FROM earning_rules r WHERE r.campaign_id = c.id)::text AS rules
       FROM earning_campaigns c
      ${includeClosed ? '' : "WHERE c.status <> 'CLOSED'"}
      ORDER BY (c.status = 'LIVE') DESC, c.starts_at DESC
      LIMIT 200`,
  );
  return rows.map((row) => ({ ...toCampaignDto(row), spentDiamonds: Number(row.spent), ruleCount: Number(row.rules) }));
}

/**
 * Both admin reads and writes accept a campaign `key` or its id, because the panel has both.
 *
 * The two queries rather than one `OR`: Postgres does not guarantee short-circuiting, so
 * `id = $1::uuid` would be cast — and rejected with 22P02 — for every key lookup.
 */
async function campaignBy(idOrKey: string): Promise<CampaignRow> {
  const byKey = await one<CampaignRow>('SELECT * FROM earning_campaigns WHERE key = $1', [idOrKey]);
  if (byKey) return byKey;
  if (UUID_PATTERN.test(idOrKey)) {
    const byId = await one<CampaignRow>('SELECT * FROM earning_campaigns WHERE id = $1', [idOrKey]);
    if (byId) return byId;
  }
  throw ApiError.notFound('Campaign not found', 'earning_campaign_not_found');
}

export async function getCampaign(idOrKey: string): Promise<CampaignDto> {
  const row = await campaignBy(idOrKey);
  const spent = await one<{ n: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS n FROM earning_payouts
      WHERE campaign_id = $1 AND currency = 'BONUS_DIAMOND'`,
    [row.id],
  );
  const rules = await one<{ n: string }>('SELECT COUNT(*)::text AS n FROM earning_rules WHERE campaign_id = $1', [row.id]);
  return {
    ...toCampaignDto(row),
    spentDiamonds: Number(spent?.n ?? 0),
    ruleCount: Number(rules?.n ?? 0),
  };
}

export async function createCampaign(adminId: string, body: Record<string, unknown>): Promise<CampaignDto> {
  const key = readKey(body?.key, 'key');
  const title = requireString(body?.title, 'title', { min: 1, max: 80 });
  const description = readText(body?.description ?? '', 'description', 300);
  const status = body?.status === undefined ? 'DRAFT' : requireEnum(body.status, 'status', ['DRAFT', 'LIVE', 'CLOSED']);
  const startsAt = readDate(body?.startsAt, 'startsAt') ?? new Date();
  const endsAt = readDate(body?.endsAt, 'endsAt');
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw ApiError.badRequest('endsAt must be after startsAt', 'earning_window_invalid');
  }
  const budget = body?.budgetDiamonds === undefined ? null : requireInt(body.budgetDiamonds, 'budgetDiamonds', { min: 1, max: 1_000_000_000 });
  const note = body?.note === undefined ? null : readText(body.note, 'note', 300);

  const row = await withTransaction(async (client) => {
    const inserted = await client.query<CampaignRow>(
      `INSERT INTO earning_campaigns (key, title, description, status, starts_at, ends_at, budget_diamonds, created_by, note)
       VALUES ($1,$2,$3,$4::earning_campaign_status,$5,$6,$7,$8,$9) RETURNING *`,
      [key, title, description, status, startsAt, endsAt, budget, adminId, note],
    );
    const created = inserted.rows[0];
    await recordAudit(
      {
        adminId,
        action: 'EARNING_CAMPAIGN_CREATE',
        targetType: 'earning_campaign',
        targetId: created.id,
        summary: `Campaign ${key} created as ${status}${budget ? ` with a ${budget}-diamond budget` : ''}`,
        details: { key, status, startsAt: created.starts_at, endsAt: created.ends_at, budgetDiamonds: budget },
      },
      client,
    );
    return created;
  });
  return toCampaignDto(row);
}

/**
 * Change a campaign.
 *
 * A budget edit is checked against what the campaign has already minted, because a ceiling below the
 * spend would silently switch off a campaign an operator believes is live; the answer is to close it,
 * which is a different verb and a different audit row.
 */
export async function updateCampaign(adminId: string, idOrKey: string, body: Record<string, unknown>): Promise<CampaignDto> {
  const existing = await campaignBy(idOrKey);
  const title = body?.title === undefined ? existing.title : requireString(body.title, 'title', { min: 1, max: 80 });
  const description = body?.description === undefined ? existing.description : readText(body.description, 'description', 300);
  const status = body?.status === undefined ? existing.status : requireEnum(body.status, 'status', ['DRAFT', 'LIVE', 'CLOSED']);
  const startsAt = body?.startsAt === undefined ? new Date(existing.starts_at) : readDate(body.startsAt, 'startsAt', { required: true })!;
  const endsAt = body?.endsAt === undefined
    ? (existing.ends_at ? new Date(existing.ends_at) : null)
    : readDate(body.endsAt, 'endsAt');
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw ApiError.badRequest('endsAt must be after startsAt', 'earning_window_invalid');
  }
  const budget = body?.budgetDiamonds === undefined
    ? existing.budget_diamonds
    : body.budgetDiamonds === null
      ? null
      : requireInt(body.budgetDiamonds, 'budgetDiamonds', { min: 1, max: 1_000_000_000 });
  const note = body?.note === undefined ? existing.note : readText(body.note, 'note', 300);

  const row = await withTransaction(async (client) => {
    if (budget !== null) {
      const spent = await client.query<{ n: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS n FROM earning_payouts
          WHERE campaign_id = $1 AND currency = 'BONUS_DIAMOND'`,
        [existing.id],
      );
      if (Number(spent.rows[0].n) > budget) {
        throw ApiError.conflict(
          `This campaign has already minted ${spent.rows[0].n} diamonds; close it instead of setting a lower budget`,
          'earning_budget_below_spend',
        );
      }
    }
    // Locking the campaign row before writing it is the same order `earning.service` uses at payout:
    // account, then campaign, then activity. A budget edit racing a payout otherwise reads a stale sum.
    await client.query('SELECT id FROM earning_campaigns WHERE id = $1 FOR UPDATE', [existing.id]);
    const updated = await client.query<CampaignRow>(
      `UPDATE earning_campaigns
          SET title = $2, description = $3, status = $4::earning_campaign_status, starts_at = $5, ends_at = $6,
              budget_diamonds = $7, note = $8, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [existing.id, title, description, status, startsAt, endsAt, budget, note],
    );
    await recordAudit(
      {
        adminId,
        action: 'EARNING_CAMPAIGN_UPDATE',
        targetType: 'earning_campaign',
        targetId: existing.id,
        summary: `Campaign ${existing.key} set to ${status}`,
        details: {
          before: { status: existing.status, budget: existing.budget_diamonds, endsAt: existing.ends_at },
          after: { status, budget, endsAt },
        },
      },
      client,
    );
    return updated.rows[0];
  });
  return toCampaignDto(row);
}

/**
 * A campaign with rules under it is evidence of a spend, so delete is refused there; retiring is
 * `status: CLOSED`, which is reversible and keeps the payout trail readable.
 */
export async function deleteCampaign(adminId: string, idOrKey: string): Promise<{ ok: true; key: string }> {
  const existing = await campaignBy(idOrKey);
  const rules = await one<{ n: string }>('SELECT COUNT(*)::text AS n FROM earning_rules WHERE campaign_id = $1', [existing.id]);
  if (Number(rules?.n ?? 0) > 0) {
    throw ApiError.conflict(
      `${rules!.n} rule(s) belong to this campaign. Set status=CLOSED to stop them paying instead.`,
      'earning_campaign_in_use',
    );
  }
  await withTransaction(async (client) => {
    await client.query('DELETE FROM earning_campaigns WHERE id = $1', [existing.id]);
    await recordAudit(
      {
        adminId,
        action: 'EARNING_CAMPAIGN_DELETE',
        targetType: 'earning_campaign',
        targetId: existing.id,
        summary: `Campaign ${existing.key} deleted (no rules referenced it)`,
        details: { key: existing.key },
      },
      client,
    );
  });
  return { ok: true, key: existing.key };
}

// ---------------------------------------------------------------------------
// rule publishing
// ---------------------------------------------------------------------------

export async function listRules(opts: { metric?: EarningMetric; campaign?: string; activeOnly?: boolean } = {}): Promise<RuleDto[]> {
  const campaignId = opts.campaign ? (await campaignBy(opts.campaign)).id : null;
  const rows = await many<RuleRow & { campaign_key: string | null; campaign_status: CampaignStatus | null }>(
    `SELECT r.*, c.key AS campaign_key, c.status AS campaign_status
       FROM earning_rules r
       LEFT JOIN earning_campaigns c ON c.id = r.campaign_id
      WHERE ($1::text IS NULL OR r.metric = $1)
        AND ($2::uuid IS NULL OR r.campaign_id = $2)
        AND ($3::boolean IS NULL OR r.is_active = $3)
      ORDER BY r.key, r.rule_version DESC
      LIMIT 500`,
    [opts.metric ?? null, campaignId, opts.activeOnly === undefined ? null : opts.activeOnly],
  );
  return rows.map((row) => toRuleDto(row, row.campaign_key, row.campaign_status));
}

/**
 * The newest version of a rule, by `key` or by any version's id.
 *
 * Every write that is not a publish works on this row: repricing makes a new version, so "switch it
 * off" and "delete it" have exactly one answer. An id from an older version resolves to its `key`'s
 * newest row rather than silently editing a version that has already stopped paying.
 */
async function ruleByKey(idOrKey: string): Promise<RuleRow> {
  let key = idOrKey;
  if (!KEY_PATTERN.test(idOrKey)) {
    if (!UUID_PATTERN.test(idOrKey)) throw ApiError.notFound('Earning rule not found', 'earning_rule_not_found');
    const byId = await one<RuleRow>('SELECT * FROM earning_rules WHERE id = $1', [idOrKey]);
    if (!byId) throw ApiError.notFound('Earning rule not found', 'earning_rule_not_found');
    key = byId.key;
  }
  const row = await one<RuleRow>(
    `SELECT r.* FROM earning_rules r
      JOIN (SELECT key, MAX(rule_version) AS v FROM earning_rules WHERE key = $1 GROUP BY key) t
        ON t.key = r.key AND t.v = r.rule_version`,
    [key],
  );
  if (!row) throw ApiError.notFound('Earning rule not found', 'earning_rule_not_found');
  return row;
}

export async function getRule(idOrKey: string): Promise<RuleDto & { history: RuleDto[] }> {
  const latest = await ruleByKey(idOrKey);
  const history = await many<RuleRow & { campaign_key: string | null; campaign_status: CampaignStatus | null }>(
    `SELECT r.*, c.key AS campaign_key, c.status AS campaign_status
       FROM earning_rules r
       LEFT JOIN earning_campaigns c ON c.id = r.campaign_id
      WHERE r.key = $1 ORDER BY r.rule_version DESC`,
    [latest.key],
  );
  return {
    ...toRuleDto(latest, history[0]?.campaign_key ?? null, history[0]?.campaign_status ?? null),
    history: history.map((row) => toRuleDto(row, row.campaign_key, row.campaign_status)),
  };
}

export type RuleInput = {
  key: string;
  title: string;
  description: string;
  campaignKey?: string | null;
  metric: EarningMetric;
  purpose: EarningPurpose;
  target: number;
  rewardAmount: number;
  rewardCurrency: RewardCurrency;
  reset: EarningReset;
  maxPerPeriod: number;
  maxTotal: number | null;
  minAccountAgeDays: number;
  minVipLevel: number;
  eligibleUserTypes: string[];
  eligibleCountries: string[];
  restrictions: Record<string, unknown>;
  requiresApproval: boolean;
  startsAt: Date;
  endsAt: Date | null;
  note: string | null;
};

/**
 * Read a rule body and answer it against the catalogue.
 *
 * Three pairings are decided here rather than left to the operator:
 *   * a `MEMBER` metric is always `target: 1` — a claim says "this happened", it cannot say how many
 *     times, so a target above one would be a rule no single submission could ever satisfy;
 *   * `requiresApproval` is only ever true for a `MEMBER` metric (the schema agrees, by CHECK);
 *   * `BONUS_DIAMOND` is priced within the mint bound `grantPromoDiamonds` already refuses, so a rule
 *     can be written that the payout path would reject.
 */
export function readRuleBody(body: Record<string, unknown>): { key: string; input: RuleInput } {
  const key = readKey(body?.key, 'key');
  const metric = requireEnum(body?.metric, 'metric', EARNING_METRICS);
  const definition = EARNING_METRIC_CATALOGUE[metric];
  const rewardCurrency = requireEnum(body?.rewardCurrency, 'rewardCurrency', REWARD_CURRENCIES);

  // A claim says "this happened"; it cannot say how many times. A `SUBMISSION` rule with target 5 would
  // be one no single submission could satisfy, so its target is not a field the operator chooses — the
  // DTO the panel reads back carries the 1 that will actually be paid against.
  const target = definition.countedBy === 'MEMBER' ? 1 : requireInt(body?.target, 'target', { min: 1, max: 1_000_000 });

  const rewardAmount = requireInt(body?.rewardAmount, 'rewardAmount', {
    min: 1,
    max: rewardCurrency === 'BONUS_DIAMOND' ? 10_000_000 : 1_000_000,
  });

  const requiresApproval = body?.requiresApproval === undefined ? false : requireBoolean(body.requiresApproval, 'requiresApproval');
  if (requiresApproval && definition.countedBy !== 'MEMBER') {
    throw ApiError.badRequest(
      `${metric} is counted by the server, so there is no claim to approve — use metric=SUBMISSION for a reviewed reward`,
      'earning_approval_needs_submission',
    );
  }

  const maxPerPeriod = body?.maxPerPeriod === undefined ? 1 : requireInt(body.maxPerPeriod, 'maxPerPeriod', { min: 1, max: 1000 });
  const maxTotal = body?.maxTotal === undefined || body.maxTotal === null
    ? null
    : requireInt(body.maxTotal, 'maxTotal', { min: 1, max: 100_000 });

  const startsAt = readDate(body?.startsAt, 'startsAt') ?? new Date();
  const endsAt = readDate(body?.endsAt, 'endsAt');
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw ApiError.badRequest('endsAt must be after startsAt', 'earning_window_invalid');
  }

  return {
    key,
    input: {
      key,
      title: requireString(body?.title, 'title', { min: 1, max: 80 }),
      description: readText(body?.description ?? '', 'description', 300),
      campaignKey: body?.campaignKey === undefined || body.campaignKey === null ? null : readKey(body.campaignKey, 'campaignKey'),
      metric,
      purpose: requireEnum(body?.purpose, 'purpose', EARNING_PURPOSES),
      target,
      rewardAmount,
      rewardCurrency,
      reset: body?.reset === undefined ? 'DAY' : requireEnum(body.reset, 'reset', EARNING_RESETS),
      maxPerPeriod,
      maxTotal,
      minAccountAgeDays: body?.minAccountAgeDays === undefined ? 0 : requireInt(body.minAccountAgeDays, 'minAccountAgeDays', { min: 0, max: 3650 }),
      minVipLevel: body?.minVipLevel === undefined ? 0 : requireInt(body.minVipLevel, 'minVipLevel', { min: 0, max: 20 }),
      eligibleUserTypes: readUserTypes(body?.eligibleUserTypes),
      eligibleCountries: readCountries(body?.eligibleCountries),
      restrictions: validateRestrictions(metric, body?.restrictions),
      requiresApproval,
      startsAt,
      endsAt,
      note: body?.note === undefined ? null : readText(body.note, 'note', 300),
    },
  };
}

/**
 * Publish a rule version: create `key` at v1, or supersede the newest version with `key` at v(n+1).
 *
 * Superseding switches the previous version off rather than ending it: `is_active = false` stops new
 * progress landing on it, while its window stays open so an attempt that began under the old price can
 * still be paid at the price the member was shown. `ends_at` therefore answers only "this reward is
 * over", which is the operator's own window or a campaign close, never a reprice. Retiring the
 * *current* version is the separate `setRuleActive` call.
 */
export async function putEarningRule(adminId: string, body: Record<string, unknown>): Promise<RuleDto> {
  const { key, input } = readRuleBody(body);
  const result = await withTransaction<{ row: RuleRow; parent: { key: string; status: CampaignStatus } | null }>(async (client) => {
    let campaign: CampaignRow | null = null;
    if (input.campaignKey) {
      const found = await client.query<CampaignRow>('SELECT * FROM earning_campaigns WHERE key = $1 FOR UPDATE', [input.campaignKey]);
      campaign = found.rows[0] ?? null;
      if (!campaign) throw ApiError.notFound(`Unknown campaign "${input.campaignKey}"`, 'earning_campaign_not_found');
      if (campaign.status === 'CLOSED') {
        throw ApiError.badRequest(`Campaign ${campaign.key} is closed — open it before adding rules`, 'earning_campaign_closed');
      }
    }
    const parent = campaign ? { key: campaign.key, status: campaign.status } : null;

    const prior = await client.query<RuleRow>(
      'SELECT * FROM earning_rules WHERE key = $1 ORDER BY rule_version DESC LIMIT 1 FOR UPDATE',
      [key],
    );
    const previous = prior.rows[0] ?? null;
    if (previous && new Date(previous.starts_at) >= input.startsAt) {
      throw ApiError.conflict(
        `Version ${previous.rule_version} already takes effect at or after this time`,
        'earning_rule_effective_conflict',
      );
    }
    if (previous) {
      await client.query('UPDATE earning_rules SET is_active = FALSE, updated_at = now() WHERE id = $1', [previous.id]);
    }
    const version = previous ? previous.rule_version + 1 : 1;

    const inserted = await client.query<RuleRow & { campaign_key: string | null }>(
      `INSERT INTO earning_rules
         (key, rule_version, title, description, campaign_id, metric, purpose, target, reward_amount, reward_currency,
          reset, max_per_period, max_total, min_account_age_days, min_vip_level, eligible_user_types, eligible_countries,
          restrictions, requires_approval, starts_at, ends_at, is_active, created_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::earning_reset,$12,$13,$14,$15,$16::text[],$17::text[],
               $18::jsonb,$19,$20,$21,TRUE,$22,$23)
       RETURNING *`,
      [
        key,
        version,
        input.title,
        input.description,
        campaign?.id ?? null,
        input.metric,
        input.purpose,
        input.target,
        input.rewardAmount,
        input.rewardCurrency,
        input.reset,
        input.maxPerPeriod,
        input.maxTotal,
        input.minAccountAgeDays,
        input.minVipLevel,
        input.eligibleUserTypes,
        input.eligibleCountries,
        JSON.stringify(input.restrictions),
        input.requiresApproval,
        input.startsAt,
        input.endsAt,
        adminId,
        input.note,
      ],
    );
    const created = inserted.rows[0];
    await recordAudit(
      {
        adminId,
        action: 'EARNING_RULE_PUBLISH',
        targetType: 'earning_rule',
        targetId: created.id,
        summary: `${key} v${version}: ${input.metric} to ${input.target} pays ${input.rewardAmount} ${input.rewardCurrency} per ${input.reset.toLowerCase()}`,
        details: {
          previousVersion: previous?.rule_version ?? null,
          campaignKey: campaign?.key ?? null,
          input: { ...input, startsAt: input.startsAt.toISOString(), endsAt: input.endsAt?.toISOString() ?? null },
        },
      },
      client,
    );
    return { row: created, parent };
  });
  return toRuleDto(result.row, result.parent?.key ?? null, result.parent?.status ?? null);
}

/**
 * Switch a rule's *current* version on or off without repricing it.
 *
 * Off means nothing new starts; attempts already OPEN keep their snapshot and still pay, which is
 * what makes this safe to reach for during an incident. `max_total` and the campaign budget are the
 * levers that stop an already-paid member being paid again.
 */
export async function setRuleActive(adminId: string, idOrKey: string, isActive: boolean, note?: string): Promise<RuleDto> {
  const latest = await ruleByKey(idOrKey);
  const reason = (note ?? '').trim();
  if (!isActive && reason.length < 8) {
    throw ApiError.badRequest('Retiring a rule needs a reason an operator can read later', 'earning_reason_required');
  }
  const row = await withTransaction(async (client) => {
    await client.query(
      `UPDATE earning_rules SET is_active = $2, note = COALESCE($3, note), updated_at = now()
        WHERE id = $1`,
      [latest.id, isActive, reason.slice(0, 300) || null],
    );
    await recordAudit(
      {
        adminId,
        action: 'EARNING_RULE_STATUS',
        targetType: 'earning_rule',
        targetId: latest.id,
        summary: `${latest.key} v${latest.rule_version} set ${isActive ? 'active' : 'inactive'}${reason ? `: ${reason}` : ''}`,
        details: { isActive, reason: reason || null },
      },
      client,
    );
    const after = await client.query<RuleRow & { campaign_key: string | null; campaign_status: CampaignStatus | null }>(
      `SELECT r.*, c.key AS campaign_key, c.status AS campaign_status
         FROM earning_rules r
         LEFT JOIN earning_campaigns c ON c.id = r.campaign_id
        WHERE r.id = $1`,
      [latest.id],
    );
    return after.rows[0];
  });
  return toRuleDto(row, row.campaign_key, row.campaign_status);
}

/** Delete is only for a rule nobody has ever attempted; anything else is history. */
export async function deleteEarningRule(adminId: string, idOrKey: string): Promise<{ ok: true; key: string }> {
  const latest = await ruleByKey(idOrKey);
  // Across every version, not just this one: deleting by key removes the whole timeline, and a v1
  // payout an operator cannot see would go with it.
  const used = await one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM earning_activities a
      JOIN earning_rules r ON r.id = a.rule_id
     WHERE r.key = $1`,
    [latest.key],
  );
  if (Number(used?.n ?? 0) > 0) {
    throw ApiError.conflict(
      `${used!.n} member attempt(s) reference ${latest.key} across its ${latest.rule_version} version(s). Set isActive=false to retire it instead.`,
      'earning_rule_in_use',
    );
  }
  await withTransaction(async (client) => {
    await client.query('DELETE FROM earning_rules WHERE key = $1', [latest.key]);
    await recordAudit(
      {
        adminId,
        action: 'EARNING_RULE_DELETE',
        targetType: 'earning_rule',
        targetId: latest.id,
        summary: `Rule ${latest.key} deleted (no attempts referenced it)`,
        details: { key: latest.key, versions: latest.rule_version },
      },
      client,
    );
  });
  return { ok: true, key: latest.key };
}

// ---------------------------------------------------------------------------
// the read the engine uses
// ---------------------------------------------------------------------------

/**
 * Every live rule listening to `metric` right now, newest version first.
 *
 * `is_active` plus the window is the whole availability answer — superseding a version clears the first
 * and ending a reward clears the second — and a campaign that is not LIVE *inside its own dates* is
 * filtered here rather than at payout so that an advance cannot build progress on a rule that will
 * refuse to pay it. On the caller's client, because the engine calls it inside the transaction that
 * moves coins.
 */
export async function liveRulesFor(client: PoolClient, metric: EarningMetric): Promise<RuleDto[]> {
  const rows = await client.query<RuleRow & { campaign_key: string | null; campaign_status: CampaignRow['status'] | null }>(
    `SELECT r.*, c.key AS campaign_key, c.status AS campaign_status
       FROM earning_rules r
       LEFT JOIN earning_campaigns c ON c.id = r.campaign_id
      WHERE r.metric = $1
        AND r.is_active
        AND r.starts_at <= now()
        AND (r.ends_at IS NULL OR r.ends_at > now())
        AND (r.campaign_id IS NULL
             OR (c.status = 'LIVE' AND (c.ends_at IS NULL OR c.ends_at > now())))
      ORDER BY r.rule_version DESC`,
    [metric],
  );
  return rows.rows.map((row) => toRuleDto(row, row.campaign_key, row.campaign_status));
}

/**
 * The newest version of one named rule, on the caller's client, with its campaign attached.
 *
 * This is the claim path's read: the phone names a rule and nothing else, so the engine needs the live
 * price, the caps and the eligibility from the row rather than the request. It deliberately does *not*
 * filter by window or `is_active` — a member who claims against a rule that retired an hour ago should
 * be told that in those words, which a filtered read cannot do.
 */
export async function latestRuleOn(client: PoolClient, idOrKey: string): Promise<RuleDto | null> {
  const select = `
    SELECT r.*, c.key AS campaign_key, c.status AS campaign_status
      FROM earning_rules r
      LEFT JOIN earning_campaigns c ON c.id = r.campaign_id
     WHERE r.key = $1
     ORDER BY r.rule_version DESC LIMIT 1`;
  const byKey = await client.query<RuleRow & { campaign_key: string | null; campaign_status: CampaignRow['status'] | null }>(select, [idOrKey]);
  if (byKey.rows[0]) return toRuleDto(byKey.rows[0], byKey.rows[0].campaign_key, byKey.rows[0].campaign_status);
  if (!UUID_PATTERN.test(idOrKey)) return null;
  // An id addresses a version; the answer is still that rule's newest version, so a claim cannot be
  // filed against a price the operator has already superseded.
  const version = await client.query<{ key: string }>('SELECT key FROM earning_rules WHERE id = $1', [idOrKey]);
  if (!version.rows[0]) return null;
  const row = await client.query<RuleRow & { campaign_key: string | null; campaign_status: CampaignRow['status'] | null }>(select, [version.rows[0].key]);
  return row.rows[0] ? toRuleDto(row.rows[0], row.rows[0].campaign_key, row.rows[0].campaign_status) : null;
}
