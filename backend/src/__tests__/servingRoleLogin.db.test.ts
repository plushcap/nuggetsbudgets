import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client, Pool } from 'pg';
import { scramSha256Verifier, syncServingRoleLogin } from '../db/servingRoleLogin.js';

/**
 * The SCRAM-SHA-256 verifier migrate gives the serving role signs in with the
 * password it was made from, through the same client the app uses, and with no other.
 * On a role of its own, so the suites signed in as nuggets_app meanwhile aren't touched.
 * What is sent (no password, logging off): servingRoleLogin.test.ts.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('the serving-role login migrate sets', () => {
  let owner: Pool;
  const role = `nuggets_scram_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const password = `Serving role password ${Math.random().toString(36).slice(2)} with a ' quote`;

  const signIn = async (secret: string) => {
    const client = new Client({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || 'nuggets_db',
      user: role,
      password: secret,
    });
    await client.connect();
    try {
      return (await client.query<{ user: string }>('SELECT current_user AS user')).rows[0].user;
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    owner = new Pool({ connectionString, max: 2 });
    // NOLOGIN, as the migration that creates nuggets_app makes it. The name is letters,
    // digits and underscores only.
    await owner.query(`CREATE ROLE ${role} NOLOGIN`);
  });

  afterAll(async () => {
    await owner?.query(`DROP ROLE IF EXISTS ${role}`);
    await owner?.end();
  });

  it('signs in with the password, and refuses another', async () => {
    await syncServingRoleLogin(owner, password, role);

    expect(await signIn(password)).toBe(role);
    await expect(signIn(`${password}x`)).rejects.toMatchObject({ code: '28P01' });
    const { rows } = await owner.query<{ rolcanlogin: boolean }>('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [role]);
    expect(rows).toEqual([{ rolcanlogin: true }]);
  });

  it('stores the verifier sent, not a hash of it', async () => {
    const { rows } = await owner.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    // pg_authid is for superusers only; the sign-in above shows it either way.
    if (!rows[0]?.rolsuper) return;
    const stored = (await owner.query<{ rolpassword: string }>('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [role])).rows[0]
      .rolpassword;
    const salt = /^SCRAM-SHA-256\$4096:([^$]+)\$/.exec(stored)?.[1];
    expect(salt).toBeDefined();
    expect(stored).toBe(scramSha256Verifier(password, { salt: Buffer.from(salt!, 'base64') }));
  });

  it('changes the password when run again', async () => {
    const next = `${password} rotated`;
    await syncServingRoleLogin(owner, next, role);
    expect(await signIn(next)).toBe(role);
    await expect(signIn(password)).rejects.toMatchObject({ code: '28P01' });
  });
});
