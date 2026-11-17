import { PoolClient } from 'pg';
import { withTransaction, one, many } from '../config/db';
import { ApiError } from '../utils/http';
import { shortCode } from '../utils/ids';
import { recordAudit } from './audit.service';
import { FIN_ACCOUNTS, coinFaceMinor, postJournal } from './finance-journal.service';
import {
  AccountCategory,
  BalanceRow,
  PurposeAccountDto,
  accountCodeFor,
  createHold,
  ensureOwnerAccount,
  minor,
  releaseHold,
  toAccountDto,
} from './purpose-account.service';

/**
 * Agencies as a money relationship (migration 0033).
 *
 * A host belongs to an agency, the agency takes a share of what that host earns from gifts, and the
 * host is *not* paid less — the ledger row that records the share is notional, so no wallet and no
 * coin projection moves for it. What the platform owes the agency is therefore a statement about the
 * money book, not about anybody's balance: the share is counted in coins, priced at the same
 * `accounts.coinValue` face value the gift spread (0031) and the withdrawal fee (0032) use, and lands
 * as DEBIT `COMMISSION_EXPENSE` / CREDIT `AGENCY:<id>`.
 *
 * Three rules this file keeps:
 *
 *  *The rate is inherited, never guessed.* Host override, then the agency's own rate, then the
 *   `accounts.agency` platform default. A `NULL` at either of the first two levels means "nobody
 *   agreed a number here", which is exactly why 0033 made those columns nullable — a `DEFAULT 1000`
 *   made an unset rate and a 10.00% rate the same row.
 *  *The fallback fails closed.* A missing or malformed `accounts.agency` reads as 0, so a bad config
 *   row cannot mint a commission the platform did not promise. `agencies.commission_bps` and
 *   `agency_hosts.commission_bps` may still legitimately be 0, and 0 means the same thing as NULL for
 *   the amount — it does not inherit, it declines to take a share.
 *  *Nothing here touches a balance.* Coins are moved by `ledger.service.ts`; this file only ever
 *  writes journal lines and the settlement batches that reference them.
 */

export const AGENCY_RATE_CONFIG_KEY = 'accounts.agency';
export const MAX_COMMISSION_BPS = 10_000;

export type RateSource = 'HOST' | 'AGENCY' | 'PLATFORM_DEFAULT';

/** Derived from the parent link, never stored beside it (migration 0040). */
export type AgencyKind = 'MASTER' | 'SUB';

export type CommissionMembership = {
  agencyId: string;
  agencyName: string;
  commissionBps: number;
  rateSource: RateSource;
  /** The master this agency reports to, and the share of its commission that master keeps. */
  parentAgencyId: string | null;
  parentAgencyName: string | null;
  parentOverrideBps: number | null;
};

/**
 * The master's share of one accrual, in coins.
 *
 * Exported because two callers need the same number for two different purposes: the gift path writes
 * it into the commission row's `meta` so reporting can attribute it without re-deriving a rate that
 * may since have changed, and `accrueAgencyCommission` prices it into the journal. One implementation
 * means the figure on the ledger row and the figure in the book cannot drift apart.
 */
export function overrideCoinsFor(coins: number, overrideBps: number | null): number {
  if (coins <= 0 || overrideBps === null || overrideBps <= 0) return 0;
  return Math.floor((coins * overrideBps) / MAX_COMMISSION_BPS);
}

/**
 * The platform-wide default.
 *
 * Takes a client when the caller is already in a transaction — the gift path must not read the dial
 * on a second connection — and falls back to the pool for a screen that only displays it.
 */
export async function defaultCommissionBps(client?: PoolClient): Promise<number> {
  const sql = 'SELECT value FROM system_config WHERE key = $1';
  const row = client
    ? (await client.query<{ value: { defaultCommissionBps?: unknown } }>(sql, [AGENCY_RATE_CONFIG_KEY])).rows[0]
    : await one<{ value: { defaultCommissionBps?: unknown } }>(sql, [AGENCY_RATE_CONFIG_KEY]);
  const configured = Number(row?.value?.defaultCommissionBps);
  return Number.isInteger(configured) && configured >= 0 && configured <= MAX_COMMISSION_BPS ? configured : 0;
}

/**
 * The three levels, in the order they speak.
 *
 * `NULL` is "nobody agreed a number here", which is what 0033's nullable columns made expressible.
 * `0` is a decision — it takes nothing, and it does not inherit — so the two are never collapsed.
 */
export function resolveCommissionRate(
  hostBps: number | null,
  agencyBps: number | null,
  fallback: number,
): { commissionBps: number; rateSource: RateSource } {
  if (hostBps !== null) return { commissionBps: hostBps, rateSource: 'HOST' };
  if (agencyBps !== null) return { commissionBps: agencyBps, rateSource: 'AGENCY' };
  return { commissionBps: fallback, rateSource: 'PLATFORM_DEFAULT' };
}

/**
 * The agency a host belongs to, and the rate that applies to their earnings.
 *
 * Returns null when there is no active membership: no agency, no commission, no accrual. The rate is
 * resolved in SQL rather than in three round trips, so the amount a gift accrues cannot be decided from
 * two different reads of the roster.
 */
