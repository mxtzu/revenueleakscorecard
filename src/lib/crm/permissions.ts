/**
 * Role checks, mirroring the SQL helpers in the migration exactly.
 *
 * Row level security is the enforcement; this is presentation. Hiding a form a
 * user cannot submit is a courtesy, not a control — a viewer who hand-crafts
 * the request still gets refused by the database, which is where the guarantee
 * lives.
 *
 * The lists below duplicate `crm_can_write()` and `crm_is_admin()`. Duplication
 * across two languages drifts, so `permissions.test.ts` parses the migration and
 * fails if these stop matching the SQL.
 */

import type { CrmRole, Profile } from './types';

/** Mirrors `public.crm_can_write()`. */
export const WRITE_ROLES: readonly CrmRole[] = ['owner', 'admin', 'sales', 'account_manager'];

/** Mirrors `public.crm_is_admin()`. */
export const ADMIN_ROLES: readonly CrmRole[] = ['owner', 'admin'];

export type Actor = Pick<Profile, 'role' | 'is_active'> | null | undefined;

/**
 * A deactivated profile is not a member, matching `crm_role_of()`, which
 * returns NULL for `is_active = false`. Revoking access is one column update.
 */
export function isMember(actor: Actor): boolean {
  return Boolean(actor && actor.is_active);
}

export function canWrite(actor: Actor): boolean {
  return isMember(actor) && WRITE_ROLES.includes(actor!.role);
}

export function isAdmin(actor: Actor): boolean {
  return isMember(actor) && ADMIN_ROLES.includes(actor!.role);
}

/**
 * Raised when an action is attempted by someone whose role forbids it.
 *
 * Server actions catch this and redirect with a readable message, so a viewer
 * who submits a form anyway sees "your role is read-only" rather than a raw
 * Postgres RLS violation on an error page.
 */
export class PermissionError extends Error {
  constructor(message = 'Your role is read-only. Ask an admin for write access.') {
    super(message);
    this.name = 'PermissionError';
  }
}

export function assertCanWrite(actor: Actor): void {
  if (!isMember(actor)) {
    throw new PermissionError('Your account is not active in this CRM.');
  }
  if (!canWrite(actor)) {
    throw new PermissionError(
      `Your role (${actor!.role.replace(/_/g, ' ')}) is read-only. Ask an admin for write access.`
    );
  }
}
