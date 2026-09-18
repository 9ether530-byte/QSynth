/**
 * Role/permission matrix. Deny-by-default in the strong sense: a route that does
 * not declare a permission is refused, not allowed (see router.ts). Adding a route
 * without thinking about authorization therefore fails closed and is caught by the
 * authz-matrix test, rather than shipping open.
 */
import { forbidden } from './errors.js';

export const PERMISSIONS = [
  'project:read',
  'project:write',
  'project:delete',
  'compile:run',
  'compile:read',
  'artifact:read',
  'member:read',
  'member:write',
  'apikey:read',
  'apikey:write',
  'audit:read',
  'org:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = 'owner' | 'admin' | 'developer' | 'viewer';

const VIEWER: Permission[] = ['project:read', 'compile:read', 'artifact:read', 'member:read'];
const DEVELOPER: Permission[] = [...VIEWER, 'project:write', 'compile:run'];
const ADMIN: Permission[] = [...DEVELOPER, 'project:delete', 'member:write', 'apikey:read', 'apikey:write', 'audit:read'];
const OWNER: Permission[] = [...ADMIN, 'org:write'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEWER,
  developer: DEVELOPER,
  admin: ADMIN,
  owner: OWNER,
};

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * An API key carries explicit scopes instead of a role. Its effective permissions
 * are the scopes themselves — a key can never exceed what was granted at creation,
 * regardless of the creating user's role, and is unaffected by later role changes.
 */
export function scopesHave(scopes: readonly string[], permission: Permission): boolean {
  return scopes.includes(permission);
}

export function assertPermission(
  principal: { kind: 'session'; role: Role } | { kind: 'api_key'; scopes: readonly string[] },
  permission: Permission,
): void {
  const ok =
    principal.kind === 'session'
      ? roleHas(principal.role, permission)
      : scopesHave(principal.scopes, permission);
  if (!ok) throw forbidden(permission);
}
