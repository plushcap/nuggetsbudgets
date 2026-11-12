import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createMerchantsRoutes } from '../merchants.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * What the merchant routes answer, status and body, for the paths the other merchant
 * suites don't reach: the lists and search, create/update/delete checks, the image
 * upload, matching rules (CRUD, preview and apply) and removing unused merchants.
 * Written before the routes' data access moved into services/merchants/,
 * so the move keeps every answer.
 */
describe('Merchant routes: lists, checks, images and matching rules', () => {
  /**
   * A refusal the services throw (MerchantError), as the route wrapper answers it: the body
   * the route wrote before, with its code (the status's when it named none) and `message`
   * (its error's text when it had none). Mounted alone, there is no request id.
   */
  const CODES: Record<number, string> = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT' };
  const refusal = (status: number, body: { error: string; message?: string; code?: string; [k: string]: unknown }) => ({
    ...body,
    code: body.code ?? CODES[status],
    message: body.message ?? body.error,
  });
  /** A body validateBody or validateQuery refused, naming `field` with `message`. */
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
  type Merchant = { id: number; uuid: string };
  const merchant = (name: string, extra: { website?: string; notes?: string } = {}) =>
    one<Merchant>(`INSERT INTO merchants (name, merchant_website, notes) VALUES ($1, $2, $3) RETURNING id, uuid`, [
      name, extra.website ?? null, extra.notes ?? null,
    ]);

  let accountId = 0;
  const transaction = (description: string, merchantId: number | null = null, importPayee: string | null = null) =>
    one<{ id: number; uuid: string }>(
      `INSERT INTO transactions (account_id, amount, description, import_payee, transaction_date, type, status, merchant_id)
       VALUES ($1, -10.00, $2, $3, '2026-04-01', 'expense', 'cleared', $4) RETURNING id, uuid`,
      [accountId, description, importPayee, merchantId]
    );

  beforeAll(async () => {
    tenant = await createTestTenant('Merchant routes characterization');
    accountId = (
      await one<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).id;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  describe('lists and search', () => {
    let alpha: Merchant;

    beforeAll(async () => {
      alpha = await merchant('Alpha Foods', { website: 'https://alpha.example', notes: 'grocer' });
      await merchant('Beta 100% Hardware');
      await merchant('Gamma', { notes: 'sells 100% cotton' });
      await merchant('alphabet soup');
      await transaction('Alpha 1', alpha.id);
      await transaction('Alpha 2', alpha.id);
      await tenant.pool.query(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'ALPHA')`, [alpha.id]);
    });

    it('lists every merchant by name, with counts, or only the lite fields', async () => {
      const full = await request(app).get('/api/merchants').expect(200);
      expect(full.body.map((m: { name: string }) => m.name)).toEqual(['Alpha Foods', 'Beta 100% Hardware', 'Gamma', 'alphabet soup']);
      expect(Object.keys(full.body[0]).sort()).toEqual([
        'created_at', 'id', 'instructions', 'merchant_accountid', 'merchant_image', 'merchant_website', 'name', 'notes',
        'rule_count', 'transaction_auto_tag_id', 'transaction_count', 'updated_at', 'uuid',
      ]);
      expect(full.body[0]).toMatchObject({ uuid: alpha.uuid, transaction_count: 2, rule_count: 1 });
      expect(full.body[3]).toMatchObject({ transaction_count: 0, rule_count: 0 });

      const lite = await request(app).get('/api/merchants').query({ fields: 'lite' }).expect(200);
      expect(lite.body[0]).toEqual({ id: alpha.id, uuid: alpha.uuid, name: 'Alpha Foods', merchant_website: 'https://alpha.example' });
    });

    it('pages merchants, searching name, website and notes, with a % matching itself', async () => {
      const page = await request(app).get('/api/merchants/paginated').query({ page: 2, limit: 3 }).expect(200);
      expect(page.body.pagination).toEqual({ total: 4, totalPages: 2, page: 2, limit: 3 });
      expect(page.body.merchants.map((m: { name: string }) => m.name)).toEqual(['alphabet soup']);
      expect(page.body.merchants[0]).toMatchObject({ transaction_count: 0, rule_count: 0 });

      const percent = await request(app).get('/api/merchants/paginated').query({ search: ' 100% ' }).expect(200);
      expect(percent.body.merchants.map((m: { name: string }) => m.name)).toEqual(['Beta 100% Hardware', 'Gamma']);
      expect(percent.body.pagination).toEqual({ total: 2, totalPages: 1, page: 1, limit: 50 });

      const lite = await request(app).get('/api/merchants/paginated').query({ search: 'ALPHA.EXAMPLE', fields: 'lite' }).expect(200);
      expect(lite.body).toEqual({
        merchants: [{ id: alpha.id, uuid: alpha.uuid, name: 'Alpha Foods', merchant_website: 'https://alpha.example', merchant_image: null }],
        pagination: { total: 1, totalPages: 1, page: 1, limit: 50 },
      });

      const capped = await request(app).get('/api/merchants/paginated').query({ limit: 1000, page: 'x' }).expect(200);
      expect(capped.body.pagination).toEqual({ total: 4, totalPages: 1, page: 1, limit: 100 });
      // A page or limit below 1 is the default, as utils/pagination.ts reads it (these answered 500).
      const negative = await request(app).get('/api/merchants/paginated').query({ page: -1, limit: -5 }).expect(200);
      expect(negative.body.pagination).toEqual({ total: 4, totalPages: 1, page: 1, limit: 50 });
      expect(negative.body.merchants).toHaveLength(4);
      const zero = await request(app).get('/api/merchants/paginated').query({ page: 0, limit: 0 }).expect(200);
      expect(zero.body.pagination).toEqual({ total: 4, totalPages: 1, page: 1, limit: 50 });

      // A search sent twice is a list, not a search (this answered 500).
      const twice = await request(app).get('/api/merchants/paginated?search=alpha&search=gamma').expect(400);
      expect(twice.body).toEqual(invalid('search', 'search must be sent once'));
    });

    it('searches names for autocomplete: an exact name first, then the shortest', async () => {
      const res = await request(app).get('/api/merchants/search').query({ q: ' alpha foods ' }).expect(200);
      expect(res.body).toEqual([
        { id: alpha.id, uuid: alpha.uuid, name: 'Alpha Foods', merchant_website: 'https://alpha.example', merchant_image: null },
      ]);
      const prefix = await request(app).get('/api/merchants/search').query({ q: 'alpha' }).expect(200);
      expect(prefix.body.map((m: { name: string }) => m.name)).toEqual(['Alpha Foods', 'alphabet soup']);
      const blank = await request(app).get('/api/merchants/search').query({ q: '  ' }).expect(200);
      expect(blank.body).toEqual([]);
      const underscore = await request(app).get('/api/merchants/search').query({ q: '_' }).expect(200);
      expect(underscore.body).toEqual([]);
    });

    it('answers one merchant by uuid, or 404', async () => {
      const res = await request(app).get(`/api/merchants/${alpha.uuid}`).expect(200);
      expect(Object.keys(res.body).sort()).toEqual([
        'created_at', 'id', 'instructions', 'merchant_accountid', 'merchant_image', 'merchant_website', 'name', 'notes',
        'transaction_auto_tag_id', 'updated_at', 'uuid',
      ]);
      const none = await request(app).get(`/api/merchants/${missing}`).expect(404);
      expect(none.body).toEqual(refusal(404, { error: 'Merchant not found' }));
    });
  });

  describe('create, update and delete', () => {
    it('creates a merchant, refusing a long name and an image from elsewhere', async () => {
      const created = await request(app).post('/api/merchants').send({ name: 'Delta', merchant_website: 'delta.example', notes: '' }).expect(201);
      expect(created.body).toMatchObject({ name: 'Delta', merchant_website: 'https://delta.example', notes: null, merchant_image: null });
      expect(Object.keys(created.body).sort()).toEqual([
        'created_at', 'id', 'instructions', 'merchant_accountid', 'merchant_image', 'merchant_website', 'name', 'notes',
        'transaction_auto_tag_id', 'updated_at', 'uuid',
      ]);

      const long = await request(app).post('/api/merchants').send({ name: 'x'.repeat(256) }).expect(400);
      expect(long.body).toEqual({ error: 'Invalid input', message: 'Merchant name must be 255 characters or less' });
      const image = await request(app).post('/api/merchants').send({ name: 'Epsilon', merchant_image: '/api/images/elsewhere' }).expect(400);
      expect(image.body).toEqual(refusal(400, {
        error: 'Invalid input',
        message: 'merchant_image must be an image uploaded to this tenant (POST /merchants/:uuid/upload-image)',
      }));
      const javascript = await request(app).post('/api/merchants').send({ name: 'Zeta', merchant_website: 'javascript:alert(1)' }).expect(400);
      expect(javascript.body.error).toBeDefined();
    });

    it('updates a merchant: checks, defaults for what is not sent, and auto-tags its transactions when its tag changes', async () => {
      const m = await merchant('Eta', { notes: 'old' });
      const t = await transaction('Eta purchase', m.id);
      const tag = await one<{ id: number }>(`INSERT INTO tags (name) VALUES ('Eta tag') RETURNING id`);

      const noName = await request(app).put(`/api/merchants/${m.uuid}`).send({}).expect(400);
      expect(noName.body).toEqual({ error: 'Missing required fields', message: 'Name is required' });
      const long = await request(app).put(`/api/merchants/${m.uuid}`).send({ name: 'x'.repeat(256) }).expect(400);
      expect(long.body).toEqual({ error: 'Invalid input', message: 'Merchant name must be 255 characters or less' });
      const none = await request(app).put(`/api/merchants/${missing}`).send({ name: 'Ghost' }).expect(404);
      expect(none.body).toEqual(refusal(404, { error: 'Merchant not found', message: 'The specified merchant does not exist' }));
      const image = await request(app).put(`/api/merchants/${m.uuid}`).send({ name: 'Eta', merchant_image: '/api/images/x' }).expect(400);
      expect(image.body.message).toBe('merchant_image must be an image uploaded to this tenant (POST /merchants/:uuid/upload-image)');
      const badTag = await request(app).put(`/api/merchants/${m.uuid}`).send({ name: 'Eta', transaction_auto_tag_id: 2147483647 }).expect(400);
      expect(badTag.body.code).toBe('INVALID_REFERENCE');

      const res = await request(app).put(`/api/merchants/${m.uuid}`).send({ name: 'Eta Ltd', transaction_auto_tag_id: tag.id }).expect(200);
      expect(res.body).toMatchObject({ name: 'Eta Ltd', notes: null, instructions: null, transaction_auto_tag_id: tag.id });
      expect(Object.keys(res.body).sort()).toEqual([
        'created_at', 'id', 'instructions', 'merchant_accountid', 'merchant_image', 'merchant_website', 'name', 'notes',
        'transaction_auto_tag_id', 'updated_at', 'uuid',
      ]);
      const tagged = await tenant.pool.query(`SELECT 1 FROM taggings WHERE taggable_type = 'transaction' AND taggable_id = $1 AND tag_id = $2`, [t.id, tag.id]);
      expect(tagged.rowCount).toBe(1);
    });

    it('refuses to delete a merchant in use without a replacement, and checks the replacement', async () => {
      const m = await merchant('Theta');
      await transaction('Theta purchase', m.id);
      await one(`INSERT INTO budget_items (name, merchant_id) VALUES ('Theta item', $1) RETURNING id`, [m.id]);

      const none = await request(app).delete(`/api/merchants/${missing}`).expect(404);
      expect(none.body).toEqual(refusal(404, { error: 'Merchant not found', message: 'The specified merchant does not exist' }));
      const inUse = await request(app).delete(`/api/merchants/${m.uuid}`).send({}).expect(409);
      expect(inUse.body).toEqual(refusal(409, {
        error: 'Merchant in use',
        message: 'This merchant is associated with budget items, transactions, recurring items, or attachments. Please provide a replacement merchant ID.',
        usage: { budget_items: 1, transactions: 1, recurring: 0, attachments: 0 },
      }));
      const noMerchant = await request(app).delete(`/api/merchants/${m.uuid}`).send({ replacementMerchantId: missing }).expect(400);
      expect(noMerchant.body).toEqual(refusal(400, { error: 'Invalid replacement merchant', message: 'The specified replacement merchant does not exist' }));
      // One that isn't a uuid is refused by the body's schema (it was read with none).
      for (const replacementMerchantId of ['not-a-uuid', 42, { uuid: missing }]) {
        const bad = await request(app).delete(`/api/merchants/${m.uuid}`).send({ replacementMerchantId }).expect(400);
        expect(bad.body).toEqual(invalid('replacementMerchantId', "replacementMerchantId must be the replacement merchant's uuid"));
      }
      // Empty or null is none: still in use.
      for (const replacementMerchantId of ['', null]) {
        await request(app).delete(`/api/merchants/${m.uuid}`).send({ replacementMerchantId }).expect(409);
      }

      const replacement = await merchant('Iota');
      await request(app).delete(`/api/merchants/${m.uuid}`).send({ replacementMerchantId: replacement.uuid }).expect(204);
      const moved = await tenant.pool.query(`SELECT count(*)::int AS n FROM transactions WHERE merchant_id = $1`, [replacement.id]);
      expect(moved.rows[0].n).toBe(1);

      const unused = await merchant('Kappa');
      await request(app).delete(`/api/merchants/${unused.uuid}`).expect(204);
    });

    it('merges a merchant into another, moving its rules unless the target has the same one', async () => {
      const source = await merchant('Lambda');
      const target = await merchant('Lambda Inc');
      await transaction('Lambda', source.id);
      await tenant.pool.query(
        `INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'lambda'), ($1, 'exact', 'LAMBDA LTD'), ($2, 'contains', 'lambda')`,
        [source.id, target.id]
      );

      const noTarget = await request(app).post(`/api/merchants/${source.uuid}/merge`).send({}).expect(400);
      expect(noTarget.body).toEqual(invalid('targetMerchantUuid', 'Target merchant UUID is required'));
      const nowhere = await request(app).post(`/api/merchants/${source.uuid}/merge`).send({ targetMerchantUuid: missing }).expect(404);
      expect(nowhere.body).toEqual(refusal(404, { error: 'Merchant not found', message: 'One or both merchants do not exist' }));
      // A target that isn't a uuid names no merchant (this answered 500).
      const malformed = await request(app).post(`/api/merchants/${source.uuid}/merge`).send({ targetMerchantUuid: 'not-a-uuid' }).expect(404);
      expect(malformed.body).toEqual(nowhere.body);
      // One that isn't text is refused by the body's schema.
      for (const targetMerchantUuid of [42, ['x']]) {
        const notText = await request(app).post(`/api/merchants/${source.uuid}/merge`).send({ targetMerchantUuid }).expect(400);
        expect(notText.body).toEqual(invalid('targetMerchantUuid', 'Target merchant UUID is required'));
      }

      const res = await request(app).post(`/api/merchants/${source.uuid}/merge`).send({ targetMerchantUuid: target.uuid }).expect(200);
      expect(res.body).toEqual({ message: 'Merchants merged successfully', targetMerchantUuid: target.uuid });
      const rules = (await tenant.pool.query(`SELECT method, matching_text FROM merchant_matching_rules WHERE merchant_id = $1 ORDER BY method`, [target.id])).rows;
      expect(rules).toEqual([
        { method: 'contains', matching_text: 'lambda' },
        { method: 'exact', matching_text: 'LAMBDA LTD' },
      ]);
      expect((await tenant.pool.query(`SELECT 1 FROM merchants WHERE id = $1`, [source.id])).rowCount).toBe(0);
    });
  });

  describe('image upload', () => {
    // A 1×1 PNG.
    const PNG = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
        '0000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082',
      'hex'
    );

    it('stores an uploaded image as the merchant\'s, replacing the old one', async () => {
      const m = await merchant('Mu');
      const none = await request(app).post(`/api/merchants/${missing}/upload-image`).attach('merchant_image', PNG, 'mu.png').expect(404);
      expect(none.body).toEqual(refusal(404, { error: 'Merchant not found', message: 'The specified merchant does not exist' }));
      const noFile = await request(app).post(`/api/merchants/${m.uuid}/upload-image`).expect(400);
      expect(noFile.body).toEqual(refusal(400, { error: 'No file uploaded', message: 'Please select an image file to upload' }));

      const first = await request(app).post(`/api/merchants/${m.uuid}/upload-image`).attach('merchant_image', PNG, 'mu.png');
      expect(first.status).toBe(200);
      expect(first.body.message).toBe('Image uploaded successfully');
      expect(Object.keys(first.body.merchant).sort()).toEqual([
        'created_at', 'id', 'instructions', 'merchant_accountid', 'merchant_image', 'merchant_website', 'name', 'notes',
        'transaction_auto_tag_id', 'updated_at', 'uuid',
      ]);
      const firstImage: string = first.body.merchant.merchant_image;
      expect(firstImage).toMatch(/^\/api\/images\//);

      const second = await request(app).post(`/api/merchants/${m.uuid}/upload-image`).attach('merchant_image', PNG, 'mu.png').expect(200);
      expect(second.body.merchant.merchant_image).not.toBe(firstImage);
      const old = await tenant.pool.query(`SELECT 1 FROM stored_images WHERE uuid::text = $1`, [firstImage.split('/').pop()]);
      expect(old.rowCount).toBe(0);

      // Its own current image may be sent back unchanged on update.
      await request(app).put(`/api/merchants/${m.uuid}`).send({ name: 'Mu', merchant_image: second.body.merchant.merchant_image }).expect(200);
    });
  });

  describe('matching rules', () => {
    let nu: Merchant;

    beforeAll(async () => {
      nu = await merchant('Nu Coffee');
    });

    it('creates, lists, updates and deletes rules, refusing a bad method, a duplicate and a pattern that could stall', async () => {
      const path = `/api/merchants/${nu.uuid}/rules`;
      const noText = await request(app).post(path).send({ method: 'contains' }).expect(400);
      expect(noText.body).toEqual({ error: 'Missing required fields', message: 'Method and matching text are required' });
      const badMethod = await request(app).post(path).send({ method: 'fuzzy', matching_text: 'nu' }).expect(400);
      expect(badMethod.body).toEqual({ error: 'Invalid method', message: 'Method must be one of: exact, contains, starts_with, ends_with, regex' });
      const stall = await request(app).post(path).send({ method: 'regex', matching_text: '(a+)+$' }).expect(400);
      expect(stall.body.error).toBeDefined();
      const none = await request(app).post(`/api/merchants/${missing}/rules`).send({ method: 'contains', matching_text: 'nu' }).expect(404);
      expect(none.body).toEqual(refusal(404, { error: 'Merchant not found', message: 'The specified merchant does not exist' }));
      // The rest of the shared schema: text that isn't a string, or is blank, is refused.
      for (const matching_text of [5, { text: 'nu' }, ['nu'], true]) {
        const invalid = await request(app).post(path).send({ method: 'contains', matching_text }).expect(400);
        expect(invalid.body).toMatchObject({ error: 'Validation failed', code: 'VALIDATION_ERROR', message: 'Matching text must be text' });
      }
      const blank = await request(app).post(path).send({ method: 'contains', matching_text: '   ' }).expect(400);
      expect(blank.body).toMatchObject({ error: 'Validation failed', code: 'VALIDATION_ERROR', message: 'Matching text is required' });
      const stallCode = await request(app).post(path).send({ method: 'regex', matching_text: '(a+)+$' }).expect(400);
      expect(stallCode.body).toMatchObject({ error: 'Invalid pattern', code: 'INVALID_PATTERN' });

      const created = await request(app).post(path).send({ method: 'contains', matching_text: 'NU COFFEE' }).expect(201);
      expect(Object.keys(created.body).sort()).toEqual(['created_at', 'id', 'matching_text', 'merchant_id', 'method', 'updated_at', 'uuid']);
      expect(created.body).toMatchObject({ merchant_id: nu.id, method: 'contains', matching_text: 'NU COFFEE' });
      const dup = await request(app).post(path).send({ method: 'contains', matching_text: 'NU COFFEE' }).expect(409);
      expect(dup.body).toEqual(refusal(409, { error: 'Rule exists', message: 'A matching rule with this method and text already exists for this merchant' }));
      const other = await request(app).post(path).send({ method: 'exact', matching_text: 'nu' }).expect(201);

      const list = await request(app).get(path).expect(200);
      expect(list.body.map((r: { method: string }) => r.method)).toEqual(['contains', 'exact']);
      const listNone = await request(app).get(`/api/merchants/${missing}/rules`).expect(404);
      expect(listNone.body).toEqual(refusal(404, { error: 'Merchant not found' }));

      const rulePath = `/api/merchants/rules/${other.body.uuid}`;
      const updNoText = await request(app).put(rulePath).send({ method: 'exact' }).expect(400);
      expect(updNoText.body).toEqual({ error: 'Missing required fields', message: 'Method and matching text are required' });
      const updBad = await request(app).put(rulePath).send({ method: 'fuzzy', matching_text: 'x' }).expect(400);
      expect(updBad.body).toEqual({ error: 'Invalid method', message: 'Method must be one of: exact, contains, starts_with, ends_with, regex' });
      for (const [matching_text, message] of [[5, 'Matching text must be text'], [{ text: 'x' }, 'Matching text must be text'], ['   ', 'Matching text is required']]) {
        const updInvalid = await request(app).put(rulePath).send({ method: 'exact', matching_text }).expect(400);
        expect(updInvalid.body).toMatchObject({ error: 'Validation failed', code: 'VALIDATION_ERROR', message });
      }
      const updStall = await request(app).put(rulePath).send({ method: 'regex', matching_text: '(a+)+$' }).expect(400);
      expect(updStall.body).toMatchObject({ error: 'Invalid pattern', code: 'INVALID_PATTERN' });
      const updNone = await request(app).put(`/api/merchants/rules/${missing}`).send({ method: 'exact', matching_text: 'x' }).expect(404);
      expect(updNone.body).toEqual(refusal(404, { error: 'Rule not found', message: 'The specified matching rule does not exist' }));
      const updDup = await request(app).put(rulePath).send({ method: 'contains', matching_text: 'NU COFFEE' }).expect(409);
      expect(updDup.body).toEqual(refusal(409, { error: 'Rule exists', message: 'A matching rule with this method and text already exists for this merchant' }));
      const updated = await request(app).put(rulePath).send({ method: 'starts_with', matching_text: 'NU ' }).expect(200);
      expect(updated.body).toMatchObject({ uuid: other.body.uuid, method: 'starts_with', matching_text: 'NU ' });

      const delNone = await request(app).delete(`/api/merchants/rules/${missing}`).expect(404);
      expect(delNone.body).toEqual(refusal(404, { error: 'Rule not found', message: 'The specified matching rule does not exist' }));
      await request(app).delete(rulePath).expect(204);
    });

    it('previews the transactions a merchant\'s rules match, once each, on the payee where there is one', async () => {
      const xi = await merchant('Xi Books');
      const empty = await request(app).post(`/api/merchants/${xi.uuid}/test-rules`).expect(200);
      expect(empty.body).toEqual({ matchingTransactions: [], message: 'No rules defined for this merchant' });
      const none = await request(app).post(`/api/merchants/${missing}/test-rules`).expect(404);
      expect(none.body).toEqual(refusal(404, { error: 'Merchant not found' }));

      await tenant.pool.query(
        `INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'xi_b'), ($1, 'starts_with', 'XI'), ($1, 'regex', '^xi ')`,
        [xi.id]
      );
      const both = await transaction('XI BOOKS 123');
      const literal = await transaction('xi_books online');
      await transaction('PAYSVC *XI BOOKS', null, 'Other payee'); // the payee is what's matched
      await transaction('XI BOOKS again', xi.id); // already this merchant's

      const res = await request(app).post(`/api/merchants/${xi.uuid}/test-rules`).expect(200);
      expect(res.body.totalRules).toBe(3);
      expect(res.body.skippedRules).toEqual([]);
      expect(res.body.message).toBe('Found 2 matching transactions');
      expect(res.body.matchingTransactions.map((t: { id: number }) => t.id).sort((a: number, b: number) => a - b)).toEqual([both.id, literal.id]);
      const first = res.body.matchingTransactions.find((t: { id: number }) => t.id === literal.id);
      expect(Object.keys(first).sort()).toEqual([
        'account_name', 'amount', 'description', 'id', 'import_payee', 'matchingRule', 'transaction_date', 'type', 'uuid',
      ]);
      expect(first.matchingRule).toMatchObject({ method: 'contains', matching_text: 'xi_b' });
    });

    it('skips a regex rule the database refuses, and says so', async () => {
      const omicron = await merchant('Omicron');
      await tenant.pool.query(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'regex', '(?<name>x)')`, [omicron.id]);
      const res = await request(app).post(`/api/merchants/${omicron.uuid}/test-rules`).expect(200);
      expect(res.body).toEqual({
        matchingTransactions: [],
        totalRules: 1,
        skippedRules: [{ id: expect.any(Number), method: 'regex', matching_text: '(?<name>x)', reason: 'invalid_pattern' }],
        message: 'No matching transactions found (1 regular expression rule couldn’t be checked: not a pattern the database accepts)',
      });
    });

    it('applies a merchant to the transactions named', async () => {
      const pi = await merchant('Pi Pizza');
      const t1 = await transaction('PI PIZZA 1');
      const t2 = await transaction('PI PIZZA 2');

      const noIds = await request(app).post(`/api/merchants/${pi.uuid}/apply-rules`).send({ transactionIds: [] }).expect(400);
      expect(noIds.body).toEqual(invalid('transactionIds', 'Transaction IDs are required'));
      const none = await request(app).post(`/api/merchants/${missing}/apply-rules`).send({ transactionIds: [t1.id] }).expect(404);
      expect(none.body).toEqual(refusal(404, { error: 'Merchant not found' }));

      const res = await request(app).post(`/api/merchants/${pi.uuid}/apply-rules`).send({ transactionIds: [t1.id, t2.id] }).expect(200);
      expect(res.body).toEqual({ updatedCount: 2, merchantName: 'Pi Pizza', message: 'Applied merchant "Pi Pizza" to 2 transactions' });
    });
  });

  describe('removing unused merchants', () => {
    it('deletes the merchants nothing refers to, and lists them', async () => {
      const separate = await createTestTenant('Merchant routes: remove unused');
      try {
        const own = express();
        own.use(express.json());
        own.use(separate.context());
        own.use('/api/merchants', createMerchantsRoutes());

        const empty = await request(own).post('/api/merchants/admin/remove-unused').expect(200);
        expect(empty.body).toEqual({ message: 'No unused merchants found', removedCount: 0, removedMerchants: [] });

        const used = (await separate.pool.query(`INSERT INTO merchants (name) VALUES ('Used') RETURNING id`)).rows[0].id;
        const account = (
          await separate.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('A', 'checking', 'cash', 'Asset') RETURNING id`)
        ).rows[0].id;
        await separate.pool.query(
          `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status, merchant_id) VALUES ($1, -1, 'x', '2026-01-01', 'expense', 'cleared', $2)`,
          [account, used]
        );
        const unused = (await separate.pool.query(`INSERT INTO merchants (name) VALUES ('Zed'), ('Unused') RETURNING uuid, name`)).rows;

        const res = await request(own).post('/api/merchants/admin/remove-unused').expect(200);
        expect(res.body).toEqual({
          message: 'Successfully removed 2 unused merchants',
          removedCount: 2,
          removedMerchants: [unused[1], unused[0]],
        });
      } finally {
        await separate.cleanup();
      }
    });
  });
});
