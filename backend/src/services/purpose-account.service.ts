import { PoolClient } from 'pg';
import { many, one, withTransaction } from '../config/db';
import { ApiError } from '../utils/http';
import { recordAudit } from './audit.service';

/**
 * Purpose accounts — the accounting window onto money Voiza already holds elsewhere.
 *
 * Sections 2, 3, 7, 8 and 9 of the accounts brief. This module deliberately does not move a
 * balance. Diamonds and R-coins stay in `users`, partner earnings stay in `commission_entries`,
 * and the platform's own position stays in `fin_journal_lines`; an account is a named, owned,
 * single-currency *view* onto one of those, and `purpose_account_balances` is where the
 * projection happens (0029). That choice is the whole reason this layer can be added without a
 * migration that has to be exactly right the first time: a projected account can be reconciled
 * against its source, so a wrong number here is a report rather than a loss.
 *
 * Three rules this module will not bend:
 *
 *  * One unit per account. `dmn` and `rcn` are counts, `pkr` is minor units. They are never
 *    added together, and the journal refuses an entry that mixes them at commit time.
 *  * Nothing here edits a balance. The only writes are holds, account status, and the
 *    idempotency claims that let a retried money action be answered with its first result.
 *    A balance change goes through `ledger.service.ts`, which is also the only place that can
 *    make one.
 *  * An operation that costs money is claimed before it runs, on the caller's client. A
 *    double-clicked "approve" must not pay twice just because the first response was slow.
 */

export const ACCOUNT_CATEGORIES = [
  'PLATFORM_MAIN',
  'USER_DIAMOND',
  'HOST_RCOIN',
  'BD_MANAGER',
  'COIN_SELLER',
  'AGENCY',
  'GAME_OPS',
  'PROMOTIONAL',
  'PENDING_SETTLEMENT',
] as const;
export type AccountCategory = (typeof ACCOUNT_CATEGORIES)[number];

export const ACCOUNT_OWNER_KINDS = ['PLATFORM', 'USER', 'BUSINESS', 'AGENCY'] as const;
export type AccountOwnerKind = (typeof ACCOUNT_OWNER_KINDS)[number];

export const ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED', 'FROZEN', 'CLOSED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const HOLD_KINDS = ['FROZEN', 'PENDING_SETTLEMENT', 'WITHDRAWAL', 'PROMOTIONAL'] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

export const UNIT_CODES = { diamonds: 'dmn', rCoins: 'rcn', pkr: 'pkr' } as const;
export const UNIT_LABELS: Record<string, string> = { dmn: 'Diamonds', rcn: 'R-coins', pkr: 'PKR' };

/** Categories whose balance someone can act on. A payable is owed, not spendable. */
const SPENDABLE = new Set<AccountCategory>(['USER_DIAMOND', 'HOST_RCOIN', 'AGENCY']);

/** The two accounts every person gets, and the column each one reads. */
const USER_CATEGORIES: Record<'USER_DIAMOND' | 'HOST_RCOIN', { code: string; source: string; name: string }> = {
  USER_DIAMOND: { code: 'dmn', source: 'users.diamond_balance', name: 'diamonds' },
  HOST_RCOIN: { code: 'rcn', source: 'users.r_coin_balance', name: 'R-coin earnings' },
};

/** An account that accrues rather than holds: available is zero by design, not by omission. */
const PAYABLE_CATEGORIES: Record<'BD_MANAGER' | 'COIN_SELLER', { beneficiary: 'BD' | 'SELLER'; label: string }> = {
  BD_MANAGER: { beneficiary: 'BD', label: 'BD commission' },
  COIN_SELLER: { beneficiary: 'SELLER', label: 'seller settlements' },
};

const KEY_PATTERN = /^[\w.-]{8,80}$/;

