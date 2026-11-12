import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'kysely';
import globalPool from '../db.js';
import { getDb, withTenant } from '../db/withTenant.js';
import { BalanceRebalanceService } from '../services/BalanceRebalanceService.js';
import NetWorthService from '../services/NetWorthService.js';
import { ImportService } from '../services/ImportService.js';
import type { TransactionImporter } from '../services/import/TransactionImporter.js';
import { calendarDateIn } from '../utils/calendarDate.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * "Today", and the day an imported transaction happened, is the calendar day
 * in the application_timezone setting: not the UTC day the code used, and not
 * CURRENT_DATE, which follows the Postgres session's zone.
 *
 * application_timezone is global, so each test sets it inside its own ledger's
 * transaction and rolls the whole transaction back: no other file ever sees it.
 */

class Rollback extends Error {}

/** Run `fn` in the tenant's transaction with application_timezone = `zone`, then roll it all back. */
async function withZone<T>(tenantId: number, zone: string, fn: () => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await withTenant(tenantId, async () => {
      await sql`
        INSERT INTO system_settings (setting_key, setting_value, category)
        VALUES ('application_timezone', ${zone}, 'general')
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
      `.execute(getDb());
      result = { value: await fn() };
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  if (!result) throw new Error('withZone: fn did not finish');
  return result.value;
}

async function insertAccount(name: string): Promise<number> {
  const row = await getDb()
    .insertInto('accounts')
    .values({ name, account_type: 'checking', account_group: 'cash', type: 'Asset' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('today is the day in the application time zone', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('App today');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dates a balance adjustment made at 10:30 pm in New York that day, not the UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T02:30:00Z')); // Oct 31, 10:30 pm EDT

    const transactionDate = await withZone(tenant.tenantId, 'America/New_York', async () => {
      const accountId = await insertAccount('Adjusted checking');
      const { uuid } = await new BalanceRebalanceService().createBalanceAdjustmentTransaction(accountId, -5, 100);
      const row = await getDb()
        .selectFrom('transactions')
        .select('transaction_date')
        .where('uuid', '=', uuid)
        .executeTakeFirstOrThrow();
      return row.transaction_date;
    });

    expect(transactionDate).toBe('2026-10-31');
  });

  it("dates SQL's snapshot of today in the application zone, not the session's", async () => {
    // A zone whose day differs from UTC's right now: Kiritimati (UTC+14) is a day
    // ahead from 10:00 UTC, Etc/GMT+12 (UTC-12) a day behind until 12:00 UTC.
    const zone = new Date().getUTCHours() >= 12 ? 'Pacific/Kiritimati' : 'Etc/GMT+12';
    const expected = calendarDateIn(zone);
    expect(expected).not.toBe(calendarDateIn('UTC'));

    const snapshotDate = await withZone(tenant.tenantId, zone, async () => {
      const snapshot = await new NetWorthService().createSnapshotIfNeeded('manual');
      return snapshot?.snapshot_date;
    });

    expect(snapshotDate).toBe(expected);
  });

  it('gives an imported transaction the date and the budget period of the same day', async () => {
    // A card swipe at 10:30 pm on Sep 30 in New York: 02:30 on Oct 1 in UTC.
    const transactedAt = Date.parse('2026-10-01T02:30:00Z') / 1000;

    const imported = await withZone(tenant.tenantId, 'America/New_York', async () => {
      const periods: Record<string, number> = {};
      for (const [month, number, start, end] of [
        ['September', 9, '2026-09-01', '2026-09-30'],
        ['October', 10, '2026-10-01', '2026-10-31'],
      ] as const) {
        periods[month] = (
          await getDb()
            .insertInto('budget_period')
            .values({ name: `${month} 2026`, month, year: 2026, month_number: number, start_date: start, end_date: end })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      const accountId = await insertAccount('Imported checking');
      const importer = (new ImportService(globalPool) as unknown as { transactions: TransactionImporter }).transactions;
      const result = await importer.importTransactions(accountId, [
        { id: `late-swipe-${Date.now()}`, posted: transactedAt + 86_400, transacted_at: transactedAt, amount: '-12.34', description: 'Late swipe' },
      ]);
      expect(result.imported).toBe(1);
      const row = await getDb()
        .selectFrom('transactions')
        .select(['transaction_date', 'budget_period_id'])
        .where('account_id', '=', accountId)
        .executeTakeFirstOrThrow();
      return { ...row, periods };
    });

    expect(imported.transaction_date).toBe('2026-09-30');
    expect(imported.budget_period_id).toBe(imported.periods.September);
  });

  it('falls back to UTC, in code and SQL alike, for a zone that does not exist', async () => {
    const { appTimezone } = await import('../utils/appDate.js');
    const zones = await withZone(tenant.tenantId, 'Not/AZone', async () => {
      const { rows } = await sql<{ zone: string; today: string }>`SELECT app_timezone() AS zone, app_today()::text AS today`.execute(getDb());
      return { sql: rows[0], code: await appTimezone() };
    });
    expect(zones.sql.zone).toBe('UTC');
    expect(zones.code).toBe('UTC');
    expect(zones.sql.today).toBe(calendarDateIn('UTC'));
  });

  // Postgres read CET as the abbreviation (+01:00 all year) where
  // JavaScript applied Central European summer time, so the two disagreed on the day for
  // an hour; and a name its tzdata lacks fell back to UTC in SQL alone.
  it('takes as the application zone only a name both runtimes read as that zone', async () => {
    const { isAppTimeZone } = await import('../utils/appDate.js');
    for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Etc/GMT+5', 'Europe/Paris']) {
      expect(await isAppTimeZone(zone), zone).toBe(true);
    }
    for (const zone of ['CET', 'EST', 'MST', 'IST', 'PST', 'GMT', '+05:00', 'UTC+5', 'localtime', '', 'Not/AZone']) {
      expect(await isAppTimeZone(zone), zone).toBe(false);
    }
    // Present in some Postgres builds' tzdata and not others: allowed exactly where it is.
    const { rows } = await globalPool.query<{ known: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = 'US/Eastern') AS known`);
    expect(await isAppTimeZone('US/Eastern')).toBe(rows[0].known);
  });

  // Node and Postgres each carry a copy of the time-zone database.
  // Where the copies differ on a zone's rules (Morocco's, between tz 2025b and 2026e),
  // a day computed with Intl differed from app_today() for an hour a night. The code
  // now asks Postgres, so the two agree whatever the copies say.
  it("computes the code's days in Postgres, so they match app_today() in every zone", async () => {
    const { appDateOf, appDatesOf, appLocalTime } = await import('../utils/appDate.js');
    const instants = ['2026-11-01T23:30:00Z', '2026-03-29T00:30:00Z', '2026-10-28T02:30:00Z'].map((at) => new Date(at));
    for (const zone of ['Africa/Casablanca', 'America/New_York', 'Pacific/Kiritimati', 'UTC']) {
      const { code, sqlDays } = await withZone(tenant.tenantId, zone, async () => {
        const { rows } = await sql<{ day: string }>`
          SELECT (t AT TIME ZONE app_timezone())::date::text AS day
            FROM unnest(${instants.map((i) => i.toISOString())}::timestamptz[]) WITH ORDINALITY AS u(t, n) ORDER BY n
        `.execute(getDb());
        return { code: [await appDateOf(instants[0]), ...(await appDatesOf(instants.slice(1)))], sqlDays: rows.map((r) => r.day) };
      });
      expect(code, zone).toEqual(sqlDays);
    }
    const newYork = await withZone(tenant.tenantId, 'America/New_York', () => appLocalTime(new Date('2026-10-28T02:30:00Z')));
    expect(newYork).toEqual({ day: '2026-10-27', minutes: 22 * 60 + 30 });
  });
});
