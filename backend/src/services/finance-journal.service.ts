import { PoolClient } from 'pg';
import { many, one } from '../config/db';
import { ApiError } from '../utils/http';
import { shortCode } from '../utils/ids';
import { FinAccountRow } from '../types/db';

/**
 * The money-side book (§25).
 *
 * `transactions` answers "whose coin balance moved". This answers "what did the platform
 * collect, what share of it is still owed to a partner, and how much is actually revenue".
 * The two are joined by source id, never merged: coins are a liability the platform holds for
 * a holder, and a collection is an asset, and confusing them is how a business decides it is
 * rich because it sold a top-up pack.
 *
 * Every entry must balance. The database enforces it with a deferred constraint trigger
 * (0004) — deferred because the header is written before its lines — and this module checks
 * first as well, so a caller gets a 400 with the account names rather than a commit failure.
 */

export type JournalLine = {
  accountCode: string;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: number;
};

export type JournalInput = {
  sourceKind: 'RECHARGE_ORDER' | 'COMMISSION_ACCRUAL' | 'SETTLEMENT' | 'REVERSAL' | 'ADJUSTMENT';
  sourceId: string;
  memo?: string | null;
  currency?: string;
  createdBy?: string | null;
  lines: JournalLine[];
};

export type JournalEntryDto = {
  id: string;
  reference: string;
  sourceKind: string;
  sourceId: string;
  memo: string | null;
  currency: string;
  occurredAt: string;
  lines: JournalLineDto[];
};

export type JournalLineDto = {
  accountCode: string;
  accountName: string;
  accountKind: string;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: number;
};

type JournalRow = {
  id: string;
  reference: string;
  source_kind: string;
  source_id: string;
  memo: string | null;
  currency: string;
  occurred_at: Date;
};

type LineRow = {
  entry_id: string;
  account_code: string;
  account_name: string;
  account_kind: string;
  direction: 'DEBIT' | 'CREDIT';
  amount_cents: string | number;
};

export const FIN_ACCOUNTS = {
  providerCollections: 'PROVIDER_COLLECTIONS',
  collectionsPending: 'COLLECTIONS_PENDING',
  providerFees: 'PROVIDER_FEES',
  coinLiability: 'COIN_LIABILITY',
  sellerCommissionPayable: 'SELLER_COMMISSION_PAY',
  bdCommissionPayable: 'BD_COMMISSION_PAY',
  commissionExpense: 'COMMISSION_EXPENSE',
  platformRevenue: 'PLATFORM_REVENUE',
  refundReserve: 'REFUND_RESERVE',
} as const;

export async function listFinAccounts(): Promise<FinAccountRow[]> {
  return many<FinAccountRow>('SELECT * FROM fin_accounts ORDER BY kind, code');
}

/**
 * Posts one balanced entry, idempotently.
 *
 * `fin_journal_entries (source_kind, source_id)` is unique, so a retry of the same workflow
 * step returns the entry that already exists instead of inventing a second one. The caller
 * passes the transaction's client: a credit that committed while its journal entry rolled back
 * would leave the finance report unable to explain the coin movement.
 */
export async function postJournal(
  client: PoolClient,
  input: JournalInput,
): Promise<{ id: string; reference: string; posted: boolean }> {
  const lines = input.lines.filter((line) => line.amountCents > 0);
  if (lines.length < 2) throw ApiError.badRequest('A journal entry needs at least two lines', 'journal_unbalanced');

  const debits = lines.filter((l) => l.direction === 'DEBIT').reduce((sum, l) => sum + l.amountCents, 0);
  const credits = lines.filter((l) => l.direction === 'CREDIT').reduce((sum, l) => sum + l.amountCents, 0);
  if (debits !== credits) {
    throw ApiError.badRequest(
      `Journal entry for ${input.sourceKind} ${input.sourceId} is unbalanced (${debits} debit / ${credits} credit)`,
      'journal_unbalanced',
    );
  }

  const currency = input.currency ?? 'pkr';
  const existing = await one<{ id: string; reference: string }>(
    'SELECT id, reference FROM fin_journal_entries WHERE source_kind = $1 AND source_id = $2',
    [input.sourceKind, input.sourceId],
  );
  if (existing) return { ...existing, posted: false };

  const entry = await one<{ id: string; reference: string }>(
    `INSERT INTO fin_journal_entries (reference, source_kind, source_id, memo, currency, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (source_kind, source_id) DO NOTHING
     RETURNING id, reference`,
    [shortCode('JR'), input.sourceKind, input.sourceId, input.memo ?? null, currency, input.createdBy ?? null],
  );
  if (!entry) {
    // Lost the race to a concurrent retry of the same step; re-read what it committed.
    const raced = await one<{ id: string; reference: string }>(
      'SELECT id, reference FROM fin_journal_entries WHERE source_kind = $1 AND source_id = $2',
      [input.sourceKind, input.sourceId],
    );
    if (!raced) throw ApiError.conflict('Journal entry could not be written');
    return { ...raced, posted: false };
  }

  for (const line of lines) {
    await client.query(
      `INSERT INTO fin_journal_lines (entry_id, account_code, direction, amount_cents, currency)
       VALUES ($1,$2,$3,$4,$5)`,
      [entry.id, line.accountCode, line.direction, line.amountCents, currency],
    );
  }
  return { ...entry, posted: true };
}