export async function commissionMembership(
  client: PoolClient,
  hostUserId: string,
): Promise<CommissionMembership | null> {
  const fallback = await defaultCommissionBps(client);
  const rows = await client.query<{
    agency_id: string;
    agency_name: string;
    host_bps: number | null;
    agency_bps: number | null;
    parent_agency_id: string | null;
    parent_name: string | null;
    parent_override_bps: number | null;
  }>(
    `SELECT ah.agency_id, a.name AS agency_name, ah.commission_bps AS host_bps, a.commission_bps AS agency_bps,
            a.parent_agency_id, p.name AS parent_name, a.parent_override_bps
       FROM agency_hosts ah
       JOIN agencies a ON a.id = ah.agency_id
       LEFT JOIN agencies p ON p.id = a.parent_agency_id
      WHERE ah.host_user_id = $1 AND ah.status = 'ACTIVE'
      LIMIT 1`,
    [hostUserId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const rate = resolveCommissionRate(row.host_bps, row.agency_bps, fallback);
  return {
    agencyId: row.agency_id,
    agencyName: row.agency_name,
    ...rate,
    parentAgencyId: row.parent_agency_id,
    parentAgencyName: row.parent_name,
    parentOverrideBps: row.parent_override_bps,
  };
}

/**
 * How a rate came to be, in the words a journal memo carries.
 *
 * The number alone cannot answer the question an agency actually asks — "why is my share this and not
 * what the contract says" — and the answer is which of the three levels spoke.
 */
export function commissionBpsLabel(
  rate: Pick<CommissionMembership, 'commissionBps' | 'rateSource'>,
): string {
  const percent = (rate.commissionBps / 100).toFixed(2).replace(/\.?0+$/, '');
  const source =
    rate.rateSource === 'HOST'
      ? 'agreed for this host'
      : rate.rateSource === 'AGENCY'
        ? 'the agency rate'
        : 'the platform default rate';
  return `${percent}% ${source}`;
}

/**
 * What the parent link means for the money, in one line an operator can read without dividing bps.
 *
 * A master has no override to give, so its label says what it keeps rather than printing a dash that
 * could be read as "zero percent agreed". A sub prints both halves of the same split, because the
 * number that matters to the sub is the one it is left with.
 */
export function overrideLabel(overrideBps: number | null, isSub: boolean): string {
  if (!isSub) return 'Keeps its own roster’s commission';
  if (overrideBps === null || overrideBps <= 0) return 'Master takes nothing — keeps 100%';
  const taken = overrideBps / 100;
  const kept = (MAX_COMMISSION_BPS - overrideBps) / 100;
  const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, '');
  return `Master keeps ${trim(taken)}% — this agency keeps ${trim(kept)}%`;
}

/**
 * Book what the platform owes an agency for one gift.
 *
 * Keyed on the commission ledger row, so the same send describes its share once: a replayed gift is
 * answered with its original receipt and adds no entry, and a retried accrual after a lost response
 * finds the index rather than double-paying.
 *
 * `0` coins or a book that does not value coins (`minorPerCoin` of 0) post nothing — the amount owed
 * would be a number nobody configured, and the reconciler reports those rows as unbooked rather than
 * the writer inventing a rate.
 */
export async function accrueAgencyCommission(
  client: PoolClient,
  opts: {
    commissionTransactionId: string;
    agencyId: string;
    coins: number;
    memo: string;
    /** Set when the accruing agency is a sub and its master takes a share (0040). */
    parentAgencyId?: string | null;
    parentAgencyName?: string | null;
    parentOverrideBps?: number | null;
  },
): Promise<{
  posted: boolean;
  amountMinor: number;
  overridePosted: boolean;
  overrideAmountMinor: number;
  overrideCoins: number;
}> {
  const nothing = { posted: false, amountMinor: 0, overridePosted: false, overrideAmountMinor: 0, overrideCoins: 0 };
  if (opts.coins <= 0) return nothing;
  const face = await coinFaceMinor(client);
  if (face <= 0) return nothing;
  const amountMinor = opts.coins * face;

  const category: AccountCategory = 'AGENCY';
  await ensureOwnerAccount(client, category, opts.agencyId);
  const entry = await postJournal(client, {
    sourceKind: 'AGENCY_COMMISSION',
    sourceId: opts.commissionTransactionId,
    memo: opts.memo.slice(0, 300),
    currency: 'pkr',
    lines: [
      { accountCode: FIN_ACCOUNTS.commissionExpense, direction: 'DEBIT', amountCents: amountMinor },
      { accountCode: accountCodeFor(category, opts.agencyId), direction: 'CREDIT', amountCents: amountMinor },
    ],
  });

  // The master's allocation is a transfer between two payables, not a second expense: the platform
  // promised `coins` once, and `COMMISSION_EXPENSE` was debited for all of it above. Debiting the
  // sub and crediting the master moves the same money to whoever negotiated it, and because an
  // AGENCY position is derived from journal lines both payables follow with no stored balance to
  // update. Keyed on the same commission row under its own source kind, so a replayed gift finds
  // both entries rather than writing either twice.
  const overrideCoins = opts.parentAgencyId
    ? overrideCoinsFor(opts.coins, opts.parentOverrideBps ?? null)
    : 0;
  if (!opts.parentAgencyId || overrideCoins <= 0) {
    return { posted: entry.posted, amountMinor, overridePosted: false, overrideAmountMinor: 0, overrideCoins: 0 };
  }
  const overrideAmountMinor = overrideCoins * face;
  await ensureOwnerAccount(client, category, opts.parentAgencyId);
  const share = await postJournal(client, {
    sourceKind: 'AGENCY_OVERRIDE',
    sourceId: opts.commissionTransactionId,
    memo: `${opts.parentAgencyName ?? 'Master agency'} keeps ${((opts.parentOverrideBps ?? 0) / 100).toFixed(2)}% of ${opts.memo}`.slice(0, 300),
    currency: 'pkr',
    lines: [
      { accountCode: accountCodeFor(category, opts.agencyId), direction: 'DEBIT', amountCents: overrideAmountMinor },
      { accountCode: accountCodeFor(category, opts.parentAgencyId), direction: 'CREDIT', amountCents: overrideAmountMinor },
    ],
  });
  return {
    posted: entry.posted,
    amountMinor,
    overridePosted: share.posted,
    overrideAmountMinor,
    overrideCoins,
  };
}

// ---------------------------------------------------------------------------
// The operator's side: what the rates are, and the batches that clear them.
//
// Reading an agency's position means reading two things that answer different questions. The
// projection says what the platform owes in money; the roster says which host's earnings produced
// that figure and at which of the three rates. An operator settling a dispute needs both, and a
// screen that showed only the total cannot answer "why is this mine".
// ---------------------------------------------------------------------------

/** The parent link and the owner, as the guard on an agency's own routes reads them. */
export type AgencyOwnerRow = {
  id: string;
  name: string;
  status: AgencyStatus;
  parent_agency_id: string | null;
  parent_override_bps: number | null;
  owner_user_id: string | null;
};

export const AGENCY_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED'] as const;
export type AgencyStatus = (typeof AGENCY_STATUSES)[number];
/** Not a column: which side of the parent link a row sits on (0040). */
export const AGENCY_KINDS = ['MASTER', 'SUB'] as const;
export const AGENCY_SETTLEMENT_STATUSES = ['DRAFT', 'APPROVED', 'PAID', 'VOID'] as const;
/** The same three the withdrawal sheet accepts: one server-owned list, not one per screen. */
export const AGENCY_PAYOUT_METHODS = ['BANK', 'WALLET', 'USDT'] as const;

export type AgencyDto = {
  id: string;
  name: string;
  status: AgencyStatus;
  contactPhone: string | null;
  ownerUserId: string | null;
  /** The agency's own rate. `null` inherits the platform default, which is the point of 0033. */
  commissionBps: number | null;
  commissionLabel: string;
  /** MASTER when there is no parent link, SUB when there is one. Derived, never stored (0040). */
  kind: AgencyKind;
  parentAgencyId: string | null;
  parentAgencyName: string | null;
  /** The share of this sub's commission its master keeps. Null on a master, which has none to give. */
  parentOverrideBps: number | null;
  parentOverrideLabel: string;
  subAgencyCount: number;
  hostCount: number;
  activeHostCount: number;
  /** Lifetime commission counted in coins — the unit an agency negotiates in. Gross, before any override. */
  accruedCoins: number;
  /** Of that gross, what was passed up to the master. Zero on a master. */
  overrideCoins: number;
  /** What this agency keeps of its own roster's gross: accrued minus passed up. */
  retainedCoins: number;
  /** What it took in from its own sub-agencies' overrides. Zero on a sub, which has none. */
  receivedOverrideCoins: number;
  openBatches: number;
  paidBatches: number;
  createdAt: string;
  /** null when the account was never opened, which the reconciliation report also says. */
  account: PurposeAccountDto | null;
};

/** One row of a master's sub-agency allocation table. */
export type AgencySubRow = {
  id: string;
  name: string;
  status: AgencyStatus;
  hostCount: number;
  activeHostCount: number;
  /** The sub's own rate — what a new host on its roster is taken at. */
  commissionBps: number | null;
  commissionLabel: string;
  parentOverrideBps: number | null;
  parentOverrideLabel: string;
  accruedCoins: number;
  overrideCoins: number;
  retainedCoins: number;
  /** The sub's payable in minor units, and the currency it is held in. Null when never opened. */
  owedMinor: number | null;
  currency: string | null;
  createdAt: string;
};

export type AgencyRosterRow = {
  membershipId: string;
  hostUserId: string;
  username: string;
  phone: string;
  avatarUrl: string | null;
  status: AgencyStatus;
  joinedAt: string;
  /** null means the host inherits the agency's rate. */
  hostCommissionBps: number | null;
  effectiveBps: number;
  effectiveSource: RateSource;
  commissionLabel: string;
  accruedCoins: number;
};

export type AgencySettlementDto = {
  id: string;
  reference: string;
  agencyId: string;
  agencyName: string;
  currency: string;
  amount: number;
  status: string;
  periodFrom: string;
  periodTo: string;
  entryCount: number;
  payoutMethod: string | null;
  payoutReference: string | null;
  holdId: string | null;
  note: string | null;
  createdByName: string | null;
  approvedByName: string | null;
  createdAt: string;
  paidAt: string | null;
};

type AgencyRow = {
  id: string;
  name: string;
  status: AgencyStatus;
  contact_phone: string | null;
  owner_user_id: string | null;
  commission_bps: number | null;
  parent_agency_id: string | null;
  parent_override_bps: number | null;
  parent_agency_name: string | null;
  created_at: Date;
  host_count: string | number;
  active_host_count: string | number;
  sub_agency_count: string | number;
  accrued_coins: string | number;
  override_coins: string | number;
  received_override_coins: string | number;
  open_batches: string | number;
  paid_batches: string | number;
};

type SettlementRow = {
  id: string;
  reference: string;
  agency_id: string;
  agency_name: string;
  currency: string;
  amount_minor: string | number;
  status: string;
  period_from: Date;
  period_to: Date;
  payout_method: string | null;
  payout_reference: string | null;
  hold_id: string | null;
  note: string | null;
  created_by: string | null;
  approved_by: string | null;
  paid_at: Date | null;
  created_at: Date;
  created_by_name: string | null;
  approved_by_name: string | null;
  entry_count: string | number;
};

const SETTLEMENT_SELECT = `
  SELECT s.*, a.name AS agency_name,
         cb.username AS created_by_name, ab.username AS approved_by_name,
         (SELECT COUNT(*) FROM agency_settlement_items i WHERE i.settlement_id = s.id) AS entry_count
    FROM agency_settlements s
    JOIN agencies a ON a.id = s.agency_id
    LEFT JOIN admins cb ON cb.id = s.created_by
    LEFT JOIN admins ab ON ab.id = s.approved_by`;

function toSettlementDto(row: SettlementRow): AgencySettlementDto {
  return {
    id: row.id,
    reference: row.reference,
    agencyId: row.agency_id,
    agencyName: row.agency_name,
    currency: row.currency,
    amount: minor(row.amount_minor),
    status: row.status,
    periodFrom: new Date(row.period_from).toISOString(),
    periodTo: new Date(row.period_to).toISOString(),
    entryCount: minor(row.entry_count),
    payoutMethod: row.payout_method,
    payoutReference: row.payout_reference,
    holdId: row.hold_id,
    note: row.note,
    createdByName: row.created_by_name,
    approvedByName: row.approved_by_name,
    createdAt: new Date(row.created_at).toISOString(),
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
  };
}

/** The row with its status decided, read behind the write that changed it. */
async function readSettlement(client: PoolClient, id: string): Promise<AgencySettlementDto> {
  const rows = await client.query<SettlementRow>(`${SETTLEMENT_SELECT} WHERE s.id = $1`, [id]);
  const row = rows.rows[0];
  if (!row) throw ApiError.notFound('Agency settlement not found', 'settlement_not_found');
  return toSettlementDto(row);
}

function toAgencyDto(row: AgencyRow, account: PurposeAccountDto | null, fallbackBps: number): AgencyDto {
  // The label describes the agency's own level, so it is resolved with no host rate — which is what
  // "what will a new host on this agency be taken at" means on this screen.
  const rate = resolveCommissionRate(null, row.commission_bps, fallbackBps);
  const isSub = row.parent_agency_id !== null;
  const accrued = minor(row.accrued_coins);
  const passedUp = minor(row.override_coins);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    contactPhone: row.contact_phone,
    ownerUserId: row.owner_user_id,
    commissionBps: row.commission_bps,
    commissionLabel: commissionBpsLabel(rate),
    kind: isSub ? 'SUB' : 'MASTER',
    parentAgencyId: row.parent_agency_id,
    parentAgencyName: row.parent_agency_name,
    parentOverrideBps: row.parent_override_bps,
    parentOverrideLabel: overrideLabel(row.parent_override_bps, isSub),
    subAgencyCount: minor(row.sub_agency_count),
    hostCount: minor(row.host_count),
    activeHostCount: minor(row.active_host_count),
    accruedCoins: accrued,
    overrideCoins: passedUp,
    retainedCoins: accrued - passedUp,
    receivedOverrideCoins: minor(row.received_override_coins),
    openBatches: minor(row.open_batches),
    paidBatches: minor(row.paid_batches),
    createdAt: new Date(row.created_at).toISOString(),
    account,
  };
}

