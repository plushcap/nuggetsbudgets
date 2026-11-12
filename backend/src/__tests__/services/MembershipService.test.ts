import { describe, it, expect, beforeEach, vi } from 'vitest';

// Chainable Kysely stub: executeTakeFirst() drains takeFirstQueue (one per call);
// execute() drains executeQueue (one array per call, [] when empty). Query-builder
// callbacks (joins, $if, eb.or) are ignored — only call order/shape matters.
const { takeFirstQueue, executeQueue, builder } = vi.hoisted(() => {
  const takeFirstQueue: unknown[] = [];
  const executeQueue: unknown[][] = [];
  const builder: object = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'executeTakeFirst') return () => Promise.resolve(takeFirstQueue.shift());
        if (prop === 'execute') return () => Promise.resolve(executeQueue.shift() ?? []);
        return () => builder;
      },
    }
  );
  return { takeFirstQueue, executeQueue, builder };
});

vi.mock('../../db/withTenant.js', () => ({
  globalDb: { selectFrom: () => builder },
  getDb: () => builder,
  withTenant: async (_id: number, fn: (trx: unknown) => unknown) => fn(builder),
}));

import { getMembershipSummary, userIsDeploymentAdmin } from '../../services/MembershipService.js';

// One accessible-budget row as projected by getMembershipSummary's main query.
function budgetRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 5,
    tenantUuid: 'tenant-uuid',
    tenantName: 'Ledger 1',
    tenantStatus: 'active',
    orgUuid: 'org-uuid',
    orgName: 'Organization 1',
    tenantIsAdmin: false,
    orgIsAdmin: null,
    ...overrides,
  };
}

beforeEach(() => {
  takeFirstQueue.length = 0;
  executeQueue.length = 0;
});

describe('userIsDeploymentAdmin', () => {
  it('true when a deployment_users admin row exists', async () => {
    takeFirstQueue.push({ id: 1 });
    expect(await userIsDeploymentAdmin(1)).toBe(true);
  });
  it('false when there is no row', async () => {
    takeFirstQueue.push(undefined);
    expect(await userIsDeploymentAdmin(2)).toBe(false);
  });
});

describe('getMembershipSummary', () => {
  // Query order: userIsDeploymentAdmin (takeFirst), budgets (execute), orgs (execute).
  it('marks a plain budget member as role "member"', async () => {
    takeFirstQueue.push(undefined); // not deployment admin
    executeQueue.push([budgetRow({ tenantIsAdmin: false, orgIsAdmin: null })]);
    executeQueue.push([{ uuid: 'org-uuid', name: 'Organization 1', status: 'active', isAdmin: false }]);

    const result = await getMembershipSummary(1, 5);

    expect(result.isDeploymentAdmin).toBe(false);
    expect(result.tenants).toHaveLength(1);
    expect(result.tenants[0].role).toBe('member');
    expect(result.tenants[0].isActiveTenant).toBe(true);
    expect(result.activeTenant?.uuid).toBe('tenant-uuid');
    expect(result.tenantRole).toBe('member');
    expect(result.orgRole).toBe('member');
    expect(result.organizations[0].role).toBe('member');
  });

  it('marks a tenant_users admin as role "admin" on that budget', async () => {
    takeFirstQueue.push(undefined);
    executeQueue.push([budgetRow({ tenantIsAdmin: true, orgIsAdmin: null })]);
    executeQueue.push([]);

    const result = await getMembershipSummary(1, 5);

    expect(result.tenants[0].role).toBe('admin');
    expect(result.tenantRole).toBe('admin');
    expect(result.orgRole).toBe('member'); // not an org admin
  });

  it('treats a deployment admin as admin everywhere', async () => {
    takeFirstQueue.push({ id: 1 }); // deployment admin
    executeQueue.push([budgetRow({ tenantId: 9, tenantIsAdmin: null, orgIsAdmin: null })]);
    executeQueue.push([]);

    const result = await getMembershipSummary(1, null);

    expect(result.isDeploymentAdmin).toBe(true);
    expect(result.tenants[0].role).toBe('admin');
    // No active budget selected.
    expect(result.activeTenant).toBeNull();
    expect(result.tenantRole).toBeNull();
    expect(result.orgRole).toBeNull();
  });

  it('returns null active context when the active id is not among accessible budgets', async () => {
    takeFirstQueue.push(undefined);
    executeQueue.push([budgetRow({ tenantId: 5 })]);
    executeQueue.push([]);

    const result = await getMembershipSummary(1, 999); // 999 not in the list

    expect(result.activeTenant).toBeNull();
    expect(result.tenantRole).toBeNull();
    expect(result.tenants[0].isActiveTenant).toBe(false);
  });
});
