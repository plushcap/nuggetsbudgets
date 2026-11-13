import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import globalPool from '../db.js';
import { inTenantTransaction, withTenant } from '../db/withTenant.js';
import { ImportService } from '../services/ImportService.js';
import type { TransactionImporter } from '../services/import/TransactionImporter.js';
import type { MerchantMatcher } from '../services/import/MerchantMatcher.js';
import type { SimplefinTransaction } from '../services/import/types.js';
import { createImportRoutes } from '../routes/import.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { addDays, calendarDateIn } from '../utils/calendarDate.js';

/**
 * SimpleFin sync against the real database, under RLS, with SimpleFin's HTTP answers
 * stubbed. The stub sits at `fetch`, under simplefinRequest, so the access-URL
 * handling, the request ImportService builds and the parsing of the answer all run.
 * Only the organization's stored credential is replaced: decrypting it needs the
 * deployment's data_encryption_key, which tests don't have.
 */

vi.mock('../services/OrganizationSimpleFinService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/OrganizationSimpleFinService.js')>();
  return {
    ...actual,
    getAccessUrlForTenant: vi.fn(async () => 'https://user:secret@bridge.simplefin.org/simplefin'),
  };
});

// The household's time zone for one test, without changing the deployment-wide
// application_timezone setting that other test files read while this one runs.
const zone = vi.hoisted(() => ({ override: null as string | null }));
vi.mock('../utils/appDate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/appDate.js')>();
  return { ...actual, appTimezone: async () => zone.override ?? actual.appTimezone() };
});

interface FeedTx {
  id: string;
  amount: string;
  description: string;
  posted: number;
  pending?: boolean;
  transacted_at?: number;
  payee?: string;
}

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const daysAgo = (n: number) => now - n * DAY;
// An import is dated by its day in the application time zone, read in beforeAll.
let appZone = 'UTC';
const appDay = (unix: number) => calendarDateIn(appZone, new Date(unix * 1000));

const CONNECTION = {
  conn_id: `CONN-${stamp}`,
  name: 'Test Bank',
  org_id: `org-${stamp}`,
  org_url: `https://bank-${stamp}.example`,
  sfin_url: 'https://bridge.simplefin.org/simplefin',
};

/** A SimpleFin v2 AccountSet holding `accounts`. */
function accountSet(accounts: Array<{ id: string; balance?: string; available?: string; transactions: FeedTx[] }>) {
  return {
    errlist: [],
    connections: [CONNECTION],
    accounts: accounts.map((a) => ({
      id: a.id,
      conn_id: CONNECTION.conn_id,
      name: `Bank account ${a.id}`,
      currency: 'USD',
      balance: a.balance ?? '0.00',
      ...(a.available !== undefined ? { 'available-balance': a.available } : {}),
      'balance-date': now,
      transactions: a.transactions,
    })),
  };
}

/** Resolves for everyone once `size` callers have arrived, or once released. */
class Barrier {
  private arrived = 0;
  private open!: () => void;
  private readonly opened = new Promise<void>((resolve) => (this.open = resolve));
  constructor(private readonly size: number) {}
  arrive(): Promise<void> {
    if (++this.arrived >= this.size) this.open();
    return this.opened;
  }
  release(): void {
    this.open();
  }
}

