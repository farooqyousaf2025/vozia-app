import { PoolClient } from 'pg';
import { many, one, withTransaction } from '../config/db';
import { rateLimit } from '../config/redis';
import {
  ApiError,
  normalizePhone,
  requireEnum,
  requireInt,
  requireString,
  requireUuid,
} from '../utils/http';
import { nextCode, readConfig } from './business.service';
import { ensureOwnerAccount } from './purpose-account.service';
import { recordAudit } from './audit.service';
import { UserRow } from '../types/db';

/**
 * Become a Partner (§ the partner-application brief): four roles an account applies for and an
 * operator grants.
 *
 * The row in `role_applications` whose status is `APPROVED` *is* the grant — see the header of
 * migration 0035 for why the state lives there rather than in a fourth table — so every question
 * below is answered from that table: `hasActiveGrant`, `activeRolesFor`, and the create-room gate in
 * `room.service.ts`. Nothing reads `users.user_type` as proof of a privilege, because
 * `room.service.ts:515` has been writing 'HOST' to it for anyone who opened a room.
 *
 * Two rules the brief calls for and the code cannot relax:
 *   * the form is validated from the spec in this file, on the server, every time. The Android and
 *     panel clients render these same fields so a user is not told a required answer is missing after
 *     they typed it, but the client is not the check — an application that arrives with an
 *     unrecognised field is refused rather than stored, because a stored field is one a future
 *     approval might act on;
 *   * approving never invents a privilege the role does not have. A coin seller is not created
 *     without the BD account it reports to (`business.service.ts` refuses an unassigned seller for the
 *     money reason: it would accrue no BD commission and look like a zero-rate rule), and a second BD
 *     manager still needs `business.bd.multiManager` switched on first.
 */

export const PARTNER_ROLES = ['HOST', 'AGENCY', 'COIN_SELLER', 'BD_MANAGER'] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];

