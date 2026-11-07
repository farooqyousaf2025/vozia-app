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

export type CommissionMembership = {
  agencyId: string;
  agencyName: string;
  commissionBps: number;
  rateSource: RateSource;
};

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
  }>(
    `SELECT ah.agency_id, a.name AS agency_name, ah.commission_bps AS host_bps, a.commission_bps AS agency_bps
       FROM agency_hosts ah
       JOIN agencies a ON a.id = ah.agency_id
      WHERE ah.host_user_id = $1 AND ah.status = 'ACTIVE'
      LIMIT 1`,
    [hostUserId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const rate = resolveCommissionRate(row.host_bps, row.agency_bps, fallback);
  return { agencyId: row.agency_id, agencyName: row.agency_name, ...rate };
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
  },
): Promise<{ posted: boolean; amountMinor: number }> {
  if (opts.coins <= 0) return { posted: false, amountMinor: 0 };
  const face = await coinFaceMinor(client);
  if (face <= 0) return { posted: false, amountMinor: 0 };
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
  return { posted: entry.posted, amountMinor };
}

// ---------------------------------------------------------------------------
// The operator's side: what the rates are, and the batches that clear them.
//
// Reading an agency's position means reading two things that answer different questions. The
// projection says what the platform owes in money; the roster says which host's earnings produced
// that figure and at which of the three rates. An operator settling a dispute needs both, and a
// screen that showed only the total cannot answer "why is this mine".
// ---------------------------------------------------------------------------

export const AGENCY_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED'] as const;
export type AgencyStatus = (typeof AGENCY_STATUSES)[number];
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
  hostCount: number;
  activeHostCount: number;
  /** Lifetime commission counted in coins — the unit an agency negotiates in. */
  accruedCoins: number;
  openBatches: number;
  paidBatches: number;
  createdAt: string;
  /** null when the account was never opened, which the reconciliation report also says. */
  account: PurposeAccountDto | null;
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
  created_at: Date;
  host_count: string | number;
  active_host_count: string | number;
  accrued_coins: string | number;
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
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    contactPhone: row.contact_phone,
    ownerUserId: row.owner_user_id,
    commissionBps: row.commission_bps,
    commissionLabel: commissionBpsLabel(rate),
    hostCount: minor(row.host_count),
    activeHostCount: minor(row.active_host_count),
    accruedCoins: minor(row.accrued_coins),
    openBatches: minor(row.open_batches),
    paidBatches: minor(row.paid_batches),
    createdAt: new Date(row.created_at).toISOString(),
    account,
  };
}

const AGENCY_AGGREGATES = `
       (SELECT COUNT(*) FROM agency_hosts h WHERE h.agency_id = a.id) AS host_count,
       (SELECT COUNT(*) FROM agency_hosts h WHERE h.agency_id = a.id AND h.status = 'ACTIVE') AS active_host_count,
       (SELECT COUNT(*) FROM agency_settlements s WHERE s.agency_id = a.id
         AND s.status IN ('DRAFT','APPROVED')) AS open_batches,
       (SELECT COUNT(*) FROM agency_settlements s WHERE s.agency_id = a.id AND s.status = 'PAID') AS paid_batches,
       COALESCE((SELECT SUM(t.amount_r_coins) FROM transactions t
                  WHERE t.agency_id = a.id AND t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'), 0) AS accrued_coins`;

/** Escape the LIKE wildcards instead of deleting them: an agency name may legitimately contain one. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listAgencies(opts: {
  search?: string;
  status?: string;
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

  return {
    agency,
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
 * `PROVIDER_COLLECTIONS` — the same pair the BD and seller batches use, because the money leaves
 * through the same rails. The entry is keyed on the batch, so replaying a pay whose response was
 * lost finds the entry instead of writing a second one.
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
