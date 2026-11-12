import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock state, hoisted so the vi.mock factories below can close over it.
const { sqlCalls, sqlExecute, transactions } = vi.hoisted(() => ({
  sqlCalls: [] as { text: string; values: unknown[] }[],
  // withTenant reads the organization it set from the first row.
  sqlExecute: vi.fn().mockResolvedValue({ rows: [{ organization_id: '9' }] }),
  // Each db.transaction() is a new fake transaction, numbered from 1.
  transactions: [] as Array<{ __trx: number }>,
}));

// Stub the kysely `sql` tag: record each call and no-op its .execute() so the
// test never touches Postgres. Everything else from kysely is the real module.
vi.mock('kysely', async (importOriginal) => {
  const actual = await importOriginal<typeof import('kysely')>();
  return {
    ...actual,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ text: strings.join('?'), values });
      return { execute: sqlExecute };
    },
  };
});

// db.transaction().execute(cb) → cb(a new fake trx); no real connection/transaction.
vi.mock('../db.js', () => ({
  default: {},
  db: {
    transaction: () => ({
      execute: (cb: (trx: unknown) => unknown) => {
        const trx = { __trx: transactions.length + 1 };
        transactions.push(trx);
        return cb(trx);
      },
    }),
  },
}));

import {
  withTenant,
  withOrganization,
  getDb,
  getOrgDb,
  getCurrentOrganizationId,
  runDetached,
} from '../db/withTenant.js';

beforeEach(() => {
  sqlCalls.length = 0;
  transactions.length = 0;
  sqlExecute.mockClear();
});

describe('withTenant', () => {
  it("sets the transaction-local tenant GUC and the tenant's organization, runs fn with the trx, returns its result", async () => {
    const seen: unknown[] = [];
    const result = await withTenant(42, async (trx) => {
      seen.push(trx);
      return 'done';
    });

    expect(result).toBe('done');
    expect(seen).toEqual([transactions[0]]); // fn receives the transaction
    // The GUC statement, then the check that nothing aborted the transaction.
    expect(sqlExecute).toHaveBeenCalledTimes(2);
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[1].text).toBe('select 1');
    expect(sqlCalls[0].text).toContain('set_config');
    expect(sqlCalls[0].text).toContain('app.current_tenant_id');
    // The organization is the tenant's own, looked up in the same statement.
    expect(sqlCalls[0].text).toMatch(/set_config\('app\.current_organization_id',\s+coalesce\(\(select organization_id::text from public\.tenants where id = \?\), ''\),\s+true\)/);
    expect(sqlCalls[0].text).toContain('true'); // is_local => true (transaction-local)
    expect(sqlCalls[0].values).toEqual(['42', 42]); // tenant id as bound params, not interpolated
  });

  it('propagates errors thrown by fn', async () => {
    await expect(
      withTenant(1, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });

  it('getDb() throws when called with no tenant context (fail-loud)', () => {
    expect(() => getDb()).toThrow(/no tenant context/i);
  });

  it('getDb() returns the active tenant transaction inside withTenant', async () => {
    const handle = await withTenant(7, async () => getDb());
    expect(handle).toBe(transactions[0]);
  });

  it("getOrgDb() returns the tenant transaction, whose organization is the tenant's", async () => {
    const seen = await withTenant(7, async () => ({ db: getOrgDb(), org: getCurrentOrganizationId() }));
    expect(seen).toEqual({ db: transactions[0], org: 9 });
  });

  it('getOrgDb() throws in a tenant transaction of a tenant with no organization', async () => {
    sqlExecute.mockResolvedValueOnce({ rows: [{ organization_id: '' }] });
    await expect(withTenant(404, async () => getOrgDb())).rejects.toThrow(/no organization context/i);
  });
});

describe('withOrganization', () => {
  it('sets the transaction-local organization GUC (bound, not interpolated) and no tenant', async () => {
    const seen = await withOrganization(5, async (trx) => ({ trx, db: getOrgDb(), org: getCurrentOrganizationId() }));
    expect(seen).toEqual({ trx: transactions[0], db: transactions[0], org: 5 });
    expect(sqlCalls.map((c) => c.text)).toEqual([
      "select set_config('app.current_organization_id', ?, true)",
      'select 1',
    ]);
    expect(sqlCalls[0].values).toEqual(['5']);
  });

  it('getOrgDb() throws with no organization context (fail-loud)', () => {
    expect(() => getOrgDb()).toThrow(/no organization context/i);
  });

  it('joins a tenant transaction of the same organization', async () => {
    const seen = await withTenant(7, async (tenantTrx) => ({
      tenantTrx,
      same: await withOrganization(9, async (trx) => trx),
      // Back in the tenant transaction afterwards.
      after: getOrgDb(),
    }));
    expect(transactions).toHaveLength(1);
    expect(seen).toEqual({ tenantTrx: transactions[0], same: transactions[0], after: transactions[0] });
  });

  // It opened a second pooled connection, whose write committed even when the ledger's
  // transaction rolled back, and in which getCurrentTenantId() still answered the ledger.
  it("refuses another organization inside a tenant transaction, opening no connection and running nothing", async () => {
    const ran = vi.fn();
    await withTenant(7, async () => {
      await expect(withOrganization(10, async () => ran())).rejects.toThrow(
        /withOrganization\(10\) was called inside a transaction of organization 9: it would open a second connection/
      );
      // The tenant transaction is untouched and still the one in use.
      expect(getDb()).toBe(transactions[0]);
      expect(getOrgDb()).toBe(transactions[0]);
    });
    expect(ran).not.toHaveBeenCalled();
    expect(transactions).toHaveLength(1);
  });

  it("refuses another organization inside a withOrganization, and inside a ledger that has none", async () => {
    await withOrganization(5, async () => {
      await expect(withOrganization(6, async () => 'x')).rejects.toThrow(/inside a transaction of organization 5/);
    });
    sqlExecute.mockResolvedValueOnce({ rows: [{ organization_id: '' }] });
    await withTenant(404, async () => {
      await expect(withOrganization(6, async () => 'x')).rejects.toThrow(/inside a transaction of a tenant with no organization/);
    });
    expect(transactions).toHaveLength(2);
  });

  it('opens its own once the outer transaction has ended', async () => {
    await withTenant(7, async () => undefined);
    const own = await withOrganization(10, async (trx) => ({ trx, org: getCurrentOrganizationId() }));
    expect(own).toEqual({ trx: transactions[1], org: 10 });
    expect(() => getDb()).toThrow(/no tenant context/i);
  });

  it('joins an enclosing withOrganization of the same organization', async () => {
    const inner = await withOrganization(5, async () => withOrganization(5, async (trx) => trx));
    expect(transactions).toHaveLength(1);
    expect(inner).toBe(transactions[0]);
  });

  it('starts clean in runDetached, so a timer armed in one never joins a finished transaction', async () => {
    const detached = await withOrganization(5, async () => runDetached(() => getCurrentOrganizationId()));
    expect(detached).toBeUndefined();
  });
});
