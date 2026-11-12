import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Integration test — needs the CI Postgres. Skip cleanly when no DB is configured (local
// runs without secrets) instead of failing on a refused connection.
const hasDb = !!(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

// A regression test: before v3.0.0, one migration swapped
// several table uniques to include tenant_id, but some PL/pgSQL functions still
// referenced the old ON CONFLICT columns. Postgres validates an ON CONFLICT target
// against a matching unique constraint when the INSERT is planned — even for zero
// rows — so these raised "there is no unique or exclusion constraint matching the
// ON CONFLICT specification" at runtime (seen in CI logs, but latent: no DB-backed
// test exercised the path). Requires the CI Postgres test database (see net-worth
// test header for the env it reads).
describeDb('DB function ON CONFLICT targets (tenant uniques)', () => {
  // The function runs in a tenant context under RLS.
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('DB function ON CONFLICT');
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('aggregate_net_worth_snapshots plans its upsert against the tenant-scoped unique', async () => {
    // A far-past range matches no daily snapshots, so this inserts 0 rows — but the
    // INSERT ... ON CONFLICT is still planned, which is exactly what failed before the fix.
    const res = await tenant.pool.query(
      "SELECT aggregate_net_worth_snapshots('daily', 'weekly', '1990-01-01'::date, '1990-12-31'::date) AS n"
    );
    expect(Number(res.rows[0].n)).toBe(0);
  });
});
