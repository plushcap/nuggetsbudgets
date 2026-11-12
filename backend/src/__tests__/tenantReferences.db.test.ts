import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express, type RequestHandler } from 'express';
import { Pool } from 'pg';
import { createTransactionsRoutes } from '../routes/transactions.js';
import { createTagsRoutes } from '../routes/tags.js';
import { createMerchantsRoutes } from '../routes/merchants.js';
import { createImagesRoutes } from '../routes/images.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { testTenantContext } from '../test/tenantContext.js';
import { withTenant, getDb } from '../db/withTenant.js';
import { db as globalDb } from '../db.js';
import { deleteImageByUrl, deleteProfileImage, imageUrl, storeProfileImage } from '../services/ImageService.js';
// storeProfileImage reads an image's type from its bytes: a signature alone isn't one.
import { png } from '../test/imageFixtures.js';

/**
 * A ledger's rows reference only that ledger's rows.
 *
 * The database checks a foreign key outside RLS, so with keys on (id) alone a
 * member of ledger B could store a reference to a row of ledger A by sending A's numeric id.
 * Every foreign key between ledger tables now includes tenant_id (rls-catalog.test.ts checks
 * them all); here the database refuses such references, as the app role under B's RLS, and the
 * routes that take numeric ids answer 400 without writing.
 *
 * Every stored_images row is a ledger's, and profile pictures are
 * user_profile_images rows, which no ledger can reach and which are served only to people who
 * share an organization or a ledger with their owner.
 */

const FK_VIOLATION = '23503';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

type Ref = { id: number; uuid: string };

async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error('expected the statement to fail');
}

