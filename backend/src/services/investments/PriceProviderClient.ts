import { createLogger } from '../../utils/logger.js';
import { circuitBreakerService } from '../CircuitBreakerService.js';

const logger = createLogger({ service: 'PriceProviderClient' });

export interface EodQuote {
  ticker: string; // original (uppercase) ticker as known to Nuggets
  date: string; // YYYY-MM-DD (the close's trading date)
  close: number;
  volume: number | null;
}

/** One CSV row from Stooq's quote endpoint (raw, unmapped). */
export interface StooqRow {
  symbol: string; // e.g. "ACMEC.US"
  date: string;
  close: number;
  volume: number | null;
}

const STOOQ_BASE = 'https://stooq.com/q/l/';
// Symbol, Date, Open, High, Low, Close, Volume — header row included via &h.
const STOOQ_FIELDS = 'sd2ohlcv';
const FETCH_TIMEOUT_MS = 25_000;
// Stooq returns HTTP 414 (URI Too Long) once too many symbols are packed into a
// single `s=` query value, so cap the comma-joined length per request and fetch
// the rest in additional batches. Kept small (~20 symbols/request) because Stooq
// also 404s overly large multi-symbol queries — the daily job only makes a
// handful of requests even with a large portfolio.
const STOOQ_MAX_QUERY_CHARS = 150;
// Pause between batch requests so a multi-batch run doesn't look like a burst to
// Stooq's rate limiter (which can answer 404/403 for aggressive clients).
const STOOQ_BATCH_DELAY_MS = 200;
// A plain/bot User-Agent gets rejected by Stooq; present as a normal browser.
const STOOQ_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Map a Nuggets ticker to a Stooq symbol. US equities/ETFs use the `.us`
 * suffix; tickers that already carry a market suffix (contain a dot) pass through. */
export function toStooqSymbol(ticker: string): string {
  const t = ticker.trim().toLowerCase();
  return t.includes('.') ? t : `${t}.us`;
}

/**
 * Split symbols into batches whose comma-joined length stays within `maxChars`,
 * so each request's URL stays under Stooq's URI-length limit. A symbol longer
 * than the budget on its own still gets its own (single-symbol) batch rather
 * than being dropped. Pure + side-effect-free for unit testing.
 */
export function batchStooqSymbols(symbols: string[], maxChars = STOOQ_MAX_QUERY_CHARS): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let len = 0; // length of the comma-joined current batch
  for (const sym of symbols) {
    const addedLen = current.length === 0 ? sym.length : sym.length + 1; // +1 for the comma
    if (current.length > 0 && len + addedLen > maxChars) {
      batches.push(current);
      current = [];
      len = 0;
    }
    len += current.length === 0 ? sym.length : sym.length + 1;
    current.push(sym);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Parse Stooq's CSV (with header) into raw rows. Skips the header, blank lines,
 * and rows with no usable close ("N/D" when Stooq has no data for the symbol).
 * Pure + side-effect-free so it can be unit-tested without network.
 */
export function parseStooqCsv(csv: string): StooqRow[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return [];
  const out: StooqRow[] = [];
  for (const line of lines.slice(1)) {
    const [symbol, date, , , , close, volume] = line.split(',');
    if (!symbol || !date || date === 'N/D') continue;
    const closeNum = Number(close);
    if (!Number.isFinite(closeNum) || closeNum <= 0) continue;
    const volNum = Number(volume);
    out.push({
      symbol: symbol.toUpperCase(),
      date,
      close: closeNum,
      volume: Number.isFinite(volNum) ? volNum : null,
    });
  }
  return out;
}

/**
 * Fetches end-of-day closes from Stooq (free, no API key). Provider-pluggable:
 * the URL/parse pair is the only Stooq-specific part. Wrapped in a circuit
 * breaker so a flaky provider doesn't hammer the backend. Stores the RAW close —
 * splits/spinoffs are modeled separately via corporate actions, so adjusted
 * prices would double-adjust.
 */
export class PriceProviderClient {
  /** Fetch the latest EOD close for each ticker. Tickers with no provider data
   * are simply omitted from the result (callers reconcile against their request). */
  async fetchEodCloses(tickers: string[]): Promise<EodQuote[]> {
    const unique = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
    if (unique.length === 0) return [];

    // stooq symbol -> original ticker, to map results back.
    const symbolToTicker = new Map<string, string>();
    for (const t of unique) symbolToTicker.set(toStooqSymbol(t).toUpperCase(), t);

    // One breaker fire per sync run (not per batch): the breaker protects the
    // backend from a sustained provider outage across runs, while batching +
    // partial tolerance live inside, so a few failed batches don't trip it and
    // cascade-reject the rest of the same run.
    const breaker = circuitBreakerService.getBreaker(
      'price-provider-stooq',
      (symbols: string[]) => this.fetchStooqBatched(symbols),
      { timeout: 120_000, name: 'price-provider-stooq' }
    );
    const rows = (await breaker.fire([...symbolToTicker.keys()])) as StooqRow[];

    const quotes: EodQuote[] = [];
    for (const r of rows) {
      const ticker = symbolToTicker.get(r.symbol.toUpperCase());
      if (!ticker) continue;
      quotes.push({ ticker, date: r.date, close: r.close, volume: r.volume });
    }
    logger.info(
      { requested: unique.length, returned: quotes.length },
      'Fetched EOD closes from Stooq'
    );
    return quotes;
  }

  /**
   * Fetch all symbols in URL-length-bounded batches (avoids Stooq HTTP 414) with
   * a short delay between requests. Tolerates a failed batch — keeps the closes
   * that did come back and only throws if every batch failed — so one bad batch
   * doesn't lose the whole sync. Runs inside the circuit breaker as a single fire.
   */
  private async fetchStooqBatched(symbols: string[]): Promise<StooqRow[]> {
    const batches = batchStooqSymbols(symbols);
    const rows: StooqRow[] = [];
    const errors: unknown[] = [];
    for (const [i, batch] of batches.entries()) {
      if (i > 0) await sleep(STOOQ_BATCH_DELAY_MS);
      try {
        rows.push(...(await this.fetchStooq(batch)));
      } catch (err) {
        errors.push(err);
        logger.warn({ err, batchSize: batch.length }, 'Stooq batch fetch failed');
      }
    }
    // Every batch failed → surface the first real error (so the breaker counts a
    // failure and the run is marked failed). Some succeeded → return partial data.
    if (rows.length === 0 && errors.length > 0) throw errors[0];
    if (errors.length > 0) {
      logger.warn({ batches: batches.length, failedBatches: errors.length }, 'Stooq returned partial results');
    }
    return rows;
  }

  private async fetchStooq(symbols: string[]): Promise<StooqRow[]> {
    const url = `${STOOQ_BASE}?s=${encodeURIComponent(symbols.join(',').toLowerCase())}&f=${STOOQ_FIELDS}&h&e=csv`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': STOOQ_USER_AGENT, Accept: 'text/csv,text/plain,*/*' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
      const csv = await res.text();
      return parseStooqCsv(csv);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const priceProviderClient = new PriceProviderClient();