export const APPLICATION_STATUSES = [
  'PENDING',
  'INFO_REQUESTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'REVOKED',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** The statuses an operator may still decide. `APPROVED` is decided; it is revoked, not decided. */
const OPEN: ApplicationStatus[] = ['PENDING', 'INFO_REQUESTED'];

/** Bumped when a form's questions change, so an old row is read against the spec it was asked under. */
export const FORM_VERSION = 1;

/** Five per hour, per account: enough to fix a typo, not enough to bury a queue. */
const SUBMISSIONS_PER_HOUR = 5;

export type ApplicationFieldInput =
  | 'TEXT'
  | 'TEXTAREA'
  | 'NUMBER'
  | 'CHECKBOX'
  | 'COUNTRY'
  | 'PHONE'
  | 'EMAIL'
  | 'AGENCY';

export type ApplicationField = {
  key: string;
  label: string;
  input: ApplicationFieldInput;
  required: boolean;
  min?: number;
  max?: number;
  hint?: string;
};

export type ApplicationForm = {
  role: PartnerRole;
  title: string;
  blurb: string;
  /** What the role actually gets, written for the applicant rather than for the operator. */
  benefits: string[];
  fields: ApplicationField[];
};

const COUNTRY = /^[A-Z]{2}$/;
const EMAIL = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;

export const APPLICATION_FORMS: Record<PartnerRole, ApplicationForm> = {
  HOST: {
    role: 'HOST',
    title: 'Apply as Host',
    blurb: 'Host audio rooms, receive gifts and earn R-coins.',
    benefits: ['Host your own rooms', 'Receive gifts and earn', 'Join an agency roster'],
    fields: [
      { key: 'fullName', label: 'Full name', input: 'TEXT', required: true, max: 120 },
      { key: 'country', label: 'Country', input: 'COUNTRY', required: true, hint: 'Two-letter country code, e.g. US.' },
      { key: 'city', label: 'City', input: 'TEXT', required: true, max: 80 },
      {
        key: 'ageConfirmed',
        label: 'I confirm I am 18 or older',
        input: 'CHECKBOX',
        required: true,
        hint: 'Hosting is a paid role and is limited to adults.',
      },
      {
        key: 'experience',
        label: 'Hosting or moderation experience',
        input: 'TEXTAREA',
        required: false,
        min: 10,
        max: 2000,
      },
      {
        key: 'preferredAgencyId',
        label: 'Preferred agency',
        input: 'AGENCY',
        required: false,
        hint: 'Optional. An operator decides whether you join this roster.',
      },
    ],
  },
  AGENCY: {
    role: 'AGENCY',
    title: 'Apply as Agency',
    blurb: 'Recruit and manage hosts, and earn a share of what they receive.',
    benefits: ['Recruit hosts', 'A share of your roster’s gift earnings', 'Your own earnings desk'],
    fields: [
      { key: 'agencyName', label: 'Agency name', input: 'TEXT', required: true, max: 80 },
      { key: 'ownerFullName', label: 'Owner full name', input: 'TEXT', required: true, max: 120 },
      { key: 'country', label: 'Country', input: 'COUNTRY', required: true, hint: 'Two-letter country code, e.g. US.' },
      { key: 'city', label: 'City', input: 'TEXT', required: true, max: 80 },
      { key: 'teamSize', label: 'Team size', input: 'NUMBER', required: true, min: 1, max: 5000 },
      {
        key: 'recruitmentExperience',
        label: 'Recruitment experience',
        input: 'TEXTAREA',
        required: true,
        min: 20,
        max: 2000,
      },
    ],
  },
  COIN_SELLER: {
    role: 'COIN_SELLER',
    title: 'Apply as Coin Seller',
    blurb: 'Sell diamonds to customers through a partner account and a commission.',
    benefits: ['Sign in to the partner panel', 'Raise recharge orders', 'Earn seller commission'],
    fields: [
      { key: 'businessOrFullName', label: 'Business or full name', input: 'TEXT', required: true, max: 120 },
      { key: 'location', label: 'Location', input: 'TEXT', required: true, max: 120 },
      { key: 'contactPhone', label: 'Contact phone', input: 'PHONE', required: true },
      { key: 'contactEmail', label: 'Contact email', input: 'EMAIL', required: false },
      {
        key: 'expectedMonthlyVolume',
        label: 'Expected monthly volume (diamonds)',
        input: 'NUMBER',
        required: true,
        min: 0,
        max: 1_000_000_000,
      },
      {
        key: 'verificationDetails',
        label: 'Payment rails and verification details',
        input: 'TEXTAREA',
        required: true,
        min: 20,
        max: 2000,
        hint: 'How the platform can check that the money you claim arrived.',
      },
    ],
  },
  BD_MANAGER: {
    role: 'BD_MANAGER',
    title: 'Apply as BD Manager',
    blurb: 'Grow the business: recruit agencies and sellers inside your territory.',
    benefits: ['Sign in to the partner panel', 'Add BD agents in your territory', 'Read the seller reports'],
    fields: [
      { key: 'fullName', label: 'Full name', input: 'TEXT', required: true, max: 120 },
      { key: 'country', label: 'Country', input: 'COUNTRY', required: true, hint: 'Two-letter country code, e.g. US.' },
      { key: 'city', label: 'City', input: 'TEXT', required: true, max: 80 },
      { key: 'experience', label: 'Business development experience', input: 'TEXTAREA', required: true, min: 20, max: 2000 },
      { key: 'languages', label: 'Languages', input: 'TEXT', required: true, max: 120 },
      {
        key: 'recruitmentNetwork',
        label: 'Recruitment network',
        input: 'TEXTAREA',
        required: false,
        min: 10,
        max: 2000,
      },
      {
        key: 'coverageArea',
        label: 'Expected coverage area',
        input: 'TEXT',
        required: true,
        max: 160,
        hint: 'An operator assigns the territory when the application is approved.',
      },
    ],
  },
};

export type ApplicationGrant = {
  kind: 'HOST' | 'AGENCY' | 'BUSINESS_ACCOUNT' | null;
  id: string | null;
  label: string | null;
  status: string | null;
};

export type RoleApplicationDto = {
  id: string;
  role: PartnerRole;
  status: ApplicationStatus;
  formVersion: number;
  data: Record<string, unknown>;
  submittedAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  decisionNote: string | null;
  infoRequestNote: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  grant: ApplicationGrant;
  applicant?: {
    id: string;
    username: string;
    phone: string;
    countryCode: string | null;
    userType: string;
    status: string;
  };
};

type JoinedRow = {
  id: string;
  user_id: string;
  role: PartnerRole;
  status: ApplicationStatus;
  data: Record<string, unknown>;
  form_version: number;
  decision_note: string | null;
  info_request_note: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  reviewer_username: string | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoker_username: string | null;
  revoke_reason: string | null;
  agency_id: string | null;
  business_account_id: string | null;
  agency_name: string | null;
  agency_status: string | null;
  business_code: string | null;
  business_status: string | null;
  applicant_username?: string | null;
  applicant_phone?: string | null;
  applicant_country_code?: string | null;
  applicant_user_type?: string | null;
  applicant_status?: string | null;
  created_at: Date;
  updated_at: Date;
};

const JOIN = `
  SELECT r.*,
         u.username AS applicant_username, u.phone AS applicant_phone,
         u.country_code AS applicant_country_code, u.user_type AS applicant_user_type,
         u.status AS applicant_status,
         a.name AS agency_name, a.status AS agency_status,
         b.code AS business_code, b.status AS business_status,
         rv.username AS reviewer_username,
         rc.username AS revoker_username
    FROM role_applications r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN agencies a ON a.id = r.agency_id
    LEFT JOIN business_accounts b ON b.id = r.business_account_id
    LEFT JOIN admins rv ON rv.id = r.reviewed_by
    LEFT JOIN admins rc ON rc.id = r.revoked_by`;

function iso(value: Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function grantOf(row: JoinedRow): ApplicationGrant {
  if (row.agency_id) {
    return { kind: 'AGENCY', id: row.agency_id, label: row.agency_name, status: row.agency_status };
  }
  if (row.business_account_id) {
    return {
      kind: 'BUSINESS_ACCOUNT',
      id: row.business_account_id,
      label: row.business_code,
      status: row.business_status,
    };
  }
  // A host's grant is a marker on their own row rather than an object this approval created, and only
  // a decided row has one: an application that is still waiting has granted nothing.
  if (row.role === 'HOST' && (row.status === 'APPROVED' || row.status === 'REVOKED')) {
    return { kind: 'HOST', id: row.user_id, label: null, status: row.status };
  }
  return { kind: null, id: null, label: null, status: null };
}

function toDto(row: JoinedRow, withApplicant: boolean): RoleApplicationDto {
  const dto: RoleApplicationDto = {
    id: row.id,
    role: row.role,
    status: row.status,
    formVersion: row.form_version,
    data: row.data ?? {},
    submittedAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    reviewedAt: iso(row.reviewed_at),
    reviewedBy: row.reviewer_username,
    decisionNote: row.decision_note,
    infoRequestNote: row.info_request_note,
    revokedAt: iso(row.revoked_at),
    revokedBy: row.revoker_username,
    revokeReason: row.revoke_reason,
    grant: grantOf(row),
  };
  if (withApplicant) {
    dto.applicant = {
      id: row.user_id,
      username: row.applicant_username ?? '',
      phone: row.applicant_phone ?? '',
      countryCode: row.applicant_country_code ?? null,
      userType: row.applicant_user_type ?? 'USER',
      status: row.applicant_status ?? 'ACTIVE',
    };
  }
  return dto;
}

// ---------------------------------------------------------------------------
// the form spec, and the only place a submitted answer is given a shape
// ---------------------------------------------------------------------------

async function normaliseAnswer(
  client: PoolClient | null,
  field: ApplicationField,
  raw: unknown,
): Promise<unknown> {
  const absent = raw === undefined || raw === null || raw === '';
  if (absent) {
    if (field.required) throw ApiError.badRequest(`${field.label} is required`, 'field_required', { field: field.key });
    return undefined;
  }
  switch (field.input) {
    case 'TEXT':
      return requireString(raw, field.key, { min: 2, max: field.max ?? 120 });
    case 'TEXTAREA':
      return requireString(raw, field.key, { min: field.min ?? 10, max: field.max ?? 2000 });
    case 'NUMBER':
      return requireInt(raw, field.key, { min: field.min ?? 0, max: field.max });
    case 'CHECKBOX': {
      if (typeof raw !== 'boolean') throw ApiError.badRequest(`${field.label} must be a boolean`, 'field_type');
      if (field.required && !raw) {
        throw ApiError.badRequest(`${field.label} must be confirmed`, 'confirmation_required', { field: field.key });
      }
      return raw;
    }
    case 'COUNTRY': {
      const code = requireString(raw, field.key, { min: 2, max: 2 }).toUpperCase();
      if (!COUNTRY.test(code)) throw ApiError.badRequest(`${field.label} must be a two-letter country code`, 'invalid_country');
      return code;
    }
    case 'PHONE':
      return normalizePhone(raw, field.key);
    case 'EMAIL': {
      const text = requireString(raw, field.key, { min: 6, max: 120 });
      if (!EMAIL.test(text)) throw ApiError.badRequest(`${field.label} is not a valid email address`, 'invalid_email');
      return text.toLowerCase();
    }
    case 'AGENCY': {
      const id = requireUuid(raw, field.key);
      if (!client) throw ApiError.badRequest(`${field.label} cannot be checked here`, 'invalid_reference');
      const agency = await client.query<{ id: string }>(
        "SELECT id FROM agencies WHERE id = $1 AND status = 'ACTIVE'",
        [id],
      );
      if (!agency.rows[0]) {
        throw ApiError.badRequest('That agency is not recruiting', 'preferred_agency_not_found', { field: field.key });
      }
      return id;
    }
  }
}

/**
 * Validate a submission against the server's spec and return exactly the fields the spec names.
 *
 * An unrecognised key is refused rather than dropped: a stored field is one a future approval could
 * act on, and the only way to be sure nothing is stored that this file did not ask for is to say so.
 */
async function normaliseForm(role: PartnerRole, raw: unknown, client: PoolClient | null): Promise<Record<string, unknown>> {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw ApiError.badRequest('data must be an object of form answers');
  }
  const form = APPLICATION_FORMS[role];
  const supplied = raw as Record<string, unknown>;
  const known = new Set(form.fields.map((field) => field.key));
  for (const key of Object.keys(supplied)) {
    if (!known.has(key)) {
      throw ApiError.badRequest(`"${key}" is not a question on the ${role} form`, 'unexpected_field', { field: key });
    }
  }
  const data: Record<string, unknown> = {};
  for (const field of form.fields) {
    const value = await normaliseAnswer(client, field, supplied[field.key]);
    if (value !== undefined) data[field.key] = value;
  }
  return data;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function hasActiveGrant(userId: string, role: PartnerRole): Promise<boolean> {
  const row = await one<{ granted: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM role_applications WHERE user_id = $1 AND role = $2::partner_role AND status = 'APPROVED') AS granted",
    [userId, role],
  );
  return row?.granted === true;
}

export async function activeRolesFor(userId: string): Promise<PartnerRole[]> {
  const rows = await many<{ role: PartnerRole }>(
    "SELECT role FROM role_applications WHERE user_id = $1 AND status = 'APPROVED'",
    [userId],
  );
  return rows.map((row) => row.role);
}

/**
 * The four specs and the agency shortlist, for whoever has to read an answer back.
 *
 * An operator reviewing a HOST application is looking at `preferredAgencyId: 7f3c…` — a uuid the
 * applicant chose from a picker labelled with an agency name. Returning the spec from the same place
 * that validates the answers is what keeps the two vocabularies from drifting apart, which is the
 * reason this exists rather than a copy of the labels in the panel.
 */
export async function formSpecs(): Promise<{
  roles: ApplicationForm[];
  agencies: Array<{ id: string; name: string }>;
}> {
  const agencies = await many<{ id: string; name: string }>(
    "SELECT id, name FROM agencies WHERE status = 'ACTIVE' ORDER BY name LIMIT 200",
  );
  return { roles: PARTNER_ROLES.map((role) => APPLICATION_FORMS[role]), agencies };
}

/**
 * The picker's whole payload: what each role is, what it asks for, and where this account stands.
 *
 * The client renders this rather than keeping its own copy of the four forms, so a field added here
 * appears in the app without a release — and a required answer cannot be a different question on the
 * two sides of the wire.
 */
export async function roleCatalogue(userId: string): Promise<{
  roles: Array<ApplicationForm & { granted: boolean; openApplication: RoleApplicationDto | null }>;
  agencies: Array<{ id: string; name: string }>;
}> {
  const applications = await many<JoinedRow>(
    `${JOIN} WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
    [userId],
  );
  // The live index allows at most one open and one granted row per (account, role), so the first
  // match in submission order is the row that describes the role now.
  const liveFor = (role: PartnerRole) =>
    applications.find((row) => row.role === role && (OPEN.includes(row.status) || row.status === 'APPROVED'));
  const agencies = await many<{ id: string; name: string }>(
    "SELECT id, name FROM agencies WHERE status = 'ACTIVE' ORDER BY name LIMIT 50",
  );
  return {
    roles: PARTNER_ROLES.map((role) => {
      const live = liveFor(role);
      return {
        ...APPLICATION_FORMS[role],
        granted: live?.status === 'APPROVED',
        openApplication: live ? toDto(live, false) : null,
      };
    }),
    agencies,
  };
}

export async function myApplications(userId: string): Promise<{
  applications: RoleApplicationDto[];
  activeRoles: PartnerRole[];
}> {
  const rows = await many<JoinedRow>(`${JOIN} WHERE r.user_id = $1 ORDER BY r.created_at DESC`, [userId]);
  return { applications: rows.map((row) => toDto(row, false)), activeRoles: await activeRolesFor(userId) };
}

export async function listApplications(opts: {
  status?: ApplicationStatus;
  role?: PartnerRole;
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ applications: RoleApplicationDto[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (opts.status) where.push(`r.status = ${bind(opts.status)}`);
  if (opts.role) where.push(`r.role = ${bind(opts.role)}::partner_role`);
  if (opts.search) {
    // An operator searches for the account, not the answers: the queue is reached from a support
    // ticket, and a ticket names a username or the phone it was filed from.
    const term = bind(`%${opts.search}%`);
    where.push(`(u.username ILIKE ${term} OR u.phone ILIKE ${term})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await one<{ n: string }>(`SELECT COUNT(*) AS n FROM role_applications r JOIN users u ON u.id = r.user_id ${clause}`, params);
  const rows = await many<JoinedRow>(
    `${JOIN} ${clause} ORDER BY r.created_at DESC LIMIT ${bind(opts.limit)} OFFSET ${bind(opts.offset)}`,
    params,
  );
  return { applications: rows.map((row) => toDto(row, true)), total: Number(total?.n ?? 0) };
}

export async function findApplication(id: string): Promise<RoleApplicationDto | null> {
  const row = await one<JoinedRow>(`${JOIN} WHERE r.id = $1`, [id]);
  return row ? toDto(row, true) : null;
}

// ---------------------------------------------------------------------------
// the applicant's side
// ---------------------------------------------------------------------------

async function loadApplicant(userId: string): Promise<UserRow> {
  const user = await one<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) throw ApiError.notFound('Account not found', 'user_not_found');
  if (user.status !== 'ACTIVE') {
    throw ApiError.forbidden('A banned account cannot apply for a partner role', 'account_not_active');
  }
  return user;
}

export async function submitApplication(
  userId: string,
  roleRaw: unknown,
  rawData: unknown,
): Promise<RoleApplicationDto> {
  const role = requireEnum(roleRaw, 'role', PARTNER_ROLES);
  await loadApplicant(userId);

  const remaining = await rateLimit(`role-application:${userId}`, SUBMISSIONS_PER_HOUR, 3600);
  if (remaining === -1) {
    throw ApiError.tooManyRequests('Too many applications filed recently; try again later', 'application_rate_limited');
  }

  if (await hasActiveGrant(userId, role)) {
    throw ApiError.conflict(`This account already holds the ${role} role`, 'role_already_granted');
  }

  const row = await withTransaction(async (client) => {
    const data = await normaliseForm(role, rawData, client);
    const inserted = await (async () => {
      try {
        const result = await client.query<JoinedRow>(
          `INSERT INTO role_applications (user_id, role, status, data, form_version)
           VALUES ($1,$2,'PENDING',$3::jsonb,$4)
           RETURNING id, user_id, role, status, data, form_version, decision_note, info_request_note,
                     reviewed_at, reviewed_by, revoked_at, revoked_by, revoke_reason,
                     agency_id, business_account_id, created_at, updated_at`,
          [userId, role, JSON.stringify(data), FORM_VERSION],
        );
        return result.rows[0];
      } catch (err) {
        // The live index is the answer to two taps and to two devices; a replayed POST is the same
        // queue item, not a second chance at a decision.
        if ((err as { code?: string }).code === '23505') {
          throw ApiError.conflict('An application for this role is already on file', 'application_already_open');
        }
        throw err;
      }
    })();
    await recordAudit(
      {
        adminId: null,
        actorSystem: 'partner-application',
        action: 'ROLE_APPLICATION_SUBMIT',
        targetType: 'role_application',
        targetId: inserted.id,
        summary: `${role} application filed by account ${userId}`,
        details: { role, fields: Object.keys(inserted.data ?? {}) },
      },
      client,
    );
    return inserted;
  });

  return (await findApplication(row.id))!;
}

/** Answer an information request: the row goes back into the queue with the new answers merged in. */
export async function supplementApplication(
  userId: string,
  applicationId: string,
  rawData: unknown,
): Promise<RoleApplicationDto> {
  await loadApplicant(userId);
  const id = requireUuid(applicationId, 'applicationId');

  await withTransaction(async (client) => {
    const current = await lockApplication(client, id);
    if (current.user_id !== userId) throw ApiError.forbidden('This application belongs to another account', 'not_yours');
    if (current.status !== 'INFO_REQUESTED') {
      throw ApiError.conflict('Only an application waiting for information can be answered', 'not_waiting_for_information');
    }
    // The answers already on file are merged *before* validation, not after: an information request
    // asks for one thing, and an applicant who supplies it must not be refused because they did not
    // retype their full name. Re-normalising a stored value is a no-op for every input kind — the
    // shape that was written is the shape that is accepted again — and an unrecognised key still
    // lands in `unexpected_field`, because the merge cannot add a question the form does not ask.
    if (rawData === undefined || rawData === null || typeof rawData !== 'object' || Array.isArray(rawData)) {
      throw ApiError.badRequest('data must be an object of form answers');
    }
    const merged = await normaliseForm(
      current.role,
      { ...(current.data ?? {}), ...(rawData as Record<string, unknown>) },
      client,
    );
    // Back to PENDING means the operator's note is no longer the row's state, and `CANCELLED` and
    // `PENDING` may not name a reviewer (0035). The request itself stays in the audit trail.
    await client.query(
      `UPDATE role_applications
          SET status = 'PENDING', data = $2::jsonb, reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(merged)],
    );
    await recordAudit(
      {
        adminId: null,
        actorSystem: 'partner-application',
        action: 'ROLE_APPLICATION_SUPPLEMENT',
        targetType: 'role_application',
        targetId: id,
        summary: `${current.role} application answered with more information`,
        details: { role: current.role, fields: Object.keys(rawData as Record<string, unknown>) },
      },
      client,
    );
  });

  return (await findApplication(id))!;
}

/** Withdraw an application the applicant no longer wants judged. */
export async function cancelApplication(userId: string, applicationId: string): Promise<RoleApplicationDto> {
  await loadApplicant(userId);
  const id = requireUuid(applicationId, 'applicationId');

  await withTransaction(async (client) => {
    const current = await lockApplication(client, id);
    if (current.user_id !== userId) throw ApiError.forbidden('This application belongs to another account', 'not_yours');
    if (!OPEN.includes(current.status)) {
      throw ApiError.conflict('Only an open application can be withdrawn', 'application_not_open');
    }
    await client.query(
      `UPDATE role_applications
          SET status = 'CANCELLED', reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
        WHERE id = $1`,
      [id],
    );
    await recordAudit(
      {
        adminId: null,
        actorSystem: 'partner-application',
        action: 'ROLE_APPLICATION_CANCEL',
        targetType: 'role_application',
        targetId: id,
        summary: `${current.role} application withdrawn by its author`,
        details: { role: current.role, from: current.status },
      },
      client,
    );
  });

  return (await findApplication(id))!;
}

// ---------------------------------------------------------------------------
// the operator's side
// ---------------------------------------------------------------------------

type LockedRow = {
  id: string;
  user_id: string;
  role: PartnerRole;
  status: ApplicationStatus;
  data: Record<string, unknown>;
  agency_id: string | null;
  business_account_id: string | null;
};

/**
 * Read the row for update. Every decision and every revocation starts here, so two operators looking
 * at the same queue item decide once — the second transaction waits on this lock, re-reads the status
 * and finds the decision already made.
 */
async function lockApplication(client: PoolClient, id: string): Promise<LockedRow> {
  const result = await client.query<LockedRow>(
    `SELECT id, user_id, role, status, data, agency_id, business_account_id
       FROM role_applications WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw ApiError.notFound('Application not found', 'application_not_found');
  return row;
}

/**
 * Give the approved applicant the app-level marker their role implies.
 *
 * Raised, never lowered: 'HOST' has been written by `room.service.ts` for anyone who opened a room,
 * so an operator withdrawing a grant cannot conclude anything from that column about what it said
 * before. The authoritative state is the application row, which the gate and the API both read.
 */
async function raiseUserTypeMarker(client: PoolClient, userId: string, role: PartnerRole): Promise<void> {
  const marker = role === 'AGENCY' ? 'AGENCY_ADMIN' : 'HOST';
  await client.query("UPDATE users SET user_type = $2::user_type, updated_at = now() WHERE id = $1 AND user_type = 'USER'", [
    userId,
    marker,
  ]);
}

/**
 * Create whatever the approved role actually is, and return the grant pointers to store on the row.
 *
 * One agency row, one business account row, one host marker — and the purpose account for anything
 * that earns money, opened here rather than on its first accrual, so an operator who approves a
 * seller or an agency sees the account in `/accounts` immediately instead of after a customer pays.
 */
async function activateRole(
  client: PoolClient,
  row: LockedRow,
  adminId: string,
  opts: { bdAccountId?: string },
): Promise<{ agencyId: string | null; businessAccountId: string | null }> {
  const data = row.data ?? {};
  if (row.role === 'HOST') return { agencyId: null, businessAccountId: null };

  if (row.role === 'AGENCY') {
    const name = requireString(data.agencyName, 'agencyName', { max: 80 });
    const taken = await client.query<{ id: string }>('SELECT id FROM agencies WHERE name = $1', [name]);
    if (taken.rows[0]) {
      throw ApiError.conflict(`An agency called ${name} already exists`, 'agency_name_taken');
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO agencies (name, contact_phone, commission_bps, status, owner_user_id)
       VALUES ($1,$2,NULL,'ACTIVE',$3)
       RETURNING id`,
      [name, null, row.user_id],
    );
    const agencyId = inserted.rows[0].id;
    await ensureOwnerAccount(client, 'AGENCY', agencyId);
    return { agencyId, businessAccountId: null };
  }

  // COIN_SELLER and BD_MANAGER both become `business_accounts` rows, ACTIVE from the moment the
  // operator decides — but a seller with nobody above it accrues no BD commission, so the account it
  // reports to is part of the approval, not a detail to fix up later.
  const kind = row.role === 'COIN_SELLER' ? 'COIN_SELLER' : 'BD_MANAGER';
  let parentId: string | null = null;
  if (kind === 'COIN_SELLER') {
    if (!opts.bdAccountId) {
      throw ApiError.badRequest(
        'Approving a coin seller names the BD account it reports to',
        'seller_bd_required',
      );
    }
    const parent = await client.query<{ kind: string; status: string }>(
      'SELECT kind, status FROM business_accounts WHERE id = $1',
      [opts.bdAccountId],
    );
    const found = parent.rows[0];
    if (!found || found.kind === 'COIN_SELLER' || found.status === 'CLOSED') {
      throw ApiError.badRequest('That BD account cannot take a seller', 'invalid_parent');
    }
    parentId = opts.bdAccountId;
  } else {
    const bd = await readConfig('business.bd', { multiManager: false });
    if (!bd.multiManager) {
      const existing = await client.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM business_accounts WHERE kind = 'BD_MANAGER' AND status <> 'CLOSED'",
      );
      if (Number(existing.rows[0]?.n ?? 0) > 0) {
        throw ApiError.forbidden(
          'More than one BD manager is not enabled. Turn on business.bd -> multiManager first.',
          'multi_manager_disabled',
        );
      }
    }
  }

  const displayName = requireString(
    kind === 'COIN_SELLER' ? data.businessOrFullName : data.fullName,
    kind === 'COIN_SELLER' ? 'businessOrFullName' : 'fullName',
    { max: 80 },
  );
  const limits = await readConfig('partner.sellerLimits', {
    maxOrderDiamonds: 100_000,
    dailyDiamondLimit: 1_000_000,
    dailyOrderLimit: 200,
  });
  const code = await nextCode(kind);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO business_accounts
       (kind, code, display_name, contact_email, contact_phone, market_country, parent_id, status,
        max_order_diamonds, daily_diamond_limit, daily_order_limit, created_by, approved_by, approved_at)
     VALUES ($1::business_account_kind,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9,$10,$11,$11,now())
     RETURNING id`,
    [
      kind,
      code,
      displayName,
      kind === 'COIN_SELLER' ? (data.contactEmail as string) ?? null : null,
      kind === 'COIN_SELLER' ? (data.contactPhone as string) ?? null : null,
      typeof data.country === 'string' ? data.country : null,
      parentId,
      limits.maxOrderDiamonds,
      limits.dailyDiamondLimit,
      limits.dailyOrderLimit,
      adminId,
    ],
  );
  const businessAccountId = inserted.rows[0].id;
  await ensureOwnerAccount(client, kind as 'COIN_SELLER' | 'BD_MANAGER', businessAccountId);
  return { agencyId: null, businessAccountId };
}

export type ApplicationDecision = 'APPROVE' | 'REJECT' | 'REQUEST_INFO';

const APPLICATION_DECISIONS: ApplicationDecision[] = ['APPROVE', 'REJECT', 'REQUEST_INFO'];

export async function decideApplication(
  adminId: string,
  applicationId: string,
  decisionRaw: unknown,
  input: { note?: string; bdAccountId?: string },
): Promise<RoleApplicationDto> {
  const decision = requireEnum(decisionRaw, 'decision', APPLICATION_DECISIONS);
  const id = requireUuid(applicationId, 'applicationId');

  const decided = await withTransaction(async (client) => {
    const row = await lockApplication(client, id);
    if (!OPEN.includes(row.status)) {
      throw ApiError.conflict('This application has already been decided', 'application_already_decided');
    }

    if (decision === 'APPROVE') {
      const grant = await activateRole(client, row, adminId, { bdAccountId: input.bdAccountId });
      await client.query(
        `UPDATE role_applications
            SET status = 'APPROVED', decision_note = $2, reviewed_by = $3, reviewed_at = now(),
                agency_id = $4, business_account_id = $5, updated_at = now()
          WHERE id = $1`,
        [id, input.note ?? null, adminId, grant.agencyId, grant.businessAccountId],
      );
      await raiseUserTypeMarker(client, row.user_id, row.role);
      await recordAudit(
        {
          adminId,
          action: 'ROLE_APPLICATION_APPROVE',
          targetType: 'role_application',
          targetId: id,
          summary: `Approved ${row.role} for account ${row.user_id}`,
          details: {
            role: row.role,
            userId: row.user_id,
            note: input.note ?? null,
            agencyId: grant.agencyId,
            businessAccountId: grant.businessAccountId,
          },
        },
        client,
      );
      return row;
    }

    // Both of the refusals need their reason in the database, not in a note beside it: 0035 refuses a
    // `REJECTED` row that says nothing, so an operator cannot decide without saying why.
    const note = requireString(input.note, 'note', { min: 3, max: 500 });
    if (decision === 'REJECT') {
      await client.query(
        `UPDATE role_applications
            SET status = 'REJECTED', decision_note = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, note, adminId],
      );
    } else {
      await client.query(
        `UPDATE role_applications
            SET status = 'INFO_REQUESTED', info_request_note = $2, reviewed_by = $3, reviewed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [id, note, adminId],
      );
    }
    await recordAudit(
      {
        adminId,
        action: decision === 'REJECT' ? 'ROLE_APPLICATION_REJECT' : 'ROLE_APPLICATION_INFO_REQUEST',
        targetType: 'role_application',
        targetId: id,
        summary: `${decision === 'REJECT' ? 'Rejected' : 'Asked for more information on'} a ${row.role} application`,
        details: { role: row.role, userId: row.user_id, note },
      },
      client,
    );
    return row;
  });

  return (await findApplication(decided.id))!;
}

/**
 * Withdraw a grant. The application row becomes `REVOKED` and whatever it created is suspended, so
 * the role stops working in every path that already reads that table — an agency's commission stops
 * accruing where `agencies.status` is read, and a partner loses its panel login where
 * `business_accounts.status` is read (`requireBusiness` refuses anything but ACTIVE).
 */
export async function revokeApplication(adminId: string, applicationId: string, reason: unknown): Promise<RoleApplicationDto> {
  const id = requireUuid(applicationId, 'applicationId');
  const note = requireString(reason, 'reason', { min: 3, max: 500 });

  const revoked = await withTransaction(async (client) => {
    const row = await lockApplication(client, id);
    if (row.status === 'REVOKED') throw ApiError.conflict('This grant is already revoked', 'grant_already_revoked');
    if (row.status !== 'APPROVED') throw ApiError.conflict('Only a live grant can be revoked', 'not_a_live_grant');

    if (row.agency_id) {
      await client.query("UPDATE agencies SET status = 'SUSPENDED', updated_at = now() WHERE id = $1 AND status = 'ACTIVE'", [
        row.agency_id,
      ]);
    }
    if (row.business_account_id) {
      await client.query(
        "UPDATE business_accounts SET status = 'SUSPENDED', suspended_reason = $2, updated_at = now() WHERE id = $1 AND status = 'ACTIVE'",
        [row.business_account_id, note],
      );
    }
    await client.query(
      `UPDATE role_applications
          SET status = 'REVOKED', revoked_by = $2, revoked_at = now(), revoke_reason = $3, updated_at = now()
        WHERE id = $1`,
      [id, adminId, note],
    );
    await recordAudit(
      {
        adminId,
        action: 'ROLE_APPLICATION_REVOKE',
        targetType: 'role_application',
        targetId: id,
        summary: `Revoked the ${row.role} grant of account ${row.user_id} — ${note}`,
        details: {
          role: row.role,
          userId: row.user_id,
          reason: note,
          agencyId: row.agency_id,
          businessAccountId: row.business_account_id,
        },
      },
      client,
    );
    return row;
  });

  return (await findApplication(revoked.id))!;
}

/** The switch the create-room gate reads; see `room.service.ts`. */
export async function hostApplicationRequired(): Promise<boolean> {
  const config = await readConfig('roles.hostApplicationRequired', { enabled: false });
  return config.enabled === true;
}
