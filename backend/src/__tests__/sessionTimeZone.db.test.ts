import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';

// CURRENT_DATE, now()::date and date_trunc on a timestamptz follow the
// session's TimeZone, which defaults to the server's (initdb takes it from the
// TZ the server starts with). The pools pin every session to UTC, whatever
// the server, the database or PGOPTIONS say. PGOPTIONS stands in for a server
// default here: node-postgres sends it as the startup options when a pool sets
// none, so without the pin these sessions would run in Kiritimati.
describe('database sessions run UTC', () => {
  const originalOptions = process.env.PGOPTIONS;
  const pools: Pool[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    if (originalOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = originalOptions;
    vi.resetModules();
  });

  it('pins the app pool to UTC', async () => {
    process.env.PGOPTIONS = '-c TimeZone=Pacific/Kiritimati';
    vi.resetModules();
    const pool = (await import('../db.js')).default;
    pools.push(pool);
    const { rows } = await pool.query<{ zone: string }>('SELECT current_setting($1) AS zone', ['TimeZone']);
    expect(rows[0].zone).toBe('UTC');
  });

  it('ends a transaction left idle on an app connection', async () => {
    vi.resetModules();
    const pool = (await import('../db.js')).default;
    pools.push(pool);
    const { rows } = await pool.query<{ timeout: string }>('SELECT current_setting($1) AS timeout', ['idle_in_transaction_session_timeout']);
    expect(rows[0].timeout).toBe('5min');
  });

  // The guardrails and the name the backend's sessions carry.
  it('gives app connections a lock timeout and a name, and the pool its configured size', async () => {
    const original = { max: process.env.DB_POOL_MAX, lock: process.env.DB_LOCK_TIMEOUT_MS };
    try {
      process.env.DB_POOL_MAX = '7';
      delete process.env.DB_LOCK_TIMEOUT_MS;
      vi.resetModules();
      const pool = (await import('../db.js')).default;
      pools.push(pool);
      const { rows } = await pool.query<{ lock: string; name: string; statement: string }>(
        `SELECT current_setting('lock_timeout') AS lock, current_setting('application_name') AS name,
                current_setting('statement_timeout') AS statement`
      );
      expect(rows[0]).toEqual({ lock: '15s', name: 'nuggets-backend', statement: '30s' });
      expect(pool.options.max).toBe(7);

      // An invalid value is index.ts's startup check to report, with the rest; the pool
      // itself keeps the default meanwhile.
      process.env.DB_POOL_MAX = 'lots';
      vi.resetModules();
      const db = await import('../db.js');
      pools.push(db.default);
      expect(db.default.options.max).toBe(20);
      expect(() => db.poolSettings()).toThrow('DB_POOL_MAX must be a whole number from 1 to 1000, not "lots"');
    } finally {
      if (original.max === undefined) delete process.env.DB_POOL_MAX;
      else process.env.DB_POOL_MAX = original.max;
      if (original.lock !== undefined) process.env.DB_LOCK_TIMEOUT_MS = original.lock;
    }
  });

  it('names the migration pool’s connections', async () => {
    vi.resetModules();
    const { createMigrationPool } = await import('../db/migrationPool.js');
    const pool = createMigrationPool();
    pools.push(pool);
    const { rows } = await pool.query<{ name: string }>(`SELECT current_setting('application_name') AS name`);
    expect(rows[0].name).toBe('nuggets-migrate');
  });

  it('pins the migration pool to UTC', async () => {
    process.env.PGOPTIONS = '-c TimeZone=Pacific/Kiritimati';
    vi.resetModules();
    const { createMigrationPool } = await import('../db/migrationPool.js');
    const pool = createMigrationPool();
    pools.push(pool);
    const { rows } = await pool.query<{ zone: string }>('SELECT current_setting($1) AS zone', ['TimeZone']);
    expect(rows[0].zone).toBe('UTC');
  });

  // node-postgres reads only the ISO style.
  it('pins DateStyle to ISO, so dates and instants still parse', async () => {
    process.env.PGOPTIONS = '-c DateStyle=SQL,DMY';
    vi.resetModules();
    const pool = (await import('../db.js')).default;
    pools.push(pool);
    const { rows } = await pool.query<{ day: string; at: Date; input: string }>(
      `SELECT DATE '2026-12-31' AS day, TIMESTAMPTZ '2026-12-31 12:00:00+00' AS at, '01/02/2026'::date::text AS input`
    );
    expect(rows[0].day).toBe('2026-12-31');
    expect(rows[0].at?.toISOString()).toBe('2026-12-31T12:00:00.000Z');
    // The configured DMY order survived ISO and read this as Feb 1.
    expect(rows[0].input).toBe('2026-01-02');
  });

  // A date ± interval is a timestamp without a zone: a UTC wall clock in these sessions.
  it('reads a timestamp without a zone as UTC, whatever the process TZ', async () => {
    vi.resetModules();
    const pool = (await import('../db.js')).default;
    pools.push(pool);
    try {
      for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
        vi.stubEnv('TZ', zone);
        const { rows } = await pool.query<{ next: Date }>(`SELECT DATE '2026-12-31' + interval '1 day' AS next`);
        expect(rows[0].next.toISOString(), zone).toBe('2027-01-01T00:00:00.000Z');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the rest of PGOPTIONS', async () => {
    process.env.PGOPTIONS = '-c application_name=nuggets-tz-test';
    vi.resetModules();
    const pool = (await import('../db.js')).default;
    pools.push(pool);
    const { rows } = await pool.query<{ name: string }>('SELECT current_setting($1) AS name', ['application_name']);
    expect(rows[0].name).toBe('nuggets-tz-test');
  });
});
