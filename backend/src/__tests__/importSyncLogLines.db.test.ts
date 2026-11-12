import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import globalPool from '../db.js';
import { ImportService } from '../services/ImportService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { calendarDateIn } from '../utils/calendarDate.js';

/**
 * A bank sync's log lines carry ids and counts, not the accounts' or the bank's names,
 * amounts, balances, payees or descriptions. Every line the sync's services
 * log, at every level (debug too), is captured as JSON and searched for each one the feed
 * and the ledger hold: the starting and lookup lines named the account, the rebalance logged
 * the balances and the adjustment, the importer the amounts of a failed row (and a database
 * error quoting one), a pending row replaced and one that left the feed, the merchant and
 * manual-entry matches the payee, description and amount, the fetch every account's name and
 * balance, a missing institution its name, the net worth snapshots the net worth. Two full
 * syncs and a one-account sync run; SimpleFin's answer is stubbed at `fetch`, as
 * importSync.db.test.ts does, and the organization's stored credential replaced.
 *
 * What is searched leaves out what can't hold an amount but can look like one: `time` (epoch
 * milliseconds), `pid`, `hostname` and an error's stack (file paths). An amount is matched as
 * a value of its own, not inside a longer number, an id or a uuid.
 */

const captured = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  const { default: pino } = await import('pino');
  // Every level, through the app's own redaction, into `captured.lines`.
  const capture = pino(
    { level: 'trace', redact: { paths: actual.REDACT_PATHS, censor: '[REDACTED]' } },
    { write: (line: string) => void captured.lines.push(line) }
  );
  return { ...actual, createLogger: (context: Record<string, unknown>) => capture.child(context) };
});

vi.mock('../services/OrganizationSimpleFinService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/OrganizationSimpleFinService.js')>();
  return { ...actual, getAccessUrlForTenant: vi.fn(async () => 'https://user:secret@bridge.simplefin.org/simplefin') };
});

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const daysAgo = (n: number) => now - n * DAY;

const CONNECTION = {
  conn_id: `CONN-${stamp}`,
  name: 'Log Test Bank',
  org_id: `org-${stamp}`,
  org_url: `https://logbank-${stamp}.example`,
  sfin_url: 'https://bridge.simplefin.org/simplefin',
};
// A bank no institution in the ledger has: the sync skips it, and named it.
const UNKNOWN_BANK = {
  conn_id: `CONN2-${stamp}`,
  name: 'INSTITUTION SECRET',
  org_id: `org2-${stamp}`,
  org_url: `https://unknownbank-${stamp}.example`,
  sfin_url: 'https://bridge.simplefin.org/simplefin',
};

interface FeedAccount {
  id: string;
  name: string;
  balance: string;
  conn?: typeof CONNECTION;
  transactions: Array<{ id: string; amount: string; description: string; payee?: string; posted: number; pending?: boolean }>;
}
const accountSet = (accounts: FeedAccount[]) => ({
  errlist: [{ code: 'act.sync', msg: `SF NAME ALPHA ${stamp} could not be refreshed`, conn_id: CONNECTION.conn_id }],
  connections: [CONNECTION, UNKNOWN_BANK],
  accounts: accounts.map(({ conn, ...a }) => ({ ...a, conn_id: (conn ?? CONNECTION).conn_id, currency: 'USD', 'balance-date': now })),
});

