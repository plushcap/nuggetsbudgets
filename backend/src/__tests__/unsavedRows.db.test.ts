import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withSavepoint, withTenant } from '../db/withTenant.js';
import { unsavedRows } from '../services/import/unsavedRows.js';
import { findManualTransactionMatch, manualEntriesNear } from '../services/import/manualMatch.js';
import type { VanishedPending } from '../services/import/pendingMatcher.js';
import type { SimplefinTransaction } from '../services/import/types.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * What the rebalance leaves out for the rows a sync couldn't save, under RLS: the
 * bank's side (the posted rows' amounts) and the ledger's rows that stand for them, matched
 * as the import would match them. importSync.db.test.ts drives it through whole syncs.
 */
describe('unsavedRows', () => {
  let tenant: TestTenant;
  let accountId: number;
  // Any datable seconds: the test's dayOf gives each the day it names.
  const second = (n: number) => 1_760_000_000 + n;
  const dayOf = new Map<number, string>([
    [second(1), '2026-10-10'],
    [second(2), '2026-10-20'],
    [second(3), '2026-10-12'],
  ]);
  const tx = (id: string, amount: string, posted: number, pending = false): SimplefinTransaction =>
    ({ id, amount, posted, description: 'X', ...(pending ? { pending } : {}) }) as SimplefinTransaction;
  const run = (failed: SimplefinTransaction[], replacements = new Map<string, VanishedPending>()) =>
    withTenant(tenant.tenantId, () => unsavedRows(accountId, failed, dayOf, replacements));

  async function insert(values: { amount: string; date: string; status?: string; importId?: string }): Promise<number> {
    const result = await tenant.pool.query<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status, is_import, import_transaction_id, import_provider)
       VALUES ($1, $2, 'Entry', $3::date, 'expense', $4, $5, $6, $7) RETURNING id`,
      [accountId, values.amount, values.date, values.status ?? 'cleared', values.importId !== undefined, values.importId ?? null, values.importId ? 'simplefin' : null]
    );
    return result.rows[0].id;
  }

  beforeAll(async () => {
    tenant = await createTestTenant('unsaved import rows');
    accountId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('leaves out each row the ledger has: its own row, or the manual entry it would be linked to, once each', async () => {
    const nearest = await insert({ amount: '-40.00', date: '2026-10-10' });
    const next = await insert({ amount: '-40.00', date: '2026-10-12' });
    const reconciled = await insert({ amount: '-30.00', date: '2026-10-10', status: 'reconciled' });
    const fartherOpen = await insert({ amount: '-30.00', date: '2026-10-13' });
    const own = await insert({ amount: '-12.00', date: '2026-10-01', importId: 'OWN-1' });

    const result = await run([
      // The nearest entry of its amount: linked to it.
      tx('A', '-40.00', second(1)),
      // The same again: the nearest is taken by then, so the next one.
      tx('B', '-40.00', second(1)),
      // The nearest is reconciled: the import adds it beside that one, so the ledger hasn't
      // got it, though a farther entry of its amount isn't reconciled.
      tx('C', '-30.00', second(1)),
      // No entry of its amount within 7 days.
      tx('D', '-25.00', second(2)),
      // Saved by an earlier sync (the import would update it).
      tx('OWN-1', '-12.50', 0),
      // Pending: the bank's balance doesn't count it, and the ledger has nothing for it.
      tx('E', '-10.00', second(2), true),
    ]);
    expect(result).toEqual({ count: 6, bankCents: -4000 - 4000 - 3000 - 2500 - 1250, standInIds: expect.any(Array), undecidable: false });
    expect([...result.standInIds].sort((a, b) => a - b)).toEqual([nearest, next, own].sort((a, b) => a - b));
    expect(result.standInIds).not.toContain(reconciled);
    expect(result.standInIds).not.toContain(fartherOpen);
  });

  it('matches no manual entry to a row that replaces a pending one', async () => {
    const entry = await insert({ amount: '-7.00', date: '2026-10-12' });
    const replaced: VanishedPending = {
      id: entry, importTransactionId: 'PENDING-1', cents: -700, date: '2026-10-12', payee: null, description: 'X', flaggedBefore: false,
    };
    const result = await run([tx('POSTED-1', '-7.00', second(3))], new Map([['POSTED-1', replaced]]));
    expect(result).toEqual({ count: 1, bankCents: -700, standInIds: [], undecidable: false });
    // Without the replacement, the same row is linked to the entry.
    expect((await run([tx('POSTED-1', '-7.00', second(3))])).standInIds).toEqual([entry]);
  });

  it("can't tell what a row changes when its amount can't be read, pending or not", async () => {
    for (const pending of [false, true]) {
      expect(await run([tx('E', 'garbled', second(2), pending)])).toMatchObject({ count: 1, undecidable: true });
    }
    // Nor one too large to count in cents exactly.
    expect(await run([tx('F', '99999999999999999999.00', second(2))])).toMatchObject({ undecidable: true });
  });

  it("can't tell, for a row with no date, whether it is an unreconciled manual entry of its amount near the feed's days", async () => {
    // The feed's dated rows span 2026-10-10 to 2026-10-20 (dayOf): an entry from 7 days before
    // its first to 7 days after its last (or today) could be the row.
    await insert({ amount: '-61.00', date: '2026-10-06' });
    await insert({ amount: '-62.00', date: '2026-10-15', status: 'reconciled' });
    // Milliseconds: no date.
    expect(await run([tx('G', '-61.00', second(1) * 1000)])).toMatchObject({ undecidable: true });
    // Only a reconciled entry has its amount: the import would add it beside that one.
    expect(await run([tx('H', '-62.00', second(1) * 1000)])).toEqual({ count: 1, bankCents: -6200, standInIds: [], undecidable: false });
  });

  // An entry of the amount anywhere in the account's history kept the rebalance
  // off for as long as the row failed.
  it('leaves a dateless row out of the bank side alone when the entries of its amount are far from the feed', async () => {
    // 8 days before the feed's first dated row (2026-10-10): just outside the 7-day window.
    await insert({ amount: '-63.00', date: '2026-10-02' });
    await insert({ amount: '-63.00', date: '2025-01-15' });
    expect(await run([tx('J', '-63.00', second(1) * 1000)])).toEqual({ count: 1, bankCents: -6300, standInIds: [], undecidable: false });
    // A feed with no dated row bounds nothing: any entry of the amount could be it.
    const none = await withTenant(tenant.tenantId, () => unsavedRows(accountId, [tx('K', '-63.00', second(1) * 1000)], new Map(), new Map()));
    expect(none).toMatchObject({ undecidable: true });
  });

  // The balance counts an entry dated after today only from its day, while the
  // bank's counts the row; leaving it out booked an adjustment the next sync undid.
  it("can't tell what a row changes when the entry it would be linked to is dated after today", async () => {
    const today = (await tenant.pool.query<{ today: string }>('SELECT app_today()::text AS today')).rows[0].today;
    const dayAfter = (await tenant.pool.query<{ d: string }>('SELECT (app_today() + 1)::text AS d')).rows[0].d;
    const dayBefore = (await tenant.pool.query<{ d: string }>('SELECT (app_today() - 1)::text AS d')).rows[0].d;
    const later = await insert({ amount: '-64.00', date: dayAfter });
    const earlier = await insert({ amount: '-64.00', date: dayBefore });
    expect(later).toBeLessThan(earlier);
    const todayOf = new Map([[second(9), today]]);
    // As near as the other, and the lower id: the import's pick.
    const result = await withTenant(tenant.tenantId, () => unsavedRows(accountId, [tx('L', '-64.00', second(9))], todayOf, new Map()));
    expect(result).toMatchObject({ undecidable: true });
    // One dated today or before is left out as before.
    const past = await withTenant(tenant.tenantId, () =>
      unsavedRows(accountId, [tx('M', '-64.00', second(9))], new Map([[second(9), dayBefore]]), new Map())
    );
    expect(past).toEqual({ count: 1, bankCents: -6400, standInIds: [earlier], undecidable: false });
  });

  // With no start-date the window began a match window before the feed's first dated
  // row; asked from one, SimpleFin's rows posted from then on, so the window begins there.
  it('starts a dateless row\'s window at the start-date asked for, a pending lag before it', async () => {
    await insert({ amount: '-65.00', date: '2026-09-25' });
    await insert({ amount: '-67.00', date: '2026-09-01' });
    const withStart = (amount: string) =>
      withTenant(tenant.tenantId, () => unsavedRows(accountId, [tx('N', amount, second(1) * 1000)], dayOf, new Map(), '2026-10-01'));
    // 2026-10-01 less 5 days' pending lag, less the 7-day window: from 2026-09-19.
    expect(await withStart('-65.00')).toMatchObject({ undecidable: true });
    expect(await withStart('-67.00')).toEqual({ count: 1, bankCents: -6700, standInIds: [], undecidable: false });
    // Without the start, the window starts at the feed's first dated row (2026-10-10) less 7: from 2026-10-03.
    expect(await run([tx('O', '-65.00', second(1) * 1000)])).toEqual({ count: 1, bankCents: -6500, standInIds: [], undecidable: false });
    // A start and no dated row: from the start to today.
    const startOnly = await withTenant(tenant.tenantId, () =>
      unsavedRows(accountId, [tx('P', '-65.00', second(1) * 1000)], new Map(), new Map(), '2026-10-01')
    );
    expect(startOnly).toMatchObject({ undecidable: true });
  });

  // findManualTransactionMatch ordered by distance alone, so of two as near the
  // one it linked followed the rows' order, and could differ from the one the rebalance left
  // out. Here the lower id comes last in the table (it was updated) and by date.
  it('picks the same entry as the import of two as near: the lower id', async () => {
    const today = (await tenant.pool.query<{ today: string }>('SELECT app_today()::text AS today')).rows[0].today;
    const plus = async (days: number) =>
      (await tenant.pool.query<{ d: string }>('SELECT ($1::date + $2::int)::text AS d', [today, days])).rows[0].d;
    const lower = await insert({ amount: '-66.00', date: await plus(-1) });
    const higher = await insert({ amount: '-66.00', date: await plus(-3) });
    await tenant.pool.query(`UPDATE transactions SET notes = 'moved' WHERE id = $1`, [lower]);
    expect(lower).toBeLessThan(higher);
    const day = await plus(-2);
    const picked = await withTenant(tenant.tenantId, () =>
      findManualTransactionMatch(accountId, '-66.00', day, (fn) => fn())
    );
    expect(picked?.id).toBe(lower);
    const near = await withTenant(tenant.tenantId, () => manualEntriesNear(accountId, [{ amount: '-66.00', day }]));
    expect(near.map((entry) => entry.id)).toEqual([lower, higher]);
  });

  // A transfer entered the day it is sent can post five business days later, over a weekend:
  // an entry up to 7 days either side of an import's day is linked, one 8 days away isn't.
  it('links an entry up to 7 days either side of the import, and none 8 days away', async () => {
    const day = '2026-08-20';
    const weekBefore = await insert({ amount: '-71.00', date: '2026-08-13' });
    const weekAfter = await insert({ amount: '-73.00', date: '2026-08-27' });
    await insert({ amount: '-72.00', date: '2026-08-12' });
    await insert({ amount: '-72.00', date: '2026-08-28' });
    const linked = (amount: string) =>
      withTenant(tenant.tenantId, () => findManualTransactionMatch(accountId, amount, day, (fn) => fn()));
    const near = (amount: string) =>
      withTenant(tenant.tenantId, () => manualEntriesNear(accountId, [{ amount, day }]));
    expect((await linked('-71.00'))?.id).toBe(weekBefore);
    expect((await linked('-73.00'))?.id).toBe(weekAfter);
    expect(await linked('-72.00')).toBeNull();
    expect((await near('-71.00')).map((entry) => entry.id)).toEqual([weekBefore]);
    expect((await near('-73.00')).map((entry) => entry.id)).toEqual([weekAfter]);
    expect(await near('-72.00')).toEqual([]);
  });

  // The window's end was worked out in JavaScript, and 7 days past a day near
  // 9999-12-31 is in year 10000, "+010000-01-0…", which Postgres refused: the catch answered "no
  // match", so the import added the row beside the entry the sync had locked for it and the
  // rebalance (manualEntriesNear, in SQL) had left out as its stand-in.
  it('finds the entry of a day within the window of 9999-12-31, as manualEntriesNear does', async () => {
    const entry = await insert({ amount: '-69.00', date: '9999-12-30' });
    for (const day of ['9999-12-28', '9999-12-31']) {
      // In a savepoint, as the import runs it (its error was caught there).
      const picked = await withTenant(tenant.tenantId, () => findManualTransactionMatch(accountId, '-69.00', day, withSavepoint));
      expect(picked?.id, day).toBe(entry);
      const near = await withTenant(tenant.tenantId, () => manualEntriesNear(accountId, [{ amount: '-69.00', day }]));
      expect(near.map((row) => row.id), day).toEqual([entry]);
    }
  });
});
