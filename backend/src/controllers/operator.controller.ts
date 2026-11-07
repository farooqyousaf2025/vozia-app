import { Request, Response } from 'express';
import {
  ApiError,
  asyncHandler,
  optionalEnum,
  optionalInt,
  optionalString,
  requireEnum,
  requireString,
  requireUuid,
} from '../utils/http';
import { ADMIN_ROLES } from '../services/rbac.service';
import {
  createOperator,
  listOperators,
  roleCatalogue,
  setOperatorActive,
  updateOperator,
} from '../services/operator.service';

/**
 * The operator roster for the back office (§23).
 *
 * This is the one surface that changes who can change everything else, so it is built around two
 * refusals rather than around editing. An operator is never deleted — `admin_audit` requires an
 * actor on every row it holds, so a delete of anyone who has written anything is rejected by the
 * database and the account has to be switchable off instead — and the last active super-admin can
 * neither be disabled nor demoted, because `operator:manage` lives only on that role and losing it
 * would mean no credential left that can undo the change.
 *
 * Both rules are enforced in the service, inside the transaction that writes them, so a client
 * cannot reach around the panel by calling the route directly.
 */

const ACTIVES = ['ALL', 'ACTIVE', 'DISABLED'] as const;

function page(req: Request): { limit: number; offset: number; page: number } {
  const pageNumber = optionalInt(req.query?.page, 'page', { min: 1 }) ?? 1;
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 100 }) ?? 25;
  return { limit, offset: (pageNumber - 1) * limit, page: pageNumber };
}

const operatorId = (req: Request): string => requireUuid(req.params.id, 'operatorId');

/** The roster, with the permissions each role actually carries beside it. */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset, page: pageNumber } = page(req);
  const result = await listOperators({
    search: optionalString(req.query?.search, 'search', 60),
    role: optionalEnum(req.query?.role, 'role', ADMIN_ROLES),
    active: optionalEnum(req.query?.active, 'active', ACTIVES) ?? 'ALL',
    limit,
    offset,
  });
  res.json({ ...result, page: pageNumber, limit });
});

/**
 * What each role means, read from the same table the guards use.
 *
 * A screen that hard-codes "finance can freeze accounts" drifts the moment the list changes, and
 * the operator reading it is the one who finds out.
 */
export const roles = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ roles: roleCatalogue() });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const username = requireString(req.body?.username, 'username', { max: 40 });
  const password = requireString(req.body?.password, 'password', { max: 200 });
  const role = requireEnum(req.body?.role, 'role', ADMIN_ROLES);
  const displayName = optionalString(req.body?.displayName, 'displayName', 60);

  const operator = await createOperator({ username, password, role, displayName, actorId: req.admin!.sub });
  res.status(201).json({ operator });
});

/** Rename an operator or move them between roles. A password is never in this route. */
export const update = asyncHandler(async (req: Request, res: Response) => {
  const role = req.body?.role === undefined ? undefined : requireEnum(req.body.role, 'role', ADMIN_ROLES);
  const displayName = req.body?.displayName === undefined ? undefined : optionalString(req.body.displayName, 'displayName', 60) ?? '';
  if (role === undefined && displayName === undefined) {
    throw ApiError.badRequest('Nothing to change', 'nothing_to_update');
  }
  const operator = await updateOperator(operatorId(req), { role, displayName, actorId: req.admin!.sub });
  res.json({ operator });
});

/**
 * The reason is validated by the service, not here: `reason_required` is the code the panel and
 * the audit log both key on, and a generic field error from a validator would hide it.
 */
export const disable = asyncHandler(async (req: Request, res: Response) => {
  const reason = optionalString(req.body?.reason, 'reason', 300);
  const operator = await setOperatorActive({ id: operatorId(req), active: false, reason, actorId: req.admin!.sub });
  res.json({ operator });
});

export const enable = asyncHandler(async (req: Request, res: Response) => {
  const reason = optionalString(req.body?.reason, 'reason', 300);
  const operator = await setOperatorActive({ id: operatorId(req), active: true, reason, actorId: req.admin!.sub });
  res.json({ operator });
});