describe('References between ledgers', () => {
  let a: TestTenant;
  let b: TestTenant;
  let owner: Pool;
  let appB: Express;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  // A's rows that B tries to reach.
  let aMerchant: Ref;
  let aTag: Ref;
  let aBudgetItem: Ref;
  let aImage: Ref;
  let aConnectionId: number;
  // B's own.
  let bAccount: Ref;
  let bMerchant: Ref;
  let bTag: Ref;
  let bTransaction: Ref;
  let bConnectionId: number;

  const one = async (pool: Pool, text: string, params: unknown[] = []): Promise<Ref> =>
    (await pool.query<Ref>(`${text} RETURNING id, uuid`, params)).rows[0];

  function appFor(context: RequestHandler): Express {
    const app = express();
    app.use(express.json());
    app.use(context);
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/tags', createTagsRoutes());
    app.use('/api/merchants', createMerchantsRoutes());
    app.use('/api/images', createImagesRoutes());
    return app;
  }

  beforeAll(async () => {
    a = await createTestTenant('References A');
    b = await createTestTenant('References B');
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
    appB = appFor(b.context());

    aMerchant = await one(a.pool, 'INSERT INTO merchants (name) VALUES ($1)', [`A merchant ${stamp}`]);
    aTag = await one(a.pool, 'INSERT INTO tags (name) VALUES ($1)', [`A tag ${stamp}`]);
    aBudgetItem = await one(a.pool, `INSERT INTO budget_items (name, expense_type) VALUES ($1, 'Expense')`, [`A item ${stamp}`]);
    aImage = await one(a.pool, `INSERT INTO stored_images (mime_type, byte_size, data) VALUES ('image/png', 8, $1)`, [PNG]);

    bAccount = await one(
      b.pool,
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset')`,
      [`B checking ${stamp}`]
    );
    bMerchant = await one(b.pool, 'INSERT INTO merchants (name) VALUES ($1)', [`B merchant ${stamp}`]);
    bTag = await one(b.pool, 'INSERT INTO tags (name) VALUES ($1)', [`B tag ${stamp}`]);
    bTransaction = await one(
      b.pool,
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
       VALUES ($1, -12.34, '2026-10-20', 'expense', 'B transaction')`,
      [bAccount.id]
    );

    const connection = async (orgId: number) =>
      (
        await owner.query<{ id: number }>(
          `INSERT INTO organization_simplefin_connections (organization_id, access_url, created_by)
           VALUES ($1, 'x', NULL) RETURNING id`,
          [orgId]
        )
      ).rows[0].id;
    aConnectionId = await connection(a.organizationId);
    bConnectionId = await connection(b.organizationId);
  });

  afterAll(async () => {
    try {
      await owner?.query('DELETE FROM user_profile_images WHERE user_id = ANY($1)', [[a?.userId, b?.userId]]);
      await b?.pool.query('UPDATE accounts SET simplefin_connection_id = NULL');
      await owner?.query('DELETE FROM organization_simplefin_connections WHERE organization_id = ANY($1)', [
        [a?.organizationId, b?.organizationId],
      ]);
      await Promise.all([a?.cleanup(), b?.cleanup()]);
    } finally {
      await owner?.end();
    }
  });

  describe('the database refuses a reference to another ledger', () => {
    it("refuses B's rule on A's merchant, and takes one on B's own", async () => {
      const err = await pgError(
        b.pool.query(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'x')`, [
          aMerchant.id,
        ])
      );
      expect(err.code).toBe(FK_VIOLATION);
      await expect(
        b.pool.query(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'x')`, [
          bMerchant.id,
        ])
      ).resolves.toBeDefined();
    });

    it("refuses B's transaction pointing at A's merchant, budget item or tag", async () => {
      expect((await pgError(b.pool.query('UPDATE transactions SET merchant_id = $1 WHERE id = $2', [aMerchant.id, bTransaction.id]))).code).toBe(
        FK_VIOLATION
      );
      expect(
        (await pgError(b.pool.query('UPDATE transactions SET budget_item_id = $1 WHERE id = $2', [aBudgetItem.id, bTransaction.id]))).code
      ).toBe(FK_VIOLATION);
      expect(
        (
          await pgError(
            b.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [
              aTag.id,
              bTransaction.id,
            ])
          )
        ).code
      ).toBe(FK_VIOLATION);
      const row = (await b.pool.query('SELECT merchant_id, budget_item_id FROM transactions WHERE id = $1', [bTransaction.id])).rows[0];
      expect(row).toEqual({ merchant_id: null, budget_item_id: null });
    });

    it("answers another ledger's id exactly as an id that names nothing, so it can't probe A's ids", async () => {
      const unused = (await owner.query<{ id: number }>('SELECT max(id) + 1000000 AS id FROM merchants')).rows[0].id;
      const foreign = await pgError(b.pool.query('UPDATE transactions SET merchant_id = $1 WHERE id = $2', [aMerchant.id, bTransaction.id]));
      const missing = await pgError(b.pool.query('UPDATE transactions SET merchant_id = $1 WHERE id = $2', [unused, bTransaction.id]));
      expect(foreign.code).toBe(missing.code);
      expect(foreign.message).toBe(missing.message);
    });

    it("refuses B's ledger naming A's merchant as its balance-adjustment merchant", async () => {
      const err = await pgError(
        b.pool.query('UPDATE tenants SET balance_adjustment_merchant_id = $1 WHERE id = current_tenant_id()', [aMerchant.id])
      );
      expect(err.code).toBe(FK_VIOLATION);
      await b.pool.query('UPDATE tenants SET balance_adjustment_merchant_id = $1 WHERE id = current_tenant_id()', [bMerchant.id]);
      await b.pool.query('UPDATE tenants SET balance_adjustment_merchant_id = NULL WHERE id = current_tenant_id()');
    });

    it("refuses B's account using A's organization's SimpleFin connection", async () => {
      const err = await pgError(b.pool.query('UPDATE accounts SET simplefin_connection_id = $1 WHERE id = $2', [aConnectionId, bAccount.id]));
      expect(err.code).toBe(FK_VIOLATION);
      await b.pool.query('UPDATE accounts SET simplefin_connection_id = $1 WHERE id = $2', [bConnectionId, bAccount.id]);
    });
  });

  describe('routes that take numeric ids', () => {
    it("PUT /transactions/:uuid with A's merchant_id or budget_item_id is a 400 and changes nothing", async () => {
      for (const body of [{ merchant_id: aMerchant.id }, { budget_item_id: aBudgetItem.id }, { budget_period_id: 2147483000 }]) {
        const res = await request(appB).put(`/api/transactions/${bTransaction.uuid}`).send({ ...body, description: 'changed' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_REFERENCE');
      }
      const row = (await b.pool.query('SELECT description, merchant_id FROM transactions WHERE id = $1', [bTransaction.id])).rows[0];
      expect(row).toEqual({ description: 'B transaction', merchant_id: null });
      // B's own merchant is taken.
      await request(appB).put(`/api/transactions/${bTransaction.uuid}`).send({ merchant_id: bMerchant.id }).expect(200);
      await b.pool.query('UPDATE transactions SET merchant_id = NULL WHERE id = $1', [bTransaction.id]);
    });

    it("POST /transactions with A's budget item or A's tag id is a 400", async () => {
      const refused = await request(appB).post('/api/transactions').send({
        account_uuid: bAccount.uuid,
        amount: -5,
        transaction_date: '2026-10-21',
        type: 'expense',
        budget_item_id: aBudgetItem.id,
      });
      expect(refused.status).toBe(400);
      expect(refused.body.field).toBe('budget_item_id');

      // A's tag id was dropped and the transaction saved without it; now it is refused, as a
      // split's is, and B's own tag still goes on.
      const tagged = (tagIds: number[]) =>
        request(appB)
          .post('/api/transactions')
          .send({ account_uuid: bAccount.uuid, amount: -5, transaction_date: '2026-10-21', type: 'expense', tag_ids: tagIds });
      const foreign = await tagged([aTag.id, bTag.id]).expect(400);
      expect([foreign.body.code, foreign.body.field]).toEqual(['INVALID_REFERENCE', 'tag_ids']);

      const created = await tagged([bTag.id]).expect(201);
      const tags = (
        await b.pool.query(
          `SELECT tg.tag_id FROM taggings tg JOIN transactions t ON t.id = tg.taggable_id AND tg.taggable_type = 'transaction'
            WHERE t.uuid = $1`,
          [created.body.transaction.uuid]
        )
      ).rows.map((r) => r.tag_id);
      expect(tags).toEqual([bTag.id]);
    });

    it("POST /tags/transaction/:uuid with A's tag is a 400", async () => {
      const res = await request(appB).post(`/api/tags/transaction/${bTransaction.uuid}`).send({ tag_id: aTag.id });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REFERENCE');
      await request(appB).post(`/api/tags/transaction/${bTransaction.uuid}`).send({ tag_id: bTag.id }).expect(201);
    });

    it("PUT /merchants/:uuid with A's tag as its auto-tag is a 400", async () => {
      const res = await request(appB)
        .put(`/api/merchants/${bMerchant.uuid}`)
        .send({ name: `B merchant ${stamp}`, transaction_auto_tag_id: aTag.id });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('transaction_auto_tag_id');
    });
  });

  describe('stored images', () => {
    it("stores an image as its ledger's, and never as another's", async () => {
      const own = (await b.pool.query(`INSERT INTO stored_images (mime_type, byte_size, data) VALUES ('image/png', 8, $1) RETURNING tenant_id`, [PNG]))
        .rows[0];
      expect(own.tenant_id).toBe(b.tenantId);
      // RLS's WITH CHECK refuses a row for another ledger.
      await expect(
        b.pool.query(`INSERT INTO stored_images (tenant_id, mime_type, byte_size, data) VALUES ($1, 'image/png', 8, $2)`, [a.tenantId, PNG])
      ).rejects.toThrow(/row-level security/);
      await expect(
        b.pool.query(`INSERT INTO stored_images (tenant_id, mime_type, byte_size, data) VALUES (NULL, 'image/png', 8, $1)`, [PNG])
      ).rejects.toThrow();
    });

    it("can't see or delete A's image from B", async () => {
      expect((await b.pool.query('SELECT 1 FROM stored_images WHERE uuid = $1', [aImage.uuid])).rows).toEqual([]);
      await request(appB).get(`/api/images/${aImage.uuid}`).expect(404);
      await withTenant(b.tenantId, () => deleteImageByUrl(getDb(), imageUrl(aImage.uuid)));
      expect((await a.pool.query('SELECT 1 FROM stored_images WHERE uuid = $1', [aImage.uuid])).rows).toHaveLength(1);
    });

    it("refuses a merchant_image that isn't one of the ledger's images", async () => {
      const res = await request(appB)
        .put(`/api/merchants/${bMerchant.uuid}`)
        .send({ name: `B merchant ${stamp}`, merchant_image: imageUrl(aImage.uuid) });
      expect(res.status).toBe(400);
      const created = await request(appB).post('/api/merchants').send({ name: `B other ${stamp}`, merchant_image: '/uploads/x.png' });
      expect(created.status).toBe(400);
      // One of B's own images is taken, and sending it back unchanged is too.
      const bImage = await one(b.pool, `INSERT INTO stored_images (mime_type, byte_size, data) VALUES ('image/png', 8, $1)`, [PNG]);
      await request(appB)
        .put(`/api/merchants/${bMerchant.uuid}`)
        .send({ name: `B merchant ${stamp}`, merchant_image: imageUrl(bImage.uuid) })
        .expect(200);
      await request(appB)
        .put(`/api/merchants/${bMerchant.uuid}`)
        .send({ name: `B merchant ${stamp}`, merchant_image: imageUrl(bImage.uuid), notes: 'again' })
        .expect(200);
    });

    it("keeps a profile picture out of every ledger: no ledger can delete it, and only people who share one with its owner see it", async () => {
      const uuid = await storeProfileImage(globalDb, a.userId, { mimeType: 'image/png', data: png(), createdByUserId: a.userId });
      await owner.query('UPDATE users SET profile_image = $1 WHERE id = $2', [imageUrl(uuid), a.userId]);

      // Its owner, and another member of A's ledger, see it.
      await request(appFor(a.context())).get(`/api/images/${uuid}`).expect(200);
      const coMember = (
        await owner.query<{ id: number }>(
          `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Co', 'Member') RETURNING id`,
          [`co-member-${stamp}@test.local`]
        )
      ).rows[0].id;
      try {
        await owner.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [a.tenantId, coMember]);
        await request(appFor(testTenantContext({ userId: coMember, tenantId: a.tenantId }))).get(`/api/images/${uuid}`).expect(200);
      } finally {
        await owner.query('DELETE FROM tenant_users WHERE user_id = $1', [coMember]);
        await owner.query('DELETE FROM users WHERE id = $1', [coMember]);
      }

      // B's member, who shares nothing with A's, doesn't; B can't delete it either.
      await request(appB).get(`/api/images/${uuid}`).expect(404);
      await withTenant(b.tenantId, () => deleteImageByUrl(getDb(), imageUrl(uuid)));
      expect((await owner.query('SELECT 1 FROM user_profile_images WHERE uuid = $1', [uuid])).rows).toHaveLength(1);
      // Nor point a merchant at it, which replacing the merchant's image would then delete.
      await request(appB)
        .put(`/api/merchants/${bMerchant.uuid}`)
        .send({ name: `B merchant ${stamp}`, merchant_image: imageUrl(uuid) })
        .expect(400);

      // A replacement is one row with a new uuid; removing it removes the row.
      const replaced = await storeProfileImage(globalDb, a.userId, { mimeType: 'image/png', data: png() });
      expect(replaced).not.toBe(uuid);
      expect((await owner.query('SELECT uuid FROM user_profile_images WHERE user_id = $1', [a.userId])).rows).toEqual([{ uuid: replaced }]);
      await deleteProfileImage(globalDb, a.userId);
      expect((await owner.query('SELECT 1 FROM user_profile_images WHERE user_id = $1', [a.userId])).rows).toEqual([]);
    });
  });
});
