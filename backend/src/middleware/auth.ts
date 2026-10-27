import { NextFunction, Request, Response } from 'express';
import { one } from '../config/db';
import { findAdminById } from '../services/admin.service';
import { AdminRow, BusinessAccountRow } from '../types/db';
import { BusinessPermission, Permission, adminHasPermission, businessHasPermission } from '../services/rbac.service';
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
  req.adminRow = row;
});

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
