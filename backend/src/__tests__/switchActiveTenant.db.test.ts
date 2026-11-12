import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { sessionService } from '../middleware/auth.js';
import { switchActiveTenant } from '../services/MembershipService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * The ledger switcher's two writes, the session's active ledger and the user's last one, are
 * one transaction: they ran on globalDb one after the other, so the first was
 * committed while the second waited, and stayed when it failed. Each case holds one of the two
 * rows locked, waits until the switch is blocked on it, and checks that nothing of the switch
 * shows meanwhile; then lets it through, and both are written.
 */
describe('switching the active ledger', () => {
  let tenant: TestTenant;
  let tenantUuid: string;
  let sessionId: number;

  beforeAll(async () => {
    tenant = await createTestTenant('Switch active tenant');
    tenantUuid = (await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [tenant.tenantId])).rows[0]!.uuid;
    sessionId = (await sessionService.createSession({ userId: tenant.userId })).sessionId;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const written = async () => ({
    session: (await tenant.pool.query<{ id: number | null }>('SELECT active_tenant_id AS id FROM sessions WHERE id = $1', [sessionId])).rows[0]!.id,
    user: (await tenant.pool.query<{ id: number | null }>('SELECT last_tenant_id AS id FROM users WHERE id = $1', [tenant.userId])).rows[0]!.id,
  });

  /** Switch while `lockRow` holds a row the switch writes; what shows while it waits. */
  async function switchPast(lockRow: string, params: unknown[]) {
    await tenant.pool.query('UPDATE sessions SET active_tenant_id = NULL WHERE id = $1', [sessionId]);
    await tenant.pool.query('UPDATE users SET last_tenant_id = NULL WHERE id = $1', [tenant.userId]);
    const hold: PoolClient = await tenant.pool.connect();
    try {
      await hold.query('BEGIN');
      const pid = (await hold.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await hold.query(lockRow, params);
      const switching = switchActiveTenant(tenant.userId, sessionId, tenantUuid);
      const deadline = Date.now() + 5_000;
      while ((await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount === 0) {
        if (Date.now() > deadline) throw new Error('the switch never waited for the held row');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const meanwhile = await written();
      await hold.query('COMMIT');
      const answer = await switching;
      return { meanwhile, answer, after: await written() };
    } finally {
      await hold.query('ROLLBACK').catch(() => undefined);
      hold.release();
    }
  }

  it("shows neither write while the user's row is held, then makes both", async () => {
    const { meanwhile, answer, after } = await switchPast('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [tenant.userId]);
    expect(meanwhile).toEqual({ session: null, user: null });
    expect(answer.uuid).toBe(tenantUuid);
    expect(after).toEqual({ session: tenant.tenantId, user: tenant.tenantId });
  });

  it("shows neither write while the session's row is held, then makes both", async () => {
    const { meanwhile, after } = await switchPast('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    expect(meanwhile).toEqual({ session: null, user: null });
    expect(after).toEqual({ session: tenant.tenantId, user: tenant.tenantId });
  });
});