// What must never reach a log line: names, payees and descriptions, and amounts (as the
// feed and the ledger write them, and as a number prints).
const NAMES = [
  'SF NAME ALPHA', 'SF NAME BRAVO', 'SF NAME CHARLIE', 'SF NAME DELTA',
  'LEDGER NAME ALPHA', 'LEDGER NAME BRAVO', 'LEDGER NAME DELTA', 'INSTITUTION SECRET',
];
const TEXTS = [
  'PAYEE SECRET ONE', 'DESC SECRET ONE', 'DESC SECRET TWO', 'DESC SECRET THREE', 'MANUAL SECRET', 'PENDING SECRET',
  'VANISHING SECRET', 'GARBLED SECRET', 'INCOME SECRET', 'UNLINKED SECRET',
];
// Alpha's ledger, sync by sync: -111.11, -222.22 (linked to the hand entry), -66.66 and
// -77.77 pending; posted -333.33, so an adjustment of 1567.89 to the bank's 1234.56
// (balance 1090.13). Then -66.66 posts, posted 1167.90, adjustment 66.66 (balance 1156.79);
// then -33.33 (balance 1123.46, posted 1201.23, adjustment 33.33). Bravo's income of 31.37
// turns -31.37, which the database refuses.
const AMOUNTS = [
  '111.11', '222.22', '66.66', '77.77', '33.33', '31.37', '1,444.44', '1444.44', '444.44', '888.88', '1234.56', '999.01',
  '555.55', '1567.89', '333.33', '477.76', '144.43', '1090.13', '1167.90', '1167.9', '1156.79', '1123.46', '1201.23',
];
const SKIPPED_KEYS = new Set(['time', 'pid', 'hostname']);

/** Every value a line holds, as [path, value], without the keys that can't hold an amount or an error's stack. */
function leaves(value: unknown, path: string[] = []): Array<[string, string | number]> {
  if (typeof value === 'string' || typeof value === 'number') return [[path.join('.'), value]];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    (path.length === 0 && SKIPPED_KEYS.has(key)) || key === 'stack' ? [] : leaves(child, [...path, key])
  );
}

/** `amount` as a value of its own in `text`: not inside a longer number, an id or a uuid. */
const amountIn = (amount: string, text: string) =>
  new RegExp(`(?<![0-9A-Za-z.])-?${amount.replace(/[.,]/g, (c) => `\\${c}`)}(?![0-9A-Za-z])`).test(text);