const AGENCY_AGGREGATES = `
       (SELECT p.name FROM agencies p WHERE p.id = a.parent_agency_id) AS parent_agency_name,
       (SELECT COUNT(*) FROM agencies c WHERE c.parent_agency_id = a.id) AS sub_agency_count,
       (SELECT COUNT(*) FROM agency_hosts h WHERE h.agency_id = a.id) AS host_count,
       (SELECT COUNT(*) FROM agency_hosts h WHERE h.agency_id = a.id AND h.status = 'ACTIVE') AS active_host_count,
       (SELECT COUNT(*) FROM agency_settlements s WHERE s.agency_id = a.id
         AND s.status IN ('DRAFT','APPROVED')) AS open_batches,
       (SELECT COUNT(*) FROM agency_settlements s WHERE s.agency_id = a.id AND s.status = 'PAID') AS paid_batches,
       COALESCE((SELECT SUM(t.amount_r_coins) FROM transactions t
                  WHERE t.agency_id = a.id AND t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'), 0) AS accrued_coins,
       -- The override is read from the commission row's own meta, not re-derived from today's rate:
       -- the split was agreed when the gift landed, and a rate changed since must not rewrite it.
       COALESCE((SELECT SUM((t.meta->>'overrideCoins')::bigint) FROM transactions t
                  WHERE t.agency_id = a.id AND t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'), 0) AS override_coins,
       COALESCE((SELECT SUM((t.meta->>'overrideCoins')::bigint) FROM transactions t
                  WHERE t.meta->>'parentAgencyId' = a.id::text
                    AND t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'), 0) AS received_override_coins`;

