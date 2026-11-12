import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { answerProblem, priceSyncRunResultResponseSchema } from '@nuggets/shared';
import { PRICE_WRITE_BATCH, PriceIngestService } from '../PriceIngestService.js';
import { PriceSyncService } from '../PriceSyncService.js';
import type { EodQuote, PriceProviderClient } from '../PriceProviderClient.js';
import { createTestTenant, type TestTenant } from '../../../test/testTenant.js';

/**
 * A price sync whose later batch fails with a database error, not a lock: the
 * batches before it are committed, and the run says how many closes they wrote, where it said
 * only "failed", with none counted. Here the write of the close of the security with the highest
 * id (alone in the second batch) fails as the database fails one (a close too large for its
 * column did, until v2.4.0 left those out).
 */
describe('a price sync that fails part way', () => {
  let tenant: TestTenant;
  let ids: number[];
  const DAY = '2026-03-03';
  let lastId = 0;
  const provider = {
    fetchEodCloses: async (tickers: string[]): Promise<EodQuote[]> =>
      tickers.map((ticker) => ({ ticker, date: DAY, close: 10, volume: null })),
  } as unknown as PriceProviderClient;

  beforeAll(async () => {
    tenant = await createTestTenant('Price sync failed batch');
    const rows = (
      await tenant.pool.query<{ id: number; ticker: string }>(
        `INSERT INTO securities (ticker, name)
         SELECT 'PFB' || lpad(n::text, 3, '0'), 'Failed batch ' || n FROM generate_series(1, $1) AS n
         RETURNING id, ticker`,
        [PRICE_WRITE_BATCH + 1]
      )
    ).rows.sort((a, b) => a.id - b.id);
    ids = rows.map((r) => r.id);
    lastId = rows[rows.length - 1]!.id;
    const ingest = PriceIngestService.prototype as unknown as { writeClose: (id: number, q: unknown) => Promise<void> };
    const writeClose = ingest.writeClose;
    vi.spyOn(ingest, 'writeClose').mockImplementation(async function (this: unknown, id: number, q: unknown) {
      if (id === lastId) throw Object.assign(new Error('numeric field overflow (1000000000000)'), { code: '22003' });
      return writeClose.call(this, id, q);
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant?.cleanup();
  });

  const pricedIds = async () =>
    (await tenant.pool.query<{ security_id: number }>('SELECT security_id FROM security_prices WHERE price_date = $1 ORDER BY 1', [DAY]))
      .rows.map((r) => r.security_id);

  it("records what the batches before the failure wrote, in the run's counts and message", async () => {
    const sync = new PriceSyncService(new PriceIngestService(provider));
    const answer = await sync.runForOrg(tenant.organizationId, { trigger: 'user', userId: tenant.userId });
    // The first batch is committed.
    expect(await pricedIds()).toEqual(ids.slice(0, PRICE_WRITE_BATCH));
    expect(answer).toMatchObject({ status: 'partial', tenants_synced: 0, prices_updated: PRICE_WRITE_BATCH, prices_failed: 1 });
    // What POST /organizations/:uuid/price-sync/run answers.
    expect(answerProblem(priceSyncRunResultResponseSchema, answer)).toBeNull();
    const run = (
      await tenant.pool.query<{ run_status: string; securities_total: number; prices_updated: number; prices_failed: number; error_message: string | null }>(
        'SELECT run_status, securities_total, prices_updated, prices_failed, error_message FROM organization_price_sync_runs WHERE id = $1',
        [answer.run_id]
      )
    ).rows[0];
    expect(run).toMatchObject({ run_status: 'partial', securities_total: PRICE_WRITE_BATCH + 1, prices_updated: PRICE_WRITE_BATCH, prices_failed: 1 });
    // Counts, never the database's text, a price or a security's name.
    expect(run?.error_message).toMatch(/price sync failed after saving 100 prices \(1 securities' prices were not saved\); the server log has the details/);
    expect(run?.error_message).not.toMatch(/numeric|overflow|PFB|1000000000000/);
  });
});
