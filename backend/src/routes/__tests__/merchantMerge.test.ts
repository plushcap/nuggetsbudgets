import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createMerchantsRoutes } from '../merchants.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Merging merchants moves everything that points at the source before deleting it. The
 * route used to move only budget items, transactions, recurring items and merchant rules,
 * so the delete took the source's attachments, budget-item rules and usage counts with it
 * (ON DELETE CASCADE) and cleared the ledger's balance-adjustment merchant (SET NULL).
 * Deleting a merchant with a replacement cleared that setting the same way.
 */
describe('Merging and replacing merchants', () => {
  let tenant: TestTenant;
  let app: Express;

  const one = async <T,>(text: string, values: unknown[] = []) => (await tenant.pool.query(text, values)).rows[0] as T;
  const all = async <T,>(text: string, values: unknown[] = []) => (await tenant.pool.query(text, values)).rows as T[];

  beforeAll(async () => {
    tenant = await createTestTenant('Merchant merge');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it("POST /merge moves the source's attachments, budget-item rules, usage counts and balance-adjustment role", async () => {
    const source = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ('Corner Shop') RETURNING id, uuid`);
    const target = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ('Corner Store') RETURNING id, uuid`);
    const groceries = await one<{ id: number }>(`INSERT INTO budget_items (name) VALUES ('Groceries') RETURNING id`);
    const snacks = await one<{ id: number }>(`INSERT INTO budget_items (name) VALUES ('Snacks') RETURNING id`);

    const attachment = await one<{ id: number }>(
      `INSERT INTO attachments (name, original_filename, safe_filename, file_extension, file_name, merchant_id)
       VALUES ('Receipt', 'r.pdf', 'r.pdf', 'pdf', 'r.pdf', $1) RETURNING id`, [source.id]);
    const rule = await one<{ id: number }>(
      `INSERT INTO budget_item_matching_rules (budget_item_id, merchant_id, method, matching_text)
       VALUES ($1, $2, 'contains', 'CORNER') RETURNING id`, [groceries.id, source.id]);

    // Both merchants were used for Groceries (the rows combine); only the source for Snacks (it moves).
    await tenant.pool.query(
      `INSERT INTO budget_item_usage_history (budget_item_id, merchant_id, usage_count, last_used_date) VALUES
         ($1, $3, 3, '2026-03-01T12:00:00Z'), ($1, $4, 2, '2026-05-01T12:00:00Z'), ($2, $3, 4, '2026-04-01T12:00:00Z')`,
      [groceries.id, snacks.id, source.id, target.id]);
    await tenant.pool.query(`UPDATE tenants SET balance_adjustment_merchant_id = $1 WHERE id = $2`, [source.id, tenant.tenantId]);

    await request(app).post(`/api/merchants/${source.uuid}/merge`).send({ targetMerchantUuid: target.uuid }).expect(200);

    expect(await all(`SELECT id FROM merchants WHERE id = $1`, [source.id])).toEqual([]);
    expect(await one(`SELECT merchant_id FROM attachments WHERE id = $1`, [attachment.id])).toEqual({ merchant_id: target.id });
    expect(await one(`SELECT merchant_id FROM budget_item_matching_rules WHERE id = $1`, [rule.id])).toEqual({ merchant_id: target.id });
    const usage = await all<{ budget_item_id: number; usage_count: number; last_used_date: Date }>(
      `SELECT budget_item_id, usage_count, last_used_date FROM budget_item_usage_history WHERE merchant_id IN ($1, $2) ORDER BY budget_item_id`,
      [source.id, target.id]);
    expect(usage.map((u) => ({ ...u, last_used_date: u.last_used_date.toISOString() }))).toEqual([
      { budget_item_id: groceries.id, usage_count: 5, last_used_date: '2026-05-01T12:00:00.000Z' },
      { budget_item_id: snacks.id, usage_count: 4, last_used_date: '2026-04-01T12:00:00.000Z' },
    ]);
    expect(await one(`SELECT balance_adjustment_merchant_id FROM tenants WHERE id = $1`, [tenant.tenantId]))
      .toEqual({ balance_adjustment_merchant_id: target.id });
  });

  // Deleting a merchant in use moves its transactions to the replacement, so the
  // replacement takes over its attachments, usage counts and balance-adjustment role too.
  // Its rules describe the deleted merchant and go with it.
  it('DELETE with a replacement keeps attachments, usage counts and the balance-adjustment role', async () => {
    const doomed = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ('Adjustment') RETURNING id, uuid`);
    const replacement = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ('Balance Adjustment') RETURNING id, uuid`);
    const fees = await one<{ id: number }>(`INSERT INTO budget_items (name) VALUES ('Fees') RETURNING id`);
    const account = await one<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`);
    await tenant.pool.query(
      `INSERT INTO transactions (account_id, merchant_id, amount, type, transaction_date, description) VALUES ($1, $2, -5.00, 'expense', '2026-10-01', 'Rebalance')`,
      [account.id, doomed.id]);
    const attachment = await one<{ id: number }>(
      `INSERT INTO attachments (name, original_filename, safe_filename, file_extension, file_name, merchant_id)
       VALUES ('Statement', 's.pdf', 's.pdf', 'pdf', 's.pdf', $1) RETURNING id`, [doomed.id]);
    await tenant.pool.query(
      `INSERT INTO budget_item_matching_rules (budget_item_id, merchant_id, method, matching_text) VALUES ($1, $2, 'contains', 'ADJ')`,
      [fees.id, doomed.id]);
    await tenant.pool.query(
      `INSERT INTO budget_item_usage_history (budget_item_id, merchant_id, usage_count) VALUES ($1, $2, 2), ($1, $3, 1)`,
      [fees.id, doomed.id, replacement.id]);
    await tenant.pool.query(`UPDATE tenants SET balance_adjustment_merchant_id = $1 WHERE id = $2`, [doomed.id, tenant.tenantId]);

    await request(app).delete(`/api/merchants/${doomed.uuid}`).send({ replacementMerchantId: replacement.uuid }).expect(204);

    expect(await one(`SELECT count(*)::int AS n FROM transactions WHERE merchant_id = $1`, [replacement.id])).toEqual({ n: 1 });
    expect(await one(`SELECT merchant_id FROM attachments WHERE id = $1`, [attachment.id])).toEqual({ merchant_id: replacement.id });
    expect(await all(`SELECT budget_item_id, usage_count FROM budget_item_usage_history WHERE budget_item_id = $1`, [fees.id]))
      .toEqual([{ budget_item_id: fees.id, usage_count: 3 }]);
    expect(await all(`SELECT id FROM budget_item_matching_rules WHERE budget_item_id = $1`, [fees.id])).toEqual([]);
    expect(await one(`SELECT balance_adjustment_merchant_id FROM tenants WHERE id = $1`, [tenant.tenantId]))
      .toEqual({ balance_adjustment_merchant_id: replacement.id });
  });

  // A merchant not in use keeps nothing the API counts, but a replacement the person
  // picked still takes its attachments.
  it('DELETE with a replacement keeps the attachments of a merchant not in use', async () => {
    const doomed = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ('Unused') RETURNING id, uuid`);
    const replacement = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ('Used') RETURNING id, uuid`);
    const attachment = await one<{ id: number }>(
      `INSERT INTO attachments (name, original_filename, safe_filename, file_extension, file_name, merchant_id)
       VALUES ('Contract', 'c.pdf', 'c.pdf', 'pdf', 'c.pdf', $1) RETURNING id`, [doomed.id]);

    await request(app).delete(`/api/merchants/${doomed.uuid}`).send({ replacementMerchantId: replacement.uuid }).expect(204);

    expect(await one(`SELECT merchant_id FROM attachments WHERE id = $1`, [attachment.id])).toEqual({ merchant_id: replacement.id });
  });

  // The uuids were compared as text, but the database reads them in any case: the same
  // merchant upper-cased passed the check, and the merge deleted it.
  it('refuses to merge a merchant into itself, or to replace it with itself, in any case', async () => {
    const merchant = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ('Selfsame') RETURNING id, uuid`);
    const account = await one<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Self checking', 'checking', 'cash', 'Asset') RETURNING id`);
    await tenant.pool.query(
      `INSERT INTO transactions (account_id, merchant_id, amount, type, transaction_date, description) VALUES ($1, $2, -1.00, 'expense', '2026-10-01', 'Self')`,
      [account.id, merchant.id]);

    await request(app).post(`/api/merchants/${merchant.uuid}/merge`).send({ targetMerchantUuid: merchant.uuid.toUpperCase() }).expect(400);
    await request(app).delete(`/api/merchants/${merchant.uuid}`).send({ replacementMerchantId: merchant.uuid }).expect(400);
    await request(app).delete(`/api/merchants/${merchant.uuid}`).send({ replacementMerchantId: 'not-a-uuid' }).expect(400);

    expect(await all(`SELECT id FROM merchants WHERE id = $1`, [merchant.id])).toEqual([{ id: merchant.id }]);
    expect(await one(`SELECT count(*)::int AS n FROM transactions WHERE merchant_id = $1`, [merchant.id])).toEqual({ n: 1 });
  });
});
