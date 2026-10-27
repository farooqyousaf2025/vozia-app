import { PoolClient } from 'pg';
import { many, query } from '../config/db';

/**
 * Who changed what, in the back office.
 *
 * `recordAudit` takes the caller's `PoolClient` when there is one, so an admin mutation and
 * its audit row commit together or not at all. An audit log that can be skipped by a
 * rollback-free code path is not an audit log.
 */

export type AuditEntry = {
  adminId: string | null;
  /** Set instead of (or alongside) `adminId` when the actor is a BD representative or seller. */
  businessId?: string | null;
  /**
   * Set when neither a human nor a partner acted — a provider confirmation, the expiry sweep.
   * The database requires one of the three, so an audit row can never be anonymous.
   */
  actorSystem?: string | null;
  /** Stable verb, so the console can filter without parsing prose. */
  action: string;
  targetType?: string;
  targetId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
};

export type AuditRow = {
  id: string;
  admin_id: string | null;
  business_id: string | null;
  actor_system: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  summary: string;
  details: Record<string, unknown>;
  created_at: Date;
  username?: string | null;
  admin_username?: string | null;
  business_code?: string | null;
};

const INSERT = `
  INSERT INTO admin_audit (admin_id, business_id, actor_system, action, target_type, target_id, summary, details)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`;

export async function recordAudit(entry: AuditEntry, client?: PoolClient): Promise<void> {
  const params = [
    entry.adminId,
    entry.businessId ?? null,
    entry.actorSystem ?? null,
    entry.action.slice(0, 48),
    entry.targetType ?? null,
    entry.targetId ?? null,
    entry.summary.slice(0, 500),
    JSON.stringify(entry.details ?? {}),
  ];
  if (client) await client.query(INSERT, params);
  else await query(INSERT, params);
}

export async function listAudit(opts: {
  limit: number;
  adminId?: string;
  businessId?: string;
  targetType?: string;
  actorKind?: 'admin' | 'business' | 'system';
}): Promise<
  Array<{
    id: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    summary: string;
    details: Record<string, unknown>;
    createdAt: string;
    actor: string;
    actorKind: 'admin' | 'business' | 'system';
  }>
> {
  const rows = await many<AuditRow>(
    `SELECT a.*, u.username AS admin_username, b.code AS business_code
       FROM admin_audit a
       LEFT JOIN admins u ON u.id = a.admin_id
       LEFT JOIN business_accounts b ON b.id = a.business_id
      WHERE ($1::uuid IS NULL OR a.admin_id = $1)
        AND ($2::uuid IS NULL OR a.business_id = $2)
        AND ($3::text IS NULL OR a.target_type = $3)
        AND ($5::text IS NULL
             OR ($5 = 'business' AND a.business_id IS NOT NULL)
             OR ($5 = 'admin'    AND a.business_id IS NULL AND a.admin_id IS NOT NULL)
             OR ($5 = 'system'   AND a.business_id IS NULL AND a.admin_id IS NULL))
      ORDER BY a.created_at DESC LIMIT $4`,
    // The branches mirror how `actorKind` is derived below: a row written by a partner counts as
    // a partner's even if an operator id travelled with it.
    [opts.adminId ?? null, opts.businessId ?? null, opts.targetType ?? null, opts.limit, opts.actorKind ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    summary: row.summary,
    details: row.details,
    createdAt: new Date(row.created_at).toISOString(),
    actor: row.business_code ?? row.admin_username ?? row.actor_system ?? 'deleted-operator',
    actorKind: row.business_id ? 'business' : row.admin_id ? 'admin' : 'system',
  }));
}
