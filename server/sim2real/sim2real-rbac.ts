/**
 * Small policy layer shared by HTTP surfaces that can affect a robot or an
 * agent runtime.  Identity adapters remain responsible for authenticating a
 * principal; this module only interprets optional, already-verified role
 * claims.  Adapters that predate role claims continue to behave as the
 * original fully trusted workspace principal so an existing deployment does
 * not unexpectedly lose access when role claims are introduced. Explicit role
 * claims are always evaluated from the allow-list below.
 */

import type { Sim2RealPrincipal } from './sim2real-auth.js';

export const SIM2REAL_ROLES = Object.freeze([
  'admin',
  'owner',
  'operator',
  'editor',
  'viewer',
] as const);

export type Sim2RealRole = (typeof SIM2REAL_ROLES)[number];

export const SIM2REAL_PERMISSIONS = Object.freeze({
  read: 'sim2real:read',
  edit: 'sim2real:edit',
  operate: 'sim2real:operate',
  approve: 'sim2real:approve',
  agent: 'sim2real:agent',
  admin: 'sim2real:admin',
} as const);

export type Sim2RealPermission = (typeof SIM2REAL_PERMISSIONS)[keyof typeof SIM2REAL_PERMISSIONS];

const ROLE_PERMISSIONS: Record<Sim2RealRole, readonly Sim2RealPermission[]> = {
  admin: Object.values(SIM2REAL_PERMISSIONS),
  owner: [
    SIM2REAL_PERMISSIONS.read,
    SIM2REAL_PERMISSIONS.edit,
    SIM2REAL_PERMISSIONS.operate,
    SIM2REAL_PERMISSIONS.approve,
    SIM2REAL_PERMISSIONS.agent,
  ],
  // The legacy single-user adapter exposed the agent endpoint to its
  // operator principal. Keep that capability for an explicit operator role
  // too; viewers remain read-only through their own allow-list.
  operator: [SIM2REAL_PERMISSIONS.read, SIM2REAL_PERMISSIONS.operate, SIM2REAL_PERMISSIONS.agent],
  editor: [SIM2REAL_PERMISSIONS.read, SIM2REAL_PERMISSIONS.edit],
  viewer: [SIM2REAL_PERMISSIONS.read],
};

// Before role claims existed, an authenticated account could use the complete
// workspace API. Keep that wire-compatible behavior for principals whose
// adapter does not emit `roles`; principals that do emit roles use the explicit
// role map above.
const LEGACY_PERMISSIONS: readonly Sim2RealPermission[] = [
  SIM2REAL_PERMISSIONS.read,
  SIM2REAL_PERMISSIONS.edit,
  SIM2REAL_PERMISSIONS.operate,
  SIM2REAL_PERMISSIONS.agent,
];

function normalizedRoles(principal: Sim2RealPrincipal | null | undefined): Sim2RealRole[] {
  if (!principal || !Array.isArray(principal.roles)) return [];
  return [...new Set(principal.roles.map((role) => String(role).trim().toLowerCase()))].filter(
    (role): role is Sim2RealRole => (SIM2REAL_ROLES as readonly string[]).includes(role),
  );
}

/**
 * Return true when the verified principal has a permission.  An adapter with
 * no role claim is treated as the legacy fully trusted workspace principal;
 * once a deployment starts emitting roles, an explicit allow-list applies and
 * viewers become read-only automatically.
 */
export function principalCan(
  principal: Sim2RealPrincipal | null | undefined,
  permission: Sim2RealPermission,
): boolean {
  if (!principal?.accountId) return false;
  const roles = normalizedRoles(principal);
  // An omitted role claim means a legacy adapter and remains fully trusted
  // for backwards compatibility. An explicitly supplied but empty/unknown
  // claim must fail closed; otherwise a malformed role header/cookie could
  // accidentally fall through to the legacy grant.
  if (principal.roles === undefined) return LEGACY_PERMISSIONS.includes(permission);
  if (!roles.length) return false;
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}

export function principalRoles(principal: Sim2RealPrincipal | null | undefined): Sim2RealRole[] {
  const roles = normalizedRoles(principal);
  return principal?.roles === undefined ? ['operator'] : roles;
}
