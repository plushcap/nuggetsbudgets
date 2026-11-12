import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createTagsRoutes } from '../tags.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * What the tag routes answer, status and body, for the paths the other tag suites don't
 * reach: the transaction list, time series and breakdown reports, the hierarchy rules on
 * create and update, and tagging transactions and budget items. Written
 * before the routes' data access moved into services/tags/, so the move
 * keeps every answer.
 */
describe('Tag routes: reports, hierarchy rules and taggings', () => {
  /**
   * A refusal the services throw (TagError), as the route wrapper answers it: the body the
   * route wrote before, with its code (the status's when it named none) and `message` (its
   * error's text when it had none). Mounted alone, there is no request id.
   */
  const CODES: Record<number, string> = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT' };
  const refusal = (status: number, body: { error: string; message?: string; code?: string; [k: string]: unknown }) => ({
    ...body,
    code: body.code ?? CODES[status],
    message: body.message ?? body.error,
  });
  /** A body or query validateBody or validateQuery refused, naming `field` with `message`. */
  const invalid = (field: string, message: string) => ({
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    message,
    details: [{ field, message }],
  });
  let tenant: TestTenant;
  let app: Express;
  const missing = '00000000-0000-7000-8000-000000000000';

  const one = async <T,>(text: string, values: unknown[] = []) => (await tenant.pool.query(text, values)).rows[0] as T;

  type Tag = { id: number; uuid: string };
  const tag = (name: string, parentId: number | null = null) =>
    one<Tag>(`INSERT INTO tags (name, parent_id) VALUES ($1, $2) RETURNING id, uuid`, [name, parentId]);

  let accountId = 0;
  const transaction = (amount: string, date: string) =>
    one<{ id: number; uuid: string }>(
      `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
       VALUES ($1, $2, $3, $4, CASE WHEN $2::numeric < 0 THEN 'expense' ELSE 'income' END, 'cleared') RETURNING id, uuid`,
      [accountId, amount, `t ${amount}`, date]
    );
  const tagTransaction = (tagId: number, transactionId: number) =>
    tenant.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [tagId, transactionId]);

  beforeAll(async () => {
    tenant = await createTestTenant('Tag routes characterization');
    accountId = (
      await one<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).id;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/tags', createTagsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  describe('reports', () => {
    let home: Tag;
    let garden: Tag;
    let kitchen: Tag;
    let seeds: Tag;

    beforeAll(async () => {
      home = await tag('Home');
      garden = await tag('Garden', home.id);
      kitchen = await tag('Kitchen', home.id);
      seeds = await tag('Seeds', garden.id);

      // Home only.
      const rent = await transaction('-1000.00', '2026-01-05');
      await tagTransaction(home.id, rent.id);
      // Garden's branch, through a grandchild, and Home too: counted once, in Garden.
      const bulbs = await transaction('-30.00', '2026-01-12');
      await tagTransaction(seeds.id, bulbs.id);
      await tagTransaction(home.id, bulbs.id);
      // Kitchen only.
      const pans = await transaction('-50.00', '2026-02-02');
      await tagTransaction(kitchen.id, pans.id);
      // Garden and Kitchen: a tie, won by the larger settled slice (Kitchen, 50 > 40).
      const both = await transaction('-5.00', '2026-02-03');
      await tagTransaction(garden.id, both.id);
      await tagTransaction(kitchen.id, both.id);
      // A refund into the garden.
      const refund = await transaction('10.00', '2026-02-10');
      await tagTransaction(garden.id, refund.id);
      // Not counted: a split parent (its splits are).
      const splitParent = await one<{ id: number }>(
        `WITH parent AS (
           INSERT INTO transactions (account_id, amount, description, transaction_date, type, status, is_split_parent)
           VALUES ($1, -888.00, 'Split', '2026-01-21', 'expense', 'cleared', true) RETURNING id
         ), split AS (
           INSERT INTO transactions (account_id, amount, description, transaction_date, type, status, parent_transaction_id)
           SELECT $1, -888.00, 'Split part', '2026-01-21', 'expense', 'cleared', id FROM parent
         )
         SELECT id FROM parent`,
        [accountId]
      );
      await tagTransaction(home.id, splitParent.id);
    });

    it('lists the transactions of a tag and its descendants once each, newest first, with every tag they carry', async () => {
      const res = await request(app).get(`/api/tags/${home.uuid}/transactions`).expect(200);
      expect(res.body).toMatchObject({ total: 5, limit: 100, offset: 0 });
      expect(res.body.transactions.map((t: { amount: string }) => t.amount)).toEqual(['10.00', '-5.00', '-50.00', '-30.00', '-1000.00']);
      const bulbs = res.body.transactions[3];
      // A row of the shared transaction list: with its merchant id, period item and instants.
      expect(Object.keys(bulbs).sort()).toEqual([
        'account_name', 'account_uuid', 'amount', 'assigned_to', 'assigned_user', 'budget_item_id', 'budget_item_name',
        'budget_item_uuid', 'budget_period_id', 'budget_period_item_id', 'budget_period_name', 'created_at', 'description', 'id',
        'is_split_parent', 'merchant_id', 'merchant_name', 'merchant_uuid', 'notes', 'parent_transaction_id', 'review_status',
        'status', 'tags', 'transaction_date', 'type', 'updated_at', 'uuid',
      ]);
      expect(bulbs).toMatchObject({ account_name: 'Checking', transaction_date: '2026-01-12', assigned_user: null });
      expect(bulbs.tags.map((t: { name: string }) => t.name).sort()).toEqual(['Home', 'Seeds']);
      expect(Object.keys(bulbs.tags[0]).sort()).toEqual(['color', 'icon', 'id', 'name', 'uuid']);
    });

    it('pages and filters the transaction list', async () => {
      const page = await request(app).get(`/api/tags/${home.uuid}/transactions`).query({ limit: 2, offset: 1 }).expect(200);
      expect(page.body).toMatchObject({ total: 5, limit: 2, offset: 1 });
      expect(page.body.transactions.map((t: { amount: string }) => t.amount)).toEqual(['-5.00', '-50.00']);

      const january = await request(app)
        .get(`/api/tags/${home.uuid}/transactions`)
        .query({ start_date: '2026-01-01', end_date: '2026-01-31' })
        .expect(200);
      expect(january.body.total).toBe(2);

      const garden_ = await request(app).get(`/api/tags/${garden.uuid}/transactions`).expect(200);
      expect(garden_.body.total).toBe(3);
    });

    it('answers 404 for a tag that does not exist', async () => {
      const body = refusal(404, { error: 'Tag not found', message: 'No tag found with the provided UUID' });
      for (const route of ['transactions', 'timeseries', 'breakdown']) {
        const res = await request(app).get(`/api/tags/${missing}/${route}`).expect(404);
        expect(res.body).toEqual(body);
      }
    });

    it('sums received and spent per month, week or day', async () => {
      const month = await request(app).get(`/api/tags/${home.uuid}/timeseries`).expect(200);
      expect(month.body).toEqual({
        bucket: 'month',
        series: [
          { bucket_date: '2026-01-01', income: 0, expenses: 1030 },
          { bucket_date: '2026-02-01', income: 10, expenses: 55 },
        ],
      });

      const week = await request(app).get(`/api/tags/${home.uuid}/timeseries`).query({ bucket: 'week' }).expect(200);
      expect(week.body.series).toEqual([
        { bucket_date: '2026-01-04', income: 0, expenses: 1000 },
        { bucket_date: '2026-01-11', income: 0, expenses: 30 },
        { bucket_date: '2026-02-01', income: 0, expenses: 55 },
        { bucket_date: '2026-02-08', income: 10, expenses: 0 },
      ]);

      const day = await request(app)
        .get(`/api/tags/${home.uuid}/timeseries`)
        .query({ bucket: 'day', start_date: '2026-02-01', end_date: '2026-02-05' })
        .expect(200);
      expect(day.body).toEqual({
        bucket: 'day',
        series: [
          { bucket_date: '2026-02-02', income: 0, expenses: 50 },
          { bucket_date: '2026-02-03', income: 0, expenses: 5 },
        ],
      });

      // No bucket is a month; another is refused (it was read as a month).
      const none = await request(app).get(`/api/tags/${home.uuid}/timeseries`).expect(200);
      expect(none.body.bucket).toBe('month');
      const other = await request(app).get(`/api/tags/${home.uuid}/timeseries`).query({ bucket: 'year' }).expect(400);
      expect(other.body).toEqual(invalid('bucket', 'bucket must be one of: day, week, month.'));
    });

    it('breaks a tag down by sub-tag, each transaction once, a tie to the larger slice', async () => {
      const res = await request(app).get(`/api/tags/${home.uuid}/breakdown`).expect(200);
      expect(res.body).toEqual({
        breakdown: [
          { id: garden.id, uuid: garden.uuid, name: 'Garden', color: '#3B82F6', icon: 'Tag', is_parent: false, value: 40, net: -20, count: 2 },
          { id: kitchen.id, uuid: kitchen.uuid, name: 'Kitchen', color: '#3B82F6', icon: 'Tag', is_parent: false, value: 55, net: -55, count: 2 },
          { id: home.id, uuid: home.uuid, name: 'Home', color: '#3B82F6', icon: 'Tag', is_parent: true, value: 1000, net: -1000, count: 1 },
        ],
      });

      // A slice with nothing in the range is left out.
      const february = await request(app)
        .get(`/api/tags/${home.uuid}/breakdown`)
        .query({ start_date: '2026-02-01', end_date: '2026-02-28' })
        .expect(200);
      expect(february.body.breakdown.map((s: { name: string }) => s.name)).toEqual(['Garden', 'Kitchen']);
    });

    it('lists report roots with their descendant and budget-item tagging counts', async () => {
      await request(app).put(`/api/tags/${home.uuid}/report-root`).send({ is_report_root: true }).expect(200);
      try {
        const res = await request(app).get('/api/tags/report-roots').expect(200);
        const row = res.body.find((r: { uuid: string }) => r.uuid === home.uuid);
        expect(Object.keys(row).sort()).toEqual([
          'budget_item_tagging_count', 'color', 'created_at', 'descendant_count', 'description', 'icon', 'id', 'name',
          'report_flow_measure', 'updated_at', 'uuid',
        ]);
        expect(row).toMatchObject({ descendant_count: '3', budget_item_tagging_count: '0', report_flow_measure: 'effective' });
      } finally {
        await request(app).put(`/api/tags/${home.uuid}/report-root`).send({ is_report_root: false }).expect(200);
      }
    });
  });

  describe('hierarchy rules', () => {
    it('creates a tag with the default color, icon and order', async () => {
      const res = await request(app).post('/api/tags').send({ name: '  Travel  ', description: '  Trips ' }).expect(201);
      expect(res.body).toMatchObject({
        name: 'Travel', color: '#3B82F6', icon: 'Tag', description: 'Trips', parent_id: null, level: 0, sort_order: 0, is_active: true,
      });
      expect(Object.keys(res.body).sort()).toEqual([
        'color', 'created_at', 'description', 'icon', 'id', 'is_active', 'level', 'name', 'parent_id', 'sort_order', 'updated_at', 'uuid',
      ]);
    });

    it('refuses a parent that does not exist, on create and on move', async () => {
      const res = await request(app).post('/api/tags').send({ name: 'Orphan', parent_id: 2147483647 }).expect(400);
      expect(res.body).toEqual(refusal(400, { error: 'Invalid parent', message: 'Parent tag does not exist' }));

      const loose = await tag('Loose');
      const nowhere = await request(app).put(`/api/tags/${loose.uuid}`).send({ name: 'Loose', parent_id: 2147483647 }).expect(400);
      expect(nowhere.body).toEqual(refusal(400, { error: 'Invalid parent', message: 'Parent tag does not exist' }));

      // Nor does one past `integer`, or one that isn't an id (these answered 500).
      for (const parent_id of [3000000000, 'x', 1.5]) {
        const created = await request(app).post('/api/tags').send({ name: 'Orphan', parent_id }).expect(400);
        expect(created.body).toEqual(res.body);
        const moved = await request(app).put(`/api/tags/${loose.uuid}`).send({ name: 'Loose', parent_id }).expect(400);
        expect(moved.body).toEqual(res.body);
      }
    });

    it('takes tags four levels deep, and refuses a fifth, on create and on move', async () => {
      const top = await tag('Depth 1');
      const second = await tag('Depth 2', top.id);
      const third = await tag('Depth 3', second.id);
      // The fourth level is allowed, on create and on move.
      const fourth = await request(app).post('/api/tags').send({ name: 'Depth 4', parent_id: third.id }).expect(201);
      expect(fourth.body).toMatchObject({ parent_id: third.id, level: 3 });
      const mover = await tag('Depth mover');
      const moved = await request(app).put(`/api/tags/${mover.uuid}`).send({ name: 'Depth mover', parent_id: third.id }).expect(200);
      expect(moved.body).toMatchObject({ parent_id: third.id, level: 3 });

      // A fifth is refused before the write, with the depth the database allows (these answered 500).
      const fifth = await request(app).post('/api/tags').send({ name: 'Depth 5', parent_id: fourth.body.id }).expect(400);
      expect(fifth.body).toEqual(refusal(400, { error: 'Maximum depth exceeded', message: 'Cannot create tag: maximum hierarchy depth of 4 levels exceeded' }));
      const loose = await tag('Depth loose');
      const tooDeep = await request(app).put(`/api/tags/${loose.uuid}`).send({ name: 'Depth loose', parent_id: fourth.body.id }).expect(400);
      expect(tooDeep.body).toEqual(refusal(400, { error: 'Maximum depth exceeded', message: 'Cannot move tag: maximum hierarchy depth of 4 levels exceeded' }));
      const kept = await one<{ parent_id: number | null; level: number }>(`SELECT parent_id, level FROM tags WHERE id = $1`, [loose.id]);
      expect(kept).toEqual({ parent_id: null, level: 0 });
    });

    it('refuses to make a tag its own parent or its descendant\'s child', async () => {
      const top = await tag('Top');
      const middle = await tag('Middle', top.id);
      const bottom = await tag('Bottom', middle.id);

      const self = await request(app).put(`/api/tags/${top.uuid}`).send({ name: 'Top', parent_id: top.id }).expect(400);
      expect(self.body).toEqual(refusal(400, { error: 'Invalid parent', message: 'Cannot set tag as its own parent' }));

      const circle = await request(app).put(`/api/tags/${top.uuid}`).send({ name: 'Top', parent_id: bottom.id }).expect(400);
      expect(circle.body).toEqual(refusal(400, { error: 'Circular reference', message: 'Cannot move tag: would create circular reference' }));
    });

    // A description that isn't text was a TypeError (`.trim()`), and is_active null failed
    // the column's NOT NULL: each a 500. The bodies are checked by tagWriteSchema.
    it('refuses a description that is not text, or an is_active that is not a boolean, with 400', async () => {
      const existing = await tag('Typed fields');
      const described = await request(app).put(`/api/tags/${existing.uuid}`).send({ name: 'Typed fields', description: 42 }).expect(400);
      expect(described.body).toEqual(invalid('description', 'description must be text'));
      const inactive = await request(app).post('/api/tags').send({ name: 'Typed fields two', is_active: null }).expect(400);
      expect(inactive.body).toEqual(invalid('is_active', 'is_active must be true or false'));
    });

    it('updates a tag: name checks, the parent kept when not sent, defaults for what is not sent', async () => {
      const parent = await tag('Pets');
      const child = await tag('Dog', parent.id);
      await tag('Cat', parent.id);

      const missingName = await request(app).put(`/api/tags/${child.uuid}`).send({ name: '   ' }).expect(400);
      expect(missingName.body).toEqual(invalid('name', 'Name is required'));
      const long = await request(app).put(`/api/tags/${child.uuid}`).send({ name: 'x'.repeat(101) }).expect(400);
      expect(long.body).toEqual(invalid('name', 'Tag name must be 100 characters or less'));
      // A name that isn't text is no name (this answered 500).
      for (const name of [42, { text: 'Dog' }, ['Dog']]) {
        const notText = await request(app).put(`/api/tags/${child.uuid}`).send({ name }).expect(400);
        expect(notText.body).toEqual(invalid('name', 'Name is required'));
      }
      const taken = await request(app).put(`/api/tags/${child.uuid}`).send({ name: ' cat ' }).expect(409);
      expect(taken.body).toEqual(refusal(409, { error: 'Tag exists', message: 'A tag with this name already exists' }));
      const created = await request(app).post('/api/tags').send({ name: 'DOG' }).expect(409);
      expect(created.body).toEqual(refusal(409, { error: 'Tag exists', message: 'A tag with this name already exists' }));
      const nowhere = await request(app).put(`/api/tags/${missing}`).send({ name: 'Ghost' }).expect(404);
      expect(nowhere.body).toEqual(refusal(404, { error: 'Tag not found', message: 'No tag found with the provided UUID' }));

      const renamed = await request(app).put(`/api/tags/${child.uuid}`).send({ name: ' Puppy ', color: '#000000', sort_order: 3 }).expect(200);
      expect(renamed.body).toMatchObject({ name: 'Puppy', color: '#000000', icon: 'Tag', parent_id: parent.id, sort_order: 3, is_active: true, level: 1 });

      const reset = await request(app).put(`/api/tags/${child.uuid}`).send({ name: 'Puppy', parent_id: null, is_active: false }).expect(200);
      expect(reset.body).toMatchObject({ color: '#3B82F6', parent_id: null, sort_order: 0, is_active: false, level: 0 });
    });

    it('answers 409 NAMESPACE_CONFLICT to a move that would give a budget item two tags of one namespace', async () => {
      const root = await tag('Owner');
      await request(app).put(`/api/tags/${root.uuid}/report-root`).send({ is_report_root: true }).expect(200);
      const alice = await tag('Alice', root.id);
      const bob = await tag('Bob');
      const item = await one<{ id: number }>(`INSERT INTO budget_items (name) VALUES ('Shared phone') RETURNING id`);
      await tenant.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'budget_item', $3), ($2, 'budget_item', $3)`, [
        alice.id, bob.id, item.id,
      ]);

      const res = await request(app).put(`/api/tags/${bob.uuid}`).send({ name: 'Bob', parent_id: root.id }).expect(409);
      expect(res.body).toEqual({
        error: 'Namespace conflict',
        code: 'NAMESPACE_CONFLICT',
        message: 'Moving this tag would put two tags from the same report namespace on a single budget item. Resolve the conflicting taggings first.',
      });
    });

    // A move takes the tags below the moved one along. It checked only the new
    // parent's level, so a subtree moved under a level-2 tag reached levels 4 and 5, and
    // the tags below kept the levels they had.
    describe('a tag with tags below it', () => {
      const TOO_DEEP = refusal(400, { error: 'Maximum depth exceeded', message: 'Cannot move tag: maximum hierarchy depth of 4 levels exceeded' });
      const placeOf = async (ids: number[]) =>
        (
          await tenant.pool.query<{ parent_id: number | null; level: number }>(
            'SELECT parent_id, level FROM tags WHERE id = ANY($1) ORDER BY array_position($1, id)',
            [ids]
          )
        ).rows;
      /** Three tags, each under the one before (levels 0 to 2), and a top-level tag with one below it. */
      const setup = async (label: string) => {
        const top = await tag(`${label} 0`);
        const first = await tag(`${label} 1`, top.id);
        const second = await tag(`${label} 2`, first.id);
        const subtree = await tag(`${label} subtree`);
        const below = await tag(`${label} subtree child`, subtree.id);
        return { top, first, second, subtree, below };
      };

      it('refuses a move that would put a tag below past level 3, before writing anything', async () => {
        const { second, subtree, below } = await setup('Height');

        const moved = await request(app).put(`/api/tags/${subtree.uuid}`).send({ name: 'Height subtree', parent_id: second.id }).expect(400);
        expect(moved.body).toEqual(TOO_DEEP);
        expect(await placeOf([subtree.id, below.id])).toEqual([
          { parent_id: null, level: 0 },
          { parent_id: subtree.id, level: 1 },
        ]);
      });

      it('moves a subtree that fits, and every tag below it takes its level', async () => {
        const { top, subtree, below } = await setup('Fits');
        const grandchild = await tag('Fits subtree grandchild', below.id);

        // Under the level-0 tag: 1, 2, 3.
        await request(app).put(`/api/tags/${subtree.uuid}`).send({ name: 'Fits subtree', parent_id: top.id }).expect(200);
        expect(await placeOf([subtree.id, below.id, grandchild.id])).toEqual([
          { parent_id: top.id, level: 1 },
          { parent_id: subtree.id, level: 2 },
          { parent_id: below.id, level: 3 },
        ]);
        // Back to the top: 0, 1, 2.
        await request(app).put(`/api/tags/${subtree.uuid}`).send({ name: 'Fits subtree', parent_id: null }).expect(200);
        expect(await placeOf([subtree.id, below.id, grandchild.id]).then((rows) => rows.map((r) => r.level))).toEqual([0, 1, 2]);
      });
    });

    // A report root is a top-level tag (chk_tags_report_root_top_level): moving one under a
    // parent failed that check, a 500.
    it('refuses to move a report root under another tag', async () => {
      const root = await tag('Root to move');
      await request(app).put(`/api/tags/${root.uuid}/report-root`).send({ is_report_root: true }).expect(200);
      const parent = await tag('Root parent');
      const REPORT_ROOT = {
        error: 'Invalid operation',
        code: 'REPORT_ROOT_TOP_LEVEL',
        message: 'A report root is a top-level tag: unmark it as a report root before moving it under another tag',
      };

      const moved = await request(app).put(`/api/tags/${root.uuid}`).send({ name: 'Root to move', parent_id: parent.id }).expect(400);
      expect(moved.body).toEqual(REPORT_ROOT);
      expect(await one(`SELECT parent_id, is_report_root FROM tags WHERE id = $1`, [root.id])).toEqual({ parent_id: null, is_report_root: true });

      // It stays where it is, and may be renamed there.
      await request(app).put(`/api/tags/${root.uuid}`).send({ name: 'Root renamed', parent_id: null }).expect(200);
    });

    // A tag above itself: every tag list of the ledger answered 500 after one ("Circular
    // reference detected" in get_tag_hierarchy_path). A move compared a parent sent as text
    // with ids as numbers, and missed it.
    describe('no tag above itself', () => {
      const OWN_PARENT = refusal(400, { error: 'Invalid parent', message: 'Cannot set tag as its own parent' });
      const CIRCULAR = refusal(400, { error: 'Circular reference', message: 'Cannot move tag: would create circular reference' });
      const parentOf = async (id: number) => (await one<{ parent_id: number | null }>(`SELECT parent_id FROM tags WHERE id = $1`, [id])).parent_id;
      const listStillWorks = async () => {
        await request(app).get('/api/tags').expect(200);
      };

      it('refuses a move under itself or its child when their ids are sent as text', async () => {
        const top = await tag('Text id top');
        const child = await tag('Text id child', top.id);

        const self = await request(app).put(`/api/tags/${top.uuid}`).send({ name: 'Text id top', parent_id: String(top.id) }).expect(400);
        expect(self.body).toEqual(OWN_PARENT);
        const under = await request(app).put(`/api/tags/${top.uuid}`).send({ name: 'Text id top', parent_id: String(child.id) }).expect(400);
        expect(under.body).toEqual(CIRCULAR);
        expect(await parentOf(top.id)).toBeNull();
        await listStillWorks();

        // A parent sent as text is still a parent.
        const other = await tag('Text id other');
        await request(app).put(`/api/tags/${other.uuid}`).send({ name: 'Text id other', parent_id: String(child.id) }).expect(200);
        expect(await parentOf(other.id)).toBe(child.id);
      });
    });

    it('deletes a tag', async () => {
      const gone = await tag('Gone');
      const res = await request(app).delete(`/api/tags/${gone.uuid}`).expect(200);
      expect(res.body).toEqual({ success: true, message: 'Tag deleted successfully' });
    });
  });

  describe('tagging transactions', () => {
    it('adds, lists and removes a transaction\'s tags', async () => {
      const parent = await tag('Fun');
      const child = await tag('Games', parent.id);
      const t = await transaction('-12.00', '2026-03-01');

      const noTag = await request(app).post(`/api/tags/transaction/${t.uuid}`).send({}).expect(400);
      expect(noTag.body).toEqual(invalid('tag_id', 'tag_id is required'));
      const noTransaction = await request(app).post(`/api/tags/transaction/${missing}`).send({ tag_id: child.id }).expect(404);
      expect(noTransaction.body).toEqual(refusal(404, { error: 'Transaction not found', message: 'No transaction found with the provided UUID' }));
      const badTag = await request(app).post(`/api/tags/transaction/${t.uuid}`).send({ tag_id: 2147483647 }).expect(400);
      expect(badTag.body.code).toBe('INVALID_REFERENCE');

      const added = await request(app).post(`/api/tags/transaction/${t.uuid}`).send({ tag_id: child.id }).expect(201);
      expect(Object.keys(added.body).sort()).toEqual(['id', 'uuid']);
      const again = await request(app).post(`/api/tags/transaction/${t.uuid}`).send({ tag_id: child.id }).expect(409);
      expect(again.body).toEqual(refusal(409, { error: 'Tag already added', message: 'This tag is already associated with the transaction' }));

      const list = await request(app).get(`/api/tags/transaction/${t.uuid}`).expect(200);
      expect(list.body).toEqual([
        { id: child.id, uuid: child.uuid, name: 'Games', color: '#3B82F6', icon: 'Tag', parent_id: parent.id, level: 1, hierarchy_path: 'Fun → Games' },
      ]);

      const removeMissing = await request(app).delete(`/api/tags/transaction/${missing}/tag/${child.id}`).expect(404);
      expect(removeMissing.body).toEqual(refusal(404, { error: 'Transaction not found', message: 'No transaction found with the provided UUID' }));
      const removed = await request(app).delete(`/api/tags/transaction/${t.uuid}/tag/${child.id}`).expect(200);
      expect(removed.body).toEqual({ success: true, message: 'Tag removed from transaction' });
      const removedAgain = await request(app).delete(`/api/tags/transaction/${t.uuid}/tag/${child.id}`).expect(404);
      expect(removedAgain.body).toEqual(refusal(404, { error: 'Tag association not found', message: 'This tag is not associated with the transaction' }));
    });
  });

  describe('tagging budget items', () => {
    it('adds, lists and removes a budget item\'s tags', async () => {
      const t = await tag('Utilities');
      const item = await one<{ id: number; uuid: string }>(`INSERT INTO budget_items (name) VALUES ('Power') RETURNING id, uuid`);

      const noTag = await request(app).post(`/api/tags/budget-items/${item.uuid}/tags`).send({}).expect(400);
      expect(noTag.body).toEqual(invalid('tag_id', 'tag_id is required'));
      const noItem = await request(app).post(`/api/tags/budget-items/${missing}/tags`).send({ tag_id: t.id }).expect(404);
      expect(noItem.body).toEqual(refusal(404, { error: 'Budget item not found', message: 'No budget item found with the provided UUID' }));
      const badTag = await request(app).post(`/api/tags/budget-items/${item.uuid}/tags`).send({ tag_id: 2147483647 }).expect(400);
      expect(badTag.body.code).toBe('INVALID_REFERENCE');

      const added = await request(app).post(`/api/tags/budget-items/${item.uuid}/tags`).send({ tag_id: t.id }).expect(201);
      expect(added.body).toEqual({ success: true, message: 'Tag added to budget item', tagging: { id: expect.any(Number), uuid: expect.any(String) } });
      const again = await request(app).post(`/api/tags/budget-items/${item.uuid}/tags`).send({ tag_id: t.id }).expect(409);
      expect(again.body).toEqual(refusal(409, { error: 'Duplicate tag', message: 'This tag is already associated with the budget item' }));

      const list = await request(app).get(`/api/tags/budget-items/${item.uuid}/tags`).expect(200);
      expect(list.body).toEqual([
        {
          id: t.id, uuid: t.uuid, name: 'Utilities', color: '#3B82F6', icon: 'Tag', parent_id: null, level: 0,
          hierarchy_path: 'Utilities', report_root_id: null, report_root_uuid: null, report_root_name: null,
        },
      ]);

      const removeMissing = await request(app).delete(`/api/tags/budget-items/${missing}/tags/${t.id}`).expect(404);
      expect(removeMissing.body).toEqual(refusal(404, { error: 'Budget item not found', message: 'No budget item found with the provided UUID' }));
      const removed = await request(app).delete(`/api/tags/budget-items/${item.uuid}/tags/${t.id}`).expect(200);
      expect(removed.body).toEqual({ success: true, message: 'Tag removed from budget item' });
      const removedAgain = await request(app).delete(`/api/tags/budget-items/${item.uuid}/tags/${t.id}`).expect(404);
      expect(removedAgain.body).toEqual(refusal(404, { error: 'Tag association not found', message: 'This tag is not associated with the budget item' }));
    });

    it('refuses a namespace change that names a tag badly, outside the namespace, or no tag', async () => {
      const root = await tag('Payer');
      await request(app).put(`/api/tags/${root.uuid}/report-root`).send({ is_report_root: true }).expect(200);
      const outsider = await tag('Not a payer');
      const item = await one<{ uuid: string }>(`INSERT INTO budget_items (name) VALUES ('Internet') RETURNING uuid`);
      const path = `/api/tags/budget-items/${item.uuid}/namespace/${root.uuid}`;

      const badType = await request(app).put(path).send({ tag_uuid: 5 }).expect(400);
      expect(badType.body).toEqual(invalid('tag_uuid', 'tag_uuid must be a string (the tag to apply) or null (to clear)'));
      const noRoot = await request(app).put(`/api/tags/budget-items/${item.uuid}/namespace/${missing}`).send({ tag_uuid: null }).expect(404);
      expect(noRoot.body).toEqual(refusal(404, { error: 'Report root not found', message: 'No tag found with the provided rootTagUuid' }));
      const noTag = await request(app).put(path).send({ tag_uuid: missing }).expect(404);
      expect(noTag.body).toEqual(refusal(404, { error: 'Tag not found', message: 'No tag found with the provided tag_uuid' }));
      // A string that isn't a uuid names no tag (this answered 500).
      const malformed = await request(app).put(path).send({ tag_uuid: 'abc' }).expect(404);
      expect(malformed.body).toEqual(noTag.body);
      const elsewhere = await request(app).put(path).send({ tag_uuid: outsider.uuid }).expect(400);
      expect(elsewhere.body).toEqual(refusal(400, { error: 'Tag not in namespace', message: 'The provided tag does not belong to the specified report namespace' }));
      // tag_uuid is required: a string, or null to clear.
      const absent = await request(app).put(path).send({}).expect(400);
      expect(absent.body).toEqual(badType.body);
      const nulled = await request(app).put(path).send({ tag_uuid: null }).expect(200);
      expect(nulled.body).toEqual({ success: true, message: 'Namespace tag cleared', tagging: null });
    });
  });

  describe('auto-tagging', () => {
    it('answers 404 for a budget item or merchant that does not exist', async () => {
      const item = await request(app).post(`/api/tags/auto-tag/budget-item/${missing}`).expect(404);
      expect(item.body).toEqual(refusal(404, { error: 'Budget item not found', message: 'No budget item found with the provided UUID' }));
      const merchant = await request(app).post(`/api/tags/auto-tag/merchant/${missing}`).expect(404);
      expect(merchant.body).toEqual(refusal(404, { error: 'Merchant not found', message: 'No merchant found with the provided UUID' }));
    });
  });
});
