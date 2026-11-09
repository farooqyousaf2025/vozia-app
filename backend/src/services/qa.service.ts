import { PoolClient } from 'pg';
import { many, one, withTransaction } from '../config/db';
import { ApiError, requireBoolean, requireEnum, requireInt, requireString, requireUuid } from '../utils/http';
import { recordAudit } from './audit.service';

/**
 * The QA programme's own record (migration 0039).
 *
 * Two facts about testing a live financial product shape this file.
 *
 * First, a test account has to be *nameable*. `is_test` alone would leave a row that nobody can
 * tie back to a cohort, so the database refuses the flag without a `qa_ref`, and this service
 * refuses a reference that is not shaped like one. The reference is internal: the member app keeps
 * showing `username`, because the brief is explicit that testers appear under their real approved
 * names and that ordinary users never see technical identifiers.
 *
 * Second, the money is not flagged here. `qa_money_marking` derives it from the accounts a row
 * belongs to, so marking an account reclassifies its whole history without a single financial row
 * being rewritten. This service therefore writes only identities and reads only the derivation —
 * it has no path that touches a balance, and `qa:manage` is deliberately not `user:wallet`.
 */

export const QA_OWNER_KINDS = ['USER', 'BUSINESS', 'AGENCY', 'ADMIN'] as const;
export type QaOwnerKind = (typeof QA_OWNER_KINDS)[number];

/** The table each kind marks. A lookup, never an interpolated request string. */
const TABLES: Record<QaOwnerKind, string> = {
  USER: 'users',
  BUSINESS: 'business_accounts',
  AGENCY: 'agencies',
  ADMIN: 'admins',
};

const REF_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

export type QaIdentityDto = {
  ownerKind: QaOwnerKind;
  ownerId: string;
  isTest: boolean;
  qaRef: string | null;
  /** What the app shows. Never the reference. */
  displayName: string;
  /** QA cohort label only — the brief is explicit that a country does not establish residence. */
  country: string | null;
  createdAt: string;
};

export type QaRosterDto = {
  identities: QaIdentityDto[];
  total: number;
  page: number;
  limit: number;
  markedTotal: number;
};

export type QaMoneyRowDto = {
  sourceTable: string;
  sourceId: string;
  occurredAt: string;
  isTest: boolean;
  testRefs: string[];
};

export type QaMoneySummaryDto = {
  tables: Array<{ sourceTable: string; total: number; testRows: number; productionRows: number }>;
  totalRows: number;
  testRows: number;
  productionRows: number;
};

function readRef(value: unknown): string {
  const ref = requireString(value, 'qaRef', { min: 2, max: 40 }).trim().toUpperCase();
  if (!REF_PATTERN.test(ref)) {
    throw ApiError.badRequest(
      'qaRef must be 2–40 characters of letters, digits, dash or underscore, e.g. PK-HOST-01',
      'qa_ref_invalid',
    );
  }
  return ref;
}

