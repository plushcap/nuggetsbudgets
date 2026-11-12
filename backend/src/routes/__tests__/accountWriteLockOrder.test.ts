import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DB_LOCK_TIMEOUT_MS = '8000';
  process.env.LOG_LEVEL ??= 'silent';
});

import pg, { type PoolClient } from 'pg';
import { withTenant } from '../../db/withTenant.js';
import { saveGeneralSettings } from '../../services/generalSettings.js';
import { updateAccount } from '../../services/accounts/AccountService.js';
import { AccountSyncer } from '../../services/import/AccountSyncer.js';
import { deleteConnection } from '../../services/OrganizationSimpleFinService.js';
import type { SimplefinAccountSet } from '../../services/import/types.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Writes of several accounts, and a time zone change, which takes the day-ranges lock alone and
 * then locks every account in id order:
 *
 * - making a lower-id account the envelope account cleared the old (higher-id) one's flag first,
 *   then waited behind the zone change, which waited for that row: updateAccount now takes the
 *   day-ranges lock shared first (tested below);
 * - a sync's connection health and a connection's delete wrote several accounts in the order they
 *   found them (the feed's, the statement's): each locks them in id order first. Here an account
 *   with a higher id is stored, and named in the feed, first, and a held lower one shows which the
 *   write took before it waited.
 */
describe('Writes of several accounts, and a time zone change', () => {
  let tenant: TestTenant;
  let n = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const waitersOf = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; status?: number }) => `${e.status ?? ''} ${e.code ?? ''}`.trim());
  /** Whether another session can lock account `id` at once. */
  const free = async (id: number) => {
    const client = await tenant.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [id]);
      return true;
    } catch {
      return false;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };
  /** Two accounts with `columns` (each a value per account): the higher id stored first. */
  const twoAccounts = async (columns: (which: 'high' | 'low') => Record<string, unknown>) => {
    const insert = async (which: 'high' | 'low', id: string | null) => {
      const cols = { name: `Lock order ${which} ${++n}`, account_type: 'checking', account_group: 'cash', type: 'Asset', ...columns(which) };
      const keys = Object.keys(cols);
      return one<{ id: number }>(
        `INSERT INTO accounts (${id === null ? '' : 'id, '}${keys.join(', ')}) VALUES (${id === null ? '' : `${id}, `}${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(cols)
      );
    };
    const { next } = await one<{ next: string }>(`SELECT nextval(pg_get_serial_sequence('accounts', 'id')) + 1000000 AS next`);
    const high = await insert('high', next);
    const low = await insert('low', null);
    expect(high.id).toBeGreaterThan(low.id);
    return { high: high.id, low: low.id };
  };
  /** `write` run while the lower account is held: it waits, and the higher one is free then (in id order) or not. */
  const takesInIdOrder = async (low: number, high: number, write: () => Promise<unknown>) => {
    const gate = await tenant.pool.connect();
    let writing: Promise<unknown> | undefined;
    let highFree: boolean;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [low]);
      const gatePid = await pidOf(gate);
      writing = write();
      writing.catch(() => undefined);
      await waitUntil(async () => (await waitersOf(gatePid)).length > 0);
      highFree = await free(high);
      await gate.query('COMMIT');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    await writing;
    return highFree;
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Account write lock order');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  // Before, the zone change answered 409 (a deadlock).
  it('making a lower-id account the envelope account while a zone change runs: both finish', async () => {
    const a = await one<{ id: number; uuid: string }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Lower', 'savings', 'cash', 'Asset') RETURNING id, uuid`);
    const b = await one<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type, is_envelope_account) VALUES ('Higher envelope', 'savings', 'cash', 'Asset', true) RETURNING id`);
    expect(a.id).toBeLessThan(b.id);
    const gate = await tenant.pool.connect();
    let changing: Promise<string> | undefined;
    let updating: Promise<string> | undefined;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [a.id]);
      const gatePid = await pidOf(gate);
      // The zone change reaches the accounts and waits for A.
      changing = outcome(withTenant(tenant.tenantId, () => saveGeneralSettings({ application_timezone: 'Pacific/Kiritimati' }, { application_timezone: null }, tenant.userId)));
      let changePid = 0;
      await waitUntil(async () => {
        [changePid = 0] = await waitersOf(gatePid);
        return changePid !== 0;
      });
      // The edit waits for the zone change before it clears B's flag.
      updating = outcome(withTenant(tenant.tenantId, () => updateAccount(a.uuid, { name: 'Lower', type: 'Asset', account_type: 'savings', account_group: 'cash', is_envelope_account: true }, undefined, tenant.userId)));
      await waitUntil(async () => (await waitersOf(changePid)).length > 0);
      await gate.query('COMMIT');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    expect({ zone: await changing, update: await updating }).toEqual({ zone: 'ok', update: 'ok' });
    expect((await tenant.pool.query('SELECT name FROM accounts WHERE is_envelope_account')).rows).toEqual([{ name: 'Lower' }]);
  }, 60_000);

  it("a sync's connection health locks the accounts it writes in id order", async () => {
    const { high, low } = await twoAccounts((which) => ({ import_provider: 'simplefin', import_account_id: `ACT-${which}-${n}` }));
    const ids = await tenant.pool.query<{ id: number; import_account_id: string }>('SELECT id, import_account_id FROM accounts WHERE id IN ($1, $2)', [high, low]);
    const feedId = (id: number) => ids.rows.find((r) => r.id === id)!.import_account_id;
    const accountSet = {
      accounts: [{ id: feedId(high) }, { id: feedId(low) }],
      errlist: [{ code: 'act.auth', account_id: feedId(high) }],
    } as unknown as SimplefinAccountSet;
    const syncer = new AccountSyncer(undefined as never, undefined as never);
    expect(await takesInIdOrder(low, high, () => withTenant(tenant.tenantId, () => syncer.persistConnectionHealth(accountSet)))).toBe(true);
    expect((await one<{ code: string | null }>('SELECT import_last_error_code AS code FROM accounts WHERE id = $1', [high])).code).toBe('act.auth');
  });

  it("a connection's delete locks the accounts it unlinks in id order", async () => {
    const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
    let connectionId: number;
    try {
      connectionId = (await owner.query<{ id: number }>(
        `INSERT INTO organization_simplefin_connections (organization_id, access_url, label) VALUES ($1, 'sealed', 'Lock order') RETURNING id`,
        [tenant.organizationId]
      )).rows[0]!.id;
    } finally {
      await owner.end();
    }
    const { high, low } = await twoAccounts((which) => ({ import_provider: 'simplefin', import_account_id: `CONN-${which}-${n}`, simplefin_connection_id: connectionId }));
    expect(await takesInIdOrder(low, high, () => deleteConnection(tenant.organizationId))).toBe(true);
    expect((await tenant.pool.query('SELECT 1 FROM accounts WHERE id IN ($1, $2) AND simplefin_connection_id IS NOT NULL', [high, low])).rowCount).toBe(0);
  });
});
