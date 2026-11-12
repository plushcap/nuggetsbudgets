import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PriceIngestService } from '../PriceIngestService.js';
import type { EodQuote, PriceProviderClient } from '../PriceProviderClient.js';
import { createTestTenant, type TestTenant } from '../../../test/testTenant.js';

/**
 * A provider's close its column can't hold. security_prices.close is NUMERIC(12,4): a close
 * of a trillion failed its batch's insert, which stopped the ledger's price sync there, every run,
 * the other securities of the batch and those after it unpriced. Such a close, one that rounds to
 * nothing at 4 places, and one on a day that isn't a date, is left out (its security counts as
 * failed); a volume that isn't a whole number is written as none, its close kept.
 */
describe('a price sync given a close its column cannot hold', () => {
  let tenant: TestTenant;
  const DAY = '2026-03-04';
  let tickers: Record<'huge' | 'fine' | 'badDay' | 'oddVolume' | 'tiny' | 'tinier', string>;
  const provider = {
    fetchEodCloses: async (): Promise<EodQuote[]> => [
      { ticker: tickers.huge, date: DAY, close: 1e12, volume: 10 },
      // Rounded to 4 places, these were written as 0.0000.
      { ticker: tickers.tiny, date: DAY, close: 0.00004, volume: 10 },
      { ticker: tickers.tinier, date: DAY, close: 1e-7, volume: 10 },
      { ticker: tickers.fine, date: DAY, close: 12.34567, volume: 100 },
      { ticker: tickers.badDay, date: '2026-02-30', close: 5, volume: null },
      { ticker: tickers.oddVolume, date: DAY, close: 7.5, volume: 1234.5 },
    ],
  } as unknown as PriceProviderClient;

  beforeAll(async () => {
    tenant = await createTestTenant('Price sync unstorable close');
    const suffix = `${Date.now() % 100000}`;
    tickers = { huge: `HUGE${suffix}`, fine: `FINE${suffix}`, badDay: `BADD${suffix}`, oddVolume: `ODDV${suffix}`, tiny: `TINY${suffix}`, tinier: `TINR${suffix}` };
    for (const ticker of Object.values(tickers)) {
      await tenant.pool.query(`INSERT INTO securities (ticker, name) VALUES ($1, $1)`, [ticker]);
    }
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('writes the closes it can and counts the others failed', async () => {
    const result = await new PriceIngestService(provider).updateMarketPrices(tenant.tenantId);
    expect(result).toEqual({ total: 6, updated: 2, failed: 4, busy: 0 });
    const rows = (
      await tenant.pool.query<{ ticker: string; close: string; volume: string | null }>(
        `SELECT s.ticker, sp.close::text, sp.volume::text FROM security_prices sp JOIN securities s ON s.id = sp.security_id ORDER BY s.ticker`
      )
    ).rows;
    expect(rows).toEqual([
      { ticker: tickers.fine, close: '12.3457', volume: '100' },
      { ticker: tickers.oddVolume, close: '7.5000', volume: null },
    ]);
  });
});
