import { PoolClient, QueryResultRow } from 'pg';
import { many, one, withTransaction } from '../config/db';
import {
  CommissionBeneficiary,
  CommissionEntryRow,
  CommissionRuleKind,
  CommissionRuleRow,
  CommissionSettlementRow,
  RechargeOrderRow,
} from '../types/db';
import { ApiError } from '../utils/http';
import { shortCode } from '../utils/ids';
import {
  CommissionEntryDto,
  CommissionRuleDto,
  CommissionSettlementDto,
  toCommissionEntry,
  toCommissionRule,
  toCommissionSettlement,
} from '../utils/serialize';
import { recordAudit } from './audit.service';
import { readConfig } from './business.service';
import { FIN_ACCOUNTS, postJournal } from './finance-journal.service';

/**
 * The commission engine for real money (§22 "Seller commission structure", §25).
 *
 * Three properties the programme asks for, and how this file gets them:
 *
 *  *Configurable and ordered.* Which rule kinds apply, and in what sequence, is a
 *   `system_config` value, not a constant. The order matters because each kind is applied to
 *   what the previous ones left in the ceiling — a percentage and a flat per-order amount are
 *   meant to combine, and "combine" has to mean one deterministic thing.
 *
 *  *Versioned.* A rate is never edited in place. A new version is inserted and the old one is
 *   closed at the new rule's effective date, and every accrual stores `rule_version`, so a
 *   statement can still be explained two years later.
 *
 *  *Bounded.* The engine truncates at `maxAllocationBps` of the eligible net value, and the
 *   database additionally refuses any accrual that pushes an order's total commission above
 *   the collection itself (0004 trigger). Arithmetic in code is a convention; that one is a
 *   constraint.
 *
 * All rounding is `Math.floor`, applied per line. Never "round the total and split it", which
 * is how a batch ends up paying one paisa more than it collected.
 */

const BPS = 10_000;

export const COMMISSION_RULE_KINDS = ['SELLER_PERCENT', 'SELLER_FIXED', 'SELLER_TIER', 'BD_PERCENT', 'BD_FIXED'] as const;
export const COMMISSION_BENEFICIARIES = ['SELLER', 'BD', 'PLATFORM', 'PROVIDER'] as const;

export type CommissionTier = { uptoCents: number; percentBps?: number; fixedCents?: number };

export type CommissionConfig = { enabled: CommissionRuleKind[]; maxAllocationBps: number };

const DEFAULT_ORDER: CommissionRuleKind[] = ['SELLER_TIER', 'SELLER_PERCENT', 'SELLER_FIXED', 'BD_PERCENT', 'BD_FIXED'];

export async function commissionConfig(): Promise<CommissionConfig> {
  const raw = await readConfig('commission.calculationOrder', { enabled: DEFAULT_ORDER, maxAllocationBps: 2500 });
  const enabled = Array.isArray(raw.enabled)
    ? (raw.enabled.filter((kind) => (COMMISSION_RULE_KINDS as readonly string[]).includes(String(kind))) as CommissionRuleKind[])
    : DEFAULT_ORDER;
  const maxAllocationBps = Number(raw.maxAllocationBps);
  return {
    enabled: enabled.length ? enabled : [...DEFAULT_ORDER],
    maxAllocationBps: Number.isFinite(maxAllocationBps) ? Math.min(Math.max(maxAllocationBps, 0), BPS) : 2500,
  };
}

const beneficiaryFor = (kind: CommissionRuleKind): CommissionBeneficiary => (kind.startsWith('BD') ? 'BD' : 'SELLER');

const RULE_SELECT = `
  SELECT r.*, b.code AS applies_to_code
    FROM commission_rules r
    LEFT JOIN business_accounts b ON b.id = r.applies_to_id`;

export async function listCommissionRules(opts: {
  beneficiary?: CommissionBeneficiary;
  kind?: CommissionRuleKind;
  appliesToId?: string;
  includeInactive?: boolean;
}): Promise<CommissionRuleDto[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (opts.beneficiary) where.push(`r.beneficiary = ${bind(opts.beneficiary)}`);
  if (opts.kind) where.push(`r.kind = ${bind(opts.kind)}`);
  if (opts.appliesToId) where.push(`(r.applies_to_id = ${bind(opts.appliesToId)} OR r.applies_to_id IS NULL)`);
  if (!opts.includeInactive) where.push('r.is_active');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await many<CommissionRuleRow>(`${RULE_SELECT} ${clause} ORDER BY r.kind, r.applies_to_id NULLS FIRST, r.effective_from DESC`, params);
  return rows.map(toCommissionRule);
}

