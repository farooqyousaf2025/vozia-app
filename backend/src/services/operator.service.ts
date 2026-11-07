import { PoolClient } from 'pg';
import { many, one, withTransaction } from '../config/db';
import { ApiError } from '../utils/http';
import { hashSecret } from '../utils/crypto';
import { recordAudit } from './audit.service';
import { ADMIN_ROLES, AdminRole, adminPermissions, normalizeAdminRole } from './rbac.service';
import { AdminRow } from '../types/db';

/**
 * Operator accounts — who may sign into the back office, and what happens when they must not.
 *
 * Two things shape this module, and both were learned from the schema rather than invented here.
 *
 * An operator is switched off, never deleted. `admin_audit` points at `admins` with
 * `ON DELETE SET NULL` and simultaneously requires every audit row to name an actor, so a delete
 * of anyone who has ever written something fails the check. Deactivation is the only lifecycle
 * this table can support, and it is also the right one: the history of what an operator did has
 * to outlive their access.
 *
 * Disabling has to be read, not remembered. The operator token lives twelve hours and is signed,
 * not session-backed, so `is_active` only means something because every admin request already
 * re-reads the row for the same reason the role is re-read (`requireAdminOperator` in the
 * middleware). That is why there is no cache here and no token revocation list.
 *
 * The last guard is the one that keeps a platform out of a lockout: the final active SUPER_ADMIN
 * may neither be disabled nor demoted, because that role is the only one holding `operator:manage`
 * and there is no recovery path below it. It runs inside a transaction that locks every active
 * super-admin row, so two operators demoting two different supers at the same time cannot both
 * see "one left" and finish with none.
 */

export type OperatorDto = {
  id: string;
  username: string;
  displayName: string | null;
  /** The role as stored, which for a row seeded before the vocabulary existed is not a real role. */
  roleStored: string;
  /** The role the permission table actually applies to this operator. */
  role: AdminRole;
  isActive: boolean;
  disabledAt: string | null;
  createdAt: string;
  /** Sent so the screen can show what a role means instead of naming it and hoping. */
  permissions: readonly string[];
};

type OperatorRow = AdminRow;

function toDto(row: OperatorRow): OperatorDto {
  const role = normalizeAdminRole(row.role);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleStored: row.role,
    role,
    isActive: row.is_active,
    disabledAt: row.disabled_at ? row.disabled_at.toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    permissions: adminPermissions(role),
  };
}