describe('SimpleFin sync', () => {
  let tenant: TestTenant;
  let institutionId: number;
  const service = new ImportService(globalPool);
  let feed: ReturnType<typeof accountSet> = accountSet([]);
  let beforeAnswer: (() => Promise<void>) | null = null;
  const requested: string[] = [];

  const fetchStub = vi.fn(async (url: string | URL) => {
    requested.push(String(url));
    if (beforeAnswer) await beforeAnswer();
    return new Response(JSON.stringify(feed), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  // No transaction around it: a sync opens its own, none while SimpleFin answers.
  const fullSync = () => service.runFullSync(tenant.tenantId, { syncType: 'manual', syncTrigger: 'user', userId: tenant.userId });

  /** A ledger account linked to SimpleFin account `importId` (budget auto-assignment off, so runs are deterministic). */
  async function linkedAccount(label: string, opts: { liability?: boolean; rebalance?: boolean } = {}) {
    const importId = `SF-${label}-${stamp}`;
    const row = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                               import_auto_assign_budget_period, import_auto_assign_budget_item, import_account_rebalance)
         VALUES ($1, $2, $3, $4, $5, 'simplefin', true, false, false, $6) RETURNING id, uuid`,
        [
          label,
          opts.liability ? 'credit_card' : 'checking',
          opts.liability ? 'credit cards' : 'cash',
          opts.liability ? 'Liability' : 'Asset',
          importId,
          opts.rebalance ?? false,
        ]
      )
    ).rows[0];
    return { id: row.id as number, uuid: row.uuid as string, importId };
  }

  async function rows(accountId: number) {
    return (
      await tenant.pool.query(
        `SELECT id, uuid, import_transaction_id, amount, import_amount, type, status, import_pending,
                transaction_date::text AS transaction_date, description, import_description,
                budget_item_id, budget_period_id
           FROM transactions WHERE account_id = $1 AND parent_transaction_id IS NULL ORDER BY id`,
        [accountId]
      )
    ).rows;
  }

  async function lastSyncLog() {
    return (
      await tenant.pool.query(
        `SELECT sync_status, transactions_imported, transactions_updated, error_message
           FROM import_sync_log ORDER BY id DESC LIMIT 1`
      )
    ).rows[0];
  }

  beforeAll(async () => {
    tenant = await createTestTenant('SimpleFin sync');
    appZone = (await tenant.pool.query<{ zone: string }>('SELECT app_timezone() AS zone')).rows[0].zone;
    institutionId = (
      await tenant.pool.query(
        `INSERT INTO account_institutions (name, import_domain) VALUES ('Test Bank', $1) RETURNING id`,
        [new URL(CONNECTION.org_url).hostname]
      )
    ).rows[0].id;
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchStub);
    beforeAnswer = null;
    requested.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('links the institution and imports each transaction with its sign', async () => {
    const checking = await linkedAccount('first-checking');
    const card = await linkedAccount('first-card', { liability: true });
    feed = accountSet([
      {
        id: checking.importId,
        balance: '2487.66',
        transactions: [
          { id: `T1-${stamp}`, amount: '-12.34', description: 'COFFEE SHOP', posted: daysAgo(3) },
          { id: `T2-${stamp}`, amount: '2500.00', description: 'PAYROLL', posted: daysAgo(2), transacted_at: daysAgo(3) },
          { id: `T3-${stamp}`, amount: '-50.00', description: 'RESTAURANT', posted: daysAgo(1), pending: true },
        ],
      },
      {
        id: card.importId,
        balance: '-40.00',
        transactions: [
          { id: `C1-${stamp}`, amount: '-45.00', description: 'GROCER', posted: daysAgo(2) },
          { id: `C2-${stamp}`, amount: '5.00', description: 'REFUND', posted: daysAgo(1) },
        ],
      },
      // Not linked to a ledger account: skipped, nothing created for it.
      { id: `SF-unlinked-${stamp}`, transactions: [{ id: `U1-${stamp}`, amount: '-1.00', description: 'X', posted: daysAgo(1) }] },
    ]);

    await fullSync();

    expect(requested).toHaveLength(1);
    const asked = new URL(requested[0]);
    expect(asked.searchParams.get('pending')).toBe('1');
    expect(asked.searchParams.get('version')).toBe('2');
    expect(asked.username).toBe('');

    expect(await rows(checking.id)).toMatchObject([
      { import_transaction_id: `T1-${stamp}`, amount: '-12.34', import_amount: '-12.34', type: 'expense', status: 'cleared', import_pending: false, transaction_date: appDay(daysAgo(3)) },
      { import_transaction_id: `T2-${stamp}`, amount: '2500.00', type: 'income', status: 'cleared', transaction_date: appDay(daysAgo(3)) },
      { import_transaction_id: `T3-${stamp}`, amount: '-50.00', type: 'expense', status: 'pending', import_pending: true },
    ]);
    // A liability account's rows are never income, whatever their sign.
    expect(await rows(card.id)).toMatchObject([
      { import_transaction_id: `C1-${stamp}`, amount: '-45.00', type: 'expense' },
      { import_transaction_id: `C2-${stamp}`, amount: '5.00', type: 'expense' },
    ]);

    const account = (
      await tenant.pool.query('SELECT institution_id, import_balance FROM accounts WHERE id = $1', [checking.id])
    ).rows[0];
    expect(account).toEqual({ institution_id: institutionId, import_balance: '2487.66' });
    const unlinked = await tenant.pool.query(
      `SELECT 1 FROM accounts WHERE import_account_id = $1 UNION ALL SELECT 1 FROM transactions WHERE import_transaction_id = $2`,
      [`SF-unlinked-${stamp}`, `U1-${stamp}`]
    );
    expect(unlinked.rowCount).toBe(0);
    expect(await lastSyncLog()).toMatchObject({ sync_status: 'completed', transactions_imported: 5, transactions_updated: 0 });
  });

  it('changes nothing when the same answer is synced again', async () => {
    const account = await linkedAccount('resync');
    feed = accountSet([
      {
        id: account.importId,
        transactions: [
          { id: `R1-${stamp}`, amount: '-10.00', description: 'ONE', posted: daysAgo(4) },
          { id: `R2-${stamp}`, amount: '-20.00', description: 'TWO', posted: daysAgo(3) },
          { id: `R3-${stamp}`, amount: '-30.00', description: 'THREE', posted: daysAgo(1), pending: true },
        ],
      },
    ]);

    await fullSync();
    const first = await rows(account.id);
    await fullSync();
    await fullSync();

    expect(await rows(account.id)).toEqual(first);
    expect(await lastSyncLog()).toMatchObject({ sync_status: 'completed', transactions_imported: 0, transactions_updated: 3 });
  });

  it('gives a pending transaction its posted amount when it posts under the same id', async () => {
    const account = await linkedAccount('same-id');
    const pending = { id: `P1-${stamp}`, amount: '-50.00', description: 'RESTAURANT', posted: daysAgo(2), pending: true };
    feed = accountSet([{ id: account.importId, transactions: [pending] }]);
    await fullSync();

    feed = accountSet([{ id: account.importId, transactions: [{ ...pending, amount: '-61.25', posted: daysAgo(1), pending: false }] }]);
    await fullSync();

    const after = await rows(account.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ amount: '-61.25', import_amount: '-61.25', status: 'cleared', import_pending: false });
  });

  it("keeps an amount the user changed when the bank's amount changes", async () => {
    const account = await linkedAccount('user-edit');
    const pending = { id: `E1-${stamp}`, amount: '-50.00', description: 'RESTAURANT', posted: daysAgo(2), pending: true };
    feed = accountSet([{ id: account.importId, transactions: [pending] }]);
    await fullSync();
    await tenant.pool.query(`UPDATE transactions SET amount = '-55.00' WHERE import_transaction_id = $1`, [pending.id]);

    feed = accountSet([{ id: account.importId, transactions: [{ ...pending, amount: '-61.25', pending: false }] }]);
    await fullSync();

    expect(await rows(account.id)).toMatchObject([{ amount: '-55.00', import_amount: '-61.25', status: 'cleared' }]);
  });

  it('updates a pending transaction in place when it posts under a new id', async () => {
    const account = await linkedAccount('new-id');
    const tip = { id: `P2-${stamp}`, amount: '-50.00', description: 'RESTAURANT', posted: daysAgo(3), pending: true };
    const exact = { id: `P3-${stamp}`, amount: '-19.99', description: 'STREAMING SVC', posted: daysAgo(3), pending: true };
    feed = accountSet([{ id: account.importId, transactions: [tip, exact] }]);
    await fullSync();
    const [tipRow, exactRow] = await rows(account.id);

    // What the family did with the pending row: budgeted, tagged.
    const item = (
      await tenant.pool.query(`INSERT INTO budget_items (name, expense_type, type) VALUES ('Dining', 'Expense', 'Monthly') RETURNING id`)
    ).rows[0].id;
    await tenant.pool.query('UPDATE transactions SET budget_item_id = $1 WHERE id = $2', [item, tipRow.id]);
    const tag = (await tenant.pool.query(`INSERT INTO tags (name) VALUES ($1) RETURNING id`, [`date-night-${stamp}`])).rows[0].id;
    await tenant.pool.query(
      `INSERT INTO taggings (tag_id, taggable_id, taggable_type) VALUES ($1, $2, 'transaction')`,
      [tag, tipRow.id]
    );

    // Both post under new ids at the same merchant: one with a tip added, one for the same
    // amount (its text differs only in case and punctuation).
    feed = accountSet([
      {
        id: account.importId,
        transactions: [
          { id: `X9-${stamp}`, amount: '-61.25', description: 'RESTAURANT', posted: daysAgo(1) },
          { id: `X8-${stamp}`, amount: '-19.99', description: 'Streaming Svc.', posted: daysAgo(1) },
        ],
      },
    ]);
    await fullSync();

    const after = await rows(account.id);
    expect(after).toHaveLength(2);
    expect(after).toMatchObject([
      { id: tipRow.id, uuid: tipRow.uuid, import_transaction_id: `X9-${stamp}`, amount: '-61.25', status: 'cleared', import_pending: false, budget_item_id: item, transaction_date: tipRow.transaction_date },
      { id: exactRow.id, uuid: exactRow.uuid, import_transaction_id: `X8-${stamp}`, amount: '-19.99', status: 'cleared', import_pending: false },
    ]);
    const tagged = await tenant.pool.query(
      `SELECT 1 FROM taggings WHERE taggable_type = 'transaction' AND taggable_id = $1 AND tag_id = $2`,
      [tipRow.id, tag]
    );
    expect(tagged.rowCount).toBe(1);
    expect(await lastSyncLog()).toMatchObject({ transactions_imported: 0, transactions_updated: 2 });

    // Synced again, nothing changes.
    await fullSync();
    expect(await rows(account.id)).toEqual(after);
  });

  it('leaves pending transactions alone when a posted one could be another purchase', async () => {
    const account = await linkedAccount('no-merge');
    const stillPending = { id: `S1-${stamp}`, amount: '-8.00', description: 'BAKERY', posted: daysAgo(2), pending: true };
    const twinA = { id: `S2-${stamp}`, amount: '-4.50', description: 'COFFEE', posted: daysAgo(2), pending: true };
    const twinB = { id: `S3-${stamp}`, amount: '-4.50', description: 'COFFEE', posted: daysAgo(2), pending: true };
    const other = { id: `S4-${stamp}`, amount: '-30.00', description: 'HARDWARE STORE', posted: daysAgo(2), pending: true };
    const old = { id: `S5-${stamp}`, amount: '-12.00', description: 'CINEMA', posted: daysAgo(7), pending: true };
    feed = accountSet([{ id: account.importId, transactions: [stillPending, twinA, twinB, other, old] }]);
    await fullSync();
    const before = await rows(account.id);

    feed = accountSet([
      {
        id: account.importId,
        transactions: [
          stillPending, // still pending, so not the bakery purchase below
          { id: `N1-${stamp}`, amount: '-8.00', description: 'BAKERY', posted: daysAgo(1) },
          // Could be either coffee: neither is replaced.
          { id: `N2-${stamp}`, amount: '-4.50', description: 'COFFEE', posted: daysAgo(1) },
          // Another amount at another merchant.
          { id: `N3-${stamp}`, amount: '-33.00', description: 'GARDEN CENTER', posted: daysAgo(1) },
          // Same amount and merchant as the cinema, but a week later.
          { id: `N4-${stamp}`, amount: '-12.00', description: 'CINEMA', posted: now },
        ],
      },
    ]);
    await fullSync();

    const after = await rows(account.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((r) => r.import_transaction_id)).toEqual([
      `N1-${stamp}`,
      `N2-${stamp}`,
      `N3-${stamp}`,
      `N4-${stamp}`,
    ]);
  });

  async function reviewStatus(accountId: number, importId: string) {
    return (
      await tenant.pool.query(
        `SELECT review_status FROM transactions WHERE account_id = $1 AND import_transaction_id = $2`,
        [accountId, importId]
      )
    ).rows[0]?.review_status;
  }
  /** A member reviewed the row, so a flag for review shows. */
  async function markReviewed(accountId: number, importId: string) {
    await tenant.pool.query(
      `UPDATE transactions SET review_status = 'reviewed' WHERE account_id = $1 AND import_transaction_id = $2`,
      [accountId, importId]
    );
  }

  it("never turns a pending purchase into another merchant's charge of the same amount", async () => {
    const account = await linkedAccount('other-merchant');
    const eats = { id: `CP-${stamp}`, amount: '-15.00', description: 'SAMPLE EATS', posted: daysAgo(2), pending: true };
    feed = accountSet([{ id: account.importId, transactions: [eats] }]);
    await fullSync();
    const item = (
      await tenant.pool.query(`INSERT INTO budget_items (name, expense_type, type) VALUES ('Dining out', 'Expense', 'Monthly') RETURNING id`)
    ).rows[0].id;
    await tenant.pool.query('UPDATE transactions SET budget_item_id = $1 WHERE import_transaction_id = $2', [item, eats.id]);
    const [eatsRow] = await rows(account.id);

    // The Sample Eats authorization disappears; an Example Fuel charge for the same amount posts.
    feed = accountSet([
      { id: account.importId, transactions: [{ id: `CX-${stamp}`, amount: '-15.00', description: 'EXAMPLE FUEL 12345', posted: daysAgo(1) }] },
    ]);
    await fullSync();

    const after = await rows(account.id);
    expect(after).toMatchObject([
      { id: eatsRow.id, import_transaction_id: eats.id, description: 'SAMPLE EATS', budget_item_id: item, import_pending: true },
      { import_transaction_id: `CX-${stamp}`, description: 'EXAMPLE FUEL 12345', budget_item_id: null, import_pending: false },
    ]);
  });

  it('flags a pending transaction left behind once its posted copy was imported beside it', async () => {
    const account = await linkedAccount('left-behind');
    const pending = { id: `LP-${stamp}`, amount: '-42.00', description: 'GROCER', posted: daysAgo(3), pending: true };
    const posted = { id: `LX-${stamp}`, amount: '-42.00', description: 'GROCER', posted: daysAgo(1) };
    feed = accountSet([{ id: account.importId, transactions: [pending] }]);
    await fullSync();
    await markReviewed(account.id, pending.id);
    // For one sync the bank lists both, so the posted one is imported as its own row.
    feed = accountSet([{ id: account.importId, transactions: [pending, posted] }]);
    await fullSync();
    expect(await reviewStatus(account.id, pending.id)).toBe('reviewed');

    // Then the pending one is gone: the purchase now counts twice, so say so.
    feed = accountSet([{ id: account.importId, transactions: [posted] }]);
    await fullSync();
    expect((await rows(account.id)).map((r) => r.import_transaction_id)).toEqual([pending.id, posted.id]);
    expect(await reviewStatus(account.id, pending.id)).toBe('needs review');
    expect(await lastSyncLog()).toMatchObject({
      sync_status: 'completed',
      error_message: expect.stringContaining('1 pending transaction disappeared without a matching posted one; flagged for review'),
    });

    // Once: a member who keeps it isn't asked again on every sync.
    await markReviewed(account.id, pending.id);
    await fullSync();
    expect(await reviewStatus(account.id, pending.id)).toBe('reviewed');
    expect(await lastSyncLog()).toMatchObject({ sync_status: 'completed', error_message: null });
  });

  it('flags the stray pending rows when a pending transaction is re-issued under a new id', async () => {
    const account = await linkedAccount('reissued');
    const first = { id: `RP1-${stamp}`, amount: '-27.50', description: 'PHARMACY', posted: daysAgo(3), pending: true };
    const second = { ...first, id: `RP2-${stamp}`, posted: daysAgo(2) };
    const posted = { id: `RX-${stamp}`, amount: '-27.50', description: 'PHARMACY', posted: daysAgo(1) };
    feed = accountSet([{ id: account.importId, transactions: [first] }]);
    await fullSync();
    await markReviewed(account.id, first.id);
    feed = accountSet([{ id: account.importId, transactions: [second] }]);
    await fullSync();
    await markReviewed(account.id, second.id);
    feed = accountSet([{ id: account.importId, transactions: [posted] }]);
    await fullSync();

    // The posted one fits both pending rows, so neither is replaced; both are flagged.
    expect((await rows(account.id)).map((r) => r.import_transaction_id)).toEqual([first.id, second.id, posted.id]);
    expect(await reviewStatus(account.id, first.id)).toBe('needs review');
    expect(await reviewStatus(account.id, second.id)).toBe('needs review');
  });

  it("measures the pending-to-posted window in the household's days, not UTC's", async () => {
    const at = (iso: string) => Date.parse(iso) / 1000;
    // The window is 5 household days. Each feed also lists an older, unrelated
    // transaction, so the pending row is among the ones the matcher looks at.
    const syncInZone = async (timeZone: string, label: string, pendingAt: number, postedAt: number) => {
      zone.override = timeZone;
      try {
        const account = await linkedAccount(label);
        const pending = { id: `${label}-P-${stamp}`, amount: '-42.00', description: 'CORNER CAFE', posted: pendingAt, transacted_at: pendingAt, pending: true };
        const older = { id: `${label}-O-${stamp}`, amount: '-3.00', description: 'PARKING', posted: at('2026-09-28T12:00:00Z') };
        feed = accountSet([{ id: account.importId, transactions: [older, pending] }]);
        await fullSync();
        feed = accountSet([
          { id: account.importId, transactions: [older, { id: `${label}-X-${stamp}`, amount: '-42.00', description: 'CORNER CAFE', posted: postedAt, transacted_at: postedAt }] },
        ]);
        await fullSync();
        return (await rows(account.id)).filter((r) => r.description === 'CORNER CAFE').map((r) => r.import_transaction_id);
      } finally {
        zone.override = null;
      }
    };

    // Kolkata: swiped 03:00 Oct 1 (21:30 UTC Sep 30), posted 11:30 Oct 6: 5 days, so one row.
    expect(await syncInZone('Asia/Kolkata', 'kolkata', at('2026-09-30T21:30:00Z'), at('2026-10-06T06:00:00Z'))).toEqual([
      `kolkata-X-${stamp}`,
    ]);
    // New York: swiped 22:30 Sep 30 (02:30 UTC Oct 1), posted noon Oct 6: 6 days, so not the same.
    expect(await syncInZone('America/New_York', 'new-york', at('2026-10-01T02:30:00Z'), at('2026-10-06T16:00:00Z'))).toEqual([
      `new-york-P-${stamp}`,
      `new-york-X-${stamp}`,
    ]);
  });

  it('skips a SimpleFin transaction without an id instead of adding it again on every sync', async () => {
    const account = await linkedAccount('no-id');
    const good = { id: `G1-${stamp}`, amount: '-1.00', description: 'GOOD', posted: daysAgo(1) };
    const nameless = [null, '', { nested: true }].map((id) => ({ id, amount: '-2.00', description: 'NO ID', posted: daysAgo(1) }));
    feed = accountSet([{ id: account.importId, transactions: [good, ...(nameless as unknown as FeedTx[])] }]);
    await fullSync();
    await fullSync();

    expect((await rows(account.id)).map((r) => r.import_transaction_id)).toEqual([good.id]);
    expect(await lastSyncLog()).toMatchObject({
      sync_status: 'partial',
      error_message: expect.stringContaining('3 transactions could not be imported'),
    });
  });

  // The transactions' days come from one query, which a timestamp out of
  // Postgres's range (milliseconds, not seconds) failed for the whole account, every sync.
  it('skips a transaction dated out of range on its own, and dates a numeric string', async () => {
    const account = await linkedAccount('bad-stamp');
    const good = { id: `GS-${stamp}`, amount: '-1.00', description: 'GOOD', posted: daysAgo(1) };
    const asText = { id: `TS-${stamp}`, amount: '-3.00', description: 'TEXT STAMP', posted: String(daysAgo(2)) };
    const milliseconds = { id: `MS-${stamp}`, amount: '-2.00', description: 'MILLISECONDS', posted: daysAgo(1) * 1000 };
    const before = { id: `BC-${stamp}`, amount: '-2.00', description: 'BEFORE YEAR 1', posted: -1e11 };
    // A swipe time out of range, but a good posted time: dated by the posted time.
    const badSwipe = { id: `BW-${stamp}`, amount: '-4.00', description: 'BAD SWIPE TIME', posted: daysAgo(3), transacted_at: daysAgo(3) * 1000 };
    feed = accountSet([{ id: account.importId, transactions: [good, asText, milliseconds, before, badSwipe] as unknown as FeedTx[] }]);
    await fullSync();

    const imported = await rows(account.id);
    expect(imported.map((r) => r.import_transaction_id).sort()).toEqual([good.id, asText.id, badSwipe.id].sort());
    expect(imported.find((r) => r.import_transaction_id === asText.id)?.transaction_date).toBe(appDay(daysAgo(2)));
    expect(imported.find((r) => r.import_transaction_id === badSwipe.id)?.transaction_date).toBe(appDay(daysAgo(3)));
    expect(await lastSyncLog()).toMatchObject({
      sync_status: 'partial',
      error_message: expect.stringContaining('2 transactions could not be imported'),
    });
  });

  it('imports each transaction once when two syncs overlap', async () => {
    const account = await linkedAccount('overlap');
    feed = accountSet([
      {
        id: account.importId,
        transactions: Array.from({ length: 5 }, (_, i) => ({
          id: `O${i}-${stamp}`,
          amount: `-${i + 1}.00`,
          description: `OVERLAP ${i}`,
          posted: daysAgo(2),
        })),
      },
    ]);
    // Hold each sync in its SimpleFin request until both are there (or one is turned away).
    const barrier = new Barrier(2);
    beforeAnswer = () => barrier.arrive();

    const run = () => fullSync().finally(() => barrier.release());
    const results = await Promise.allSettled([run(), run()]);

    const imported = await rows(account.id);
    expect(imported.map((r) => r.import_transaction_id).sort()).toEqual(
      Array.from({ length: 5 }, (_, i) => `O${i}-${stamp}`).sort()
    );
    // One ran; the other was turned away because a sync of this ledger was running.
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: 'SYNC_IN_PROGRESS' });
  });

  it('waits on SimpleFin with no transaction open, the sync already logged as started', async () => {
    const account = await linkedAccount('no-transaction');
    feed = accountSet([{ id: account.importId, transactions: [{ id: `NT-${stamp}`, amount: '-3.00', description: 'NO TXN', posted: daysAgo(1) }] }]);
    let seen: { inTransaction: boolean; logStatuses: string[] } | undefined;
    beforeAnswer = async () => {
      seen = {
        inTransaction: inTenantTransaction(),
        logStatuses: (await tenant.pool.query<{ sync_status: string }>(
          'SELECT sync_status FROM import_sync_log ORDER BY id DESC LIMIT 1'
        )).rows.map((r) => r.sync_status),
      };
    };

    await fullSync();
    expect(seen).toEqual({ inTransaction: false, logStatuses: ['started'] });
    expect((await rows(account.id)).map((r) => r.import_transaction_id)).toEqual([`NT-${stamp}`]);
    // Started inside a transaction it would hold that transaction open through the fetch.
    await expect(withTenant(tenant.tenantId, () => fullSync())).rejects.toThrow(/outside one/);
  });

  it('saves one copy even when two writers get past the sync lock', async () => {
    // Something that writes imports without the lock (a future code path, a script): the
    // unique index and ON CONFLICT DO NOTHING still keep one row per bank id.
    const account = await linkedAccount('no-lock');
    const txs: FeedTx[] = [1, 2, 3].map((i) => ({ id: `L${i}-${stamp}`, amount: `-${i}.00`, description: `NO LOCK ${i}`, posted: daysAgo(1) }));
    const internals = service as unknown as { transactions: TransactionImporter; merchants: MerchantMatcher };
    const importTransactions = (accountId: number, transactions: FeedTx[]) =>
      internals.transactions.importTransactions(accountId, transactions as SimplefinTransaction[]);
    // Both writers find no row for the first transaction before either inserts it.
    const barrier = new Barrier(2);
    const match = internals.merchants.match;
    vi.spyOn(internals.merchants, 'match').mockImplementation(async function (this: MerchantMatcher, ...args: Parameters<MerchantMatcher['match']>) {
      await barrier.arrive();
      return match.apply(this, args);
    });

    const write = () =>
      withTenant(tenant.tenantId, () => importTransactions(account.id, txs)).finally(() => barrier.release());
    await Promise.all([write(), write()]);

    expect((await rows(account.id)).map((r) => r.import_transaction_id)).toEqual(txs.map((t) => t.id));
  });

  it("imports the other rows when one can't be saved, and says the sync was partial", async () => {
    const account = await linkedAccount('bad-row');
    const longDescription = `VERY LONG STATEMENT TEXT ${'x'.repeat(300)}`;
    feed = accountSet([
      {
        id: account.importId,
        transactions: [
          { id: `B1-${stamp}`, amount: '-10.00', description: 'GOOD ONE', posted: daysAgo(3) },
          // numeric(12,2) can't hold it.
          { id: `B2-${stamp}`, amount: '-99999999999.00', description: 'OVERFLOW', posted: daysAgo(3) },
          // Longer than transactions.description (varchar 255): kept whole in import_description.
          { id: `B3-${stamp}`, amount: '-20.00', description: longDescription, posted: daysAgo(2) },
          { id: `B4-${stamp}`, amount: 'not a number', description: 'GARBLED', posted: daysAgo(2) },
          { id: `B5-${stamp}`, amount: '-30.00', description: 'GOOD TWO', posted: daysAgo(1) },
        ],
      },
    ]);

    await fullSync();

    const imported = await rows(account.id);
    expect(imported.map((r) => r.import_transaction_id)).toEqual([`B1-${stamp}`, `B3-${stamp}`, `B5-${stamp}`]);
    expect(imported[1].description).toHaveLength(255);
    expect(imported[1].import_description).toBe(longDescription);
    expect(await lastSyncLog()).toMatchObject({
      sync_status: 'partial',
      transactions_imported: 3,
      error_message: expect.stringContaining('2 transactions could not be imported'),
    });
    // Its balance doesn't follow the bank's, so there was no adjustment to skip.
    expect((await lastSyncLog()).error_message).not.toContain('balance');
  });

  describe('the auto-rebalance', () => {
    /** The account's balance adjustments, oldest first. */
    async function adjustments(accountId: number) {
      return (
        await tenant.pool.query(
          `SELECT amount FROM transactions WHERE account_id = $1 AND type = 'balance adjustment' ORDER BY id`,
          [accountId]
        )
      ).rows.map((r) => r.amount as string);
    }
    async function balance(accountId: number) {
      return (await tenant.pool.query('SELECT calculate_account_balance($1)::text AS b', [accountId])).rows[0].b as string;
    }

    it("adds no adjustment for a pending purchase the bank's balance doesn't count yet", async () => {
      const account = await linkedAccount('rebalance-pending', { rebalance: true });
      const pending = { id: `RB1-${stamp}`, amount: '-50.00', description: 'RESTAURANT', posted: daysAgo(1), pending: true };
      // The bank's balance is what has posted (-12.34 + 2500.00); its available balance
      // also takes the pending -50.00 off.
      const posted = [
        { id: `RB2-${stamp}`, amount: '-12.34', description: 'COFFEE SHOP', posted: daysAgo(3) },
        { id: `RB3-${stamp}`, amount: '2500.00', description: 'PAYROLL', posted: daysAgo(2) },
      ];
      feed = accountSet([{ id: account.importId, balance: '2487.66', available: '2437.66', transactions: [...posted, pending] }]);
      await fullSync();
      expect(await adjustments(account.id)).toEqual([]);
      expect(await balance(account.id)).toBe('2437.66');

      // It posts with a tip: now the bank's balance has it, and the ledger's row isn't pending.
      feed = accountSet([
        {
          id: account.importId,
          balance: '2426.41',
          available: '2426.41',
          transactions: [...posted, { ...pending, amount: '-61.25', pending: false }],
        },
      ]);
      await fullSync();
      expect(await adjustments(account.id)).toEqual([]);
      expect(await balance(account.id)).toBe('2426.41');
    });

    it('adjusts by the real difference only, while a purchase is pending', async () => {
      const card = await linkedAccount('rebalance-card', { liability: true, rebalance: true });
      // The bank's balance owes 10.00 more than the posted rows (a fee the feed didn't
      // list); the -20.00 is pending. A card's available balance is the credit left.
      feed = accountSet([
        {
          id: card.importId,
          balance: '-55.00',
          available: '4925.00',
          transactions: [
            { id: `RC1-${stamp}`, amount: '-45.00', description: 'GROCER', posted: daysAgo(2) },
            { id: `RC2-${stamp}`, amount: '-20.00', description: 'FUEL', posted: daysAgo(1), pending: true },
          ],
        },
      ]);
      await fullSync();
      expect(await adjustments(card.id)).toEqual(['-10.00']);
      // The bank's balance plus what is still pending.
      expect(await balance(card.id)).toBe('-75.00');

      await fullSync();
      expect(await adjustments(card.id)).toEqual(['-10.00']);
    });

    // A pending row that leaves the feed with nothing posted for it stays out of the
    // comparison (it is flagged for review): the bank often posts it a sync later.
    const deposit = { id: `RL1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(4) };
    const hold = (label: string) => ({ id: `RL2-${label}-${stamp}`, amount: '-100.00', description: 'HOTEL', posted: daysAgo(2), pending: true });

    it('adds no adjustments when the bank drops a pending row a sync before it posts under a new id', async () => {
      const account = await linkedAccount('rebalance-late-post', { rebalance: true });
      const pending = hold('late');
      feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [deposit, pending] }]);
      await fullSync();
      feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [deposit] }]);
      await fullSync();
      feed = accountSet([
        {
          id: account.importId,
          balance: '900.00',
          transactions: [deposit, { id: `RL3-late-${stamp}`, amount: '-100.00', description: 'HOTEL', posted: daysAgo(1) }],
        },
      ]);
      await fullSync();

      expect(await adjustments(account.id)).toEqual([]);
      expect((await rows(account.id)).map((r) => [r.import_transaction_id, r.amount, r.import_pending])).toEqual([
        [deposit.id, '1000.00', false],
        [`RL3-late-${stamp}`, '-100.00', false],
      ]);
      expect(await balance(account.id)).toBe('900.00');
    });

    it('leaves a released hold to the member: no adjustment before or after they delete it', async () => {
      const account = await linkedAccount('rebalance-released', { rebalance: true });
      const pending = hold('released');
      feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [deposit, pending] }]);
      await fullSync();
      feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [deposit] }]);
      await fullSync();

      // Flagged for review, and the ledger shows it until a member deals with it.
      const [row] = (
        await tenant.pool.query(`SELECT import_pending, review_status FROM transactions WHERE import_transaction_id = $1`, [pending.id])
      ).rows;
      expect(row).toEqual({ import_pending: true, review_status: 'needs review' });
      expect(await adjustments(account.id)).toEqual([]);
      expect(await balance(account.id)).toBe('900.00');

      await tenant.pool.query(`DELETE FROM transactions WHERE import_transaction_id = $1`, [pending.id]);
      await fullSync();
      expect(await adjustments(account.id)).toEqual([]);
      expect(await balance(account.id)).toBe('1000.00');
    });

    describe("a row it couldn't save stays out of both balances", () => {
      const notAdjusted = "balance was not adjusted to the bank's";
      const single = (uuid: string) =>
        service.runSingleAccountSync(tenant.tenantId, uuid, { syncType: 'manual', syncTrigger: 'user', userId: tenant.userId });
      // A posted time in milliseconds is out of range: the import can't date the row.
      const inMilliseconds = <T extends { posted: number }>(tx: T): T => ({ ...tx, posted: tx.posted * 1000 });

      it('adjusts only by the drift the feed leaves unexplained, sync after sync, and counts the row once it is saved', async () => {
        const account = await linkedAccount('rebalance-failed-row', { rebalance: true });
        const opening = { id: `RF1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(9) };
        // Older than the 7 days before an import a manual entry of its amount is linked across, or
        // the row coming in later would take over an adjustment of its amount.
        const fee = { id: `RF2-${stamp}`, amount: '-40.00', description: 'FEE', posted: daysAgo(8) };
        // The bank's balance has the fee in it, and a 5.00 charge the feed never lists. Compared
        // whole, the rebalance booked -45.00, then +40.00 once the fee came in; skipped while a
        // row failed, the account never rebalanced at all, and the 5.00 stayed uncorrected.
        feed = accountSet([{ id: account.importId, balance: '955.00', transactions: [opening, inMilliseconds(fee)] }]);
        for (let sync = 0; sync < 3; sync++) {
          await fullSync();
          expect(await adjustments(account.id)).toEqual(['-5.00']);
          expect(await balance(account.id)).toBe('995.00');
          expect(await lastSyncLog()).toMatchObject({
            sync_status: 'partial',
            error_message: '1 transaction could not be imported; see the server log',
          });
        }
        const [note] = (
          await tenant.pool.query(`SELECT notes FROM transactions WHERE account_id = $1 AND type = 'balance adjustment'`, [account.id])
        ).rows;
        expect(note.notes).toBe('Adjusted to match imported balance of $955.00, leaving out 1 transaction that could not be imported');
        // A one-account sync compares them the same way.
        expect(await single(account.uuid)).toMatchObject({ success: true, status: 'partial' });
        expect(await adjustments(account.id)).toEqual(['-5.00']);

        // The next sync saves it: the balance is the bank's, and nothing was counted twice.
        feed = accountSet([{ id: account.importId, balance: '955.00', transactions: [opening, fee] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual(['-5.00']);
        expect(await balance(account.id)).toBe('955.00');
        expect((await lastSyncLog()).error_message).toBeNull();
      });

      it("leaves out a pending row: the bank's balance doesn't count it either", async () => {
        const account = await linkedAccount('rebalance-failed-pending', { rebalance: true });
        const opening = { id: `RP1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(9) };
        const hold = { id: `RP2-${stamp}`, amount: '-30.00', description: 'FUEL', posted: daysAgo(1), pending: true };
        // Taking its amount off the bank's balance would book +30.00.
        feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [opening, inMilliseconds(hold)] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual([]);
        expect(await balance(account.id)).toBe('1000.00');

        feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [opening, hold] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual([]);
        expect(await balance(account.id)).toBe('970.00');

        feed = accountSet([{ id: account.importId, balance: '970.00', transactions: [opening, { ...hold, pending: false }] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual([]);
        expect(await balance(account.id)).toBe('970.00');
      });

      it('leaves out the row a sync saved earlier when a later sync fails on it', async () => {
        const account = await linkedAccount('rebalance-failed-again', { rebalance: true });
        const opening = { id: `RA1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(9) };
        const fee = { id: `RA2-${stamp}`, amount: '-40.00', description: 'FEE', posted: daysAgo(7) };
        feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [opening, fee] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual([]);

        // The ledger has the fee already: leaving it out of the bank's balance alone would book
        // +35.00 here, and -40.00 once the row is saved again.
        feed = accountSet([{ id: account.importId, balance: '955.00', transactions: [opening, inMilliseconds(fee)] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual(['-5.00']);
        expect(await balance(account.id)).toBe('955.00');

        feed = accountSet([{ id: account.importId, balance: '955.00', transactions: [opening, fee] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual(['-5.00']);
        expect(await balance(account.id)).toBe('955.00');
      });

      it("doesn't compare the balances when a row's amount can't be read, and says so in the sync log", async () => {
        const account = await linkedAccount('rebalance-garbled', { rebalance: true });
        const opening = { id: `RG1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(9) };
        const garbled = { id: `RG2-${stamp}`, amount: 'not a number', description: 'FEE', posted: daysAgo(7) };
        feed = accountSet([{ id: account.importId, balance: '955.00', transactions: [opening, garbled] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual([]);
        expect(await balance(account.id)).toBe('1000.00');
        expect(await lastSyncLog()).toMatchObject({
          sync_status: 'partial',
          error_message:
            "1 transaction could not be imported; see the server log; 1 account's balance was not adjusted to the bank's: " +
            'a transaction of it that could not be imported had an amount that could not be read, or may be a transaction entered by hand that is dated after today or can\'t be told apart',
        });
        // A one-account sync says it too.
        expect(await single(account.uuid)).toMatchObject({ success: true, status: 'partial', notice: expect.stringContaining(notAdjusted) });
        expect(await adjustments(account.id)).toEqual([]);

        // Once every row is read, the balances are compared again.
        feed = accountSet([{ id: account.importId, balance: '955.00', transactions: [opening, { ...garbled, amount: '-40.00' }] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual(['-5.00']);
        expect(await balance(account.id)).toBe('955.00');
      });

      it("doesn't compare the balances when a row with no date may be a transaction entered by hand", async () => {
        const account = await linkedAccount('rebalance-failed-manual', { rebalance: true });
        const opening = { id: `RM1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(9) };
        const fee = { id: `RM2-${stamp}`, amount: '-40.00', description: 'FEE', posted: daysAgo(7) };
        feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [opening] }]);
        await fullSync();
        // A member enters the fee before the bank's row of it is saved.
        await tenant.pool.query(
          `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
           VALUES ($1, -40.00, 'Bank fee', $2::date, 'expense', 'cleared')`,
          [account.id, appDay(fee.posted)]
        );

        // Left out of the bank's balance only, the fee booked +40.00 here and -40.00 after.
        feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [opening, inMilliseconds(fee)] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual([]);
        expect((await lastSyncLog()).error_message).toContain(notAdjusted);

        // Saved, it is linked to the member's entry.
        feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [opening, fee] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual([]);
        expect(await balance(account.id)).toBe('960.00');
        expect((await rows(account.id)).map((r) => r.import_transaction_id)).toEqual([opening.id, fee.id]);
      });

      // Any unreconciled entry of the amount, on any day, kept the rebalance off
      // for as long as the row failed, and the sync log's note sends members to enter it by hand.
      it('compares the balances when the only entry of a dateless row\'s amount is far from the feed\'s days', async () => {
        const account = await linkedAccount('rebalance-failed-far-manual', { rebalance: true });
        const opening = { id: `RN1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(9) };
        const fee = { id: `RN2-${stamp}`, amount: '-40.00', description: 'FEE', posted: daysAgo(7) };
        feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [opening] }]);
        await fullSync();
        // An entry of the fee's amount 300 days back: the fee can't be linked to it.
        await tenant.pool.query(
          `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
           VALUES ($1, -40.00, 'Old fee', $2::date, 'expense', 'cleared')`,
          [account.id, appDay(daysAgo(300))]
        );
        // The bank's 915.00 is the fee and 45.00 the feed doesn't list; the ledger has the old
        // entry beside the deposit (960.00).
        feed = accountSet([{ id: account.importId, balance: '915.00', transactions: [opening, inMilliseconds(fee)] }]);
        for (let sync = 0; sync < 3; sync++) {
          await fullSync();
          expect(await adjustments(account.id)).toEqual(['-5.00']);
          expect(await balance(account.id)).toBe('955.00');
          expect((await lastSyncLog()).error_message).not.toContain(notAdjusted);
        }

        // An entry of its amount near the feed's days could be it: not compared.
        const near = await linkedAccount('rebalance-failed-near-manual', { rebalance: true });
        feed = accountSet([{ id: near.importId, balance: '1000.00', transactions: [{ ...opening, id: `RN3-${stamp}` }] }]);
        await fullSync();
        await tenant.pool.query(
          `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
           VALUES ($1, -40.00, 'Fee', $2::date, 'expense', 'cleared')`,
          [near.id, appDay(daysAgo(12))]
        );
        feed = accountSet([{ id: near.importId, balance: '915.00', transactions: [{ ...opening, id: `RN3-${stamp}` }, inMilliseconds({ ...fee, id: `RN4-${stamp}` })] }]);
        await fullSync();
        expect(await adjustments(near.id)).toEqual([]);
        expect((await lastSyncLog()).error_message).toContain(notAdjusted);
      });

      // The window started a match window before the feed's earliest dated row, so a
      // dateless row older than it (a fee 20 days back, the deposit 3) missed its own copy
      // entered by hand: +40.00 on the failing sync, -40.00 once it was saved and linked.
      it('starts the window at the start-date SimpleFin was asked for, when the ledger sets one', async () => {
        await tenant.pool.query(`INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('import_days_back', '30')`);
        try {
          const account = await linkedAccount('rebalance-failed-days-back', { rebalance: true });
          const deposit = { id: `RD1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(3) };
          const fee = { id: `RD2-${stamp}`, amount: '-40.00', description: 'FEE', posted: daysAgo(20) };
          feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [deposit] }]);
          await fullSync();
          expect(new URL(requested[requested.length - 1]).searchParams.get('start-date')).not.toBeNull();
          await tenant.pool.query(
            `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
             VALUES ($1, -40.00, 'Bank fee', $2::date, 'expense', 'cleared')`,
            [account.id, appDay(fee.posted)]
          );
          feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [deposit, inMilliseconds(fee)] }]);
          await fullSync();
          expect(await adjustments(account.id)).toEqual([]);
          expect((await lastSyncLog()).error_message).toContain(notAdjusted);

          // Saved, it is linked to the member's copy: nothing booked either way.
          feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [deposit, fee] }]);
          await fullSync();
          expect(await adjustments(account.id)).toEqual([]);
          expect(await balance(account.id)).toBe('960.00');
        } finally {
          await tenant.pool.query(`DELETE FROM tenant_settings WHERE setting_key = 'import_days_back'`);
        }
      });

      // As it stands, the window begins 5 days (a pending row's lag) before the
      // start-date, but a row is dated when it was transacted, and a cheque can post months after
      // it was written. A cheque written 50 days back and cashed 10 days back, entered by hand on
      // the day it was written, is outside the window: the failing sync books +40.00, and the one
      // that saves and links it books -40.00. A wider window (six months) would stop that pair, but
      // also stop the rebalance, real drift included, for as long as a dateless row of an amount
      // entered by hand in those months kept failing; which of the two is worse is left open.
      it("books a pair of adjustments for a dateless cheque written more than 5 days before the start-date", async () => {
        await tenant.pool.query(`INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('import_days_back', '30')`);
        try {
          const account = await linkedAccount('rebalance-failed-cheque', { rebalance: true });
          const deposit = { id: `RC1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(3) };
          const cheque = { id: `RC2-${stamp}`, amount: '-40.00', description: 'CHECK 1234', posted: daysAgo(10), transacted_at: daysAgo(50) };
          feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [deposit] }]);
          await fullSync();
          await tenant.pool.query(
            `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
             VALUES ($1, -40.00, 'Cheque to the plumber', $2::date, 'expense', 'cleared')`,
            [account.id, appDay(cheque.transacted_at)]
          );
          // Both its times in milliseconds: no date.
          const dateless = { ...inMilliseconds(cheque), transacted_at: cheque.transacted_at * 1000 };
          feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [deposit, dateless] }]);
          await fullSync();
          expect(await adjustments(account.id)).toEqual(['40.00']);

          // Saved, it is dated the day it was written and linked to the member's copy, and the
          // adjustment is undone.
          feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [deposit, cheque] }]);
          await fullSync();
          expect(await adjustments(account.id)).toEqual(['40.00', '-40.00']);
          expect(await balance(account.id)).toBe('960.00');
          const kept = (await rows(account.id)).filter((r) => r.type !== 'balance adjustment');
          expect(kept.map((r) => r.import_transaction_id)).toEqual([deposit.id, cheque.id]);
        } finally {
          await tenant.pool.query(`DELETE FROM tenant_settings WHERE setting_key = 'import_days_back'`);
        }
      });

      // The one-account sync passes the start-date too (ImportService's
      // runSingleAccountSync). Without it, its window started at the feed's rows, as above.
      it('starts the window at the start-date SimpleFin was asked for in a one-account sync too', async () => {
        await tenant.pool.query(`INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('import_days_back', '30')`);
        try {
          const account = await linkedAccount('rebalance-failed-days-back-single', { rebalance: true });
          const deposit = { id: `RS1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(3) };
          const fee = { id: `RS2-${stamp}`, amount: '-40.00', description: 'FEE', posted: daysAgo(20) };
          feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [deposit] }]);
          await single(account.uuid);
          expect(new URL(requested[requested.length - 1]).searchParams.get('start-date')).not.toBeNull();
          await tenant.pool.query(
            `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
             VALUES ($1, -40.00, 'Bank fee', $2::date, 'expense', 'cleared')`,
            [account.id, appDay(fee.posted)]
          );
          feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [deposit, inMilliseconds(fee)] }]);
          expect(await single(account.uuid)).toMatchObject({ success: true, status: 'partial' });
          expect(await adjustments(account.id)).toEqual([]);
          expect((await lastSyncLog()).error_message).toContain(notAdjusted);

          feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [deposit, fee] }]);
          await single(account.uuid);
          expect(await adjustments(account.id)).toEqual([]);
          expect(await balance(account.id)).toBe('960.00');
        } finally {
          await tenant.pool.query(`DELETE FROM tenant_settings WHERE setting_key = 'import_days_back'`);
        }
      });

      // Of two entries as near, the import's pick and the rebalance's could differ,
      // and one dated after today stood for the row without the balance counting it: +40.00 on
      // the failing sync, -40.00 once the row was saved.
      it("doesn't compare the balances while the entry the row would be linked to is dated after today", async () => {
        const account = await linkedAccount('rebalance-failed-future-manual', { rebalance: true });
        const opening = { id: `RT1-${stamp}`, amount: '1000.00', description: 'DEPOSIT', posted: daysAgo(9) };
        feed = accountSet([{ id: account.importId, balance: '1000.00', transactions: [opening] }]);
        await fullSync();
        const today = appDay(now);
        const entry = async (day: string) =>
          (
            await tenant.pool.query<{ id: number }>(
              `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
               VALUES ($1, -40.00, 'Fee', $2::date, 'expense', 'cleared') RETURNING id`,
              [account.id, day]
            )
          ).rows[0].id;
        // Tomorrow's first (the lower id), then the member's copy dated yesterday: a day from
        // today each. Updated, tomorrow's row lies after the other one in the table.
        const tomorrow = await entry(addDays(today, 1));
        const yesterday = await entry(addDays(today, -1));
        await tenant.pool.query(`UPDATE transactions SET notes = 'moved' WHERE id = $1`, [tomorrow]);
        // Dated today (transacted_at); its posted time past what a date holds: the row can't be saved.
        const fee = { id: `RT2-${stamp}`, amount: '-40.00', description: 'FEE', posted: now, transacted_at: now };
        feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [opening, { ...fee, posted: 9e12 }] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual([]);
        expect((await lastSyncLog()).error_message).toContain(notAdjusted);

        // Saved, it is linked to the lower id of the two, as the rebalance read it.
        feed = accountSet([{ id: account.importId, balance: '960.00', transactions: [opening, fee] }]);
        await fullSync();
        expect(await adjustments(account.id)).toEqual([]);
        const linked = (
          await tenant.pool.query<{ id: number }>('SELECT id FROM transactions WHERE import_transaction_id = $1', [fee.id])
        ).rows.map((r) => r.id);
        expect(linked).toEqual([tomorrow]);
        expect(yesterday).toBeGreaterThan(tomorrow);
      });
    });
  });

  describe('POST /api/import/sync while a sync of the ledger is running', () => {
    const app = express();
    beforeAll(() => {
      app.use(express.json());
      app.use((req, res, next) => tenant.context()(req, res, next));
      app.use('/api/import', createImportRoutes({ lifecycleService: {} as ApplicationLifecycleService, importService: new ImportService(globalPool) }));
    });

    it('says a full sync was partial when a transaction could not be saved', async () => {
      const account = await linkedAccount('route-partial');
      feed = accountSet([
        {
          id: account.importId,
          transactions: [
            { id: `RT1-${stamp}`, amount: '-1.00', description: 'FINE', posted: daysAgo(1) },
            { id: `RT2-${stamp}`, amount: 'garbled', description: 'BAD', posted: daysAgo(1) },
          ],
        },
      ]);
      const res = await request(app).post('/api/import/sync').expect(200);
      expect(res.body).toMatchObject({
        success: true,
        status: 'partial',
        message: expect.stringMatching(/^Sync completed with problems: 1 transaction could not be imported/),
      });
    });

    it('answers 409 for a full or a one-account sync, and the running sync finishes', async () => {
      const account = await linkedAccount('route');
      feed = accountSet([
        { id: account.importId, transactions: [{ id: `H1-${stamp}`, amount: '-1.00', description: 'HELD', posted: daysAgo(1) }] },
      ]);
      // The running sync waits inside its SimpleFin request until the requests below are answered.
      const barrier = new Barrier(3);
      let inside!: () => void;
      const runningIsInside = new Promise<void>((resolve) => (inside = resolve));
      beforeAnswer = () => {
        inside();
        return barrier.arrive();
      };
      const running = fullSync();
      await runningIsInside;

      const full = request(app).post('/api/import/sync').then((r) => (barrier.release(), r));
      const one = request(app).post(`/api/import/sync/${account.uuid}`).then((r) => (barrier.release(), r));
      const [fullRes, oneRes] = await Promise.all([full, one]);
      await running;

      expect(fullRes.status).toBe(409);
      expect(fullRes.body).toMatchObject({ code: 'SYNC_IN_PROGRESS' });
      expect(oneRes.status).toBe(409);
      expect(oneRes.body).toMatchObject({ code: 'SYNC_IN_PROGRESS' });
      expect((await rows(account.id)).map((r) => r.import_transaction_id)).toEqual([`H1-${stamp}`]);
    });
  });
});