export type PutRuleInput = {
  kind: CommissionRuleKind;
  appliesToId?: string | null;
  percentBps?: number;
  fixedCents?: number;
  tiers?: CommissionTier[];
  minOrderCents?: number | null;
  maxOrderCents?: number | null;
  currency?: string;
  effectiveFrom?: Date;
  note?: string;
};

function validateRuleShape(input: PutRuleInput): void {
  if (input.kind === 'SELLER_TIER') {
    if (!input.tiers?.length) throw ApiError.badRequest('A volume-tier rule needs at least one tier', 'rule_incomplete');
    const sorted = [...input.tiers].sort((a, b) => a.uptoCents - b.uptoCents);
    for (const tier of sorted) {
      if (!Number.isFinite(tier.uptoCents) || tier.uptoCents <= 0) throw ApiError.badRequest('Tier ceilings must be positive');
      const pct = tier.percentBps ?? 0;
      const fixed = tier.fixedCents ?? 0;
      if (pct < 0 || pct > BPS) throw ApiError.badRequest('Tier percentage must be between 0 and 10000 bps');
      if (fixed < 0) throw ApiError.badRequest('Tier fixed amount cannot be negative');
      if (!pct && !fixed) throw ApiError.badRequest('Each tier needs a percentBps or a fixedCents');
    }
    if (sorted.length > 12) throw ApiError.badRequest('Too many tiers (12 max)');
    return;
  }
  if (input.kind.endsWith('PERCENT')) {
    if (input.percentBps === undefined) throw ApiError.badRequest(`${input.kind} needs percentBps`, 'rule_incomplete');
    if (input.percentBps < 0 || input.percentBps > BPS) throw ApiError.badRequest('percentBps must be between 0 and 10000');
    return;
  }
  if (input.fixedCents === undefined) throw ApiError.badRequest(`${input.kind} needs fixedCents`, 'rule_incomplete');
  if (input.fixedCents < 0 || input.fixedCents > 1_000_000_000) throw ApiError.badRequest('fixedCents is out of range');
}

/**
 * Publish a new version of a rule.
 *
 * The previous active version for the same (kind, account) is closed at the moment this one
 * takes effect, so the timeline has no overlap and no gap — and an order accrued under the old
 * rate keeps its old `rule_version` rather than being repriced.
 */