function toIdentity(row: {
  owner_kind: string;
  owner_id: string;
  is_test: boolean;
  qa_ref: string | null;
  display_name: string;
  country: string | null;
  created_at: Date;
}): QaIdentityDto {
  return {
    ownerKind: row.owner_kind as QaOwnerKind,
    ownerId: row.owner_id,
    isTest: row.is_test,
    qaRef: row.qa_ref,
    displayName: row.display_name,
    country: row.country,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The roster. Production accounts are excluded unless asked for, because the point of the screen
 * is "who is testing" — but `includeProduction` exists so an operator can find an account that was
 * never marked and mark it, which is the common case when a demo account joins the programme.
 */
export async function listQaIdentities(opts: {
  ownerKind?: QaOwnerKind;
  country?: string;
  search?: string;
  includeProduction?: boolean;
  page?: number;
  limit?: number;
} = {}): Promise<QaRosterDto> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: string[] = [];
  const params: unknown[] = [];

  if (!opts.includeProduction) where.push('is_test');
  if (opts.ownerKind) where.push(`owner_kind = $${params.push(opts.ownerKind)}`);
  if (opts.country) where.push(`country = $${params.push(opts.country.toUpperCase())}`);
  if (opts.search) {
    const p = params.push(`%${opts.search}%`);
    where.push(`(display_name ILIKE $${p} OR qa_ref ILIKE $${p} OR owner_id::text = $${p})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Counted before the paging params go on: `is_test` is a predicate that binds nothing, so the
  // number of WHERE terms is not the number of parameters and slicing by it would hand the count
  // query a limit it has no placeholder for.
  const filterParams = params.length;

  const rows = await many<{
    owner_kind: string;
    owner_id: string;
    is_test: boolean;
    qa_ref: string | null;
    display_name: string;
    country: string | null;
    created_at: Date;
  }>(
    `SELECT * FROM qa_identities ${clause}
      ORDER BY is_test DESC, qa_ref NULLS LAST, created_at DESC
      LIMIT $${params.push(limit)} OFFSET $${params.push((page - 1) * limit)}`,
    params,
  );
  const counted = await one<{ n: string; marked: string }>(
    `SELECT COUNT(*)::text AS n, COUNT(*) FILTER (WHERE is_test)::text AS marked FROM qa_identities ${clause}`,
    params.slice(0, filterParams),
  );

  return {
    identities: rows.map(toIdentity),
    total: Number(counted?.n ?? 0),
    page,
    limit,
    markedTotal: Number(counted?.marked ?? 0),
  };
}

/**
 * The one refusal that is not about shape: the last active, unmarked Super Admin cannot be marked
 * as QA. Doing so would leave nobody outside the programme able to unmark it, which is a lockout
 * dressed up as a checkbox.
 */
async function assertNotLastProductionSuperAdmin(client: PoolClient, ownerId: string): Promise<void> {
  const target = await client.query<{ role: string; is_active: boolean }>(
    'SELECT role, is_active FROM admins WHERE id = $1',
    [ownerId],
  );
  const admin = target.rows[0];
  if (!admin?.is_active || admin.role !== 'SUPER_ADMIN') return;
  const others = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM admins
      WHERE role = 'SUPER_ADMIN' AND is_active AND NOT is_test AND id <> $1`,
    [ownerId],
  );
  if (Number(others.rows[0]?.n ?? 0) === 0) {
    throw ApiError.conflict(
      'This is the last active Super Admin outside the QA programme; marking it would leave nobody able to unmark it',
      'last_production_super_admin',
    );
  }
}

/**
 * Mark or unmark one account, on a client the caller owns.
 *
 * Unmarking keeps the reference: it is the historical name of a cohort, and freeing it would let a
 * later account inherit a label that already appears in the audit log and in exported evidence.
 */
async function applyMark(
  client: PoolClient,
  adminId: string,
  ownerKind: QaOwnerKind,
  ownerId: string,
  isTest: boolean,
  rawRef?: unknown,
): Promise<QaIdentityDto> {
  const table = TABLES[ownerKind];
  const found = await client.query<{ id: string; is_test: boolean; qa_ref: string | null }>(
    `SELECT id, is_test, qa_ref FROM ${table} WHERE id = $1 FOR UPDATE`,
    [ownerId],
  );
  const row = found.rows[0];
  if (!row) throw ApiError.notFound('That account does not exist', 'qa_account_not_found');

  if (isTest && ownerKind === 'ADMIN') await assertNotLastProductionSuperAdmin(client, ownerId);

  const qaRef = rawRef === undefined ? undefined : readRef(rawRef);
  const nextRef = qaRef ?? row.qa_ref;
  if (isTest && !nextRef) throw ApiError.badRequest('Marking an account as QA needs a qaRef', 'qa_ref_required');

  await client.query(`UPDATE ${table} SET is_test = $2, qa_ref = $3 WHERE id = $1`, [ownerId, isTest, nextRef]);
  await recordAudit(
    {
      adminId,
      action: isTest ? 'QA_MARK' : 'QA_UNMARK',
      targetType: ownerKind,
      targetId: ownerId,
      summary: `${isTest ? 'Marked' : 'Unmarked'} ${ownerKind} ${ownerId} as QA${nextRef ? ` (${nextRef})` : ''}`,
      details: { previousIsTest: row.is_test, previousQaRef: row.qa_ref, isTest, qaRef: nextRef },
    },
    client,
  );

  const fresh = await client.query<{
    owner_kind: string;
    owner_id: string;
    is_test: boolean;
    qa_ref: string | null;
    display_name: string;
    country: string | null;
    created_at: Date;
  }>('SELECT * FROM qa_identities WHERE owner_id = $1 AND owner_kind = $2', [ownerId, ownerKind]);
  const identity = fresh.rows[0];
  if (!identity) throw new Error(`qa_identities lost ${ownerKind} ${ownerId} inside its own update`);
  return toIdentity(identity);
}

export async function setQaMarking(
  adminId: string,
  ownerKind: QaOwnerKind,
  ownerId: string,
  input: { isTest: boolean; qaRef?: unknown },
): Promise<QaIdentityDto> {
  const isTest = requireBoolean(input.isTest, 'isTest');
  return withTransaction((client) => applyMark(client, adminId, ownerKind, ownerId, isTest, input.qaRef));
}

/**
 * Mark a whole cohort at once — the brief's country × role matrix is 30-plus accounts, and marking
 * them one request at a time is how a half-marked matrix happens.
 *
 * All-or-nothing: one bad id rolls the cohort back rather than leaving the operator to work out
 * which of thirty rows took. Each mark still writes its own audit row.
 */
export async function markQaCohort(
  adminId: string,
  entries: Array<{ ownerKind: QaOwnerKind; ownerId: string; qaRef: string }>,
): Promise<QaIdentityDto[]> {
  if (entries.length === 0) throw ApiError.badRequest('A cohort needs at least one account', 'qa_cohort_empty');
  if (entries.length > 200) throw ApiError.badRequest('A cohort is at most 200 accounts', 'qa_cohort_too_large');
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.ownerKind}:${entry.ownerId}`;
    if (seen.has(key)) throw ApiError.badRequest(`Account ${entry.ownerId} appears twice in the cohort`, 'qa_cohort_duplicate');
    seen.add(key);
  }
  return withTransaction(async (client) => {
    const marked: QaIdentityDto[] = [];
    for (const entry of entries) {
      marked.push(await applyMark(client, adminId, entry.ownerKind, entry.ownerId, true, entry.qaRef));
    }
    return marked;
  });
}

/** Every financial record, split by the derivation. What the delivery report quotes. */
export async function qaMoneySummary(): Promise<QaMoneySummaryDto> {
  const rows = await many<{ source_table: string; total: string; test_rows: string }>(
    `SELECT source_table, COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE is_test)::text AS test_rows
       FROM qa_money_marking GROUP BY source_table ORDER BY source_table`,
  );
  const tables = rows.map((row) => {
    const total = Number(row.total);
    const testRows = Number(row.test_rows);
    return { sourceTable: row.source_table, total, testRows, productionRows: total - testRows };
  });
  return {
    tables,
    totalRows: tables.reduce((sum, t) => sum + t.total, 0),
    testRows: tables.reduce((sum, t) => sum + t.testRows, 0),
    productionRows: tables.reduce((sum, t) => sum + t.productionRows, 0),
  };
}

export async function listQaMoney(opts: {
  isTest?: boolean;
  sourceTable?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
} = {}): Promise<{ rows: QaMoneyRowDto[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.isTest !== undefined) where.push(`is_test = $${params.push(opts.isTest)}`);
  if (opts.sourceTable) where.push(`source_table = $${params.push(opts.sourceTable)}`);
  if (opts.from) where.push(`occurred_at >= $${params.push(opts.from)}`);
  if (opts.to) where.push(`occurred_at <= $${params.push(opts.to)}`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const filterParams = params.length;

  const rows = await many<{
    source_table: string;
    source_id: string;
    occurred_at: Date;
    is_test: boolean;
    test_refs: string[];
  }>(
    `SELECT * FROM qa_money_marking ${clause}
      ORDER BY occurred_at DESC, source_id
      LIMIT $${params.push(limit)} OFFSET $${params.push((page - 1) * limit)}`,
    params,
  );
  const counted = await one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM qa_money_marking ${clause}`,
    params.slice(0, filterParams),
  );
  return {
    rows: rows.map((row) => ({
      sourceTable: row.source_table,
      sourceId: row.source_id,
      occurredAt: row.occurred_at.toISOString(),
      isTest: row.is_test,
      testRefs: row.test_refs ?? [],
    })),
    total: Number(counted?.n ?? 0),
    page,
    limit,
  };
}