export async function listOperators(params: {
  search?: string;
  role?: string;
  active?: 'ALL' | 'ACTIVE' | 'DISABLED';
  limit: number;
  offset: number;
}): Promise<{ operators: OperatorDto[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (params.search) {
    values.push(`%${params.search}%`);
    where.push(`(username ILIKE $${values.length} OR COALESCE(display_name, '') ILIKE $${values.length})`);
  }
  if (params.role) {
    values.push(params.role);
    where.push(`role = $${values.length}`);
  }
  if (params.active === 'ACTIVE') where.push('is_active');
  if (params.active === 'DISABLED') where.push('NOT is_active');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  values.push(params.limit, params.offset);
  const rows = await many<OperatorRow>(
    `SELECT * FROM admins ${clause} ORDER BY is_active DESC, username LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const count = await one<{ n: string }>(`SELECT COUNT(*)::bigint AS n FROM admins ${clause}`, values.slice(0, -2));
  return { operators: rows.map(toDto), total: Number(count?.n ?? 0) };
}

/** A username is a login, so it has to survive being typed: no spaces, no ambiguity. */
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,39}$/;

export async function createOperator(input: {
  username: string;
  password: string;
  role: string;
  displayName?: string;
  actorId: string;
}): Promise<OperatorDto> {
  const username = input.username.trim().toLowerCase();
  if (!USERNAME.test(username)) {
    throw ApiError.badRequest(
      'username must be 3-40 characters: a lowercase letter or digit first, then letters, digits, dot, underscore or hyphen',
      'bad_username',
    );
  }
  if (input.password.length < 8 || input.password.length > 200) {
    throw ApiError.badRequest('password must be at least 8 characters', 'bad_password');
  }
  const role = normalizeAdminRole(input.role);

  return withTransaction(async (client) => {
    const clash = (
      await client.query<{ n: string }>('SELECT COUNT(*)::int AS n FROM admins WHERE username = $1', [username])
    ).rows[0];
    if (Number(clash.n ?? 0) > 0) throw ApiError.conflict(`An operator named "${username}" already exists`, 'username_taken');

    const row = (
      await client.query<OperatorRow>(
        'INSERT INTO admins (username, password_hash, display_name, role) VALUES ($1, $2, $3, $4) RETURNING *',
        [username, hashSecret(input.password), input.displayName ?? null, role],
      )
    ).rows[0];
    await recordAudit(
      {
        adminId: input.actorId,
        action: 'OPERATOR_CREATE',
        targetType: 'admin',
        targetId: row.id,
        summary: `Operator "${username}" created as ${role}`,
        details: { username, role, displayName: input.displayName ?? null },
      },
      client,
    );
    return toDto(row);
  });
}

/**
 * Change a role or a display name.
 *
 * A password is not in here on purpose: rotating one needs the operator's own credential, and an
 * administrative reset without that is a way to take an account without leaving a reason behind.
 * Until a supervised reset with its own audit trail exists, the route is the operator's own
 * `POST /admin/change-password`.
 */
export async function updateOperator(
  id: string,
  input: { role?: string; displayName?: string; actorId: string },
): Promise<OperatorDto> {
  if (input.role === undefined && input.displayName === undefined) {
    throw ApiError.badRequest('Nothing to change', 'nothing_to_update');
  }
  return withTransaction(async (client) => {
    const current = await lockOperator(client, id);
    const previousRole = normalizeAdminRole(current.role);
    const nextRole = input.role === undefined ? previousRole : normalizeAdminRole(input.role);
    const changedRole = nextRole !== previousRole;
    const displayName = input.displayName === undefined ? current.display_name : input.displayName;
    const changedName = displayName !== current.display_name;

    // The lock only matters when the target is one of the rows being counted. Demoting a moderator
    // to a moderator, or switching off a super-admin who is already disabled, removes nobody.
    if (changedRole && nextRole !== 'SUPER_ADMIN' && previousRole === 'SUPER_ADMIN' && current.is_active) {
      await refuseLastSuperAdmin(client, current);
    }
    if (!changedRole && !changedName) {
      throw ApiError.badRequest('Nothing to change', 'nothing_to_update');
    }
    const row = (
      await client.query<OperatorRow>('UPDATE admins SET role = $2, display_name = $3 WHERE id = $1 RETURNING *', [
        id,
        nextRole,
        displayName,
      ])
    ).rows[0];
    await recordAudit(
      {
        adminId: input.actorId,
        action: 'OPERATOR_UPDATE',
        targetType: 'admin',
        targetId: id,
        summary: changedRole
          ? `Operator "${current.username}" changed role from ${previousRole} to ${nextRole}`
          : `Display name of operator "${current.username}" updated`,
        details: {
          username: current.username,
          from: { role: previousRole, displayName: current.display_name },
          to: { role: nextRole, displayName },
        },
      },
      client,
    );
    return toDto(row);
  });
}

/** Switch an operator off, or back on. The reason is required to switch off, not on. */
export async function setOperatorActive(input: {
  id: string;
  active: boolean;
  reason?: string;
  actorId: string;
}): Promise<OperatorDto> {
  if (!input.active && (input.reason === undefined || input.reason.trim().length < 8)) {
    throw ApiError.badRequest('A reason of at least 8 characters is required to disable an operator', 'reason_required');
  }
  return withTransaction(async (client) => {
    const current = await lockOperator(client, input.id);
    if (!input.active && current.id === input.actorId) {
      throw ApiError.conflict(
        'You cannot disable the operator you are signed in as; another super-admin has to do it',
        'cannot_disable_self',
      );
    }
    if (!input.active && normalizeAdminRole(current.role) === 'SUPER_ADMIN' && current.is_active) {
      await refuseLastSuperAdmin(client, current);
    }
    if (current.is_active === input.active) {
      // Returning the row unchanged would let a double click read as a second act with a second
      // reason; saying so keeps the audit a record of what actually changed.
      throw ApiError.conflict(
        `Operator "${current.username}" is already ${input.active ? 'active' : 'disabled'}`,
        'already_in_that_state',
      );
    }

    const row = (
      await client.query<OperatorRow>(
        'UPDATE admins SET is_active = $2, disabled_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE id = $1 RETURNING *',
        [input.id, input.active],
      )
    ).rows[0];
    await recordAudit(
      {
        adminId: input.actorId,
        action: input.active ? 'OPERATOR_ENABLE' : 'OPERATOR_DISABLE',
        targetType: 'admin',
        targetId: input.id,
        summary: `Operator "${current.username}" ${input.active ? 're-enabled' : 'disabled'}${input.reason ? `: ${input.reason.trim()}` : ''}`,
        details: { username: current.username, role: normalizeAdminRole(current.role), reason: input.reason?.trim() ?? null },
      },
      client,
    );
    return toDto(row);
  });
}

async function lockOperator(client: PoolClient, id: string): Promise<OperatorRow> {
  const row = (await client.query<OperatorRow>('SELECT * FROM admins WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row) throw ApiError.notFound('Operator not found', 'operator_not_found');
  return row;
}

/**
 * Hold every active super-admin row before counting them.
 *
 * A plain `COUNT(*)` would let two operators demote two different supers concurrently and both
 * conclude that a third is still around. Locking the set makes the last-one-standing test atomic.
 */
async function refuseLastSuperAdmin(client: PoolClient, target: OperatorRow): Promise<void> {
  await client.query("SELECT id FROM admins WHERE role = 'SUPER_ADMIN' AND is_active FOR UPDATE");
  const others = (
    await client.query<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM admins WHERE role = 'SUPER_ADMIN' AND is_active AND id <> $1",
      [target.id],
    )
  ).rows[0];
  if (Number(others.n ?? 0) === 0) {
    throw ApiError.conflict(
      'This is the only active super-admin; another operator has to be given the role before this one can be disabled or demoted',
      'last_super_admin',
    );
  }
}

/** Every admin role, with the permissions the server will actually apply to it. */
export function roleCatalogue(): Array<{ role: AdminRole; permissions: readonly string[] }> {
  return ADMIN_ROLES.map((role) => ({ role, permissions: adminPermissions(role) }));
}