/** Balance of one account over a window, in minor units. Positive means its normal side grew. */
export async function accountBalance(accountCode: string, from?: Date, to?: Date): Promise<{
  code: string;
  name: string;
  kind: string;
  debits: number;
  credits: number;
  balance: number;
}> {
  const row = await one<{ name: string; kind: string; normal_side: string; debits: string; credits: string }>(
    `SELECT a.name, a.kind, a.normal_side,
            COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'DEBIT'), 0)::text AS debits,
            COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'CREDIT'), 0)::text AS credits
       FROM fin_accounts a
       LEFT JOIN fin_journal_lines l ON l.account_code = a.code
       LEFT JOIN fin_journal_entries e ON e.id = l.entry_id
            AND ($2::timestamptz IS NULL OR e.occurred_at >= $2)
            AND ($3::timestamptz IS NULL OR e.occurred_at <= $3)
      WHERE a.code = $1
      GROUP BY a.name, a.kind, a.normal_side`,
    [accountCode, from ?? null, to ?? null],
  );
  if (!row) throw ApiError.notFound(`Unknown financial account ${accountCode}`);
  const debits = Number(row.debits);
  const credits = Number(row.credits);
  return {
    code: accountCode,
    name: row.name,
    kind: row.kind,
    debits,
    credits,
    balance: row.normal_side === 'DEBIT' ? debits - credits : credits - debits,
  };
}

/** The whole chart, so the finance page can print a trial balance and prove it sums to zero. */
export async function trialBalance(from?: Date, to?: Date): Promise<{
  accounts: Array<{ code: string; name: string; kind: string; debits: number; credits: number; balance: number }>;
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
}> {
  const rows = await many<{
    code: string;
    name: string;
    kind: string;
    normal_side: string;
    debits: string;
    credits: string;
  }>(
    `SELECT a.code, a.name, a.kind, a.normal_side,
            COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'DEBIT'), 0)::text  AS debits,
            COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'CREDIT'), 0)::text AS credits
       FROM fin_accounts a
       LEFT JOIN fin_journal_lines l ON l.account_code = a.code
       LEFT JOIN fin_journal_entries e ON e.id = l.entry_id
            AND ($1::timestamptz IS NULL OR e.occurred_at >= $1)
            AND ($2::timestamptz IS NULL OR e.occurred_at <= $2)
      GROUP BY a.code, a.name, a.kind, a.normal_side
      ORDER BY a.kind, a.code`,
    [from ?? null, to ?? null],
  );

  const accounts = rows.map((row) => {
    const debits = Number(row.debits);
    const credits = Number(row.credits);
    return {
      code: row.code,
      name: row.name,
      kind: row.kind,
      debits,
      credits,
      balance: row.normal_side === 'DEBIT' ? debits - credits : credits - debits,
    };
  });
  const totalDebits = accounts.reduce((sum, a) => sum + a.debits, 0);
  const totalCredits = accounts.reduce((sum, a) => sum + a.credits, 0);
  return { accounts, totalDebits, totalCredits, balanced: totalDebits === totalCredits };
}

/**
 * The journal itself, newest first, with its lines.
 *
 * §25 asks finance to trace any amount from a collection to the coins it issued and the
 * commission it owed. That is a read of this table, not a reconstruction from the coin ledger,
 * so the entry's `sourceKind`/`sourceId` travel with it — they name the order or batch a line
 * belongs to and let a report join back to the operational record.
 */
export async function listJournal(opts: {
  sourceKind?: string;
  sourceId?: string;
  accountCode?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}): Promise<{ entries: JournalEntryDto[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (opts.sourceKind) where.push(`e.source_kind = ${bind(opts.sourceKind)}`);
  if (opts.sourceId) where.push(`e.source_id = ${bind(opts.sourceId)}`);
  if (opts.from) where.push(`e.occurred_at >= ${bind(opts.from.toISOString())}`);
  if (opts.to) where.push(`e.occurred_at <= ${bind(opts.to.toISOString())}`);
  if (opts.accountCode) where.push(`EXISTS (SELECT 1 FROM fin_journal_lines f WHERE f.entry_id = e.id AND f.account_code = ${bind(opts.accountCode)})`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
  const offset = Math.max(0, Number(opts.offset) || 0);

  const rows = await many<JournalRow>(
    `SELECT e.* FROM fin_journal_entries e ${clause} ORDER BY e.occurred_at DESC, e.reference LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  if (!rows.length) return { entries: [], total: 0 };

  const lines = await many<LineRow>(
    `SELECT l.entry_id, l.account_code, a.name AS account_name, a.kind AS account_kind, l.direction, l.amount_cents
       FROM fin_journal_lines l JOIN fin_accounts a ON a.code = l.account_code
      WHERE l.entry_id = ANY($1::uuid[])
      ORDER BY a.kind, a.code`,
    [rows.map((row) => row.id)],
  );
  const byEntry = new Map<string, JournalLineDto[]>();
  for (const line of lines) {
    const list = byEntry.get(line.entry_id) ?? [];
    list.push({
      accountCode: line.account_code,
      accountName: line.account_name,
      accountKind: line.account_kind,
      direction: line.direction,
      amountCents: Number(line.amount_cents),
    });
    byEntry.set(line.entry_id, list);
  }

  const count = await one<{ n: string }>(`SELECT COUNT(*) AS n FROM fin_journal_entries e ${clause}`, params);
  return {
    entries: rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      memo: row.memo,
      currency: row.currency,
      occurredAt: new Date(row.occurred_at).toISOString(),
      lines: byEntry.get(row.id) ?? [],
    })),
    total: Number(count?.n ?? 0),
  };
}
