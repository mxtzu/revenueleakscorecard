import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ADMIN_ROLES, PermissionError, WRITE_ROLES, assertCanWrite, canWrite, isAdmin, isMember } from '../permissions';
import { CRM_ROLES, type CrmRole } from '../types';

function actor(role: CrmRole, is_active = true) {
  return { role, is_active };
}

describe('role checks', () => {
  it('lets the four writing roles write', () => {
    for (const role of ['owner', 'admin', 'sales', 'account_manager'] as CrmRole[]) {
      expect(canWrite(actor(role))).toBe(true);
    }
  });

  it('does not let a viewer write', () => {
    expect(canWrite(actor('viewer'))).toBe(false);
    expect(isMember(actor('viewer'))).toBe(true); // a viewer still reads
  });

  it('treats a deactivated profile as no access at all', () => {
    // Mirrors crm_role_of(), which returns NULL when is_active is false —
    // revoking access is one column update, and it must hold in the UI too.
    expect(isMember(actor('owner', false))).toBe(false);
    expect(canWrite(actor('owner', false))).toBe(false);
    expect(isAdmin(actor('owner', false))).toBe(false);
  });

  it('treats a missing profile as no access', () => {
    for (const missing of [null, undefined]) {
      expect(isMember(missing)).toBe(false);
      expect(canWrite(missing)).toBe(false);
      expect(isAdmin(missing)).toBe(false);
    }
  });

  it('restricts admin to owner and admin', () => {
    expect(isAdmin(actor('owner'))).toBe(true);
    expect(isAdmin(actor('admin'))).toBe(true);
    for (const role of ['sales', 'account_manager', 'viewer'] as CrmRole[]) {
      expect(isAdmin(actor(role))).toBe(false);
    }
  });

  it('accounts for every role, so a new one is not silently granted write', () => {
    for (const role of CRM_ROLES) {
      expect(typeof canWrite(actor(role))).toBe('boolean');
    }
    expect(new Set([...WRITE_ROLES, 'viewer'])).toEqual(new Set(CRM_ROLES));
  });
});

describe('assertCanWrite', () => {
  it('passes silently for a writer', () => {
    expect(() => assertCanWrite(actor('sales'))).not.toThrow();
  });

  it('names the role in the message so the user knows why', () => {
    expect(() => assertCanWrite(actor('viewer'))).toThrow(PermissionError);
    expect(() => assertCanWrite(actor('viewer'))).toThrow(/viewer/);
    expect(() => assertCanWrite(actor('viewer'))).toThrow(/read-only/);
  });

  it('distinguishes a deactivated account from a read-only role', () => {
    expect(() => assertCanWrite(actor('sales', false))).toThrow(/not active/);
  });
});

/**
 * The TypeScript lists duplicate the SQL helpers. Duplication across two
 * languages drifts, and the drift is silent: the UI would keep showing a form
 * the database has started refusing, or hiding one it now allows. So the SQL is
 * the source of truth and this reads it.
 */
describe('the TypeScript roles match the SQL helpers', () => {
  // Comments are stripped first: crm_is_admin()'s own comment explains the
  // `NULL in (...)` trap, and a naive match reads that instead of the code.
  const migration = readFileSync('supabase/migrations/20260815_create_agency_crm.sql', 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

  function roleList(source: string, what: string): Set<string> {
    const match = source.match(/\(([^)]*)\)/);
    if (!match) throw new Error(`Could not read a role list out of ${what}`);
    return new Set(match[1].split(',').map((role) => role.trim().replace(/'/g, '')));
  }

  function rolesInHelper(name: string): Set<string> {
    const start = migration.indexOf(`create or replace function public.${name}()`);
    if (start < 0) throw new Error(`${name}() is not in the migration`);
    const body = migration.slice(start, migration.indexOf('$$;', start));
    return roleList(body.slice(body.indexOf(' in ')), `${name}()`);
  }

  it('crm_can_write() allows exactly WRITE_ROLES', () => {
    expect(rolesInHelper('crm_can_write')).toEqual(new Set(WRITE_ROLES));
  });

  it('crm_is_admin() allows exactly ADMIN_ROLES', () => {
    expect(rolesInHelper('crm_is_admin')).toEqual(new Set(ADMIN_ROLES));
  });

  it('the crm_role enum matches CRM_ROLES', () => {
    const start = migration.indexOf('create type crm_role as enum');
    expect(start).toBeGreaterThan(-1);
    expect(roleList(migration.slice(start), 'crm_role enum')).toEqual(new Set(CRM_ROLES));
  });
});