/**
 * The predicate the production reports add.
 *
 * `alias` is the money table's alias in the caller's query and `columns` are its owner columns.
 * Returned as SQL rather than applied here because the reports aggregate in one pass and a second
 * query per report would be both slower and a second place for the rule to live.
 *
 * A row with no owner at all (a platform-only journal entry) is production, which is why this is
 * NOT EXISTS rather than a join that would drop it.
 */
export function excludeTestSql(alias: string, columns: readonly string[]): string {
  const owners = columns.map((column) => `${alias}.${column}`).join(', ');
  return `NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY[${owners}]) AS qa_oid
      JOIN qa_identities qi ON qi.owner_id = qa_oid
     WHERE qi.is_test
  )`;
}

/** Validation shared by the controller, so a body is read once and the same way for every route. */
export function readMarkBody(body: Record<string, unknown>): { ownerKind: QaOwnerKind; ownerId: string; isTest: boolean; qaRef?: unknown } {
  return {
    ownerKind: requireEnum(body?.ownerKind, 'ownerKind', QA_OWNER_KINDS),
    ownerId: requireUuid(body?.ownerId, 'ownerId'),
    isTest: requireBoolean(body?.isTest, 'isTest'),
    qaRef: body?.qaRef,
  };
}

export function readCohortBody(body: Record<string, unknown>): Array<{ ownerKind: QaOwnerKind; ownerId: string; qaRef: string }> {
  const raw = body?.accounts;
  if (!Array.isArray(raw)) throw ApiError.badRequest('accounts must be an array', 'qa_cohort_invalid');
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw ApiError.badRequest(`accounts[${index}] must be an object`, 'qa_cohort_invalid');
    }
    const item = entry as Record<string, unknown>;
    return {
      ownerKind: requireEnum(item.ownerKind, `accounts[${index}].ownerKind`, QA_OWNER_KINDS),
      ownerId: requireUuid(item.ownerId, `accounts[${index}].ownerId`),
      qaRef: requireString(item.qaRef, `accounts[${index}].qaRef`, { min: 2, max: 40 }),
    };
  });
}

export function readMoneyQuery(query: Record<string, unknown>): {
  isTest?: boolean;
  sourceTable?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
} {
  const out: ReturnType<typeof readMoneyQuery> = {};
  if (query.isTest !== undefined) out.isTest = requireBoolean(query.isTest, 'isTest');
  if (query.sourceTable !== undefined) out.sourceTable = requireString(query.sourceTable, 'sourceTable', { min: 1, max: 48 });
  for (const key of ['from', 'to'] as const) {
    if (query[key] !== undefined) {
      const date = new Date(requireString(query[key], key, { min: 1, max: 40 }));
      if (Number.isNaN(date.getTime())) throw ApiError.badRequest(`${key} must be an ISO date`, 'qa_date_invalid');
      out[key] = date;
    }
  }
  if (query.page !== undefined) out.page = requireInt(query.page, 'page', { min: 1, max: 100_000 });
  if (query.limit !== undefined) out.limit = requireInt(query.limit, 'limit', { min: 1, max: 500 });
  return out;
}