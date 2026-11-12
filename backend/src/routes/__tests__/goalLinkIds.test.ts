import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { createGoalRoutes } from '../goals.js';
import { rejectMalformedIds } from '../../middleware/routeParams.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The goal link DELETE routes name the linked account or envelope by its uuid.
 * They took its numeric id, read with parseInt: 'abc' reached the query as NaN
 * (a 500) and '<id>abc' unlinked row <id>. Now anything that isn't a uuid, the old numeric
 * id included, names nothing: 404 (rejectMalformedIds, as routes.ts mounts the router), and
 * the link stays. A uuid that names no account or envelope of the ledger, or one not linked,
 * is nothing to unlink.
 */
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('Goal link ids in the path', () => {
  let app: Express;
  let tenant: TestTenant;
  let goal: { id: number; uuid: string };
  let account: { id: number; uuid: string };
  let envelope: { id: number; uuid: string };

  const NOWHERE = '0190a000-0000-7000-8000-000000000000';
  const one = async <T>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const accountLinkOpen = async () =>
    (await one<{ open: boolean }>(
      'SELECT valid_to IS NULL AS open FROM budget_item_accounts WHERE budget_item_id = $1 AND account_id = $2',
      [goal.id, account.id]
    )).open;
  const envelopeLinkOpen = async () =>
    (await one<{ open: boolean }>(
      'SELECT valid_to IS NULL AS open FROM goal_budget_items WHERE goal_id = $1 AND budget_item_id = $2',
      [goal.id, envelope.id]
    )).open;

  beforeAll(async () => {
    tenant = await createTestTenant('Goal link ids');
    goal = await one(
      `INSERT INTO budget_items (name, status, type, expense_type, goal_target_amount)
       VALUES ('House', 'active', 'Goal', 'Savings', 5000) RETURNING id, uuid`
    );
    account = await one(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Savings', 'savings', 'cash', 'Asset') RETURNING id, uuid`
    );
    envelope = await one(
      `INSERT INTO budget_items (name, status, type, expense_type, rollover) VALUES ('Rainy day', 'active', 'Expense', 'Expense', true) RETURNING id, uuid`
    );
    // Linked ten days ago, so unlinking closes the link today rather than deleting it.
    await tenant.pool.query('INSERT INTO budget_item_accounts (budget_item_id, account_id, valid_from) VALUES ($1, $2, app_today() - 10)', [goal.id, account.id]);
    await tenant.pool.query('INSERT INTO goal_budget_items (goal_id, budget_item_id, valid_from) VALUES ($1, $2, app_today() - 10)', [goal.id, envelope.id]);

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/goals', rejectMalformedIds(createGoalRoutes()));
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const malformed = (id: number) => [String(id), 'abc', `${id}abc`, '0', '-1'];

  it('answers 404 for an account named by anything but its uuid, its old numeric id included, and leaves the link', async () => {
    for (const bad of malformed(account.id)) {
      const res = await request(app).delete(`/api/goals/${goal.uuid}/accounts/${encodeURIComponent(bad)}`);
      expect(res.status, `${bad}: ${res.text}`).toBe(404);
    }
    await request(app).delete(`/api/goals/${goal.uuid}/accounts/${NOWHERE}`).expect(200);
    expect(await accountLinkOpen()).toBe(true);
  });

  it('answers 404 for an envelope named by anything but its uuid, and leaves the link', async () => {
    for (const bad of malformed(envelope.id)) {
      const res = await request(app).delete(`/api/goals/${goal.uuid}/budget-items/${encodeURIComponent(bad)}`);
      expect(res.status, `${bad}: ${res.text}`).toBe(404);
    }
    await request(app).delete(`/api/goals/${goal.uuid}/budget-items/${NOWHERE}`).expect(200);
    expect(await envelopeLinkOpen()).toBe(true);
  });

  it('unlinks by uuid', async () => {
    await request(app).delete(`/api/goals/${goal.uuid}/accounts/${account.uuid}`).expect(200);
    expect(await accountLinkOpen()).toBe(false);
    await request(app).delete(`/api/goals/${goal.uuid}/budget-items/${envelope.uuid}`).expect(200);
    expect(await envelopeLinkOpen()).toBe(false);
  });

  it('answers 404 for a goal that is not there, before anything else', async () => {
    const res = await request(app).delete(`/api/goals/${NOWHERE}/accounts/${account.uuid}`).expect(404);
    expect(res.body).toMatchObject({ error: 'Goal not found', code: 'NOT_FOUND' });
  });
});