/** node-pg hands int8 and numeric back as strings so a large amount cannot lose precision. */
function minor(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

type BalanceRow = {
  account_code: string;
  name: string;
  category: AccountCategory;
  owner_kind: AccountOwnerKind | null;
  owner_id: string | null;
  currency: string;
  status: AccountStatus;
  balance_source: string;
  available_minor: string | number;
  pending_minor: string | number;
  approved_minor: string | number;
  frozen_minor: string | number;
  balance_minor: string | number;
  lifetime_in_minor: string | number;
  lifetime_out_minor: string | number;
  source_row_present: boolean;
  opened_at: Date | null;
  last_activity_at: Date | null;
};

export type PurposeAccountDto = {
  accountCode: string;
  name: string;
  category: AccountCategory;
  ownerKind: AccountOwnerKind | null;
  ownerId: string | null;
  currency: string;
  unit: string;
  status: AccountStatus;
  /** The table whose row this account reads, so a reader can always check the number. */
  balanceSource: string;
  available: number;
  pending: number;
  approved: number;
  frozen: number;
  balance: number;
  lifetimeIn: number;
  lifetimeOut: number;
  /**
   * The balance the ledger cannot explain (section 9). For an account whose every coin came
   * from a recorded movement this is zero. A non-zero opening is not an error — it is the
   * amount granted before this book existed, and naming it is what makes the rest of the
   * statement reconstructable. Leaving it implicit is how a seeded balance turns into a
   * permanent unexplained difference.
   */
  opening: number;
  sourceRowPresent: boolean;
  openedAt: string | null;
  lastActivityAt: string | null;
};

export type AccountHoldDto = {
  id: string;
  accountCode: string;
  kind: HoldKind;
  amount: number;
  currency: string;
  reason: string;
  status: string;
  createdByName: string | null;
  createdAt: string;
  releasedAt: string | null;
  convertedRef: string | null;
};

type HoldRow = {
  id: string;
  account_code: string;
  kind: HoldKind;
  amount_minor: string | number;
  currency: string;
  reason: string;
  status: string;
  admin_username: string | null;
  created_at: Date;
  released_at: Date | null;
  converted_ref: string | null;
};

function toHoldDto(row: HoldRow): AccountHoldDto {
  return {
    id: row.id,
    accountCode: row.account_code,
    kind: row.kind,
    amount: minor(row.amount_minor),
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    createdByName: row.admin_username,
    createdAt: new Date(row.created_at).toISOString(),
    releasedAt: row.released_at ? new Date(row.released_at).toISOString() : null,
    convertedRef: row.converted_ref,
  };
}

export type AccountMovementDto = {
  reference: string;
  occurredAt: string;
  type: string;
  status: string;
  direction: 'IN' | 'OUT';
  amount: number;
  currency: string;
  description: string;
  /** Who else the money involved, or which accounts sat on the other side of the entry. */
  counterparty: string | null;
};

function toAccountDto(row: BalanceRow): PurposeAccountDto {
  const available = minor(row.available_minor);
  const pending = minor(row.pending_minor);
  const approved = minor(row.approved_minor);
  const frozen = minor(row.frozen_minor);
  const balance = minor(row.balance_minor);
  const lifetimeIn = minor(row.lifetime_in_minor);
  const lifetimeOut = minor(row.lifetime_out_minor);
  return {
    accountCode: row.account_code,
    name: row.name,
    category: row.category,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    currency: row.currency,
    unit: UNIT_LABELS[row.currency] ?? row.currency,
    status: row.status,
    balanceSource: row.balance_source,
    available,
    pending,
    approved,
    frozen,
    balance,
    lifetimeIn,
    lifetimeOut,
    opening: balance - (lifetimeIn - lifetimeOut),
    sourceRowPresent: row.source_row_present,
    openedAt: row.opened_at ? new Date(row.opened_at).toISOString() : null,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
  };
}

/**
 * Codes are derived, never chosen. `CATEGORY:owner` means an owner cannot be handed two
 * accounts for one category by two code paths disagreeing about a name — the conflict lands on
 * the primary key and the second writer reads the first one's row.
 */
export function accountCodeFor(category: AccountCategory, ownerId?: string | null): string {
  return `${category}:${ownerId ?? 'PLATFORM'}`;
}

async function insertAccount(
  client: PoolClient,
  input: {
    code: string;
    name: string;
    kind: 'ASSET' | 'LIABILITY' | 'EXPENSE';
    currency: string;
    normalSide: 'DEBIT' | 'CREDIT';
    category: AccountCategory;
    ownerKind: AccountOwnerKind | null;
    ownerId: string | null;
    balanceSource: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO fin_accounts (code, name, kind, currency, normal_side, category, owner_kind, owner_id, balance_source)
     VALUES ($1,$2,$3,$4,$5,$6::account_category,$7::account_owner_kind,$8,$9)
     ON CONFLICT (code) DO NOTHING`,
    [
      input.code,
      input.name.slice(0, 80),
      input.kind,
      input.currency,
      input.normalSide,
      input.category,
      input.ownerKind,
      input.ownerId,
      input.balanceSource,
    ],
  );
}

/**
 * Open the two accounts a person holds, if they are not open yet.
 *
 * The backfill in 0029 covers everyone who existed before the layer; this covers everyone after.
 * It runs on first read rather than on signup so that a signup path cannot fail because an
 * accounting table was unavailable — an account is derived, so a missing one is never a reason
 * to refuse a login.
 */
export async function ensureUserAccounts(userId: string, client?: PoolClient): Promise<void> {
  const run = async (tx: PoolClient) => {
    const user = (await tx.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id = $1', [userId]))
      .rows[0];
    if (!user) throw ApiError.notFound('Account not found', 'user_not_found');
    for (const [category, meta] of Object.entries(USER_CATEGORIES)) {
      await insertAccount(tx, {
        code: accountCodeFor(category as AccountCategory, user.id),
        name: `${user.username} — ${meta.name}`,
        kind: category === 'USER_DIAMOND' ? 'ASSET' : 'LIABILITY',
        currency: meta.code,
        normalSide: category === 'USER_DIAMOND' ? 'DEBIT' : 'CREDIT',
        category: category as AccountCategory,
        ownerKind: 'USER',
        ownerId: user.id,
        balanceSource: meta.source,
      });
    }
  };
  if (client) return run(client);
  return withTransaction(run);
}

/** Open a partner or agency account from the row that already describes the owner. */
async function ensureOwnerAccount(client: PoolClient, category: AccountCategory, ownerId: string): Promise<void> {
  if (PAYABLE_CATEGORIES[category as 'BD_MANAGER' | 'COIN_SELLER']) {
    const payable = PAYABLE_CATEGORIES[category as 'BD_MANAGER' | 'COIN_SELLER'];
    const partner = (
      await client.query<{ id: string; display_name: string; kind: string }>(
        'SELECT id, display_name, kind FROM business_accounts WHERE id = $1',
        [ownerId],
      )
    ).rows[0];
    if (!partner) throw ApiError.notFound('Business account not found', 'business_not_found');
    if (category === 'COIN_SELLER' ? partner.kind !== 'COIN_SELLER' : !partner.kind.startsWith('BD_')) {
      throw ApiError.badRequest(`${partner.kind} does not hold a ${category} account`, 'wrong_account_kind');
    }
    await insertAccount(client, {
      code: accountCodeFor(category, partner.id),
      name: `${partner.display_name} — ${payable.label}`,
      kind: 'LIABILITY',
      currency: 'pkr',
      normalSide: 'CREDIT',
      category,
      ownerKind: 'BUSINESS',
      ownerId: partner.id,
      balanceSource: 'commission_entries',
    });
    return;
  }
  if (category === 'AGENCY') {
    const agency = (await client.query<{ id: string; name: string }>('SELECT id, name FROM agencies WHERE id = $1', [ownerId]))
      .rows[0];
    if (!agency) throw ApiError.notFound('Agency not found', 'agency_not_found');
    await insertAccount(client, {
      code: accountCodeFor(category, agency.id),
      name: `${agency.name} — agency earnings`,
      kind: 'LIABILITY',
      currency: 'pkr',
      normalSide: 'CREDIT',
      category,
      ownerKind: 'AGENCY',
      ownerId: agency.id,
      balanceSource: 'fin_journal_lines',
    });
    return;
  }
  throw ApiError.badRequest(`${category} is a platform account and always exists`, 'not_an_owner_account');
}

export async function findAccount(accountCode: string): Promise<PurposeAccountDto> {
  const row = await one<BalanceRow>('SELECT * FROM purpose_account_balances WHERE account_code = $1', [accountCode]);
  if (!row) throw ApiError.notFound(`Unknown account ${accountCode}`, 'account_not_found');
  return toAccountDto(row);
}

/** The account one owner holds for one category, opened on demand. */
export async function accountFor(category: AccountCategory, ownerId?: string | null): Promise<PurposeAccountDto> {
  if (!ACCOUNT_CATEGORIES.includes(category)) throw ApiError.badRequest('Unknown account category', 'bad_category');
  const code = accountCodeFor(category, ownerId ?? null);
  const exists = await one<{ code: string }>('SELECT code FROM fin_accounts WHERE code = $1', [code]);
  if (!exists) {
    if (!ownerId) throw ApiError.notFound(`Platform account ${code} is missing`, 'account_not_found');
    await withTransaction(async (client) => {
      if (category === 'USER_DIAMOND' || category === 'HOST_RCOIN') return ensureUserAccounts(ownerId, client);
      return ensureOwnerAccount(client, category, ownerId);
    });
  }
  return findAccount(code);
}

export type AccountListFilters = {
  category?: string;
  ownerKind?: string;
  ownerId?: string;
  status?: string;
  currency?: string;
  search?: string;
  onlyWithPosition?: boolean;
  limit: number;
  offset: number;
};

/**
 * The account overview (section 7). Filters stay on the view, not in TypeScript, because the
 * admin page must be able to sort and page over 700 accounts without loading them.
 */
export async function listAccounts(filters: AccountListFilters): Promise<{ accounts: PurposeAccountDto[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filters.category) where.push(`category = ${bind(filters.category)}::account_category`);
  if (filters.ownerKind) where.push(`owner_kind = ${bind(filters.ownerKind)}::account_owner_kind`);
  if (filters.ownerId) where.push(`owner_id = ${bind(filters.ownerId)}::uuid`);
  if (filters.status) where.push(`status = ${bind(filters.status)}::purpose_account_status`);
  if (filters.currency) where.push(`currency = ${bind(filters.currency)}`);
  if (filters.onlyWithPosition) where.push('balance_minor <> 0');
  if (filters.search) {
    // Escape the LIKE wildcards rather than deleting them. Stripping `_` looked safe and broke
    // the one thing worth searching for: every category name in the book contains one, so
    // "USER_DIAMOND" became "USERDIAMOND" and matched nothing.
    const pattern = `%${filters.search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(`(name ILIKE ${bind(pattern)} ESCAPE '\\' OR account_code ILIKE ${bind(pattern)} ESCAPE '\\')`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(filters.limit || 50, 200));
  const offset = Math.max(0, filters.offset || 0);

  const [rows, total] = await Promise.all([
    many<BalanceRow>(
      `SELECT * FROM purpose_account_balances ${clause}
        ORDER BY abs(balance_minor) DESC, account_code LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    one<{ n: string }>(`SELECT COUNT(*)::text AS n FROM purpose_account_balances ${clause}`, params),
  ]);
  return { accounts: rows.map(toAccountDto), total: Number(total?.n ?? 0) };
}

/**
 * One movement list per account, from whatever the account reads.
 *
 * Three shapes because there are genuinely three books, and pretending otherwise would mean
 * either a second ledger or a statement that silently stops at a page boundary. The unit is
 * carried on every row so a caller cannot add a diamond figure to a rupee figure.
 */
export async function listMovements(
  accountCode: string,
  opts: { from?: Date; to?: Date; limit: number; offset: number },
): Promise<{ movements: AccountMovementDto[]; unit: string; total: number }> {
  const account = await findAccount(accountCode);
  const limit = Math.max(1, Math.min(opts.limit || 50, 500));
  const offset = Math.max(0, opts.offset || 0);
  const from = opts.from?.toISOString() ?? null;
  const to = opts.to?.toISOString() ?? null;

  let sql: string;
  let countSql: string;
  const params: unknown[] = [];

  if (account.category === 'USER_DIAMOND' || account.category === 'HOST_RCOIN') {
    params.push(account.ownerId, account.currency, from, to);
    // COMPLETED only, which is exactly the set the balance view counts as lifetime (`flows` in
    // 0029). A PENDING withdrawal has already left `r_coin_balance` and is reported as pending,
    // so listing it as an outflow here would charge the host twice for the same escrow; a
    // REVERSED one came back through an update that has no leg of its own, so neither direction
    // would add up. The wallet screen shows both — the statement is the book, not the queue.
    sql = `
      SELECT m.reference, m.occurred_at, m.movement_type::text AS type, m.status::text AS status,
             m.direction::text AS direction, m.amount_minor, m.unit AS currency,
             COALESCE(NULLIF(m.note, ''), m.movement_type::text) AS description,
             CASE WHEN m.direction = 'IN' THEN su.username ELSE ru.username END AS counterparty
        FROM coin_movements m
        LEFT JOIN users su ON su.id = m.sender_id
        LEFT JOIN users ru ON ru.id = m.receiver_id
       WHERE m.owner_id = $1 AND m.unit = $2 AND m.status = 'COMPLETED'
         AND ($3::timestamptz IS NULL OR m.occurred_at >= $3)
         AND ($4::timestamptz IS NULL OR m.occurred_at <= $4)
       ORDER BY m.occurred_at DESC, m.reference DESC
       LIMIT ${limit} OFFSET ${offset}`;
    countSql = `SELECT COUNT(*)::text AS n FROM coin_movements m
                 WHERE m.owner_id = $1 AND m.unit = $2 AND m.status = 'COMPLETED'
                   AND ($3::timestamptz IS NULL OR m.occurred_at >= $3)
                   AND ($4::timestamptz IS NULL OR m.occurred_at <= $4)`;
  } else if (account.category === 'BD_MANAGER' || account.category === 'COIN_SELLER') {
    const beneficiary = PAYABLE_CATEGORIES[account.category].beneficiary;
    params.push(account.ownerId, beneficiary, from, to);
    // One leg list, reused by the page and by the count. Its two sums are the same two sums the
    // balance view calls lifetime_in and lifetime_out, so `opening + in - out` from this statement
    // reproduces the account — which is what section 9 asks of every account, and the reason an
    // entry is never replaced by the batch that later paid it: both happened, and netting one
    // against the other is how a statement stops adding up.
    const legs = `
        SELECT ('CE-' || e.id)::text AS reference,
               e.created_at AS occurred_at,
               e.kind::text AS type,
               e.status::text AS status,
               'IN' AS direction,
               e.amount_cents AS amount_minor,
               e.currency,
               e.kind::text || ' on order ' || LEFT(o.reference, 12) AS description,
               COALESCE(CASE WHEN e.beneficiary = 'BD' THEN sb.display_name ELSE bb.display_name END, 'the platform') AS counterparty
          FROM commission_entries e
          LEFT JOIN recharge_orders o ON o.id = e.recharge_order_id
          LEFT JOIN business_accounts sb ON sb.id = o.seller_id
          LEFT JOIN business_accounts bb ON bb.id = o.bd_id
         WHERE e.beneficiary_id = $1 AND e.beneficiary = $2::commission_beneficiary
           AND e.status IN ('ACCRUED', 'SETTLED', 'REVERSED')
        UNION ALL
        SELECT ('CE-' || e.id || '-rev')::text, COALESCE(e.reversed_at, e.created_at), 'COMMISSION_REVERSAL',
               'REVERSED', 'OUT', e.amount_cents, e.currency,
               COALESCE(NULLIF(e.reversal_reason, ''), 'Commission reversed') || ' (order ' || LEFT(o.reference, 12) || ')',
               COALESCE(CASE WHEN e.beneficiary = 'BD' THEN sb.display_name ELSE bb.display_name END, 'the platform')
          FROM commission_entries e
          LEFT JOIN recharge_orders o ON o.id = e.recharge_order_id
          LEFT JOIN business_accounts sb ON sb.id = o.seller_id
          LEFT JOIN business_accounts bb ON bb.id = o.bd_id
         WHERE e.beneficiary_id = $1 AND e.beneficiary = $2::commission_beneficiary
           AND e.status = 'REVERSED'
        UNION ALL
        SELECT s.reference, COALESCE(s.paid_at, s.updated_at), 'SETTLEMENT', s.status::text, 'OUT',
               s.amount_cents, s.currency,
               'Settlement batch ' || s.reference || ' paid' ||
                 CASE WHEN s.payout_method IS NULL THEN '' ELSE ' via ' || s.payout_method END,
               'the platform'
          FROM commission_settlements s
         WHERE s.beneficiary_id = $1 AND s.beneficiary = $2::commission_beneficiary AND s.status = 'PAID'`;
    sql = `SELECT * FROM (${legs}) AS legs
       WHERE ($3::timestamptz IS NULL OR occurred_at >= $3)
         AND ($4::timestamptz IS NULL OR occurred_at <= $4)
       ORDER BY occurred_at DESC, reference DESC
       LIMIT ${limit} OFFSET ${offset}`;
    countSql = `SELECT COUNT(*)::text AS n FROM (${legs}) AS legs
                 WHERE ($3::timestamptz IS NULL OR occurred_at >= $3)
                   AND ($4::timestamptz IS NULL OR occurred_at <= $4)`;
  } else {
    params.push(accountCode, from, to);
    sql = `
      SELECT e.reference, e.occurred_at, e.source_kind AS type, 'COMPLETED' AS status,
             CASE WHEN (a.normal_side = 'DEBIT' AND l.direction = 'DEBIT')
                    OR (a.normal_side = 'CREDIT' AND l.direction = 'CREDIT')
                  THEN 'IN' ELSE 'OUT' END AS direction,
             l.amount_cents AS amount_minor, l.currency,
             COALESCE(NULLIF(e.memo, ''), e.source_kind || ' ' || e.source_id) AS description,
             (SELECT STRING_AGG(DISTINCT o.account_code, ',' ORDER BY o.account_code)
                FROM fin_journal_lines o
               WHERE o.entry_id = e.id AND o.account_code <> a.code) AS counterparty
        FROM fin_journal_lines l
        JOIN fin_journal_entries e ON e.id = l.entry_id
        JOIN fin_accounts a ON a.code = l.account_code
       WHERE l.account_code = $1
         AND ($2::timestamptz IS NULL OR e.occurred_at >= $2)
         AND ($3::timestamptz IS NULL OR e.occurred_at <= $3)
       ORDER BY e.occurred_at DESC, e.reference DESC
       LIMIT ${limit} OFFSET ${offset}`;
    countSql = `SELECT COUNT(*)::text AS n
                  FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id
                 WHERE l.account_code = $1
                   AND ($2::timestamptz IS NULL OR e.occurred_at >= $2)
                   AND ($3::timestamptz IS NULL OR e.occurred_at <= $3)`;
  }

  type MovementRow = {
    reference: string;
    occurred_at: Date;
    type: string;
    status: string;
    direction: string;
    amount_minor: string | number;
    currency: string;
    description: string | null;
    counterparty: string | null;
  };
  const [rows, total] = await Promise.all([
    many<MovementRow>(sql, params),
    one<{ n: string }>(countSql, params),
  ]);
  return {
    movements: rows.map((row) => ({
      reference: row.reference,
      occurredAt: new Date(row.occurred_at).toISOString(),
      type: row.type,
      status: row.status,
      direction: row.direction === 'IN' ? 'IN' : 'OUT',
      amount: minor(row.amount_minor),
      currency: row.currency,
      description: row.description ?? row.type,
      counterparty: row.counterparty,
    })),
    unit: account.currency,
    total: Number(total?.n ?? 0),
  };
}

export async function listHolds(opts: {
  accountCode?: string;
  status?: string;
  limit: number;
  offset: number;
}): Promise<{ holds: AccountHoldDto[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (opts.accountCode) where.push(`h.account_code = ${bind(opts.accountCode)}`);
  if (opts.status) where.push(`h.status = ${bind(opts.status)}::account_hold_status`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = Math.max(0, opts.offset || 0);

  const rows = await many<HoldRow>(
    `SELECT h.*, ad.username AS admin_username
       FROM account_holds h
       LEFT JOIN admins ad ON ad.id = h.created_by
       ${clause} ORDER BY h.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = await one<{ n: string }>(`SELECT COUNT(*)::text AS n FROM account_holds h ${clause}`, params);
  return {
    holds: rows.map(toHoldDto),
    total: Number(total?.n ?? 0),
  };
}

/**
 * Freeze, or earmark, part of an account.
 *
 * A hold is a row with a reason and an author rather than a number on the account, so a release
 * has a history and an investigation can be answered. A freeze is refused when it would cover
 * more than the owner can currently spend: a hold larger than the balance is not a control, it
 * is a claim on money that does not exist.
 */
export async function createHold(input: {
  accountCode: string;
  kind: string;
  amount: number;
  reason: string;
  adminId: string;
  /**
   * Run inside the caller's transaction. Without it the hold and the idempotency claim that
   * guards it commit separately, and a crash between the two leaves a hold on the book that no
   * replay can ever answer for.
   */
  client?: PoolClient;
}): Promise<AccountHoldDto> {
  const kind = input.kind as HoldKind;
  if (!HOLD_KINDS.includes(kind)) throw ApiError.badRequest('Unknown hold kind', 'bad_hold_kind');
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw ApiError.badRequest('A hold must be a whole positive amount', 'bad_amount');
  }
  const reason = (input.reason ?? '').trim();
  if (reason.length < 8) throw ApiError.badRequest('A hold needs a reason an operator can read later', 'reason_required');

  const run = async (client: PoolClient): Promise<AccountHoldDto> => {
    // The view is not lockable, so the account row itself is locked first and the projected
    // balance is read behind that lock. Without this two concurrent freezes could each see a
    // balance the other had not yet taken into account.
    const locked = await client.query<{ code: string; name: string; category: AccountCategory }>(
      'SELECT code, name, category FROM fin_accounts WHERE code = $1 FOR UPDATE',
      [input.accountCode],
    );
    if (!locked.rows[0]) throw ApiError.notFound(`Unknown account ${input.accountCode}`, 'account_not_found');
    const accountRow = await client.query<BalanceRow>(
      'SELECT * FROM purpose_account_balances WHERE account_code = $1',
      [input.accountCode],
    );
    const account = accountRow.rows[0];
    if (!account) throw ApiError.notFound(`Unknown account ${input.accountCode}`, 'account_not_found');
    if (account.status !== 'ACTIVE') {
      throw ApiError.conflict(`${account.status} accounts cannot take new holds`, 'account_not_active');
    }
    if (SPENDABLE.has(account.category) && minor(account.frozen_minor) + input.amount > minor(account.available_minor)) {
      throw ApiError.conflict(
        `Only ${minor(account.available_minor) - minor(account.frozen_minor)} ${account.currency} is free to freeze`,
        'freeze_exceeds_available',
      );
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO account_holds (account_code, kind, amount_minor, currency, reason, created_by)
       VALUES ($1,$2::account_hold_kind,$3,$4,$5,$6) RETURNING id`,
      [input.accountCode, kind, input.amount, account.currency, reason.slice(0, 300), input.adminId],
    );
    await recordAudit(
      {
        adminId: input.adminId,
        action: 'ACCOUNT_HOLD_CREATE',
        targetType: 'account_hold',
        targetId: inserted.rows[0].id,
        summary: `${kind} hold of ${input.amount} ${account.currency} on ${input.accountCode}`,
        details: { accountCode: input.accountCode, kind, amount: input.amount, currency: account.currency, reason },
      },
      client,
    );
    const created = await client.query<HoldRow>(
      `SELECT h.*, ad.username AS admin_username
         FROM account_holds h
         LEFT JOIN admins ad ON ad.id = h.created_by
        WHERE h.id = $1`,
      [inserted.rows[0].id],
    );
    return toHoldDto(created.rows[0]);
  };
  if (input.client) return run(input.client);
  return withTransaction(run);
}

/**
 * Release a hold, or convert it into the thing it was waiting for.
 *
 * Conversion is recorded rather than deleted: a hold that becomes a paid settlement should be
 * traceable to the settlement, and a hold that is simply released should say so.
 */
export async function releaseHold(
  holdId: string,
  adminId: string,
  convertTo?: string | null,
  client?: PoolClient,
): Promise<{ id: string; status: string }> {
  const run = async (tx: PoolClient): Promise<{ id: string; status: string }> => {
    const existing = await tx.query<{ id: string; status: string; account_code: string; amount_minor: string; currency: string }>(
      `SELECT id, status, account_code, amount_minor, currency FROM account_holds WHERE id = $1 FOR UPDATE`,
      [holdId],
    );
    const hold = existing.rows[0];
    if (!hold) throw ApiError.notFound('Hold not found', 'hold_not_found');
    if (hold.status !== 'OPEN') throw ApiError.conflict('Hold is already closed', 'hold_closed');

    const status = convertTo ? 'CONVERTED' : 'RELEASED';
    await tx.query(
      `UPDATE account_holds SET status = $2::account_hold_status, released_by = $3, released_at = now(),
              converted_ref = $4
        WHERE id = $1`,
      [holdId, status, adminId, convertTo ? convertTo.slice(0, 64) : null],
    );
    await recordAudit(
      {
        adminId,
        action: convertTo ? 'ACCOUNT_HOLD_CONVERT' : 'ACCOUNT_HOLD_RELEASE',
        targetType: 'account_hold',
        targetId: holdId,
        summary: `${hold.account_code} ${hold.amount_minor} ${hold.currency} ${status.toLowerCase()}`,
        details: { accountCode: hold.account_code, convertedTo: convertTo ?? null },
      },
      tx,
    );
    return { id: holdId, status };
  };
  if (client) return run(client);
  return withTransaction(run);
}

/** Activate, suspend, freeze or close an account. Section 8, and never a balance change. */
export async function setAccountStatus(
  accountCode: string,
  status: string,
  adminId: string,
  reason?: string,
): Promise<{ accountCode: string; status: AccountStatus }> {
  if (!ACCOUNT_STATUSES.includes(status as AccountStatus)) throw ApiError.badRequest('Unknown account status', 'bad_status');
  const note = (reason ?? '').trim();
  if (status !== 'ACTIVE' && note.length < 8) {
    throw ApiError.badRequest('Suspending, freezing or closing an account needs a reason', 'reason_required');
  }
  return withTransaction(async (client) => {
    const updated = await client.query<{ code: string }>(
      `UPDATE fin_accounts SET status = $2::purpose_account_status, suspended_reason = $3, updated_at = now()
        WHERE code = $1 RETURNING code`,
      [accountCode, status, status === 'ACTIVE' ? null : note.slice(0, 200)],
    );
    if (!updated.rows[0]) throw ApiError.notFound(`Unknown account ${accountCode}`, 'account_not_found');
    await recordAudit(
      {
        adminId,
        action: 'ACCOUNT_STATUS_UPDATE',
        targetType: 'purpose_account',
        targetId: accountCode,
        summary: `Account ${accountCode} set to ${status}`,
        details: { status, reason: note || null },
      },
      client,
    );
    return { accountCode, status: status as AccountStatus };
  });
}

/**
 * Claim an idempotency key before spending on it.
 *
 * On the caller's client, so a claim and the movement it guards commit together. A replay
 * returns the first attempt's result instead of running the action twice, which is the only
 * defence against a finance operator clicking approve twice on a slow connection — the gift
 * path has had this since 0023 and the operator path has not had it at all.
 */
export async function claimIdempotency(
  client: PoolClient,
  scope: string,
  key: string,
  actorId: string | null,
): Promise<{ replay: boolean; resourceRef: string | null; response: Record<string, unknown> | null }> {
  if (!KEY_PATTERN.test(key)) {
    throw ApiError.badRequest('Idempotency key must be 8-80 characters of [A-Za-z0-9._-]', 'bad_idempotency_key');
  }
  const inserted = await client.query<{ scope: string }>(
    `INSERT INTO idempotent_requests (scope, key, created_by) VALUES ($1,$2,$3)
     ON CONFLICT (scope, key) DO NOTHING RETURNING scope`,
    [scope, key, actorId],
  );
  if (inserted.rows.length) return { replay: false, resourceRef: null, response: null };

  const prior = await client.query<{ resource_ref: string | null; response: Record<string, unknown> | null }>(
    'SELECT resource_ref, response FROM idempotent_requests WHERE scope = $1 AND key = $2 FOR UPDATE',
    [scope, key],
  );
  const row = prior.rows[0];
  // A claim that exists but has published no result belongs to an attempt that is still running
  // — or to one that failed and rolled back, which Postgres frees for the next caller. Either way
  // the outcome is unknown, so this must not be answered as a replay: a caller that skipped the
  // work and reported success would be reporting something it never did.
  if (!row || (row.resource_ref === null && row.response === null)) {
    throw ApiError.conflict('This request is still being processed; retry in a moment', 'idempotency_in_flight');
  }
  return { replay: true, resourceRef: row.resource_ref, response: row.response ?? null };
}

/** Fill in the result a replay should be answered with. */
export async function completeIdempotency(
  client: PoolClient,
  scope: string,
  key: string,
  resourceRef: string,
  response: Record<string, unknown>,
): Promise<void> {
  await client.query(
    'UPDATE idempotent_requests SET resource_ref = $3, response = $4::jsonb WHERE scope = $1 AND key = $2',
    [scope, key, resourceRef.slice(0, 64), JSON.stringify(response)],
  );
}

export type ReconciliationFinding = {
  code: string;
  severity: 'ERROR' | 'INFO';
  accountCode: string | null;
  currency: string | null;
  amountMinor: number;
  detail: string;
};

/**
 * Can every account be explained by its own book? (section 9, section 10's last bullet.)
 *
 * These checks are written to be able to fail, which is why none of them compare an account
 * against the number the view just read from it. An ERROR is a contradiction between two tables
 * that should agree; an INFO is a figure that is true but not yet booked, which the operator
 * needs to see rather than trust.
 */
export async function reconcileAccounts(): Promise<{ generatedAt: string; findings: ReconciliationFinding[] }> {
  const findings: ReconciliationFinding[] = [];

  const openings = await many<{
    account_code: string;
    currency: string;
    opening: string | number;
    name: string;
  }>(
    `SELECT account_code, currency, name, balance_minor - (lifetime_in_minor - lifetime_out_minor) AS opening
       FROM purpose_account_balances
      WHERE balance_minor <> lifetime_in_minor - lifetime_out_minor
      ORDER BY abs(balance_minor - (lifetime_in_minor - lifetime_out_minor)) DESC
      LIMIT 100`,
  );
  for (const row of openings) {
    findings.push({
      code: 'opening_not_explained_by_ledger',
      severity: 'INFO',
      accountCode: row.account_code,
      currency: row.currency,
      amountMinor: minor(row.opening),
      detail: `${row.name} holds ${minor(row.opening)} ${row.currency} the ledger never moved, recorded as its opening balance`,
    });
  }

  const orphans = await many<{ account_code: string; name: string }>(
    'SELECT account_code, name FROM purpose_account_balances WHERE NOT source_row_present',
  );
  for (const row of orphans) {
    findings.push({
      code: 'account_source_missing',
      severity: 'ERROR',
      accountCode: row.account_code,
      currency: null,
      amountMinor: 0,
      detail: `${row.name} names an authoritative row that no longer exists`,
    });
  }

  const overFrozen = await many<{ account_code: string; currency: string; frozen: string | number; available: string | number }>(
    `SELECT account_code, currency, frozen_minor AS frozen, available_minor AS available
       FROM purpose_account_balances
      WHERE category IN ('USER_DIAMOND','HOST_RCOIN','AGENCY') AND frozen_minor > available_minor`,
  );
  for (const row of overFrozen) {
    findings.push({
      code: 'frozen_exceeds_available',
      severity: 'ERROR',
      accountCode: row.account_code,
      currency: row.currency,
      amountMinor: minor(row.frozen) - minor(row.available),
      detail: `${minor(row.frozen)} frozen against ${minor(row.available)} available`,
    });
  }

  // A commission is pending, approved, or paid — never two of those. If the three do not add up
  // to the position, an entry is counted in a batch it has not settled into, or a batch paid an
  // entry that was never accrued.
  const payableMismatch = await many<{ account_code: string; balance: string | number; pending: string | number; approved: string | number }>(
    `SELECT account_code, balance_minor AS balance, pending_minor AS pending, approved_minor AS approved
       FROM purpose_account_balances
      WHERE category IN ('BD_MANAGER','COIN_SELLER')
        AND balance_minor <> pending_minor + approved_minor`,
  );
  for (const row of payableMismatch) {
    findings.push({
      code: 'payable_state_conflict',
      severity: 'ERROR',
      accountCode: row.account_code,
      currency: 'pkr',
      amountMinor: minor(row.pending) + minor(row.approved) - minor(row.balance),
      detail: `pending ${minor(row.pending)} + approved ${minor(row.approved)} does not equal position ${minor(row.balance)}`,
    });
  }

  // The withdrawal pipeline: the request row and its ledger row must tell one story. Since 0032 the
  // ledger follows the request one step behind — the money leaves the wallet when the host asks
  // (escrow), so PENDING and APPROVED both sit on a PENDING ledger row, and only a recorded payout
  // books it COMPLETED. Anything else is a write that went around one of the two service functions,
  // which is why APPROVED-with-a-COMPLETED-row is an error now rather than the pipeline's shape.
  const withdrawalMismatch = await many<{
    id: string;
    wstatus: string;
    tstatus: string | null;
    amount: string | number;
  }>(
    `SELECT w.id, w.status AS wstatus, t.status::text AS tstatus, w.amount_r_coins AS amount
       FROM withdrawal_requests w
       LEFT JOIN transactions t ON t.type = 'WITHDRAWAL' AND t.meta->>'withdrawalId' = w.id::text
      WHERE (w.status = 'PENDING' AND (t.id IS NULL OR t.status <> 'PENDING'))
         OR (w.status = 'APPROVED' AND (t.id IS NULL OR t.status <> 'PENDING'))
         OR (w.status = 'PAID' AND (t.id IS NULL OR t.status <> 'COMPLETED'))
         OR (w.status = 'REJECTED' AND (t.id IS NULL OR t.status <> 'REVERSED'))
      LIMIT 100`,
  );
  for (const row of withdrawalMismatch) {
    findings.push({
      code: 'withdrawal_state_conflict',
      severity: 'ERROR',
      accountCode: null,
      currency: 'rcn',
      amountMinor: minor(row.amount),
      detail: `withdrawal ${row.id} is ${row.wstatus} while its ledger row is ${row.tstatus ?? 'missing'}`,
    });
  }

  // Approved and still sitting in the outbox. Nothing is wrong — the R-coins are escrowed and the
  // projection counts them as pending — but the host has been promised money and the book does not
  // yet name anyone who moved it, so the queue is stated rather than enumerated as errors.
  const unpaid = await one<{ n: string | number; total: string | number; oldest: Date | null }>(
    `SELECT COUNT(*)::text AS n, COALESCE(SUM(w.amount_r_coins), 0)::text AS total,
            MIN(w.reviewed_at) AS oldest
       FROM withdrawal_requests w
      WHERE w.status = 'APPROVED'`,
  );
  if (unpaid && minor(unpaid.n) > 0) {
    findings.push({
      code: 'withdrawal_awaiting_payout',
      severity: 'INFO',
      accountCode: null,
      currency: 'rcn',
      amountMinor: minor(unpaid.total),
      detail: `${minor(unpaid.n)} approved withdrawal(s) totalling ${minor(unpaid.total)} R-coins await a payout${
        unpaid.oldest ? `; the oldest accepted ${new Date(unpaid.oldest).toISOString().slice(0, 10)}` : ''
      }`,
    });
  }

  // Belt and braces on the two invariants the triggers enforce: if either ever reports rows,
  // something wrote the journal without going through postJournal.
  const journalBreaks = await many<{ reference: string; debits: string | number; credits: string | number; currencies: number }>(
    `SELECT e.reference,
            SUM(l.amount_cents) FILTER (WHERE l.direction = 'DEBIT')  AS debits,
            SUM(l.amount_cents) FILTER (WHERE l.direction = 'CREDIT') AS credits,
            COUNT(DISTINCT l.currency) AS currencies
       FROM fin_journal_entries e JOIN fin_journal_lines l ON l.entry_id = e.id
      GROUP BY e.id, e.reference
     HAVING SUM(l.amount_cents) FILTER (WHERE l.direction = 'DEBIT')
        <> SUM(l.amount_cents) FILTER (WHERE l.direction = 'CREDIT')
        OR COUNT(DISTINCT l.currency) > 1
      LIMIT 50`,
  );
  for (const row of journalBreaks) {
    findings.push({
      code: 'journal_entry_invalid',
      severity: 'ERROR',
      accountCode: null,
      currency: null,
      amountMinor: Number(row.debits) - Number(row.credits),
      detail: `entry ${row.reference} debits ${row.debits} credits ${row.credits} across ${row.currencies} currenc${Number(row.currencies) === 1 ? 'y' : 'ies'}`,
    });
  }

  // A gift takes diamonds and banks R-coins in one ledger row, and the difference is the platform's
  // take; a settled game keeps whatever its prize ladder did not distribute. Both now write a journal
  // entry keyed on that same row or session (0031), so a spread with no entry is a write that went
  // around the book — which is why this is counted in coins, not in minor units. Multiplying the
  // ledger by today's face value would report a number the journal never posted, and the face value
  // is an operator dial.
  const unbooked = await one<{
    giftRows: string | number;
    giftCoins: string | number;
    gameRows: string | number;
    gameCoins: string | number;
  }>(
    `SELECT COUNT(*)::text AS gift_rows,
            COALESCE(SUM(t.amount_diamonds - t.amount_r_coins), 0)::text AS gift_coins,
            (SELECT COUNT(*)::text FROM game_settlements gs
              WHERE gs.status = 'SETTLED' AND gs.gross_pool <> gs.distributed
                AND NOT EXISTS (SELECT 1 FROM fin_journal_entries e
                                 WHERE e.source_kind = 'GAME_TAKE' AND e.source_id = gs.session_id::text)) AS game_rows,
            (SELECT COALESCE(SUM(gs.gross_pool - gs.distributed), 0)::text FROM game_settlements gs
              WHERE gs.status = 'SETTLED' AND gs.gross_pool <> gs.distributed
                AND NOT EXISTS (SELECT 1 FROM fin_journal_entries e
                                 WHERE e.source_kind = 'GAME_TAKE' AND e.source_id = gs.session_id::text)) AS game_coins
       FROM transactions t
      WHERE t.type = 'GIFT_SENT' AND t.status = 'COMPLETED' AND t.amount_diamonds <> t.amount_r_coins
        AND NOT EXISTS (SELECT 1 FROM fin_journal_entries e
                         WHERE e.source_kind = 'GIFT_TAX' AND e.source_id = t.id::text)`,
  );
  if (unbooked && minor(unbooked.giftRows) + minor(unbooked.gameRows) > 0) {
    findings.push({
      code: 'platform_revenue_not_booked',
      severity: 'ERROR',
      accountCode: 'PLATFORM_REVENUE',
      currency: null,
      amountMinor: minor(unbooked.giftCoins) + minor(unbooked.gameCoins),
      detail: `${minor(unbooked.giftRows)} gift row(s) spread ${minor(unbooked.giftCoins)} coins and ` +
        `${minor(unbooked.gameRows)} settled game(s) kept ${minor(unbooked.gameCoins)} coins with no journal entry`,
    });
  }

  // Coverage, not correctness: an account is opened the first time something reads it, so anyone
  // who has never been looked at has no row yet. Reported instead of assumed away, because the
  // account list is otherwise quietly missing exactly the newest, least-tested owners.
  const notOpened = await one<{users: string | number; partners: string | number; agencies: string | number}>(
    `SELECT (SELECT COUNT(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM fin_accounts a WHERE a.owner_id = u.id))::text AS users,
            (SELECT COUNT(*) FROM business_accounts b WHERE NOT EXISTS (SELECT 1 FROM fin_accounts a WHERE a.owner_id = b.id))::text AS partners,
            (SELECT COUNT(*) FROM agencies g WHERE NOT EXISTS (SELECT 1 FROM fin_accounts a WHERE a.owner_id = g.id))::text AS agencies`,
  );
  if (notOpened && minor(notOpened.users) + minor(notOpened.partners) + minor(notOpened.agencies) > 0) {
    findings.push({
      code: 'account_not_yet_opened',
      severity: 'INFO',
      accountCode: null,
      currency: null,
      amountMinor: 0,
      detail: `${minor(notOpened.users)} user(s), ${minor(notOpened.partners)} partner(s) and ${minor(notOpened.agencies)} agenc(y/ies) have no purpose account until first read`,
    });
  }

  return { generatedAt: new Date().toISOString(), findings };
}
