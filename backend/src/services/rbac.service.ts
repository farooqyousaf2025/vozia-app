import { BusinessAccountKind } from '../types/db';

/**
 * Programme §23: authorization is a list of permissions, not a role name.
 *
 * Two things follow from that, and both matter here.
 *
 * First, the panel routes no longer trust the `role` claim inside the JWT. The token is
 * signed by us, so it is authentic, but it lives for twelve hours — an operator demoted at
 * 09:00 would keep super powers until 21:00. `requirePermission` therefore re-reads the
 * operator row for every mutation.
 *
 * Second, BD representatives and coin sellers are not administrators. They authenticate
 * through their own scope and reach a hand-written set of own-scope routes, so a forgotten
 * permission check on `/admin/*` can never be reached with a seller credential.
 */

export const PERMISSIONS = [
  'dashboard:read',
  'user:read',
  'user:moderate',
  'user:wallet',
  'user:vip',
  'room:read',
  'room:moderate',
  'gift:manage',
  // Uploading the art a gift, effect or badge points at. Separate from `gift:manage` on
  // purpose: whoever maintains room effects and rank badges should not thereby gain the
  // right to set what a gift costs.
  'media:manage',
  'withdrawal:review',
  'game:read',
  'game:manage',
  'game:dispute',
  'audit:read',
  // §23's partner-side roles. Creating a coin seller is an operations decision; deciding
  // whether money actually arrived, and what is owed for it, is a finance one.
  'business:manage',
  'recharge:review',
  'commission:manage',
  'finance:read',
  // The switches that change money itself: the commission order and ceiling, the recharge
  // window, whether a webhook may credit without a human. One role holds them.
  'config:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ADMIN_ROLES = ['SUPER_ADMIN', 'FINANCE_ADMIN', 'OPERATIONS_ADMIN', 'MODERATOR'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/**
 * `SUPER_ADMIN` is the only role with everything, and no role is allowed to approve its own
 * disputed transaction — that is why `withdrawal:review` and `game:dispute` sit with finance
 * rather than with whoever filed them.
 */
const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  FINANCE_ADMIN: [
    'dashboard:read',
    'user:read',
    'user:wallet',
    'gift:manage',
    'media:manage',
    'withdrawal:review',
    'game:read',
    'game:dispute',
    'audit:read',
    'recharge:review',
    'commission:manage',
    'finance:read',
  ],
  OPERATIONS_ADMIN: [
    'dashboard:read',
    'user:read',
    'user:moderate',
    'user:vip',
    'room:read',
    'room:moderate',
    'game:read',
    'game:manage',
    'gift:manage',
    'media:manage',
    'business:manage',
    'finance:read',
  ],
  // Legacy rows seeded before this split existed: read-only plus the moderation tools that
  // need no financial judgement.
  MODERATOR: ['dashboard:read', 'user:read', 'room:read', 'room:moderate', 'game:read'],
};

/** Roles written before the vocabulary existed, and the value they map to. */
const LEGACY_ROLES: Record<string, AdminRole> = { SUPER: 'SUPER_ADMIN', ADMIN: 'SUPER_ADMIN' };

export function normalizeAdminRole(role: string): AdminRole {
  const mapped = LEGACY_ROLES[role] ?? role;
  return (ADMIN_ROLES as readonly string[]).includes(mapped) ? (mapped as AdminRole) : 'MODERATOR';
}

export function adminPermissions(role: string): readonly Permission[] {
  return ROLE_PERMISSIONS[normalizeAdminRole(role)];
}

export function adminHasPermission(role: string, permission: Permission): boolean {
  return adminPermissions(role).includes(permission);
}

export const BUSINESS_PERMISSIONS = [
  'recharge:create',
  'recharge:read',
  'customer:lookup',
  'statement:read',
  'seller:read',
  'report:read',
  'bd:manage',
] as const;

export type BusinessPermission = (typeof BUSINESS_PERMISSIONS)[number];

export const BUSINESS_KIND_PERMISSIONS: Record<BusinessAccountKind, readonly BusinessPermission[]> = {
  // A seller sees its own orders and its own statement, and may look up a recharge it is
  // asked about — never another seller's book, and never a balance to edit.
  COIN_SELLER: ['recharge:create', 'recharge:read', 'customer:lookup', 'statement:read'],
  // A BD agent reads the sellers assigned to it.
  BD_AGENT: ['recharge:read', 'statement:read', 'seller:read', 'report:read'],
  // A BD manager adds agents inside its own territory; whether more than one manager may
  // exist at all is the `business.bd` switch in system_config.
  BD_MANAGER: ['recharge:read', 'statement:read', 'seller:read', 'report:read', 'bd:manage'],
};

export function businessHasPermission(kind: BusinessAccountKind, permission: BusinessPermission): boolean {
  return BUSINESS_KIND_PERMISSIONS[kind].includes(permission);
}
