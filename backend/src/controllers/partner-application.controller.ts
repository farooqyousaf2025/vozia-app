import { Request, Response } from 'express';
import { ApiError, asyncHandler, optionalEnum, optionalInt, optionalString, requireUuid } from '../utils/http';
import { pushToUser } from '../services/push.service';
import { emitToUser } from '../services/socket.service';
import {
  APPLICATION_FORMS,
  APPLICATION_STATUSES,
  ApplicationDecision,
  PARTNER_ROLES,
  RoleApplicationDto,
  cancelApplication,
  decideApplication,
  findApplication,
  formSpecs,
  listApplications,
  myApplications,
  revokeApplication,
  roleCatalogue,
  supplementApplication,
  submitApplication,
} from '../services/partner-application.service';

/**
 * Become a Partner: `/api/role-applications` for the account that asks, and
 * `/api/admin/partner-applications` for the operator who decides.
 *
 * Two things this file is responsible for, and neither belongs in the service.
 *
 * The applicant's id is never read from the body. `req.user.sub` — set by `requireAuth` from a token
 * we signed — is the only source of "who is applying", so an account cannot file an application on
 * behalf of another one, and cannot ask for the queue of someone else's.
 *
 * The notification lives here rather than inside `decideApplication`, for the same reason the
 * withdrawal decision does (admin.controller.ts): a push is not part of the grant. If FCM is down,
 * the role is still approved, and a failed delivery must not roll back — or replay — a decision that
 * already opened an agency or a partner account.
 */

/** Which notification each ending sends, written from the applicant's point of view. */
const NOTIFICATIONS: Record<string, { title: (role: string) => string; body: (role: string) => string }> = {
  APPROVED: {
    title: () => 'Application approved',
    body: (role) => `You are now a ${LABELS[role]}. The role is active on this account.`,
  },
  REJECTED: {
    title: () => 'Application declined',
    body: (role) => `Your ${LABELS[role]} application was not approved. Open My Applications to read why.`,
  },
  INFO_REQUESTED: {
    title: () => 'More information needed',
    body: (role) => `An operator has a question about your ${LABELS[role]} application.`,
  },
  REVOKED: {
    title: () => 'Role revoked',
    body: (role) => `Your ${LABELS[role]} role has been revoked. Open My Applications to read why.`,
  },
};

const LABELS: Record<string, string> = {
  HOST: 'Host',
  AGENCY: 'Agency',
  COIN_SELLER: 'Coin Seller',
  BD_MANAGER: 'BD Manager',
};

function tell(dto: RoleApplicationDto, outcome: keyof typeof NOTIFICATIONS): void {
  const userId = dto.applicant?.id;
  if (!userId) return;
  const copy = NOTIFICATIONS[outcome];
  emitToUser(userId, 'roleApplication:update', { id: dto.id, role: dto.role, status: dto.status });
  void pushToUser(userId, {
    title: copy.title(dto.role),
    body: dto.status === 'REJECTED' || dto.status === 'REVOKED'
      ? `${copy.body(dto.role)} ${dto.decisionNote ?? dto.revokeReason ?? ''}`.trim()
      : copy.body(dto.role),
    data: { type: 'role_application', id: dto.id, role: dto.role, status: dto.status },
  });
}

const upper = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.toUpperCase() : undefined;

const queryPage = (
  req: Request,
): { page: number; limit: number; offset: number } => {
  const page = optionalInt(req.query?.page, 'page', { min: 1, max: 100_000 }) ?? 1;
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 100 }) ?? 25;
  return { page, limit, offset: (page - 1) * limit };
};

// ---------------------------------------------------------------------------
// the applicant's side
// ---------------------------------------------------------------------------

/** The picker: all four forms, this account's standing in each, and the agency shortlist. */
export const roles = asyncHandler(async (req: Request, res: Response) => {
  res.json(await roleCatalogue(req.user!.sub));
});