describe("a bank sync's log lines", () => {
  let tenant: TestTenant;
  const service = new ImportService(globalPool);
  let feed: ReturnType<typeof accountSet>;

  async function linkedAccount(label: string, name: string, rebalance = false) {
    const importId = `SF-${label}-${stamp}`;
    const row = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                               import_auto_assign_budget_period, import_auto_assign_budget_item, import_account_rebalance)
         VALUES ($1, 'checking', 'cash', 'Asset', $2, 'simplefin', true, false, false, $3) RETURNING id, uuid`,
        [`${name} ${stamp}`, importId, rebalance]
      )
    ).rows[0];
    return { id: row.id as number, uuid: row.uuid as string, importId };
  }

  beforeAll(async () => {
    tenant = await createTestTenant('Sync log lines');
    const zone = (await tenant.pool.query<{ zone: string }>('SELECT app_timezone() AS zone')).rows[0].zone;
    await tenant.pool.query(`INSERT INTO account_institutions (name, import_domain) VALUES ('Log Test Bank', $1)`, [
      new URL(CONNECTION.org_url).hostname,
    ]);
    const alpha = await linkedAccount('alpha', 'LEDGER NAME ALPHA', true);
    const bravo = await linkedAccount('bravo', 'LEDGER NAME BRAVO');
    const delta = await linkedAccount('delta', 'LEDGER NAME DELTA');
    // A merchant the payee names, for the import to match by name.
    await tenant.pool.query(`INSERT INTO merchants (name) VALUES ('PAYEE SECRET ONE')`);
    // Entered by hand, for the import to link to.
    await tenant.pool.query(
      `INSERT INTO transactions (account_id, type, amount, description, transaction_date, is_import)
       VALUES ($1, 'expense', -222.22, 'MANUAL SECRET', $2, false)`,
      [alpha.id, calendarDateIn(zone, new Date(daysAgo(1) * 1000))]
    );

    const alphaRows = [
      { id: `T1-${stamp}`, amount: '-111.11', description: 'DESC SECRET ONE', payee: 'PAYEE SECRET ONE', posted: daysAgo(2) },
      { id: `T2-${stamp}`, amount: '-222.22', description: 'DESC SECRET TWO', posted: daysAgo(1) },
    ];
    const accounts = (alphaExtra: FeedAccount['transactions'], income: string): FeedAccount[] => [
      { id: alpha.importId, name: `SF NAME ALPHA ${stamp}`, balance: '1234.56', transactions: [...alphaRows, ...alphaExtra] },
      {
        id: bravo.importId,
        name: `SF NAME BRAVO ${stamp}`,
        balance: '0.00',
        transactions: [
          // An amount written another way: refused, and the row skipped.
          { id: `TB-${stamp}`, amount: '1,444.44', description: 'GARBLED SECRET', posted: daysAgo(1) },
          // An income, then the bank makes it negative: the database refuses the update.
          { id: `TI-${stamp}`, amount: income, description: 'INCOME SECRET', posted: daysAgo(2) },
        ],
      },
      // Not linked to a ledger account, at a bank no institution has.
      {
        id: `SF-charlie-${stamp}`,
        name: `SF NAME CHARLIE ${stamp}`,
        balance: '999.01',
        conn: UNKNOWN_BANK,
        transactions: [{ id: `TC-${stamp}`, amount: '-888.88', description: 'UNLINKED SECRET', posted: daysAgo(1) }],
      },
      // Linked, with a balance and no transactions.
      { id: delta.importId, name: `SF NAME DELTA ${stamp}`, balance: '555.55', transactions: [] },
    ];

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(feed), { status: 200, headers: { 'content-type': 'application/json' } })));
    const options = { syncType: 'manual', syncTrigger: 'user', userId: tenant.userId } as const;

    // Two pending purchases; then one posts under a new id and the other leaves the feed;
    // then a one-account sync of alpha brings one more.
    feed = accountSet(accounts([
      { id: `P1-${stamp}`, amount: '-66.66', description: 'PENDING SECRET', posted: daysAgo(3), pending: true },
      { id: `P2-${stamp}`, amount: '-77.77', description: 'VANISHING SECRET', posted: daysAgo(3), pending: true },
    ], '31.37'));
    await service.runFullSync(tenant.tenantId, options);
    const posted = { id: `P1X-${stamp}`, amount: '-66.66', description: 'PENDING SECRET', posted: daysAgo(1) };
    feed = accountSet(accounts([posted], '-31.37'));
    await service.runFullSync(tenant.tenantId, options);
    feed = accountSet(accounts([posted, { id: `T3-${stamp}`, amount: '-33.33', description: 'DESC SECRET THREE', posted: daysAgo(1) }], '-31.37'));
    const single = await service.runSingleAccountSync(tenant.tenantId, alpha.uuid, options);
    vi.unstubAllGlobals();

    // What the syncs did, so the lines searched below are the ones that say so.
    expect(single).toMatchObject({ success: true, transactionsImported: 1 });
    const alphaTx = (
      await tenant.pool.query<{ import_transaction_id: string | null; type: string }>(
        'SELECT import_transaction_id, type FROM transactions WHERE account_id = $1 ORDER BY id',
        [alpha.id]
      )
    ).rows;
    expect(alphaTx.map((t) => t.import_transaction_id)).toEqual(
      expect.arrayContaining([`T1-${stamp}`, `T2-${stamp}`, `P1X-${stamp}`, `P2-${stamp}`, `T3-${stamp}`])
    );
    expect(alphaTx.filter((t) => t.type === 'balance adjustment').length).toBeGreaterThanOrEqual(2);
    const income = (await tenant.pool.query('SELECT amount::text FROM transactions WHERE import_transaction_id = $1', [`TI-${stamp}`])).rows;
    expect(income).toEqual([{ amount: '31.37' }]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await tenant?.cleanup();
  });

  const lines = () => captured.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const said = (msg: string) => lines().filter((line) => line.msg === msg);

  it('logged what the syncs did: every path the old lines named something on', () => {
    for (const msg of [
      'SimpleFin accounts fetched',
      'SimpleFin returned errors',
      'SimpleFin returned errors during account sync',
      'Starting account sync',
      'Account lookup result',
      'Checking for transactions to import',
      'Account has no transactions from SimpleFin',
      'Skipping unlinked account - not linked by user',
      'Institution not found - skipping auto-creation. User must manually create institution',
      'Could not import transaction; skipped it and carried on with the others',
      'A pending transaction posted under a new id; updated it in place',
      'Pending transactions are no longer in the bank feed and no posted transaction was matched to them; flagged for review',
      'Found potential manual transaction match',
      'Merchant matched by exact name',
      'Created new merchant from import',
      'Created balance adjustment',
      'Created balance adjustment transaction',
      '⚠️ Institutions skipped (not found in database - must be created manually)',
      '⚠️ Accounts skipped (not linked to Nuggets accounts)',
      'ℹ️ Accounts with no transactions from SimpleFin',
      '✅ Net worth snapshot created',
      '✅ Net worth snapshot updated',
    ]) {
      expect(said(msg), msg).not.toEqual([]);
    }
  });

  it('names no account or bank, and carries no amount, balance, payee or description', () => {
    const found: string[] = [];
    for (const line of lines()) {
      for (const [path, value] of leaves(line)) {
        const text = String(value);
        for (const name of [...NAMES, ...TEXTS]) if (text.includes(name)) found.push(`${line.msg} ${path}: ${name}`);
        for (const amount of AMOUNTS) if (amountIn(amount, text)) found.push(`${line.msg} ${path}: ${amount}`);
        // Nor any other value with cents.
        if (typeof value === 'number' ? !Number.isInteger(value) : /(?<![\w.])-?\d+\.\d{2}(?![\w.])/.test(value)) {
          found.push(`${line.msg} ${path}: ${text}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('says which accounts, rows and failures by their ids and codes', () => {
    expect(said('Account lookup result')[0]).toMatchObject({ importAccountId: expect.any(String), foundInDb: expect.any(Boolean) });
    const failedRows = said('Could not import transaction; skipped it and carried on with the others');
    expect(failedRows).toContainEqual(expect.objectContaining({
      importTransactionId: `TB-${stamp}`,
      err: expect.objectContaining({ message: "SimpleFin sent an amount that isn't a number (text of 8 characters)" }),
    }));
    // The database refused the negative income: its code and where, not its message.
    const refused = failedRows.find((line) => line.importTransactionId === `TI-${stamp}`);
    expect(refused).toMatchObject({ dbError: { code: '23514', routine: expect.any(String) } });
    expect(refused).not.toHaveProperty('err');
    expect(said('SimpleFin returned errors')[0]).toMatchObject({ simplefinErrors: [{ code: 'act.sync', conn_id: CONNECTION.conn_id }] });
    expect(said('Institution not found - skipping auto-creation. User must manually create institution')[0]).toMatchObject({
      domain: new URL(UNKNOWN_BANK.org_url).hostname,
      importOrgId: UNKNOWN_BANK.org_id,
    });
    expect(said('⚠️ Accounts skipped (not linked to Nuggets accounts)')[0]).toMatchObject({ importAccountIds: [`SF-charlie-${stamp}`] });
    expect(said('✅ Net worth snapshot updated')[0]).toMatchObject({ snapshotId: expect.any(Number) });
  });

  it('matches an amount as a value of its own, not inside a time, an id or a uuid', () => {
    expect(amountIn('400.13', 'amount -400.13)')).toBe(true);
    expect(amountIn('400.13', '1400.13')).toBe(false);
    expect(amountIn('31.37', 'an income can\'t be negative (transaction 0190…, amount -31.37)')).toBe(true);
    expect(leaves({ time: 1793836640400, pid: 400, err: { stack: 'at /home/400.13/x.js', message: 'ok' } })).toEqual([['err.message', 'ok']]);
  });
});
