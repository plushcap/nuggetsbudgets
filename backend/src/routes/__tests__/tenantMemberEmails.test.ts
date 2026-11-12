import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * Adding someone to a ledger by email (POST /api/tenants/current/members) finds them
 * among its organization's members whatever the case their address was stored in, as
 * the organization routes do: one stored exactly as asked wins, and two or more
 * that differ only in case, none exact, are refused (409 EMAIL_AMBIGUOUS) rather than one
 * picked. It used to take whichever row came first. Only the organization's members are
 * looked at: an account outside it changes no answer.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('adding a ledger member by email, whatever its case', () => {
  let h: RouteHarness;
  let c: TestTenant;
  let tenantAdmin: string;

  beforeAll(async () => {
    h = await startRouteHarness('Ledger member emails');
    c = await createTestTenant('Ledger member emails');
    await h.owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [c.tenantId, c.userId]);
    await h.owner.query('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2)', [c.organizationId, c.userId]);
    tenantAdmin = await h.signIn(c.userId, c.tenantId);
  }, 60_000);

  afterAll(async () => {
    // The harness's people first: their memberships reference the organization.
    const closed = await Promise.allSettled([h?.close()]);
    await c?.cleanup();
    if (closed[0].status === 'rejected') throw closed[0].reason;
  }, 60_000);

  const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  /** An account stored with exactly `email`, in the ledger's organization unless `outside`. */
  async function person(label: string, email: string, { outside = false } = {}) {
    const u = await h.addUser(label);
    await h.owner.query('UPDATE users SET email = $1 WHERE id = $2', [email, u.id]);
    if (!outside) await h.owner.query('INSERT INTO organization_users (organization_id, user_id) VALUES ($1, $2)', [c.organizationId, u.id]);
    return { ...u, email };
  }
  const inTenant = async (userId: number) =>
    ((await h.owner.query('SELECT 1 FROM tenant_users WHERE tenant_id = $1 AND user_id = $2', [c.tenantId, userId])).rowCount ?? 0) > 0;
  const add = (email: string) => h.call(tenantAdmin, 'post', '/api/tenants/current/members', { email });

  it('adds the one stored exactly as asked, of two that differ only in case', async () => {
    const address = `twin-${stamp()}@test.local`;
    // The capitalised one first, so it is the row a lookup without an order meets first.
    const capital = await person('twin-capital', address.toUpperCase());
    const exact = await person('twin-exact', address);

    const res = await add(address);
    expect(res.status, res.text).toBe(201);
    expect(res.body.user).toMatchObject({ uuid: exact.uuid, email: address });
    expect(await inTenant(capital.id)).toBe(false);
  });

  it('refuses to guess between two that differ only in case, neither as asked', async () => {
    const address = `guess-${stamp()}@test.local`;
    const one = await person('guess-one', address.replace(/^./, (ch) => ch.toUpperCase()));
    const two = await person('guess-two', address.toUpperCase());

    const res = await add(address);
    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('EMAIL_AMBIGUOUS');
    expect(await inTenant(one.id)).toBe(false);
    expect(await inTenant(two.id)).toBe(false);
  });

  it("decides among the organization's members only: an account outside it changes nothing", async () => {
    // The only member with this address has capitals; an account outside has it exactly.
    const address = `mixed-${stamp()}@test.local`;
    const member = await person('mixed-member', address.toUpperCase());
    const outsider = await person('mixed-outsider', address, { outside: true });
    const added = await add(address);
    expect(added.status, added.text).toBe(201);
    expect(added.body.user.uuid).toBe(member.uuid);
    expect(await inTenant(outsider.id)).toBe(false);

    // Two accounts outside it that differ only in case: answered as an address no one has.
    const outside = `outside-${stamp()}@test.local`;
    await person('outside-one', outside.replace(/^./, (ch) => ch.toUpperCase()), { outside: true });
    await person('outside-two', outside.toUpperCase(), { outside: true });
    const refused = await add(outside);
    const unknown = await add(`nobody-${stamp()}@test.local`);
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('NOT_ORG_MEMBER');
    expect({ ...refused.body, requestId: undefined }).toEqual({ ...unknown.body, requestId: undefined });
  });
});