/**
 * Just the form spec, for a client that already knows which role it is rendering.
 *
 * Signed-in, like the rest of this router: `GET /roles` already gives any applicant the same specs
 * with their own status attached, so a public copy of the questions would buy a stranger nothing and
 * cost the platform a second place to decide what an application asks.
 */
export const form = asyncHandler(async (req: Request, res: Response) => {
  const role = optionalString(req.params.role, 'role', 20)?.toUpperCase();
  const spec = role && (PARTNER_ROLES as readonly string[]).includes(role)
    ? APPLICATION_FORMS[role as keyof typeof APPLICATION_FORMS]
    : undefined;
  if (!spec) throw ApiError.notFound('No such partner role', 'unknown_role');
  res.json(spec);
});

export const mine = asyncHandler(async (req: Request, res: Response) => {
  res.json(await myApplications(req.user!.sub));
});

/** 201: a queue row now exists and an operator owes it a decision. */
export const apply = asyncHandler(async (req: Request, res: Response) => {
  const application = await submitApplication(req.user!.sub, req.body?.role, req.body?.data);
  res.status(201).json({ application });
});

/** Answers to a request for more information. Only the missing fields need to be sent again. */
export const supplement = asyncHandler(async (req: Request, res: Response) => {
  const id = requireUuid(req.params.id, 'applicationId');
  const application = await supplementApplication(req.user!.sub, id, req.body?.data);
  res.json({ application });
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const id = requireUuid(req.params.id, 'applicationId');
  const application = await cancelApplication(req.user!.sub, id);
  res.json({ application });
});

// ---------------------------------------------------------------------------
// the operator's side
// ---------------------------------------------------------------------------

/** The four specs plus the agency names, so the panel reads answers with the applicant's labels. */
export const specs = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await formSpecs());
});

export const queue = asyncHandler(async (req: Request, res: Response) => {
  const page = queryPage(req);
  const result = await listApplications({
    // Filters arrive from a panel dropdown, so the case is whatever the URL had.
    status: optionalEnum(upper(req.query?.status), 'status', APPLICATION_STATUSES),
    role: optionalEnum(upper(req.query?.role), 'role', PARTNER_ROLES),
    search: optionalString(req.query?.search, 'search', 60),
    ...page,
  });
  res.json({ ...result, page: page.page, limit: page.limit });
});

export const detail = asyncHandler(async (req: Request, res: Response) => {
  const application = await findApplication(requireUuid(req.params.id, 'applicationId'));
  if (!application) throw ApiError.notFound('Application not found', 'application_not_found');
  res.json({ application });
});

/**
 * The three decisions share one handler because they share one guard and one notification path.
 *
 * `bdAccountId` is only read by the coin-seller branch of the service, and only because a seller with
 * no BD above it is a money bug rather than a form field — see `business.service.ts`.
 */
async function decide(req: Request, res: Response, decision: ApplicationDecision): Promise<void> {
  const application = await decideApplication(req.admin!.sub, req.params.id, decision, {
    note: optionalString(req.body?.note, 'note', 500),
    bdAccountId: optionalString(req.body?.bdAccountId, 'bdAccountId', 36),
  });
  tell(application, decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'INFO_REQUESTED');
  res.json({ application });
}

export const approve = asyncHandler(async (req: Request, res: Response) => decide(req, res, 'APPROVE'));
export const reject = asyncHandler(async (req: Request, res: Response) => decide(req, res, 'REJECT'));
export const requestInfo = asyncHandler(async (req: Request, res: Response) => decide(req, res, 'REQUEST_INFO'));

/** Pull a role back after it was granted. The applicant created nothing themselves, so say why. */
export const revoke = asyncHandler(async (req: Request, res: Response) => {
  const application = await revokeApplication(req.admin!.sub, req.params.id, req.body?.reason);
  tell(application, 'REVOKED');
  res.json({ application });
});
