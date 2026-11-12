import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { rewrapSecrets } from '../services/secretRewrap.js';
import { EncryptionService } from '../services/EncryptionService.js';
import { AAD, DOMAIN, deriveKey, envelopeKeyId, keyIdOf, open, seal } from '../utils/crypto-envelope.js';

/**
 * Rotating the data encryption key: rewrap-secrets re-encrypts every
 * stored secret from the old key to the new one, v2 values and v3 alike, leaves what is
 * already current, and reports what neither key opens. Rotating without it left every
 * credential unreadable.
 *
 * Everything runs in a transaction that is rolled back, as the schema owner the script
 * uses, so other test files never see these rows or wait on the locks for long.
 */
describe('rewrap-secrets', () => {
  let pool: Pool;
  let client: PoolClient;
  /**
   * A random secret whose key id is (or, with `same: false`, isn't) `other`'s. A key id is
   * one byte, so two random secrets share one a time in 256: then the old key's refusal
   * can't say "another data_encryption_key", and the first test failed so in full runs
   * ("encryption key mismatch"). The shared id is tested on its own, below.
   */
  const secretWithKeyIdOf = (other: string, same: boolean) => {
    for (;;) {
      const secret = randomBytes(32).toString('base64');
      if ((keyIdOf(secret) === keyIdOf(other)) === same) return secret;
    }
  };
  const oldSecret = randomBytes(32).toString('base64');
  const newSecret = secretWithKeyIdOf(oldSecret, false);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ids: Record<string, number> = {};

  const sealWith = (secret: string, domain: typeof DOMAIN.credential | typeof DOMAIN.onedrive, text: string, withKeyId: boolean) =>
    seal(deriveKey(secret, domain), Buffer.from(text), domain === DOMAIN.onedrive ? AAD.onedrive : AAD.credential, withKeyId ? keyIdOf(secret) : undefined).toString('base64');

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    const user = (await client.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`rewrap-${stamp}@test.local`])).rows[0].id;
    const org = (await client.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`Rewrap ${stamp}`])).rows[0].id;
    // A v2 SimpleFin URL (sealed before key ids), a v3 push subscription under the old key, OneDrive
    // tokens one of which is already under the new key, and one value of another key.
    ids.simplefin = (await client.query(
      `INSERT INTO organization_simplefin_connections (organization_id, access_url) VALUES ($1, $2) RETURNING id`,
      [org, sealWith(oldSecret, DOMAIN.credential, 'https://user:pw@bridge.example/simplefin', false)]
    )).rows[0].id;
    ids.push = (await client.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_encrypted) VALUES ($1, $2, $3) RETURNING id`,
      [user, `https://push.example/${stamp}`, sealWith(oldSecret, DOMAIN.credential, '{"p256dh":"k","auth":"a"}', true)]
    )).rows[0].id;
    ids.onedrive = (await client.query(
      `INSERT INTO onedrive_tokens (user_id, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [user, sealWith(oldSecret, DOMAIN.onedrive, 'access-token', true), sealWith(newSecret, DOMAIN.onedrive, 'refresh-token', true)]
    )).rows[0].id;
    ids.stray = (await client.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_encrypted) VALUES ($1, $2, $3) RETURNING id`,
      [user, `https://push.example/stray-${stamp}`, sealWith(randomBytes(32).toString('base64'), DOMAIN.credential, 'lost', true)]
    )).rows[0].id;
  });

  afterAll(async () => {
    await client?.query('ROLLBACK');
    client?.release();
    await pool?.end();
  });

  const value = async (table: string, column: string, id: number) =>
    (await client.query(`SELECT ${column} AS v FROM ${table} WHERE id = $1`, [id])).rows[0].v as string;

  it('re-encrypts what the old key sealed under the new one, as v3 with its key id', async () => {
    const results = await rewrapSecrets(client, oldSecret, newSecret);
    const byLabel = Object.fromEntries(results.map((r) => [r.label, r]));
    expect(byLabel['SimpleFin access URLs'].unreadable).not.toContain(ids.simplefin);
    expect(byLabel['Web Push subscription keys'].unreadable).toContain(ids.stray);
    expect(byLabel['Web Push subscription keys'].unreadable).not.toContain(ids.push);

    const newService = EncryptionService.withSecret(newSecret);
    const url = await value('organization_simplefin_connections', 'access_url', ids.simplefin);
    expect(await newService.decryptString(url)).toBe('https://user:pw@bridge.example/simplefin');
    expect(envelopeKeyId(Buffer.from(url, 'base64'))).toBe(keyIdOf(newSecret));
    expect(await newService.decryptString(await value('push_subscriptions', 'keys_encrypted', ids.push))).toBe('{"p256dh":"k","auth":"a"}');

    const access = Buffer.from(await value('onedrive_tokens', 'access_token', ids.onedrive), 'base64');
    expect(open(deriveKey(newSecret, DOMAIN.onedrive), access, AAD.onedrive).toString()).toBe('access-token');
    const refresh = Buffer.from(await value('onedrive_tokens', 'refresh_token', ids.onedrive), 'base64');
    expect(open(deriveKey(newSecret, DOMAIN.onedrive), refresh, AAD.onedrive).toString()).toBe('refresh-token');

    // The old key no longer opens them.
    await expect(EncryptionService.withSecret(oldSecret).decryptString(url)).rejects.toThrow(/another data_encryption_key/);
  });

  it('changes nothing when run again', async () => {
    const before = await value('organization_simplefin_connections', 'access_url', ids.simplefin);
    const results = await rewrapSecrets(client, oldSecret, newSecret);
    // Only this file's rows were under the old key, and they are all current now.
    expect(results.map((r) => r.rewrapped)).toEqual(results.map(() => 0));
    expect(await value('organization_simplefin_connections', 'access_url', ids.simplefin)).toBe(before);
    expect(results.find((r) => r.label === 'Web Push subscription keys')!.unreadable).toEqual(expect.arrayContaining([ids.stray]));
  });

  it("rewraps a value whose old key has the new key's id: the id is a hint, the tag decides", async () => {
    const twin = secretWithKeyIdOf(newSecret, true);
    const id = (await client.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_encrypted)
       SELECT user_id, $1, $2 FROM push_subscriptions WHERE id = $3 RETURNING id`,
      [`https://push.example/twin-${stamp}`, sealWith(twin, DOMAIN.credential, '{"twin":true}', true), ids.push]
    )).rows[0].id as number;
    const results = await rewrapSecrets(client, twin, newSecret);
    const push = results.find((r) => r.label === 'Web Push subscription keys')!;
    expect(push.unreadable).not.toContain(id);
    expect(push.rewrapped).toBe(1);
    const stored = await value('push_subscriptions', 'keys_encrypted', id);
    expect(await EncryptionService.withSecret(newSecret).decryptString(stored)).toBe('{"twin":true}');
    // Sealed afresh: the twin's tag no longer opens it.
    expect(() => open(deriveKey(twin, DOMAIN.credential), Buffer.from(stored, 'base64'), AAD.credential)).toThrow();
  });

  it('refuses the same key twice', async () => {
    await expect(rewrapSecrets(client, newSecret, newSecret)).rejects.toThrow('The old and the new key are the same.');
  });
});