export async function putCommissionRule(adminId: string, input: PutRuleInput): Promise<CommissionRuleDto> {
  validateRuleShape(input);
  const beneficiary = beneficiaryFor(input.kind);
  const effectiveFrom = input.effectiveFrom ?? new Date();
  if (input.appliesToId) {
    const target = await one<{ kind: string; status: string }>(
      'SELECT kind, status FROM business_accounts WHERE id = $1',
      [input.appliesToId],
    );
    if (!target) throw ApiError.notFound('Business account not found', 'account_not_found');
    const wantsSeller = beneficiary === 'SELLER';
    const isSeller = target.kind === 'COIN_SELLER';
    if (wantsSeller !== isSeller) {
      throw ApiError.badRequest(`${input.kind} applies to ${wantsSeller ? 'a coin seller' : 'a BD account'}`, 'rule_target_mismatch');
    }
  }

  const row = await withTransaction(async (client) => {
    const prior = await client.query<CommissionRuleRow>(
      `SELECT * FROM commission_rules
        WHERE kind = $1 AND COALESCE(applies_to_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY rules_version DESC LIMIT 1
        FOR UPDATE`,
      [input.kind, input.appliesToId ?? null],
    );
    const previous = prior.rows[0] ?? null;
    if (previous && previous.is_active && new Date(previous.effective_from) >= effectiveFrom) {
      throw ApiError.conflict(
        `Rule version ${previous.rules_version} already takes effect at or after this date`,
        'rule_effective_conflict',
      );
    }
    if (previous && previous.is_active && new Date(previous.effective_from) < effectiveFrom) {
      await client.query('UPDATE commission_rules SET effective_to = $2 WHERE id = $1', [previous.id, effectiveFrom]);
    }
    const nextVersion = previous ? previous.rules_version + 1 : 1;

    const inserted = await client.query<CommissionRuleRow>(
      `INSERT INTO commission_rules
         (kind, beneficiary, applies_to_id, rules_version, percent_bps, fixed_cents, tiers,
          min_order_cents, max_order_cents, currency, effective_from, created_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        input.kind,
        beneficiary,
        input.appliesToId ?? null,
        nextVersion,
        input.kind.endsWith('PERCENT') ? (input.percentBps ?? 0) : null,
        input.kind.endsWith('FIXED') ? (input.fixedCents ?? 0) : null,
        input.kind === 'SELLER_TIER' ? JSON.stringify(input.tiers ?? []) : null,
        input.minOrderCents ?? null,
        input.maxOrderCents ?? null,
        input.currency ?? 'pkr',
        effectiveFrom,
        adminId,
        input.note ?? null,
      ],
    );
    await recordAudit(
      {
        adminId,
        action: 'COMMISSION_RULE_PUBLISH',
        targetType: 'commission_rule',
        targetId: inserted.rows[0].id,
        summary: `${input.kind} v${nextVersion}${input.appliesToId ? ` for account ${input.appliesToId}` : ' (platform default)'} from ${effectiveFrom.toISOString()}`,
        details: { previousVersion: previous?.rules_version ?? null, input },
      },
      client,
    );
    return inserted.rows[0];
  });

  const enriched = await one<CommissionRuleRow>(`${RULE_SELECT} WHERE r.id = $1`, [row.id]);
  return toCommissionRule(enriched ?? row);
}

export async function retireCommissionRule(adminId: string, ruleId: string, reason: string): Promise<CommissionRuleDto> {
  const row = await withTransaction(async (client) => {
    const updated = await client.query<CommissionRuleRow>(
      `UPDATE commission_rules SET is_active = false, effective_to = now(), note = COALESCE(note,'') || ' | retired: ' || $2
        WHERE id = $1 RETURNING *`,
      [ruleId, reason],
    );
    if (!updated.rows.length) throw ApiError.notFound('Commission rule not found');
    await recordAudit(
      {
        adminId,
        action: 'COMMISSION_RULE_RETIRE',
        targetType: 'commission_rule',
        targetId: ruleId,
        summary: `Retired ${updated.rows[0].kind} v${updated.rows[0].rules_version} — ${reason}`,
      },
      client,
    );
    return updated.rows[0];
  });
  const enriched = await one<CommissionRuleRow>(`${RULE_SELECT} WHERE r.id = $1`, [row.id]);
  return toCommissionRule(enriched ?? row);
}

async function activeRule(
  client: PoolClient | null,
  kind: CommissionRuleKind,
  appliesToId: string | null,
  at: Date,
): Promise<CommissionRuleRow | null> {
  const run = <T extends QueryResultRow>(sql: string, params: unknown[]) =>
    client ? client.query<T>(sql, params).then((r) => r.rows[0] ?? null) : one<T>(sql, params);
  // An account-specific rate beats the platform default; the most recent effective row wins.
  return run<CommissionRuleRow>(
    `SELECT * FROM commission_rules
      WHERE kind = $1 AND is_active
        AND (applies_to_id = $2 OR applies_to_id IS NULL)
        AND effective_from <= $3
        AND (effective_to IS NULL OR effective_to > $3)
      ORDER BY (applies_to_id IS NULL), effective_from DESC, rules_version DESC
      LIMIT 1`,
    [kind, appliesToId ?? '00000000-0000-0000-0000-000000000000', at],
  );
}

export type AccrualLine = {
  kind: CommissionRuleKind;
  beneficiary: CommissionBeneficiary;
  beneficiaryId: string;
  ruleId: string;
  ruleVersion: number;
  basisCents: number;
  amountCents: number;
  currency: string;
};

export function amountForRule(rule: CommissionRuleRow, netCents: number, periodVolumeCents: number): number {
  switch (rule.kind) {
    case 'SELLER_PERCENT':
    case 'BD_PERCENT':
      return Math.floor((netCents * (rule.percent_bps ?? 0)) / BPS);
    case 'SELLER_FIXED':
    case 'BD_FIXED':
      return rule.fixed_cents ?? 0;
    case 'SELLER_TIER': {
      const tiers = rule.tiers ?? [];
      // The tier is chosen from the partner's approved volume, then applied to this order.
      const tier = tiers.find((t) => periodVolumeCents <= t.uptoCents) ?? tiers[tiers.length - 1];
      if (!tier) return 0;
      const percent = tier.percentBps ? Math.floor((netCents * tier.percentBps) / BPS) : 0;
      return percent + (tier.fixedCents ?? 0);
    }
    default:
      return 0;
  }
}

/**
 * Decide what an order is worth to each partner, without writing anything.
 *
 * `periodVolumeCents` is the seller's already-credited collection for the current period
 * *including* this order, which is what makes the tier decision reproducible: the same order
 * and the same books always produce the same plan.
 */
export async function planOrderCommissions(opts: {
  sellerId: string;
  bdId: string | null;
  amountCents: number;
  feeCents: number;
  periodVolumeCents: number;
  at: Date;
  client?: PoolClient | null;
}): Promise<{ lines: AccrualLine[]; ceilingCents: number; netCents: number; config: CommissionConfig }> {
  const config = await commissionConfig();
  // §22 pays on the *eligible net recharge value*: the platform should not owe commission on
  // money a payment provider took before it ever arrived.
  const netCents = Math.max(opts.amountCents - opts.feeCents, 0);
  const ceilingCents = Math.floor((netCents * config.maxAllocationBps) / BPS);
  const lines: AccrualLine[] = [];
  let used = 0;

  for (const kind of config.enabled) {
    const beneficiary = beneficiaryFor(kind);
    const accountId = beneficiary === 'SELLER' ? opts.sellerId : opts.bdId;
    if (!accountId) continue; // unattributed order: no BD share, and that is a fact worth seeing

    const rule = await activeRule(opts.client ?? null, kind, accountId, opts.at);
    if (!rule) continue;
    if (rule.min_order_cents !== null && opts.amountCents < rule.min_order_cents) continue;
    if (rule.max_order_cents !== null && opts.amountCents > rule.max_order_cents) continue;

    const raw = amountForRule(rule, netCents, opts.periodVolumeCents);
    const amountCents = Math.min(raw, ceilingCents - used);
    if (amountCents <= 0) continue;
    used += amountCents;
    lines.push({
      kind,
      beneficiary,
      beneficiaryId: accountId,
      ruleId: rule.id,
      ruleVersion: rule.rules_version,
      basisCents: netCents,
      amountCents,
      currency: rule.currency,
    });
  }

  return { lines, ceilingCents, netCents, config };
}

/**
 * Write the plan as accruals, and book the liability.
 *
 * Called inside the same SQL transaction that credits the user's coins, so a partner's
 * commission cannot exist without the collection that earned it, or vice versa. The insert is
 * `ON CONFLICT DO NOTHING` against the (order, beneficiary, kind) key: re-running this for a
 * retried webhook is a no-op rather than a second payment.
 */
export async function accrueOrderCommissions(
  client: PoolClient,
  opts: { order: Pick<RechargeOrderRow, 'id' | 'reference' | 'currency'>; lines: AccrualLine[] },
): Promise<{ entries: CommissionEntryRow[]; journalId: string | null }> {
  const entries: CommissionEntryRow[] = [];
  for (const line of opts.lines) {
    const inserted = await client.query<CommissionEntryRow>(
      `INSERT INTO commission_entries
         (recharge_order_id, beneficiary, beneficiary_id, kind, rule_id, rule_version, basis_cents, amount_cents, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (recharge_order_id, beneficiary, beneficiary_id, kind) DO NOTHING
       RETURNING *`,
      [opts.order.id, line.beneficiary, line.beneficiaryId, line.kind, line.ruleId, line.ruleVersion, line.basisCents, line.amountCents, line.currency],
    );
    if (inserted.rows.length) entries.push(inserted.rows[0]);
  }

  const byBeneficiary = new Map<CommissionBeneficiary, number>();
  for (const entry of entries) {
    byBeneficiary.set(entry.beneficiary, (byBeneficiary.get(entry.beneficiary) ?? 0) + Number(entry.amount_cents));
  }
  const total = [...byBeneficiary.values()].reduce((sum, value) => sum + value, 0);

  let journalId: string | null = null;
  if (total > 0) {
    const lines: Array<{ accountCode: string; direction: 'DEBIT' | 'CREDIT'; amountCents: number }> = [
      { accountCode: FIN_ACCOUNTS.commissionExpense, direction: 'DEBIT', amountCents: total },
    ];
    const seller = byBeneficiary.get('SELLER') ?? 0;
    const bd = byBeneficiary.get('BD') ?? 0;
    if (seller) lines.push({ accountCode: FIN_ACCOUNTS.sellerCommissionPayable, direction: 'CREDIT', amountCents: seller });
    if (bd) lines.push({ accountCode: FIN_ACCOUNTS.bdCommissionPayable, direction: 'CREDIT', amountCents: bd });
    const posted = await postJournal(client, {
      sourceKind: 'COMMISSION_ACCRUAL',
      sourceId: opts.order.id,
      memo: `Commission accrued for order ${opts.order.reference}`,
      currency: opts.order.currency,
      lines,
    });
    journalId = posted.id;
  }

  return { entries, journalId };
}

/** Freeze the decision on the order so a statement can be re-derived without re-resolving rules. */
export async function recordRulesSnapshot(
  client: PoolClient,
  orderId: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  await client.query('UPDATE recharge_orders SET rules_snapshot = $2 WHERE id = $1', [orderId, JSON.stringify(snapshot)]);
}

/**
 * Undo an order's accruals when the collection is refunded or charged back.
 *
 * A commission that has already been paid out is not silently un-paid: that has to be settled
 * as a negative in the next period, which is a human decision with a reference number, so this
 * refuses and says so rather than inventing a ledger line nobody approved.
 */
export async function reverseOrderCommissions(
  client: PoolClient,
  opts: { orderId: string; orderReference: string; reason: string },
): Promise<{ reversed: number; amountCents: number }> {
  const settled = await client.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM commission_entries WHERE recharge_order_id = $1 AND status = 'SETTLED'`,
    [opts.orderId],
  );
  if (Number(settled.rows[0]?.n ?? 0) > 0) {
    throw ApiError.conflict(
      `Order ${opts.orderReference} already has settled commission; raise a negative settlement instead of reversing it`,
      'commission_already_settled',
    );
  }

  const rows = await client.query<CommissionEntryRow>(
    `UPDATE commission_entries SET status = 'REVERSED', reversed_at = now(), reversal_reason = $2
      WHERE recharge_order_id = $1 AND status = 'ACCRUED' RETURNING *`,
    [opts.orderId, opts.reason],
  );
  const total = rows.rows.reduce((sum, row) => sum + Number(row.amount_cents), 0);

  if (total > 0) {
    const byBeneficiary = new Map<CommissionBeneficiary, number>();
    for (const row of rows.rows) {
      byBeneficiary.set(row.beneficiary, (byBeneficiary.get(row.beneficiary) ?? 0) + Number(row.amount_cents));
    }
    const lines: Array<{ accountCode: string; direction: 'DEBIT' | 'CREDIT'; amountCents: number }> = [];
    const seller = byBeneficiary.get('SELLER') ?? 0;
    const bd = byBeneficiary.get('BD') ?? 0;
    if (seller) lines.push({ accountCode: FIN_ACCOUNTS.sellerCommissionPayable, direction: 'DEBIT', amountCents: seller });
    if (bd) lines.push({ accountCode: FIN_ACCOUNTS.bdCommissionPayable, direction: 'DEBIT', amountCents: bd });
    lines.push({ accountCode: FIN_ACCOUNTS.commissionExpense, direction: 'CREDIT', amountCents: total });
    await postJournal(client, {
      sourceKind: 'REVERSAL',
      sourceId: `commission:${opts.orderId}`,
      memo: `Commission reversed for ${opts.orderReference}: ${opts.reason}`,
      lines,
    });
  }

  return { reversed: rows.rows.length, amountCents: total };
}

const ENTRY_SELECT = `
  SELECT e.*, o.reference AS order_reference, b.code AS beneficiary_code, b.display_name AS beneficiary_name,
         s.reference AS settlement_reference
    FROM commission_entries e
    JOIN recharge_orders o ON o.id = e.recharge_order_id
    LEFT JOIN business_accounts b ON b.id = e.beneficiary_id
    LEFT JOIN commission_settlement_items si ON si.entry_id = e.id
    LEFT JOIN commission_settlements s ON s.id = si.settlement_id`;

export async function listCommissionEntries(opts: {
  beneficiaryId?: string;
  status?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}): Promise<{ entries: CommissionEntryDto[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (opts.beneficiaryId) where.push(`e.beneficiary_id = ${bind(opts.beneficiaryId)}`);
  if (opts.status) where.push(`e.status = ${bind(opts.status)}`);
  if (opts.from) where.push(`e.created_at >= ${bind(opts.from)}`);
  if (opts.to) where.push(`e.created_at <= ${bind(opts.to)}`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Number(opts.limit) || 50;
  const offset = Number(opts.offset) || 0;

  const rows = await many<CommissionEntryRow>(`${ENTRY_SELECT} ${clause} ORDER BY e.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  const count = await one<{ n: string }>(`SELECT COUNT(*) AS n FROM commission_entries e ${clause}`, params);
  return { entries: rows.map(toCommissionEntry), total: Number(count?.n ?? 0) };
}

/** Pending / settled / reversed totals: the numbers a partner's statement opens with. */
export async function commissionSummary(beneficiaryId: string): Promise<{
  accruedCents: number;
  settledCents: number;
  reversedCents: number;
  entryCount: number;
  currency: string;
}> {
  const row = await one<{
    accrued: string;
    settled: string;
    reversed: string;
    n: string;
    currency: string;
  }>(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status = 'ACCRUED'), 0)::text  AS accrued,
            COALESCE(SUM(amount_cents) FILTER (WHERE status = 'SETTLED'), 0)::text  AS settled,
            COALESCE(SUM(amount_cents) FILTER (WHERE status = 'REVERSED'), 0)::text AS reversed,
            COUNT(*) AS n, MAX(currency) AS currency
       FROM commission_entries WHERE beneficiary_id = $1`,
    [beneficiaryId],
  );
  return {
    accruedCents: Number(row?.accrued ?? 0),
    settledCents: Number(row?.settled ?? 0),
    reversedCents: Number(row?.reversed ?? 0),
    entryCount: Number(row?.n ?? 0),
    currency: row?.currency ?? 'pkr',
  };
}

export async function createCommissionSettlement(adminId: string, opts: {
  beneficiary: CommissionBeneficiary;
  beneficiaryId: string;
  periodFrom: Date;
  periodTo: Date;
  payoutMethod?: string;
}): Promise<CommissionSettlementDto> {
  if (!['SELLER', 'BD'].includes(opts.beneficiary)) {
    throw ApiError.badRequest('Only SELLER and BD commissions are payable to an account', 'bad_beneficiary');
  }
  if (opts.periodTo <= opts.periodFrom) throw ApiError.badRequest('Settlement period end must follow its start');

  const row = await withTransaction(async (client) => {
    const eligible = await client.query<CommissionEntryRow>(
      `SELECT * FROM commission_entries
        WHERE beneficiary = $1 AND beneficiary_id = $2 AND status = 'ACCRUED'
          AND created_at >= $3 AND created_at < $4
        ORDER BY created_at
        FOR UPDATE`,
      [opts.beneficiary, opts.beneficiaryId, opts.periodFrom, opts.periodTo],
    );
    if (!eligible.rows.length) throw ApiError.conflict('Nothing eligible to settle in this period', 'nothing_to_settle');

    const amountCents = eligible.rows.reduce((sum, entry) => sum + Number(entry.amount_cents), 0);
    const settlement = await client.query<CommissionSettlementRow>(
      `INSERT INTO commission_settlements
         (reference, beneficiary, beneficiary_id, currency, amount_cents, entry_count, period_from, period_to,
          payout_method, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        shortCode('CS-', 5),
        opts.beneficiary,
        opts.beneficiaryId,
        eligible.rows[0].currency,
        amountCents,
        eligible.rows.length,
        opts.periodFrom,
        opts.periodTo,
        opts.payoutMethod ?? null,
        adminId,
      ],
    );
    const created = settlement.rows[0];

    for (const entry of eligible.rows) {
      // `commission_settlement_items.entry_id` is unique, so this is the only place an entry
      // can ever be claimed. A concurrent batch either wins here or aborts on this key.
      await client.query(
        'INSERT INTO commission_settlement_items (settlement_id, entry_id) VALUES ($1,$2)',
        [created.id, entry.id],
      );
    }
    await client.query(
      `UPDATE commission_entries SET status = 'SETTLED', settled_at = now()
        WHERE id = ANY($1::uuid[])`,
      [eligible.rows.map((entry) => entry.id)],
    );

    await postJournal(client, {
      sourceKind: 'SETTLEMENT',
      sourceId: created.id,
      memo: `Commission settlement ${created.reference} prepared`,
      currency: created.currency,
      lines: [
        {
          accountCode: opts.beneficiary === 'SELLER' ? FIN_ACCOUNTS.sellerCommissionPayable : FIN_ACCOUNTS.bdCommissionPayable,
          direction: 'DEBIT',
          amountCents,
        },
        { accountCode: FIN_ACCOUNTS.providerCollections, direction: 'CREDIT', amountCents },
      ],
    });

    await recordAudit(
      {
        adminId,
        action: 'COMMISSION_SETTLEMENT_CREATE',
        targetType: 'commission_settlement',
        targetId: created.id,
        summary: `Settled ${amountCents} ${created.currency} for ${eligible.rows.length} entries (${opts.beneficiary} ${opts.beneficiaryId})`,
        details: { periodFrom: opts.periodFrom, periodTo: opts.periodTo, entryIds: eligible.rows.map((entry) => entry.id) },
      },
      client,
    );
    return created;
  });

  return toCommissionSettlement(row);
}

/**
 * Approve a batch. The operator who prepared it may not be the one who signs it off — the same
 * reason a withdrawal cannot approve itself.
 */
export async function approveCommissionSettlement(adminId: string, settlementId: string): Promise<CommissionSettlementDto> {
  const row = await withTransaction(async (client) => {
    const current = await client.query<CommissionSettlementRow>('SELECT * FROM commission_settlements WHERE id = $1 FOR UPDATE', [settlementId]);
    const batch = current.rows[0];
    if (!batch) throw ApiError.notFound('Settlement not found');
    if (batch.status !== 'DRAFT') throw ApiError.conflict(`A ${batch.status} batch cannot be approved`, 'invalid_status');
    if (batch.created_by === adminId) throw ApiError.forbidden('A settlement must be approved by a different operator', 'self_approval');
    const updated = await client.query<CommissionSettlementRow>(
      `UPDATE commission_settlements SET status = 'APPROVED', approved_by = $2 WHERE id = $1 RETURNING *`,
      [settlementId, adminId],
    );
    await recordAudit(
      {
        adminId,
        action: 'COMMISSION_SETTLEMENT_APPROVE',
        targetType: 'commission_settlement',
        targetId: settlementId,
        summary: `Approved ${updated.rows[0].reference} for ${updated.rows[0].amount_cents} ${updated.rows[0].currency}`,
      },
      client,
    );
    return updated.rows[0];
  });
  return toCommissionSettlement(row);
}

/** The batch is only marked paid once the money has actually left the platform account. */
export async function markCommissionSettlementPaid(adminId: string, settlementId: string, note?: string): Promise<CommissionSettlementDto> {
  const row = await withTransaction(async (client) => {
    const current = await client.query<CommissionSettlementRow>('SELECT * FROM commission_settlements WHERE id = $1 FOR UPDATE', [settlementId]);
    const batch = current.rows[0];
    if (!batch) throw ApiError.notFound('Settlement not found');
    if (batch.status !== 'APPROVED') throw ApiError.conflict(`Only an approved batch can be marked paid (this is ${batch.status})`, 'invalid_status');
    const updated = await client.query<CommissionSettlementRow>(
      `UPDATE commission_settlements SET status = 'PAID', paid_at = now(), note = COALESCE($2, note) WHERE id = $1 RETURNING *`,
      [settlementId, note ?? null],
    );
    await recordAudit(
      {
        adminId,
        action: 'COMMISSION_SETTLEMENT_PAID',
        targetType: 'commission_settlement',
        targetId: settlementId,
        summary: `Marked ${updated.rows[0].reference} paid${note ? ` — ${note}` : ''}`,
        details: { amountCents: Number(batch.amount_cents), note: note ?? null },
      },
      client,
    );
    return updated.rows[0];
  });
  return toCommissionSettlement(row);
}

export async function listCommissionSettlements(opts: {
  beneficiaryId?: string;
  status?: string;
  limit: number;
}): Promise<CommissionSettlementDto[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (opts.beneficiaryId) where.push(`beneficiary_id = ${bind(opts.beneficiaryId)}`);
  if (opts.status) where.push(`status = ${bind(opts.status)}`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Number(opts.limit) || 50;
  const rows = await many<CommissionSettlementRow>(
    `SELECT * FROM commission_settlements ${clause} ORDER BY created_at DESC LIMIT ${limit}`,
    params,
  );
  return rows.map(toCommissionSettlement);
}
