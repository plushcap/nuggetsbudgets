import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createAccountsRoutes } from '../accounts.js';
import { createMerchantsRoutes } from '../merchants.js';
import { createGoalRoutes } from '../goals.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { answerProblem, goalImageResponseSchema, messageResponseSchema } from '@nuggets/shared';
// An image's type comes from its bytes, read through to IEND: the hand-written PNG
// this used had a damaged IDAT chunk, and is refused as not an image.
import { png } from '../../test/imageFixtures.js';
import { Kysely, PostgresDialect } from 'kysely';
import type { PoolClient } from 'pg';
import type { DB } from '../../db/schema.generated.js';
import { deleteImageByUrl, isTenantImageUrl } from '../../services/ImageService.js';

const PNG = png();

/**
 * Replacing an account's image deletes the one it replaces: the old one
 * used to stay in stored_images, and in every backup, for good. But only when nothing
 * else in the ledger shows it: a merchant's merchant_image may name any of the ledger's
 * images, so one image can be an account's, a goal's and a merchant's at once, and
 * replacing it on one used to delete it from under the others.
 */
describe('replacing a ledger image', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Account image replace');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());
    app.use('/api/merchants', createMerchantsRoutes());
    app.use('/api/goals', createGoalRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const imageIds = async () =>
    (await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM stored_images WHERE tenant_id = $1 ORDER BY id', [tenant.tenantId]))
      .rows.map((r) => r.uuid);
  const exists = async (url: string) => (await imageIds()).includes(url.split('/').pop()!);

  const newAccount = async (label: string) => {
    const created = await request(app)
      .post('/api/accounts')
      .field('name', `${label} ${Date.now()}`)
      .field('account_type', 'checking')
      .attach('account_image', PNG, { filename: 'first.png', contentType: 'image/png' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body as { uuid: string; account_image: string };
  };
  const replaceAccountImage = async (uuid: string) => {
    const updated = await request(app)
      .put(`/api/accounts/${uuid}`)
      .field('name', 'Image replaced')
      .field('account_type', 'checking')
      .attach('account_image', PNG, { filename: 'second.png', contentType: 'image/png' });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    return updated.body.account_image as string;
  };
  const merchantShowing = async (image: string) => {
    const merchant = await request(app).post('/api/merchants').send({ name: `Shared image ${Date.now()}`, merchant_image: image });
    expect(merchant.status, JSON.stringify(merchant.body)).toBeLessThan(300);
    return (await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM merchants WHERE merchant_image = $1', [image])).rows[0].uuid;
  };

  it('stores the new image and deletes the old one', async () => {
    const before = await imageIds();
    const created = await newAccount('Image replace');
    const first = created.account_image;
    expect(first).toMatch(/^\/api\/images\//);
    expect(await imageIds()).toEqual([...before, first.split('/').pop()]);

    const second = await replaceAccountImage(created.uuid);
    expect(second).not.toBe(first);
    expect(await imageIds()).toEqual([...before, second.split('/').pop()]);

    // An edit without a new image keeps the one it has.
    const renamed = await request(app)
      .put(`/api/accounts/${created.uuid}`)
      .field('name', 'Image kept')
      .field('account_type', 'checking');
    expect(renamed.status).toBe(200);
    expect(renamed.body.account_image).toBe(second);
    expect(await imageIds()).toEqual([...before, second.split('/').pop()]);
  });

  it("keeps an account's old image that a merchant shows too", async () => {
    const account = await newAccount('Shared with a merchant');
    const shared = account.account_image;
    await merchantShowing(shared);

    const replaced = await replaceAccountImage(account.uuid);
    expect(replaced).not.toBe(shared);
    expect(await exists(shared)).toBe(true);
    expect(await exists(replaced)).toBe(true);
  });

  it("keeps a merchant's old image that an account shows too", async () => {
    const account = await newAccount('Shared with a merchant, replaced on it');
    const shared = account.account_image;
    const merchant = await merchantShowing(shared);

    const uploaded = await request(app)
      .post(`/api/merchants/${merchant}/upload-image`)
      .attach('merchant_image', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    expect(uploaded.body.merchant.merchant_image).not.toBe(shared);
    expect(await exists(shared)).toBe(true);

    // Once nothing shows it any more, replacing it deletes it.
    const replaced = await replaceAccountImage(account.uuid);
    expect(await exists(shared)).toBe(false);
    expect(await exists(replaced)).toBe(true);
  });

  // Two requests at once: one pointing a merchant at an image (isTenantImageUrl, then the
  // update), the other replacing it on its account. The delete waits for the first to
  // commit, then sees its reference, rather than delete the image from under it.
  it('keeps an image a request in progress is pointing a merchant at', async () => {
    const account = await newAccount('Shared while replaced');
    const shared = account.account_image;
    const merchant = (await tenant.pool.query<{ id: number }>("INSERT INTO merchants (name) VALUES ('Racing merchant') RETURNING id")).rows[0].id;
    // Each request's transaction: Kysely on one connection, which it doesn't release.
    const onClient = (client: PoolClient) =>
      new Kysely<DB>({
        dialect: new PostgresDialect({ pool: { connect: async () => ({ query: client.query.bind(client), release: () => {} }) } as never }),
      });
    const pointing = await tenant.pool.connect();
    const replacing = await tenant.pool.connect();
    try {
      await pointing.query('BEGIN');
      expect(await isTenantImageUrl(onClient(pointing), shared)).toBe(true);
      await pointing.query('UPDATE merchants SET merchant_image = $1 WHERE id = $2', [shared, merchant]);

      await replacing.query('BEGIN');
      await replacing.query("UPDATE accounts SET account_image = NULL WHERE uuid = $1", [account.uuid]);
      let deleted = false;
      const deleting = deleteImageByUrl(onClient(replacing), shared).then(() => (deleted = true));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(deleted).toBe(false); // waiting for the request that points at it
      await pointing.query('COMMIT');
      await deleting;
      await replacing.query('COMMIT');
    } finally {
      await pointing.query('ROLLBACK').catch(() => {});
      await replacing.query('ROLLBACK').catch(() => {});
      pointing.release();
      replacing.release();
    }
    expect(await exists(shared)).toBe(true);
  });

  it("keeps a goal's old image that a merchant shows too, on replace and on delete", async () => {
    const goal = (
      await tenant.pool.query<{ uuid: string }>(
        "INSERT INTO budget_items (name, expense_type, type) VALUES ($1, 'Savings', 'Goal') RETURNING uuid",
        [`Shared goal ${Date.now()}`]
      )
    ).rows[0].uuid;
    const upload = async () => {
      const res = await request(app).post(`/api/goals/${goal}/image`).attach('image', PNG, { filename: 'goal.png', contentType: 'image/png' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(answerProblem(goalImageResponseSchema, res.body)).toBeNull();
      return res.body.image_path as string;
    };
    const first = await upload();
    await merchantShowing(first);
    const second = await upload();
    expect(await exists(first)).toBe(true);

    await merchantShowing(second);
    const removed = await request(app).delete(`/api/goals/${goal}/image`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(answerProblem(messageResponseSchema, removed.body)).toBeNull();
    expect(await exists(second)).toBe(true);

    // A goal image nothing else shows goes with it.
    const third = await upload();
    expect((await request(app).delete(`/api/goals/${goal}/image`)).status).toBe(200);
    expect(await exists(third)).toBe(false);
  });
});
