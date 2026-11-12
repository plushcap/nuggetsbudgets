import { describe, it, expect } from 'vitest';
import { parseStooqCsv, toStooqSymbol, batchStooqSymbols } from '../PriceProviderClient.js';

describe('toStooqSymbol', () => {
  it('adds the .us suffix for a plain ticker', () => {
    expect(toStooqSymbol('ACMEC')).toBe('acmec.us');
  });
  it('passes through a ticker that already has a market suffix', () => {
    expect(toStooqSymbol('ACMEC.UK')).toBe('acmec.uk');
  });
});

describe('parseStooqCsv', () => {
  const header = 'Symbol,Date,Open,High,Low,Close,Volume';

  it('parses data rows and skips the header', () => {
    const rows = parseStooqCsv(`${header}\nACMEC.US,2026-06-26,100,101,99,100.5,12345`);
    expect(rows).toEqual([{ symbol: 'ACMEC.US', date: '2026-06-26', close: 100.5, volume: 12345 }]);
  });

  it('skips N/D dates and non-positive closes', () => {
    const csv = `${header}\nBAD.US,N/D,N/D,N/D,N/D,N/D,N/D\nZERO.US,2026-06-26,1,1,1,0,0`;
    expect(parseStooqCsv(csv)).toEqual([]);
  });

  it('treats a non-numeric volume as null', () => {
    const rows = parseStooqCsv(`${header}\nWIDGT.US,2026-06-26,1,1,1,250.25,N/D`);
    expect(rows[0]).toMatchObject({ symbol: 'WIDGT.US', close: 250.25, volume: null });
  });

  it('returns empty for blank or header-only input', () => {
    expect(parseStooqCsv('')).toEqual([]);
    expect(parseStooqCsv(header)).toEqual([]);
  });
});

describe('batchStooqSymbols', () => {
  it('keeps everything in one batch when within the budget', () => {
    expect(batchStooqSymbols(['acmec.us', 'widgt.us'], 400)).toEqual([['acmec.us', 'widgt.us']]);
  });

  it('splits into multiple batches so each comma-joined value stays within budget', () => {
    // budget 10: 'aaa.us'(6) + ','(1) + 'bbb.us'(6) = 13 > 10 → second symbol starts a new batch
    const batches = batchStooqSymbols(['aaa.us', 'bbb.us', 'ccc.us'], 10);
    expect(batches).toEqual([['aaa.us'], ['bbb.us'], ['ccc.us']]);
    for (const b of batches) expect(b.join(',').length).toBeLessThanOrEqual(10);
  });

  it('never drops symbols — every input lands in exactly one batch', () => {
    const symbols = Array.from({ length: 250 }, (_, i) => `tick${i}.us`);
    const batches = batchStooqSymbols(symbols, 400);
    expect(batches.flat()).toEqual(symbols);
    for (const b of batches) expect(b.join(',').length).toBeLessThanOrEqual(400);
  });

  it('gives an over-budget single symbol its own batch rather than dropping it', () => {
    const long = 'x'.repeat(50) + '.us';
    expect(batchStooqSymbols([long], 10)).toEqual([[long]]);
  });

  it('returns no batches for an empty input', () => {
    expect(batchStooqSymbols([], 400)).toEqual([]);
  });
});
