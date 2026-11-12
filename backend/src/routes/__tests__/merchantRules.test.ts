import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * The merchant routes that change many rows at once, through the real app under RLS:
 * matching-rule CRUD, test-rules and apply-rules, merging, and the
 * "remove unused merchants" cleanup. Ledger B, in another organization, has its own
 * merchants, rules and transactions; none of them may be read, changed or deleted.
 *
 * merchantMerge.test.ts covers what merging takes along besides transactions
 * (attachments, budget-item rules, usage counts, the balance-adjustment role);
 * likePatterns.test.ts that a rule's %, _ and \ match themselves; and
 * merchantsRoutesCharacterization.test.ts each route's answers within one ledger
 * (rule CRUD and its refusals among them).
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

type Ref = { id: number; uuid: string };

describeDb('Merchant rules, merge and cleanup routes', () => {
  let h: RouteHarness;
  let a: TestTenant;
  let b: TestTenant;
  let session: string; // a member of ledger A
  let accountA: number;
  let accountB: number;
  const CHECKING = `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`;

  const one = async <T>(t: TestTenant, text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows[0] as T;
  const merchant = (t: TestTenant, name: string) => one<Ref>(t, 'INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid', [name]);
  const txn = (t: TestTenant, account: number, description: string, merchantId: number | null = null, payee: string | null = null) =>
    one<Ref>(
      t,
      `INSERT INTO transactions (account_id, amount, transaction_date, description, import_payee, type, merchant_id)
       VALUES ($1, -12.34, '2026-10-01', $2, $3, 'expense', $4) RETURNING id, uuid`,
      [account, description, payee, merchantId]
    );
  const merchantOf = async (t: TestTenant, txnId: number) =>
    (await one<{ merchant_id: number | null }>(t, 'SELECT merchant_id FROM transactions WHERE id = $1', [txnId])).merchant_id;
  const exists = async (t: TestTenant, table: string, id: number) =>
    ((await t.pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount ?? 0) > 0;

  beforeAll(async () => {
    h = await startRouteHarness('Merchant rules');
    a = await createTestTenant('Merchant rules A');
    b = await createTestTenant('Merchant rules B');
    session = await h.signIn(a.userId, a.tenantId);
    accountA = (await one<{ id: number }>(a, CHECKING)).id;
    accountB = (await one<{ id: number }>(b, CHECKING)).id;
  }, 60_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([h?.close(), a?.cleanup(), b?.cleanup()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  describe('matching rules', () => {
    it("can't read, add to, change or delete another ledger's rules", async () => {
      const theirs = await merchant(b, 'Their Cafe');
      const theirRule = await one<Ref>(b, `INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'THEIRS') RETURNING id, uuid`, [theirs.id]);

      expect((await h.call(session, 'get', `/api/merchants/${theirs.uuid}/rules`)).status).toBe(404);
      expect((await h.call(session, 'post', `/api/merchants/${theirs.uuid}/rules`, { method: 'contains', matching_text: 'X' })).status).toBe(404);
      expect((await h.call(session, 'put', `/api/merchants/rules/${theirRule.uuid}`, { method: 'exact', matching_text: 'MINE' })).status).toBe(404);
      expect((await h.call(session, 'delete', `/api/merchants/rules/${theirRule.uuid}`)).status).toBe(404);

      const still = await b.pool.query('SELECT merchant_id, method, matching_text FROM merchant_matching_rules WHERE merchant_id = $1', [theirs.id]);
      expect(still.rows).toEqual([{ merchant_id: theirs.id, method: 'contains', matching_text: 'THEIRS' }]);
    });
  });

  describe('test-rules and apply-rules', () => {
    it("previews the ledger's matching transactions not yet the merchant's, then applies the merchant to the ones chosen", async () => {
      const m = await merchant(a, 'Bean Barn');
      const other = await merchant(a, 'Somebody Else');
      await a.pool.query(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'bean barn'), ($1, 'starts_with', 'BB #')`, [m.id]);

      const byDescription = await txn(a, accountA, 'POS BEAN BARN 0042');
      const byOtherRule = await txn(a, accountA, 'BB ' + '#' + '17 coffee');
      const fromOtherMerchant = await txn(a, accountA, 'BEAN BARN again', other.id);
      const alreadyMine = await txn(a, accountA, 'BEAN BARN mine', m.id);
      // The provider's payee wins over the description, as at import.
      const payeeSaysOtherwise = await txn(a, accountA, 'BEAN BARN 9', null, 'Hardware Hut');
      const unrelated = await txn(a, accountA, 'SAMPLE GROCERY');
      const inB = await txn(b, accountB, 'BEAN BARN in B');

      const preview = await h.call(session, 'post', `/api/merchants/${m.uuid}/test-rules`);
      expect(preview.status, preview.text).toBe(200);
      const found = (preview.body.matchingTransactions as Array<{ id: number; matchingRule: { method: string } }>);
      expect(found.map((t) => t.id).sort((x, y) => x - y)).toEqual(
        [byDescription.id, byOtherRule.id, fromOtherMerchant.id].sort((x, y) => x - y)
      );
      expect(found.find((t) => t.id === byOtherRule.id)?.matchingRule.method).toBe('starts_with');
      expect(preview.body.totalRules).toBe(2);

      // Apply to two of them, plus an id from ledger B, which RLS keeps out of reach.
      const applied = await h.call(session, 'post', `/api/merchants/${m.uuid}/apply-rules`, {
        transactionIds: [byDescription.id, fromOtherMerchant.id, inB.id],
      });
      expect(applied.status, applied.text).toBe(200);
      expect(applied.body.updatedCount).toBe(2);
      expect(await merchantOf(a, byDescription.id)).toBe(m.id);
      expect(await merchantOf(a, fromOtherMerchant.id)).toBe(m.id);
      expect(await merchantOf(a, byOtherRule.id)).toBeNull();
      expect(await merchantOf(a, alreadyMine.id)).toBe(m.id);
      expect(await merchantOf(a, payeeSaysOtherwise.id)).toBeNull();
      expect(await merchantOf(a, unrelated.id)).toBeNull();
      expect(await merchantOf(b, inB.id)).toBeNull();
    });

    it('refuses apply-rules without transactions, and for an unknown merchant', async () => {
      const m = await merchant(a, 'Empty Apply');
      expect((await h.call(session, 'post', `/api/merchants/${m.uuid}/apply-rules`, { transactionIds: [] })).status).toBe(400);
      const theirs = await merchant(b, 'Their Apply');
      const t = await txn(a, accountA, 'apply to theirs');
      expect((await h.call(session, 'post', `/api/merchants/${theirs.uuid}/apply-rules`, { transactionIds: [t.id] })).status).toBe(404);
      expect(await merchantOf(a, t.id)).toBeNull();
    });
  });

  describe('merge', () => {
    it("moves the source's transactions, budget items and rules to the target, drops duplicate rules, then deletes the source", async () => {
      const source = await merchant(a, 'Merge Source');
      const target = await merchant(a, 'Merge Target');
      const bystander = await merchant(a, 'Merge Bystander');
      const t1 = await txn(a, accountA, 'source 1', source.id);
      const t2 = await txn(a, accountA, 'source 2', source.id);
      const tBystander = await txn(a, accountA, 'bystander', bystander.id);
      const item = await one<Ref>(a, `INSERT INTO budget_items (name, merchant_id) VALUES ('Merged item', $1) RETURNING id, uuid`, [source.id]);
      await a.pool.query(
        `INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES
           ($1, 'contains', 'SHARED'), ($1, 'exact', 'ONLY SOURCE'), ($2, 'contains', 'SHARED'), ($3, 'contains', 'BYSTANDER')`,
        [source.id, target.id, bystander.id]
      );

      const res = await h.call(session, 'post', `/api/merchants/${source.uuid}/merge`, { targetMerchantUuid: target.uuid });
      expect(res.status, res.text).toBe(200);

      expect(await exists(a, 'merchants', source.id)).toBe(false);
      expect(await merchantOf(a, t1.id)).toBe(target.id);
      expect(await merchantOf(a, t2.id)).toBe(target.id);
      expect(await merchantOf(a, tBystander.id)).toBe(bystander.id);
      expect((await one<{ merchant_id: number }>(a, 'SELECT merchant_id FROM budget_items WHERE id = $1', [item.id])).merchant_id).toBe(target.id);
      const rules = await a.pool.query<{ merchant_id: number; method: string; matching_text: string }>(
        'SELECT merchant_id, method, matching_text FROM merchant_matching_rules WHERE merchant_id = ANY($1) ORDER BY merchant_id, matching_text',
        [[source.id, target.id, bystander.id]]
      );
      expect(rules.rows).toEqual([
        { merchant_id: target.id, method: 'exact', matching_text: 'ONLY SOURCE' },
        { merchant_id: target.id, method: 'contains', matching_text: 'SHARED' },
        { merchant_id: bystander.id, method: 'contains', matching_text: 'BYSTANDER' },
      ].sort((x, y) => x.merchant_id - y.merchant_id || x.matching_text.localeCompare(y.matching_text)));
    });

    it("won't merge into, or out of, another ledger's merchant", async () => {
      const mine = await merchant(a, 'Merge Mine');
      const theirs = await merchant(b, 'Merge Theirs');
      const myTxn = await txn(a, accountA, 'mine', mine.id);
      const theirTxn = await txn(b, accountB, 'theirs', theirs.id);

      const into = await h.call(session, 'post', `/api/merchants/${mine.uuid}/merge`, { targetMerchantUuid: theirs.uuid });
      expect(into.status).toBe(404);
      const outOf = await h.call(session, 'post', `/api/merchants/${theirs.uuid}/merge`, { targetMerchantUuid: mine.uuid });
      expect(outOf.status).toBe(404);

      expect(await exists(a, 'merchants', mine.id)).toBe(true);
      expect(await exists(b, 'merchants', theirs.id)).toBe(true);
      expect(await merchantOf(a, myTxn.id)).toBe(mine.id);
      expect(await merchantOf(b, theirTxn.id)).toBe(theirs.id);
    });
  });

  describe('remove unused', () => {
    it('deletes only the merchants nothing refers to, in this ledger only', async () => {
      // A ledger of its own, whose only merchants are the ones below: the cleanup removes
      // every unused merchant, and the other tests leave some in A. It used to
      // empty A first, so the tests after it had to make their merchants again.
      const c = await createTestTenant('Merchant rules C');
      try {
        const sessionC = await h.signIn(c.userId, c.tenantId);
        const accountC = (await one<{ id: number }>(c, CHECKING)).id;

        const unused = await merchant(c, 'Unused One');
        const unusedWithRule = await merchant(c, 'Unused With Rule');
        await c.pool.query(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'UNUSED')`, [unusedWithRule.id]);

        const withTransaction = await merchant(c, 'Has Transaction');
        await txn(c, accountC, 'used', withTransaction.id);
        const withBudgetItem = await merchant(c, 'Has Budget Item');
        const item = await one<Ref>(c, `INSERT INTO budget_items (name, merchant_id) VALUES ('Gym', $1) RETURNING id, uuid`, [withBudgetItem.id]);
        const withRecurring = await merchant(c, 'Has Recurring');
        const recurring = await one<Ref>(
          c,
          `INSERT INTO recurring (merchant_id, amount, recurring_frequency, starting_date, recurring_status)
           VALUES ($1, -50.00, 'monthly', '2026-01-01', 'active') RETURNING id, uuid`,
          [withRecurring.id]
        );
        const withItemRule = await merchant(c, 'Has Budget Item Rule');
        const itemRule = await one<Ref>(
          c,
          `INSERT INTO budget_item_matching_rules (budget_item_id, merchant_id, method) VALUES ($1, $2, 'merchant') RETURNING id, uuid`,
          [item.id, withItemRule.id]
        );
        const withAttachment = await merchant(c, 'Has Attachment');
        await c.pool.query(
          `INSERT INTO attachments (name, original_filename, safe_filename, file_extension, file_name, merchant_id)
           VALUES ('Receipt', 'r.pdf', 'r.pdf', 'pdf', 'r.pdf', $1)`,
          [withAttachment.id]
        );
        const adjustments = await merchant(c, 'Balance Adjustments');
        await h.owner.query('UPDATE tenants SET balance_adjustment_merchant_id = $1 WHERE id = $2', [adjustments.id, c.tenantId]);
        // Usage history alone keeps a merchant: it's what budget-item suggestions count,
        // and its rows would go with the merchant (ON DELETE CASCADE).
        const withUsage = await merchant(c, 'Has Usage History');
        const usage = await one<Ref>(
          c,
          `INSERT INTO budget_item_usage_history (budget_item_id, merchant_id, transaction_description, amount, usage_count)
           VALUES ($1, $2, 'GYM MONTHLY', -50.00, 7) RETURNING id, uuid`,
          [item.id, withUsage.id]
        );

        const theirsUnused = await merchant(b, 'Unused In B');

        const res = await h.call(sessionC, 'post', '/api/merchants/admin/remove-unused');
        expect(res.status, res.text).toBe(200);
        expect(res.body.removedCount).toBe(2);
        expect((res.body.removedMerchants as Array<{ uuid: string }>).map((m) => m.uuid).sort()).toEqual([unused.uuid, unusedWithRule.uuid].sort());

        const left = await c.pool.query<{ id: number }>('SELECT id FROM merchants');
        expect(left.rows.map((r) => r.id).sort((x, y) => x - y)).toEqual(
          [withTransaction.id, withBudgetItem.id, withRecurring.id, withItemRule.id, withAttachment.id, adjustments.id, withUsage.id].sort(
            (x, y) => x - y
          )
        );
        expect(await exists(c, 'budget_item_usage_history', usage.id)).toBe(true);
        // What referred to the kept merchants is untouched.
        expect((await one<{ merchant_id: number }>(c, 'SELECT merchant_id FROM budget_items WHERE id = $1', [item.id])).merchant_id).toBe(withBudgetItem.id);
        expect(await exists(c, 'recurring', recurring.id)).toBe(true);
        expect(await exists(c, 'budget_item_matching_rules', itemRule.id)).toBe(true);
        const adjustment = await h.owner.query('SELECT balance_adjustment_merchant_id AS m FROM tenants WHERE id = $1', [c.tenantId]);
        expect(adjustment.rows[0].m).toBe(adjustments.id);
        // The rules of a removed merchant go with it.
        expect((await c.pool.query('SELECT 1 FROM merchant_matching_rules WHERE merchant_id = $1', [unusedWithRule.id])).rowCount).toBe(0);
        // Nothing of another ledger: B's unused merchant, and A's.
        expect(await exists(b, 'merchants', theirsUnused.id)).toBe(true);
        const unusedInA = await merchant(a, 'Unused In A');
        const again = await h.call(sessionC, 'post', '/api/merchants/admin/remove-unused');
        expect(again.status).toBe(200);
        expect(again.body.removedCount).toBe(0);
        expect(await exists(a, 'merchants', unusedInA.id)).toBe(true);
      } finally {
        await c.cleanup();
      }
    }, 60_000);
  });
});
