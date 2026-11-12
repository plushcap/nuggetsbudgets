import { describe, it, expect } from 'vitest';
import { servingRolePassword } from '../db/servingRole.js';

/**
 * Which password the serving role connects with. No database: kept out of
 * servingRole.test.ts, which the migrations project runs (it changes roles), so CI's unit
 * step without a database still runs these.
 */

const secrets = { dbPassword: 'owner-password', appDbPassword: 'app-password' };
const noAppPassword = { ...secrets, appDbPassword: '' };

describe('servingRolePassword', () => {
  it("uses the serving role's own password when it is a separate role", () => {
    expect(servingRolePassword(secrets, { DB_USER: 'nuggets_app', MIGRATION_DB_USER: 'owner' })).toBe('app-password');
    expect(servingRolePassword(secrets, { DB_USER: 'nuggets_app' })).toBe('app-password');
  });

  it("uses the owner's password when the app serves as the migration role", () => {
    expect(servingRolePassword(noAppPassword, { DB_USER: 'owner' })).toBe('owner-password');
    // Even when app_db_password is mounted, as both shipped stacks do.
    expect(servingRolePassword(secrets, { DB_USER: 'owner', MIGRATION_DB_USER: 'owner' })).toBe('owner-password');
    expect(
      servingRolePassword(secrets, { DB_USER: 'owner', MIGRATION_DB_USER: 'owner', MIGRATION_DB_PASSWORD: 'migration-password' })
    ).toBe('migration-password');
    // migrationPool connects as DB_USER with MIGRATION_DB_PASSWORD when MIGRATION_DB_USER is unset.
    expect(servingRolePassword(noAppPassword, { DB_USER: 'owner', MIGRATION_DB_PASSWORD: 'migration-password' })).toBe(
      'migration-password'
    );
  });

  it("refuses to fall back to the owner's password for a separate serving role", () => {
    expect(() => servingRolePassword(noAppPassword, { DB_USER: 'nuggets_app', MIGRATION_DB_USER: 'owner' })).toThrow(
      /app_db_password/
    );
  });
});
