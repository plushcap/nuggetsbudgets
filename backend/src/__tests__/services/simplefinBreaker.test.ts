import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { runWithRequestContext } from '../../context/requestContext.js';
import { ImportService, NoSimpleFinConnectionError } from '../../services/ImportService.js';
import { circuitBreakerService } from '../../services/CircuitBreakerService.js';
import { SimpleFinClient } from '../../services/import/SimpleFinClient.js';

/**
 * SimpleFin requests go through a circuit breaker. There used to be one for the whole
 * deployment, so a few failures in one family (an organization without a connection
 * was enough) turned away every other family's requests for 30 seconds.
 */
describe('The SimpleFin circuit breaker', () => {
  const service = new ImportService({} as Pool);
  const fetchInternal = vi.spyOn(
    SimpleFinClient.prototype as unknown as { fetchAccountsInternal: () => Promise<unknown> },
    'fetchAccountsInternal'
  );
  const asTenant = <T>(tenantId: number, fn: () => Promise<T>) =>
    runWithRequestContext({ userId: 1, tenantId, isDeploymentAdmin: false }, fn);
  const fetchFor = (tenantId: number) => asTenant(tenantId, () => service.fetchAccounts());
  const ok = { accounts: [], errlist: [], connections: [] };

  afterEach(() => {
    fetchInternal.mockReset();
    circuitBreakerService.clearAll();
  });

  it("opens for the ledger whose requests fail, not for the others'", async () => {
    fetchInternal.mockImplementation(async () => {
      throw new Error('SimpleFin answered 500');
    });
    for (let i = 0; i < 4; i++) await expect(fetchFor(901)).rejects.toThrow();
    await expect(fetchFor(901)).rejects.toThrow(/currently unavailable/);

    fetchInternal.mockResolvedValue(ok);
    await expect(fetchFor(902)).resolves.toEqual(ok);
  });

  it("doesn't count a missing connection as SimpleFin failing", async () => {
    fetchInternal.mockImplementation(async () => {
      throw new NoSimpleFinConnectionError();
    });
    for (let i = 0; i < 6; i++) await expect(fetchFor(903)).rejects.toBeInstanceOf(NoSimpleFinConnectionError);
    fetchInternal.mockResolvedValue(ok);
    await expect(fetchFor(903)).resolves.toEqual(ok);
  });
});