/** Escape the LIKE wildcards instead of deleting them: an agency name may legitimately contain one. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listAgencies(opts: {
  search?: string;
  status?: string;
  kind?: string;
  parentAgencyId?: string;
  limit: number;
  offset: number;
}): Promise<{ agencies: AgencyDto[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (opts.status) where.push(`a.status = ${bind(opts.status)}::agency_status`);
  if (opts.search) where.push(`a.name ILIKE ${bind(likePattern(opts.search))} ESCAPE '\\'`);
  // Kind is the parent link, so the filter is the link — there is no stored column to disagree with it.
  if (opts.kind === 'MASTER') where.push('a.parent_agency_id IS NULL');
  if (opts.kind === 'SUB') where.push('a.parent_agency_id IS NOT NULL');
  if (opts.parentAgencyId) where.push(`a.parent_agency_id = ${bind(opts.parentAgencyId)}::uuid`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(opts.limit || 25, 200));
  const offset = Math.max(0, opts.offset || 0);

  const [rows, count, fallbackBps] = await Promise.all([
    many<AgencyRow>(
      `SELECT a.*, ${AGENCY_AGGREGATES} FROM agencies a ${clause} ORDER BY a.created_at DESC, a.name LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    one<{ n: string }>(`SELECT COUNT(*)::text AS n FROM agencies a ${clause}`, params),
    defaultCommissionBps(),
  ]);

  const accounts = await many<BalanceRow>(
    `SELECT * FROM purpose_account_balances WHERE account_code = ANY($1::text[])`,
    [rows.map((row) => accountCodeFor('AGENCY', row.id))],
  );
  const byOwner = new Map(accounts.map((account) => [account.owner_id, toAccountDto(account)]));

  return {
    agencies: rows.map((row) => toAgencyDto(row, byOwner.get(row.id) ?? null, fallbackBps)),
    total: Number(count?.n ?? 0),
  };
}

export async function agencyDetail(agencyId: string): Promise<{
  agency: AgencyDto;
  roster: AgencyRosterRow[];
  subAgencies: AgencySubRow[];
  settlements: AgencySettlementDto[];
}> {
  const [row, account, fallbackBps] = await Promise.all([
    one<AgencyRow>(`SELECT a.*, ${AGENCY_AGGREGATES} FROM agencies a WHERE a.id = $1`, [agencyId]),
    one<BalanceRow>('SELECT * FROM purpose_account_balances WHERE account_code = $1', [accountCodeFor('AGENCY', agencyId)]),
    defaultCommissionBps(),
  ]);
  if (!row) throw ApiError.notFound('Agency not found', 'agency_not_found');
  const agency = toAgencyDto(row, account ? toAccountDto(account) : null, fallbackBps);
  const [rosterRows, batches] = await Promise.all([
    many<{
      membership_id: string;
      host_user_id: string;
      username: string;
      phone: string;
      avatar_url: string | null;
      status: AgencyStatus;
      joined_at: Date;
      host_bps: number | null;
      agency_bps: number | null;
      accrued_coins: string | number;
    }>(
      `SELECT ah.id AS membership_id, ah.host_user_id, u.username, u.phone, u.avatar_url, ah.status,
              ah.joined_at, ah.commission_bps AS host_bps, a.commission_bps AS agency_bps,
              COALESCE((SELECT SUM(t.amount_r_coins) FROM transactions t
                         WHERE t.agency_id = $1 AND t.receiver_id = ah.host_user_id
                           AND t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'), 0) AS accrued_coins
         FROM agency_hosts ah
         JOIN users u ON u.id = ah.host_user_id
         JOIN agencies a ON a.id = ah.agency_id
        WHERE ah.agency_id = $1
        ORDER BY ah.joined_at DESC`,
      [agencyId],
    ),
    many<SettlementRow>(
      `${SETTLEMENT_SELECT} WHERE s.agency_id = $1 ORDER BY s.created_at DESC LIMIT 50`,
      [agencyId],
    ),
  ]);

  const subRows = await many<AgencyRow>(
    `SELECT a.*, ${AGENCY_AGGREGATES} FROM agencies a WHERE a.parent_agency_id = $1 ORDER BY a.name`,
    [agencyId],
  );
  const subAccounts = subRows.length
    ? await many<BalanceRow>('SELECT * FROM purpose_account_balances WHERE account_code = ANY($1::text[])', [
        subRows.map((sub) => accountCodeFor('AGENCY', sub.id)),
      ])
    : [];
  const subByOwner = new Map(subAccounts.map((account) => [account.owner_id, account]));

  return {
    agency,
    subAgencies: subRows.map((sub) => {
      const subRate = resolveCommissionRate(null, sub.commission_bps, fallbackBps);
      const position = subByOwner.get(sub.id);
      const gross = minor(sub.accrued_coins);
      const up = minor(sub.override_coins);
      return {
        id: sub.id,
        name: sub.name,
        status: sub.status,
        hostCount: minor(sub.host_count),
        activeHostCount: minor(sub.active_host_count),
        commissionBps: sub.commission_bps,
        commissionLabel: commissionBpsLabel(subRate),
        parentOverrideBps: sub.parent_override_bps,
        parentOverrideLabel: overrideLabel(sub.parent_override_bps, true),
        accruedCoins: gross,
        overrideCoins: up,
        retainedCoins: gross - up,
        owedMinor: position ? minor(position.available_minor) : null,
        currency: position?.currency ?? null,
        createdAt: new Date(sub.created_at).toISOString(),
      };
    }),
    roster: rosterRows.map((row) => {
      const rate = resolveCommissionRate(row.host_bps, row.agency_bps, fallbackBps);
      return {
        membershipId: row.membership_id,
        hostUserId: row.host_user_id,
        username: row.username,
        phone: row.phone,
        avatarUrl: row.avatar_url,
        status: row.status,
        joinedAt: new Date(row.joined_at).toISOString(),
        hostCommissionBps: row.host_bps,
        effectiveBps: rate.commissionBps,
        effectiveSource: rate.rateSource,
        commissionLabel: commissionBpsLabel(rate),
        accruedCoins: minor(row.accrued_coins),
      };
    }),
    settlements: batches.map(toSettlementDto),
  };
}

/** Every batch on the platform, newest first — the queue finance works through. */
export async function listAgencySettlements(opts: {
  agencyId?: string;
  status?: string;
  limit: number;
}): Promise<AgencySettlementDto[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (opts.agencyId) where.push(`s.agency_id = ${bind(opts.agencyId)}::uuid`);
  if (opts.status) where.push(`s.status = ${bind(opts.status)}::settlement_status_new`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const rows = await many<SettlementRow>(
    `${SETTLEMENT_SELECT} ${clause} ORDER BY s.created_at DESC LIMIT ${limit}`,
    params,
  );
  return rows.map(toSettlementDto);
}

/**
 * The accruals one batch paid.
 *
 * This is the list an agency asks for when it disputes a figure, and the journal is the only place
 * that answer exists: each row names the ledger transaction the commission was counted from.
 */
export async function agencySettlementEntries(settlementId: string): Promise<{
  settlement: AgencySettlementDto;
  entries: { reference: string; occurredAt: string; amount: number; currency: string; memo: string | null; sourceId: string }[];
}> {
  const settlement = await one<SettlementRow>(`${SETTLEMENT_SELECT} WHERE s.id = $1`, [settlementId]);
  if (!settlement) throw ApiError.notFound('Agency settlement not found', 'settlement_not_found');
  const entries = await many<{
    reference: string;
    occurred_at: Date;
    amount_minor: string | number;
    currency: string;
    memo: string | null;
    source_id: string;
  }>(
    `SELECT e.reference, e.occurred_at, e.currency, e.memo, e.source_id, i.amount_minor
       FROM agency_settlement_items i
       JOIN fin_journal_entries e ON e.id = i.entry_id
      WHERE i.settlement_id = $1
      ORDER BY e.occurred_at, e.reference`,
    [settlementId],
  );
  return {
    settlement: toSettlementDto(settlement),
    entries: entries.map((row) => ({
      reference: row.reference,
      occurredAt: new Date(row.occurred_at).toISOString(),
      amount: minor(row.amount_minor),
      currency: row.currency,
      memo: row.memo,
      sourceId: row.source_id,
    })),
  };
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/**
 * Set, change or clear an agency's rate.
 *
 * `null` is not "unknown" here, it is a decision: it says the agency takes the platform default, and
 * the audit row records both the figure that stops applying and the one that starts. The DB CHECK
 * keeps the number inside 0..10000 bps; the check below exists so a mistake returns a readable 400
 * instead of a constraint name.
 */
export async function setAgencyRate(adminId: string, agencyId: string, commissionBps: number | null): Promise<AgencyDto> {
  if (commissionBps !== null && (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > MAX_COMMISSION_BPS)) {
    throw ApiError.badRequest(`A commission rate must be a whole number of basis points between 0 and ${MAX_COMMISSION_BPS}`, 'bad_rate');
  }
  const row = await withTransaction(async (client) => {
    const current = await client.query<AgencyRow>(
      `SELECT a.*, ${AGENCY_AGGREGATES} FROM agencies a WHERE a.id = $1 FOR UPDATE`,
      [agencyId],
    );
    const agency = current.rows[0];
    if (!agency) throw ApiError.notFound('Agency not found', 'agency_not_found');
    const updated = await client.query<{ commission_bps: number | null }>(
      'UPDATE agencies SET commission_bps = $2 WHERE id = $1 RETURNING commission_bps',
      [agencyId, commissionBps],
    );
    const after = updated.rows[0].commission_bps;
    await recordAudit(
      {
        adminId,
        action: 'AGENCY_RATE_UPDATE',
        targetType: 'agency',
        targetId: agencyId,
        summary: `${agency.name} commission ${describeRate(agency.commission_bps)} → ${describeRate(after)}`,
        details: { from: agency.commission_bps, to: after },
      },
      client,
    );
    return { ...agency, commission_bps: after };
  });
  const account = await one<BalanceRow>('SELECT * FROM purpose_account_balances WHERE account_code = $1', [
    accountCodeFor('AGENCY', agencyId),
  ]);
  return toAgencyDto(row, account ? toAccountDto(account) : null, await defaultCommissionBps());
}

/**
 * Override, or inherit, one host's rate.
 *
 * Only a host already on the roster can be given a rate: this is not the route that adds people to
 * an agency, and letting it do so would put a money decision behind whichever screen happens to
 * call it.
 */
export async function setHostRate(
  adminId: string,
  agencyId: string,
  hostUserId: string,
  commissionBps: number | null,
): Promise<AgencyRosterRow> {
  if (commissionBps !== null && (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > MAX_COMMISSION_BPS)) {
    throw ApiError.badRequest(`A commission rate must be a whole number of basis points between 0 and ${MAX_COMMISSION_BPS}`, 'bad_rate');
  }
  const row = await withTransaction(async (client) => {
    const existing = await client.query<{
      id: string;
      commission_bps: number | null;
      agency_bps: number | null;
      status: AgencyStatus;
      joined_at: Date;
    }>(
      `SELECT ah.id, ah.commission_bps, a.commission_bps AS agency_bps, ah.status, ah.joined_at
         FROM agency_hosts ah JOIN agencies a ON a.id = ah.agency_id
        WHERE ah.agency_id = $1 AND ah.host_user_id = $2
        FOR UPDATE OF ah`,
      [agencyId, hostUserId],
    );
    const membership = existing.rows[0];
    if (!membership) throw ApiError.notFound('This host is not on the agency roster', 'membership_not_found');
    const updated = await client.query<{ commission_bps: number | null }>(
      'UPDATE agency_hosts SET commission_bps = $3 WHERE id = $1 AND agency_id = $2 RETURNING commission_bps',
      [membership.id, agencyId, commissionBps],
    );
    const after = updated.rows[0].commission_bps;
    await recordAudit(
      {
        adminId,
        action: 'AGENCY_HOST_RATE_UPDATE',
        targetType: 'agency_host',
        targetId: membership.id,
        summary: `Host ${hostUserId} commission ${describeRate(membership.commission_bps)} → ${describeRate(after)}`,
        details: { agencyId, hostUserId, from: membership.commission_bps, to: after },
      },
      client,
    );
    return { membershipId: membership.id, hostBps: after, agencyBps: membership.agency_bps,
             status: membership.status, joinedAt: membership.joined_at };
  });

  const fallback = await defaultCommissionBps();
  const rate = resolveCommissionRate(row.hostBps, row.agencyBps, fallback);
  const host = await one<{ username: string; phone: string; avatar_url: string | null }>(
    'SELECT username, phone, avatar_url FROM users WHERE id = $1',
    [hostUserId],
  );
  const coins = await one<{ n: string | number }>(
    `SELECT COALESCE(SUM(amount_r_coins), 0) AS n FROM transactions
      WHERE agency_id = $1 AND receiver_id = $2 AND type = 'AGENCY_COMMISSION' AND status = 'COMPLETED'`,
    [agencyId, hostUserId],
  );
  return {
    membershipId: row.membershipId,
    hostUserId,
    username: host?.username ?? '',
    phone: host?.phone ?? '',
    avatarUrl: host?.avatar_url ?? null,
    status: row.status,
    joinedAt: new Date(row.joinedAt).toISOString(),
    hostCommissionBps: row.hostBps,
    effectiveBps: rate.commissionBps,
    effectiveSource: rate.rateSource,
    commissionLabel: commissionBpsLabel(rate),
    accruedCoins: minor(coins?.n ?? 0),
  };
}

function describeRate(bps: number | null): string {
  return bps === null ? 'inherited' : `${(bps / 100).toFixed(2)}%`;
}

/** The row as a screen reads it, after a write changed it. */
async function readAgencyDto(agencyId: string): Promise<AgencyDto> {
  const [row, account, fallback] = await Promise.all([
    one<AgencyRow>(`SELECT a.*, ${AGENCY_AGGREGATES} FROM agencies a WHERE a.id = $1`, [agencyId]),
    one<BalanceRow>('SELECT * FROM purpose_account_balances WHERE account_code = $1', [
      accountCodeFor('AGENCY', agencyId),
    ]),
    defaultCommissionBps(),
  ]);
  if (!row) throw ApiError.notFound('Agency not found', 'agency_not_found');
  return toAgencyDto(row, account ? toAccountDto(account) : null, fallback);
}

/**
 * Put an agency under a master, or release it to stand on its own.
 *
 * The relationship is a money decision, so it is taken here and never inferred from a name or a
 * screen: the same checks the 0040 trigger makes are made first, in words an operator can act on,
 * and the trigger remains the backstop for anything that writes the column directly.
 *
 * Changing a parent always clears the override. The share was negotiated with the master it was
 * agreed under, and carrying it to a different master would book money nobody agreed to — the new
 * master takes nothing until an operator sets a rate for this sub explicitly. History is untouched:
 * overrides already posted stay posted, because they describe gifts that landed under the old link.
 */
export async function setAgencyParent(
  adminId: string,
  agencyId: string,
  parentAgencyId: string | null,
): Promise<AgencyDto> {
  if (parentAgencyId === agencyId) {
    throw ApiError.badRequest('An agency cannot be its own master', 'self_parent');
  }
  await withTransaction(async (client) => {
    const current = await client.query<{
      name: string;
      parent_agency_id: string | null;
      parent_override_bps: number | null;
    }>('SELECT name, parent_agency_id, parent_override_bps FROM agencies WHERE id = $1 FOR UPDATE', [agencyId]);
    const agency = current.rows[0];
    if (!agency) throw ApiError.notFound('Agency not found', 'agency_not_found');
    if (agency.parent_agency_id === parentAgencyId) return;

    let parentName: string | null = null;
    if (parentAgencyId !== null) {
      // Child before parent: the only other write that locks two agency rows is this one, and a
      // grandchild is refused, so the order cannot invert into a deadlock.
      const parent = await client.query<{ name: string; status: AgencyStatus; parent_agency_id: string | null }>(
        'SELECT name, status, parent_agency_id FROM agencies WHERE id = $1 FOR UPDATE',
        [parentAgencyId],
      );
      const master = parent.rows[0];
      if (!master) throw ApiError.notFound('That master agency does not exist', 'parent_not_found');
      if (master.parent_agency_id !== null) {
        throw ApiError.badRequest(`${master.name} is itself a sub-agency and cannot take sub-agencies`, 'parent_not_master');
      }
      if (master.status !== 'ACTIVE') {
        throw ApiError.badRequest(`${master.name} is ${master.status.toLowerCase()} and cannot take sub-agencies`, 'parent_inactive');
      }
      const children = await client.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM agencies WHERE parent_agency_id = $1',
        [agencyId],
      );
      if (Number(children.rows[0]?.n ?? 0) > 0) {
        throw ApiError.badRequest(
          `${agency.name} already has ${children.rows[0].n} sub-agencies and cannot itself become one`,
          'agency_has_children',
        );
      }
      parentName = master.name;
    }

    const fromName = agency.parent_agency_id
      ? (await client.query<{ name: string }>('SELECT name FROM agencies WHERE id = $1', [agency.parent_agency_id])).rows[0]?.name ?? null
      : null;

    await client.query('UPDATE agencies SET parent_agency_id = $2, parent_override_bps = NULL WHERE id = $1', [
      agencyId,
      parentAgencyId,
    ]);
    await recordAudit(
      {
        adminId,
        action: 'AGENCY_PARENT_UPDATE',
        targetType: 'agency',
        targetId: agencyId,
        summary: `${agency.name}: master ${fromName ?? 'none'} → ${parentName ?? 'none (stands alone)'}`,
        details: {
          from: agency.parent_agency_id,
          to: parentAgencyId,
          clearedOverrideBps: agency.parent_override_bps,
        },
      },
      client,
    );
  });
  return readAgencyDto(agencyId);
}

/**
 * Set, change or clear the share a sub-agency's master keeps of its commission.
 *
 * Only a sub has a master to allocate to, so this refuses on a master rather than storing a number
 * that would never be read — the same reason the trigger refuses the column there. `null` and `0`
 * both stop the split; `null` records that no share was agreed, `0` that one was and it is nothing.
 */
export async function setParentOverride(
  adminId: string,
  agencyId: string,
  overrideBps: number | null,
): Promise<AgencyDto> {
  if (overrideBps !== null && (!Number.isInteger(overrideBps) || overrideBps < 0 || overrideBps > MAX_COMMISSION_BPS)) {
    throw ApiError.badRequest(
      `An override must be a whole number of basis points between 0 and ${MAX_COMMISSION_BPS}`,
      'bad_rate',
    );
  }
  await withTransaction(async (client) => {
    const current = await client.query<{
      name: string;
      parent_agency_id: string | null;
      parent_override_bps: number | null;
    }>('SELECT name, parent_agency_id, parent_override_bps FROM agencies WHERE id = $1 FOR UPDATE', [agencyId]);
    const agency = current.rows[0];
    if (!agency) throw ApiError.notFound('Agency not found', 'agency_not_found');
    if (agency.parent_agency_id === null) {
      throw ApiError.badRequest(
        `${agency.name} is a master agency: put it under a master before allocating a share of its commission`,
        'override_needs_parent',
      );
    }
    await client.query('UPDATE agencies SET parent_override_bps = $2 WHERE id = $1', [agencyId, overrideBps]);
    await recordAudit(
      {
        adminId,
        action: 'AGENCY_OVERRIDE_UPDATE',
        targetType: 'agency',
        targetId: agencyId,
        summary: `${agency.name} master allocation ${describeRate(agency.parent_override_bps)} → ${describeRate(overrideBps)}`,
        details: {
          parentAgencyId: agency.parent_agency_id,
          from: agency.parent_override_bps,
          to: overrideBps,
        },
      },
      client,
    );
  });
  return readAgencyDto(agencyId);
}

// ---------------------------------------------------------------------------
// Settlement batches
// ---------------------------------------------------------------------------

/**
 * Raise a batch over an agency's accruals for one period.
 *
 * What makes this a claim on money rather than a document: the accruals it takes are written to
 * `agency_settlement_items`, whose unique key on the journal entry means a second batch — run by
 * another operator, on another tab, in the same second — cannot claim any of them a second time,
 * and the agency's account gets a `PENDING_SETTLEMENT` hold for the amount, so the balance an
 * agency sees as spendable already excludes what this batch is waiting to pay.
 *
 * Locking the agency row serialises raises on one agency; the claim key is what makes the guarantee
 * hold even if that lock is ever removed.
 */
export async function raiseAgencySettlement(
  adminId: string,
  opts: { agencyId: string; periodFrom: Date; periodTo: Date; payoutMethod?: string | null },
): Promise<AgencySettlementDto> {
  if (opts.periodTo <= opts.periodFrom) throw ApiError.badRequest('Settlement period end must follow its start', 'bad_period');

  return withTransaction(async (client) => {
    const agency = await client.query<{ id: string; name: string; status: AgencyStatus }>(
      'SELECT id, name, status FROM agencies WHERE id = $1 FOR UPDATE',
      [opts.agencyId],
    );
    const row = agency.rows[0];
    if (!row) throw ApiError.notFound('Agency not found', 'agency_not_found');

    const code = accountCodeFor('AGENCY', opts.agencyId);
    await ensureOwnerAccount(client, 'AGENCY', opts.agencyId);

    const candidates = await client.query<{ entry_id: string; amount_minor: string | number }>(
      `SELECT e.id AS entry_id, l.amount_cents AS amount_minor
         FROM fin_journal_entries e
         JOIN fin_journal_lines l ON l.entry_id = e.id AND l.account_code = $1 AND l.direction = 'CREDIT'
        WHERE e.source_kind = 'AGENCY_COMMISSION'
          AND e.occurred_at >= $2 AND e.occurred_at < $3
          AND NOT EXISTS (SELECT 1 FROM agency_settlement_items i WHERE i.entry_id = e.id)
        ORDER BY e.occurred_at, e.id`,
      [code, opts.periodFrom, opts.periodTo],
    );
    if (!candidates.rows.length) {
      throw ApiError.conflict('No unsettled agency commission in this period', 'nothing_to_settle');
    }
    const amountMinor = candidates.rows.reduce((sum, entry) => sum + minor(entry.amount_minor), 0);

    // The lock `createHold` takes, taken first, so the figures below and the hold that follows
    // describe the same position rather than two reads of a moving one.
    await client.query('SELECT code FROM fin_accounts WHERE code = $1 FOR UPDATE', [code]);
    const position = await client.query<BalanceRow>(
      'SELECT * FROM purpose_account_balances WHERE account_code = $1',
      [code],
    );
    const account = position.rows[0];
    if (!account) throw ApiError.notFound(`Agency account ${code} is missing`, 'account_not_found');
    const free = minor(account.available_minor) - minor(account.frozen_minor) - minor(account.pending_minor);
    if (amountMinor > free) {
      throw ApiError.conflict(
        `This batch is ${amountMinor} ${account.currency} but only ${free} is unclaimed — release a hold or widen the period`,
        'settlement_exceeds_payable',
      );
    }

    const batch = await client.query<{ id: string; reference: string }>(
      `INSERT INTO agency_settlements
         (reference, agency_id, currency, amount_minor, status, period_from, period_to, payout_method, created_by)
       VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8) RETURNING id, reference`,
      [
        shortCode('AS-', 5),
        opts.agencyId,
        account.currency,
        amountMinor,
        opts.periodFrom,
        opts.periodTo,
        opts.payoutMethod ?? null,
        adminId,
      ],
    );
    const created = batch.rows[0];

    await client.query(
      `INSERT INTO agency_settlement_items (settlement_id, entry_id, amount_minor)
       SELECT $1, e.entry_id, e.amount_minor
         FROM unnest($2::uuid[], $3::bigint[]) AS e(entry_id, amount_minor)`,
      [created.id, candidates.rows.map((entry) => entry.entry_id), candidates.rows.map((entry) => minor(entry.amount_minor))],
    );

    const hold = await createHold({
      accountCode: code,
      kind: 'PENDING_SETTLEMENT',
      amount: amountMinor,
      reason: `Agency settlement ${created.reference}: ${candidates.rows.length} accruals from ${opts.periodFrom.toISOString()} to ${opts.periodTo.toISOString()}`.slice(0, 300),
      adminId,
      client,
    });
    await client.query('UPDATE agency_settlements SET hold_id = $2 WHERE id = $1', [created.id, hold.id]);

    await recordAudit(
      {
        adminId,
        action: 'AGENCY_SETTLEMENT_CREATE',
        targetType: 'agency_settlement',
        targetId: created.id,
        summary: `Raised ${created.reference} for ${row.name}: ${amountMinor} ${account.currency} over ${candidates.rows.length} accruals`,
        details: {
          agencyId: opts.agencyId,
          entryIds: candidates.rows.map((entry) => entry.entry_id),
          holdId: hold.id,
          periodFrom: opts.periodFrom,
          periodTo: opts.periodTo,
        },
      },
      client,
    );
    return readSettlement(client, created.id);
  });
}

/** Sign a batch off. The operator who raised it cannot be the one who signs it. */
export async function approveAgencySettlement(adminId: string, settlementId: string): Promise<AgencySettlementDto> {
  return withTransaction(async (client) => {
    const current = await client.query<SettlementRow>('SELECT * FROM agency_settlements WHERE id = $1 FOR UPDATE', [settlementId]);
    const batch = current.rows[0];
    if (!batch) throw ApiError.notFound('Agency settlement not found', 'settlement_not_found');
    if (batch.status !== 'DRAFT') throw ApiError.conflict(`A ${batch.status} batch cannot be approved`, 'invalid_status');
    if (batch.created_by === adminId) throw ApiError.forbidden('A settlement must be approved by a different operator', 'self_approval');

    await client.query(`UPDATE agency_settlements SET status = 'APPROVED', approved_by = $2 WHERE id = $1`, [settlementId, adminId]);
    await recordAudit(
      {
        adminId,
        action: 'AGENCY_SETTLEMENT_APPROVE',
        targetType: 'agency_settlement',
        targetId: settlementId,
        summary: `Approved agency settlement ${batch.reference} for ${minor(batch.amount_minor)} ${batch.currency}`,
      },
      client,
    );
    return readSettlement(client, settlementId);
  });
}

/**
 * Record that the transfer happened.
 *
 * The journal moves here and nowhere earlier: DEBIT the agency's own account, CREDIT
 * `PROVIDER_COLLECTIONS` — the pair a BD commission batch uses, because the money leaves through
 * the same rails. A seller batch is the exception (0042): a seller keeps their cut out of cash they
 * already hold, so it credits `SELLER_RECEIVABLE` instead. The entry is keyed on the batch, so
 * replaying a pay whose response was lost finds the entry instead of writing a second one.
 *
 * The hold is converted, not deleted, so the account's statement can still name the batch that
 * cleared it. An operator may have released it by hand from the accounts screen in the meantime;
 * that is recorded rather than treated as a reason to refuse the payment, because the transfer is a
 * fact about the outside world by then.
 */
export async function payAgencySettlement(
  adminId: string,
  settlementId: string,
  opts: { payoutReference: string; payoutMethod?: string | null; note?: string | null },
): Promise<AgencySettlementDto> {
  const reference = opts.payoutReference.trim();
  if (reference.length < 3) {
    throw ApiError.badRequest('A payout needs the reference of the transfer that paid it', 'payout_reference_required');
  }
  return withTransaction(async (client) => {
    const current = await client.query<SettlementRow>('SELECT * FROM agency_settlements WHERE id = $1 FOR UPDATE', [settlementId]);
    const batch = current.rows[0];
    if (!batch) throw ApiError.notFound('Agency settlement not found', 'settlement_not_found');
    if (batch.status !== 'APPROVED') {
      throw ApiError.conflict(`Only an approved batch can be paid (this is ${batch.status})`, 'invalid_status');
    }

    const amountMinor = minor(batch.amount_minor);
    await postJournal(client, {
      sourceKind: 'AGENCY_SETTLEMENT',
      sourceId: batch.id,
      memo: `Agency settlement ${batch.reference} paid${batch.payout_method ? ` via ${batch.payout_method}` : ''}: ${amountMinor} ${batch.currency}`,
      currency: batch.currency,
      createdBy: adminId,
      lines: [
        { accountCode: accountCodeFor('AGENCY', batch.agency_id), direction: 'DEBIT', amountCents: amountMinor },
        { accountCode: FIN_ACCOUNTS.providerCollections, direction: 'CREDIT', amountCents: amountMinor },
      ],
    });

    let holdStatus: string | null = null;
    if (batch.hold_id) {
      const hold = await client.query<{ status: string }>('SELECT status FROM account_holds WHERE id = $1 FOR UPDATE', [batch.hold_id]);
      holdStatus = hold.rows[0]?.status ?? null;
      if (holdStatus === 'OPEN') await releaseHold(batch.hold_id, adminId, batch.reference, client);
    }

    await client.query(
      `UPDATE agency_settlements
          SET status = 'PAID', paid_at = now(), payout_reference = $2,
              payout_method = COALESCE($3, payout_method), note = COALESCE($4, note)
        WHERE id = $1`,
      [settlementId, reference.slice(0, 120), opts.payoutMethod ?? null, opts.note?.slice(0, 200) ?? null],
    );
    await recordAudit(
      {
        adminId,
        action: 'AGENCY_SETTLEMENT_PAID',
        targetType: 'agency_settlement',
        targetId: settlementId,
        summary: `Paid agency settlement ${batch.reference} — ${amountMinor} ${batch.currency}, transfer ${reference}`.slice(0, 500),
        details: { amountMinor, currency: batch.currency, payoutReference: reference, holdStatus },
      },
      client,
    );
    return readSettlement(client, settlementId);
  });
}

/**
 * Give up on a batch that was never paid.
 *
 * Its claims are deleted, which puts the accruals back on the table for the next batch — the reason
 * nothing needs reversing in the journal is that a batch that was not paid never wrote a line. The
 * batch keeps its amount as the record of what was raised and given up, and `admin_audit` names the
 * accruals that were released.
 */
export async function voidAgencySettlement(adminId: string, settlementId: string, reason: string): Promise<AgencySettlementDto> {
  const note = reason.trim();
  if (note.length < 8) throw ApiError.badRequest('Voiding a batch needs a reason an auditor can read later', 'reason_required');
  return withTransaction(async (client) => {
    const current = await client.query<SettlementRow>('SELECT * FROM agency_settlements WHERE id = $1 FOR UPDATE', [settlementId]);
    const batch = current.rows[0];
    if (!batch) throw ApiError.notFound('Agency settlement not found', 'settlement_not_found');
    if (batch.status === 'PAID') {
      throw ApiError.conflict(
        'A paid batch cannot be voided: the transfer happened, so the correction belongs in a new accrual',
        'settlement_paid',
      );
    }
    if (batch.status === 'VOID') throw ApiError.conflict('This batch is already void', 'invalid_status');

    const released = await client.query(
      `DELETE FROM agency_settlement_items WHERE settlement_id = $1 RETURNING entry_id`,
      [settlementId],
    );
    let holdStatus: string | null = null;
    if (batch.hold_id) {
      const hold = await client.query<{ status: string }>('SELECT status FROM account_holds WHERE id = $1 FOR UPDATE', [batch.hold_id]);
      holdStatus = hold.rows[0]?.status ?? null;
      if (holdStatus === 'OPEN') await releaseHold(batch.hold_id, adminId, null, client);
    }

    await client.query(`UPDATE agency_settlements SET status = 'VOID', note = $2 WHERE id = $1`, [settlementId, note.slice(0, 200)]);
    await recordAudit(
      {
        adminId,
        action: 'AGENCY_SETTLEMENT_VOID',
        targetType: 'agency_settlement',
        targetId: settlementId,
        summary: `Voided agency settlement ${batch.reference} (${minor(batch.amount_minor)} ${batch.currency}) — ${note}`,
        details: { releasedEntryIds: released.rows.map((entry) => entry.entry_id), holdStatus },
      },
      client,
    );
    return readSettlement(client, settlementId);
  });
}

// ---------------------------------------------------------------------------
// The agency's own side: what the member who runs it is allowed to see.
//
// Deliberately its own shapes rather than a filter over `agencyDetail`. The operator's desk carries
// the things a partner must not read — another operator's username on a batch, a payout reference
// from the platform's bank rails, a host's phone number — and a screen that hid them client-side
// would still be sending them. Everything below is derived from the agency's own rows, addressed by
// the owner link alone, and priced in the two units an agency actually negotiates in: coins earned
// and money owed.
// ---------------------------------------------------------------------------

export type AgencySelfDto = {
  id: string;
  name: string;
  kind: AgencyKind;
  status: AgencyStatus;
  createdAt: string;
  /** What a new host on this roster is taken at, and which level decided it. */
  commissionLabel: string;
  hostCount: number;
  activeHostCount: number;
  subAgencyCount: number;
  /** The master this agency reports to. Null for a master, which has none. */
  master: { id: string; name: string; overrideBps: number | null; overrideLabel: string } | null;
  earnings: {
    /** Lifetime commission counted on this agency's own roster, gross of any override. */
    accruedCoins: number;
    /** Of that, passed up to the master. */
    overrideCoins: number;
    /** What this agency keeps. */
    retainedCoins: number;
    /** Taken in from this agency's own sub-agencies. Zero for a sub. */
    receivedOverrideCoins: number;
    /** The last thirty days, so a monthly figure is readable without the operator's book. */
    last30dCoins: number;
    last30dOverrideCoins: number;
  };
  account: {
    currency: string;
    /** Settled and claimable. */
    availableMinor: number;
    /** Claimed by a batch that has not been paid yet. */
    pendingMinor: number;
    frozenMinor: number;
  } | null;
};

export type AgencySelfHost = {
  username: string;
  avatarUrl: string | null;
  status: AgencyStatus;
  joinedAt: string;
  commissionLabel: string;
  accruedCoins: number;
  last30dCoins: number;
};

export type AgencySelfSub = {
  id: string;
  name: string;
  status: AgencyStatus;
  hostCount: number;
  activeHostCount: number;
  parentOverrideBps: number | null;
  parentOverrideLabel: string;
  accruedCoins: number;
  overrideCoins: number;
  retainedCoins: number;
};

export type AgencySelfSettlement = {
  reference: string;
  amount: number;
  currency: string;
  status: string;
  periodFrom: string;
  periodTo: string;
  entryCount: number;
  createdAt: string;
  paidAt: string | null;
};

/** What one agency's position is, in the units its owner reads it in. */
export async function agencySelfPosition(agencyId: string): Promise<AgencySelfDto> {
  const [row, recent, account, fallback] = await Promise.all([
    one<AgencyRow>(`SELECT a.*, ${AGENCY_AGGREGATES} FROM agencies a WHERE a.id = $1`, [agencyId]),
    one<{ coins: string | number; override_coins: string | number }>(
      `SELECT COALESCE(SUM(t.amount_r_coins), 0) AS coins,
              COALESCE(SUM((t.meta->>'overrideCoins')::bigint), 0) AS override_coins
         FROM transactions t
        WHERE t.agency_id = $1 AND t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'
          AND t.created_at >= now() - INTERVAL '30 days'`,
      [agencyId],
    ),
    one<BalanceRow>('SELECT * FROM purpose_account_balances WHERE account_code = $1', [
      accountCodeFor('AGENCY', agencyId),
    ]),
    defaultCommissionBps(),
  ]);
  if (!row) throw ApiError.notFound('Agency not found', 'agency_not_found');

  const rate = resolveCommissionRate(null, row.commission_bps, fallback);
  const isSub = row.parent_agency_id !== null;
  const accrued = minor(row.accrued_coins);
  const passedUp = minor(row.override_coins);
  return {
    id: row.id,
    name: row.name,
    kind: isSub ? 'SUB' : 'MASTER',
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    commissionLabel: commissionBpsLabel(rate),
    hostCount: minor(row.host_count),
    activeHostCount: minor(row.active_host_count),
    subAgencyCount: minor(row.sub_agency_count),
    master: isSub
      ? {
          id: row.parent_agency_id as string,
          name: row.parent_agency_name ?? '',
          overrideBps: row.parent_override_bps,
          overrideLabel: overrideLabel(row.parent_override_bps, true),
        }
      : null,
    earnings: {
      accruedCoins: accrued,
      overrideCoins: passedUp,
      retainedCoins: accrued - passedUp,
      receivedOverrideCoins: minor(row.received_override_coins),
      last30dCoins: minor(recent?.coins ?? 0),
      last30dOverrideCoins: minor(recent?.override_coins ?? 0),
    },
    account: account
      ? {
          currency: account.currency,
          availableMinor: minor(account.available_minor),
          pendingMinor: minor(account.pending_minor),
          frozenMinor: minor(account.frozen_minor),
        }
      : null,
  };
}

/**
 * The hosts this agency is responsible for.
 *
 * No phone and no membership id: a roster is a list of people, and the two things an operator needs
 * in order to act on a row are not things a partner needs in order to read it.
 */
export async function agencySelfRoster(agencyId: string, limit: number): Promise<AgencySelfHost[]> {
  const fallback = await defaultCommissionBps();
  const rows = await many<{
    username: string;
    avatar_url: string | null;
    status: AgencyStatus;
    joined_at: Date;
    host_bps: number | null;
    agency_bps: number | null;
    accrued_coins: string | number;
    recent_coins: string | number;
  }>(
    `SELECT u.username, u.avatar_url, ah.status, ah.joined_at,
            ah.commission_bps AS host_bps, a.commission_bps AS agency_bps,
            COALESCE((SELECT SUM(t.amount_r_coins) FROM transactions t
                       WHERE t.agency_id = $1 AND t.receiver_id = ah.host_user_id
                         AND t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'), 0) AS accrued_coins,
            COALESCE((SELECT SUM(t.amount_r_coins) FROM transactions t
                       WHERE t.agency_id = $1 AND t.receiver_id = ah.host_user_id
                         AND t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'
                         AND t.created_at >= now() - INTERVAL '30 days'), 0) AS recent_coins
       FROM agency_hosts ah
       JOIN users u ON u.id = ah.host_user_id
       JOIN agencies a ON a.id = ah.agency_id
      WHERE ah.agency_id = $1
      ORDER BY ah.joined_at DESC
      LIMIT ${Math.max(1, Math.min(limit, 200))}`,
    [agencyId],
  );
  return rows.map((row) => ({
    username: row.username,
    avatarUrl: row.avatar_url,
    status: row.status,
    joinedAt: new Date(row.joined_at).toISOString(),
    commissionLabel: commissionBpsLabel(resolveCommissionRate(row.host_bps, row.agency_bps, fallback)),
    accruedCoins: minor(row.accrued_coins),
    last30dCoins: minor(row.recent_coins),
  }));
}

/** A master's allocation table: each sub-agency, and what it keeps after its share comes up. */
export async function agencySelfSubs(agencyId: string): Promise<AgencySelfSub[]> {
  const rows = await many<AgencyRow>(
    `SELECT a.*, ${AGENCY_AGGREGATES} FROM agencies a WHERE a.parent_agency_id = $1 ORDER BY a.name`,
    [agencyId],
  );
  return rows.map((sub) => {
    const gross = minor(sub.accrued_coins);
    const up = minor(sub.override_coins);
    return {
      id: sub.id,
      name: sub.name,
      status: sub.status,
      hostCount: minor(sub.host_count),
      activeHostCount: minor(sub.active_host_count),
      parentOverrideBps: sub.parent_override_bps,
      parentOverrideLabel: overrideLabel(sub.parent_override_bps, true),
      accruedCoins: gross,
      overrideCoins: up,
      retainedCoins: gross - up,
    };
  });
}

/** The batches raised for this agency, without the operator or the bank detail beside them. */
export async function agencySelfSettlements(agencyId: string, limit: number): Promise<AgencySelfSettlement[]> {
  const rows = await many<SettlementRow>(
    `${SETTLEMENT_SELECT} WHERE s.agency_id = $1 ORDER BY s.created_at DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`,
    [agencyId],
  );
  return rows.map((row) => ({
    reference: row.reference,
    amount: minor(row.amount_minor),
    currency: row.currency,
    status: row.status,
    periodFrom: new Date(row.period_from).toISOString(),
    periodTo: new Date(row.period_to).toISOString(),
    entryCount: Number(row.entry_count ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
  }));
}
