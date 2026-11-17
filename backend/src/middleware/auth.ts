import { NextFunction, Request, Response } from 'express';
import { one } from '../config/db';
import { findAdminById } from '../services/admin.service';
import { AdminRow, BusinessAccountRow } from '../types/db';
import { BusinessPermission, Permission, adminHasPermission, businessHasPermission } from '../services/rbac.service';
import { AgencyOwnerRow } from '../services/agency.service';
import {
  AccessTokenPayload,
  AdminTokenPayload,
  BusinessTokenPayload,
  verifyToken,
} from '../services/token.service';
import { ApiError } from '../utils/http';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
      admin?: AdminTokenPayload;
      business?: BusinessTokenPayload;
      /** Loaded on demand by requirePermission / requireBusiness; never taken from the token. */
      adminRow?: AdminRow | null;
      businessRow?: BusinessAccountRow | null;
      /** Loaded on demand by requireAgencyOwner; the agency the signed-in member runs. */
      agencyRow?: AgencyOwnerRow | null;
    }
  }
}

function bearer(req: Request): string {
  const header = req.headers.authorization;
  if (!header) throw ApiError.unauthorized('Missing Authorization header');
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) {
    throw ApiError.unauthorized('Authorization header must be "Bearer <token>"');
  }
  return value;
}

/** Express 4 does not catch a rejected async handler; every guard below runs through this. */
function guard(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).then(next, next);
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const payload = verifyToken(bearer(req));
  if (payload.scope !== 'user') throw ApiError.forbidden('User token required');
  req.user = payload;
  next();
}

/**
 * Public reads that personalise when a member is signed in (the ranking boards' own row).
 * No header means anonymous; a header that is present must still be a valid user token, so a
 * stale or forged one is refused rather than silently downgraded to a stranger's view.
 */
export function optionalUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.headers.authorization) return next();
  const payload = verifyToken(bearer(req));
  if (payload.scope !== 'user') throw ApiError.forbidden('User token required');
  req.user = payload;
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const payload = verifyToken(bearer(req));
  if (payload.scope !== 'admin') throw ApiError.forbidden('Admin token required');
  req.admin = payload;
  next();
}

/**
 * Any admin token, with the operator row attached. The row is read from the database because
 * the role inside the token is a snapshot of who they were when they signed in.
 */
export const requireAdminOperator = guard(async (req) => {
  const payload = verifyToken(bearer(req));
  if (payload.scope !== 'admin') throw ApiError.forbidden('Admin token required');
  req.admin = payload;
  const row = await findAdminById(payload.sub);
  if (!row) throw ApiError.unauthorized('Operator account no longer exists');
  assertOperatorActive(row);
  req.adminRow = row;
});

/**
 * A disabled operator is refused on every request, not only at sign-in.
 *
 * The twelve-hour token is signed and says nothing about the switch thrown since it was issued,
 * so `is_active` means what it should only if it is read from the row — which this path already
 * loads for the role, so the check costs nothing and closes the window the token would leave open.
 */
function assertOperatorActive(row: AdminRow): void {
  if (!row.is_active) {
    throw ApiError.forbidden('This operator account is disabled', 'operator_disabled');
  }
}

/** Programme §23: the permission decides, not the role name a client can read. */
export function requirePermission(...permissions: Permission[]) {
  return guard(async (req) => {
    const payload = verifyToken(bearer(req));
    if (payload.scope !== 'admin') {
      throw ApiError.forbidden('This action belongs to the operator panel', 'permission_denied');
    }
    req.admin = payload;
    const row = (req.adminRow ??= await findAdminById(payload.sub));
    if (!row) throw ApiError.unauthorized('Operator account no longer exists');
    assertOperatorActive(row);
    for (const permission of permissions) {
      if (!adminHasPermission(row.role, permission)) {
        throw ApiError.forbidden(`Role ${row.role} may not perform ${permission}`, 'permission_denied');
      }
    }
  });
}

export const requireBusiness = (...permissions: BusinessPermission[]) =>
  guard(async (req) => {
    const payload = verifyToken(bearer(req));
    if (payload.scope !== 'business') throw ApiError.forbidden('Business account token required');
    req.business = payload;
    // last_login_at is the only write this guard makes, and it is one indexed UPDATE.
    const row = await one<BusinessAccountRow>(
      'UPDATE business_accounts SET last_login_at = now() WHERE id = $1 RETURNING *',
      [payload.sub],
    );
    if (!row) throw ApiError.unauthorized('Business account no longer exists');
    if (row.status !== 'ACTIVE') {
      throw ApiError.forbidden(`This business account is ${row.status.toLowerCase()}`, 'business_account_inactive');
    }
    req.businessRow = row;
    for (const permission of permissions) {
      if (!businessHasPermission(row.kind, permission)) {
        throw ApiError.forbidden(`This account may not perform ${permission}`, 'permission_denied');
      }
    }
  });

/**
 * The member who runs an agency, with that agency's row.
 *
 * An agency is not an operator and not a business account: it is a `users` row the partner queue
 * promoted (0035), so the credential is an ordinary member token and the scope is decided by the
 * database rather than by anything the client sends. The row is re-read on every request for the
 * same reason `requirePermission` re-reads an operator: a twelve-hour token cannot be allowed to
 * outlive a revoke, and an agency suspended since signing in must not keep reading its book.
 *
 * `owner_user_id` is the whole authorisation. There is no agency id in a path or a body, so a member
 * cannot ask for another agency's roster by naming its uuid.
 */
export const requireAgencyOwner = guard(async (req) => {
  const payload = verifyToken(bearer(req));
  if (payload.scope !== 'user') throw ApiError.forbidden('Member token required', 'member_token_required');
  req.user = payload;
  const row = await one<AgencyOwnerRow>(
    `SELECT id, name, status, parent_agency_id, parent_override_bps, owner_user_id
       FROM agencies
      WHERE owner_user_id = $1 AND status = 'ACTIVE'
      ORDER BY created_at
      LIMIT 1`,
    [payload.sub],
  );
  if (!row) {
    throw ApiError.forbidden('This member does not run an active agency', 'agency_not_found');
  }
  req.agencyRow = row;
});

/**
 * A master's own routes: the sub-agency roster and the allocations under it.
 *
 * A sub-agency reaches its own position through `requireAgencyOwner` and is refused here, which is
 * what makes the brief's "restricted access to Master Agency settings" a testable answer rather than
 * a hidden menu item. It runs the owner lookup itself so a route cannot mount the refusal without
 * the authentication.
 */
export const requireMasterAgency = [
  requireAgencyOwner,
  guard(async (req) => {
    if (req.agencyRow && req.agencyRow.parent_agency_id !== null) {
      throw ApiError.forbidden('A sub-agency has no sub-agencies of its own', 'master_only');
    }
  }),
];
