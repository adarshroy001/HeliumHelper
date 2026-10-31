import type { Actor } from './actor.js';

/** `<area>:<action>`, for example `campaigns:write`. */
export type Permission = `${string}:${string}`;

/** Injection token for the role-to-permissions table, so tests can replace it. */
export const ROLE_PERMISSIONS = Symbol('ROLE_PERMISSIONS');

export type RolePermissions = Readonly<Record<string, readonly Permission[]>>;

/**
 * The permissions each role of an acting user grants. Roles come from HeliumAdmin in the token's `act.roles`;
 * routes require permissions with `@RequirePermissions(...)`. A module adds its permissions here, with the
 * roles that grant them, when it adds routes. A caller with no user, or with unknown roles, has none.
 */
export const DEFAULT_ROLE_PERMISSIONS: RolePermissions = {
  // Messaging (docs/modules/messaging/api.md). HeliumAdmin sends `admin` for every admin until it has roles.
  admin: [
    'campaigns:read',
    'campaigns:write',
    'campaigns:send',
    'inbox:read',
    'inbox:send',
    'suppressions:write',
    'messaging:ops',
  ],
  marketing: [
    'campaigns:read',
    'campaigns:write',
    'campaigns:send',
    'inbox:read',
    'inbox:send',
    'suppressions:write',
  ],
  support: ['inbox:read', 'inbox:send', 'suppressions:write'],
  viewer: ['campaigns:read', 'inbox:read'],
};

export function permissionsOf(actor: Actor | undefined, table: RolePermissions): ReadonlySet<Permission> {
  return new Set((actor?.user?.roles ?? []).flatMap((role) => table[role] ?? []));
}
