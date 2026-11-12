import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A short wait, so a held security times its batch out quickly.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '300';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

import type { PoolClient } from 'pg';
import { PRICE_WRITE_BATCH, PriceIngestService } from '../PriceIngestService.js';
import { PriceSyncService } from '../PriceSyncService.js';
import type { EodQuote, PriceProviderClient } from '../PriceProviderClient.js';
import { createTestTenant, type TestTenant } from '../../../test/testTenant.js';

/**
 * A price sync writes its closes PRICE_WRITE_BATCH securities per transaction, each batch's
 * securities locked first. A batch that can't lock them within the pool's lock_timeout (a
 * delete holding one, say) is skipped whole: its securities count as failed and busy, the
 * other batches are written, and the organization's run is partial and says why (the
 * path had no test before).
 */
describe('a price sync that finds a batch of securities busy', () => {
  let tenant: TestTenant;
  let ids: number[];
  const DAY = '2026-03-02';
  // A close for every ticker asked for.
  const provider = {
    fetchEodCloses: async (tickers: string[]): Promise<EodQuote[]> => tickers.map((ticker) => ({ ticker, date: DAY, close: 10, volume: null })),
  } as unknown as PriceProviderClient;

  beforeAll(async () => {
    tenant = await createTestTenant('Price sync skipped batch');
    // One more than a batch: the first batch is the 100 lowest ids, the second the last one.
    const count = PRICE_WRITE_BATCH + 1;
    ids = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO securities (ticker, name)
         SELECT 'PSB' || lpad(n::text, 3, '0'), 'Skipped batch ' || n FROM generate_series(1, $1) AS n
         RETURNING id`,
        [count]
      )
    ).rows.map((r) => r.id).sort((a, b) => a - b);
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  /** `work` while a third connection holds the security with the highest id FOR UPDATE (as a delete would). */
  const whileLastHeld = async <T>(work: () => Promise<T>): Promise<T> => {
    const gate: PoolClient = await tenant.pool.connect();
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT 1 FROM securities WHERE id = $1 FOR UPDATE', [ids[ids.length - 1]]);
      return await work();
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
  };
  const pricedIds = async () =>
    (await tenant.pool.query<{ security_id: number }>('SELECT security_id FROM security_prices WHERE price_date = $1 ORDER BY 1', [DAY]))
      .rows.map((r) => r.security_id);

  it('writes the batches it can lock and counts the one it skipped as busy and failed', async () => {
    const result = await whileLastHeld(() => new PriceIngestService(provider).updateMarketPrices(tenant.tenantId));
    expect(result).toEqual({ total: PRICE_WRITE_BATCH + 1, updated: PRICE_WRITE_BATCH, failed: 1, busy: 1 });
    // The first batch, and nothing of the held one.
    expect(await pricedIds()).toEqual(ids.slice(0, PRICE_WRITE_BATCH));

    // The next run, with nothing held, writes it.
    expect(await new PriceIngestService(provider).updateMarketPrices(tenant.tenantId)).toMatchObject({ failed: 0, busy: 0 });
    expect(await pricedIds()).toEqual(ids);
  });

  it("makes the organization's run partial, and says the ledger's prices weren't all saved", async () => {
    await tenant.pool.query('DELETE FROM security_prices WHERE price_date = $1', [DAY]);
    const sync = new PriceSyncService(new PriceIngestService(provider));
    const answer = await whileLastHeld(() => sync.runForOrg(tenant.organizationId, { trigger: 'user', userId: tenant.userId }));
    expect(answer).toMatchObject({ status: 'partial', tenants_synced: 1, prices_updated: PRICE_WRITE_BATCH, prices_failed: 1 });
    const run = (
      await tenant.pool.query<{ run_status: string; prices_updated: number; prices_failed: number; error_message: string | null }>(
        'SELECT run_status, prices_updated, prices_failed, error_message FROM organization_price_sync_runs WHERE id = $1',
        [answer.run_id]
      )
    ).rows[0];
    expect(run).toMatchObject({ run_status: 'partial', prices_updated: PRICE_WRITE_BATCH, prices_failed: 1 });
    expect(run?.error_message).toMatch(/1 securities' prices were not saved, because another change to them was being saved at the same time/);
  });
});
