import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express, NextFunction, Request, Response } from 'express';
import path from 'path';
import { promises as fsp } from 'fs';
import { sql } from 'kysely';
import { createMerchantsRoutes } from '../merchants.js';
import { runRegexPreview } from '../../services/merchants/regexPreview.js';
import { createBudgetRoutes } from '../budgets.js';
import { createAttachmentRoutes } from '../attachments.js';
import { getDb, withTenant } from '../../db/withTenant.js';
import { BudgetItemMatcher } from '../../services/BudgetItemMatcher.js';
import { answerError } from '../../utils/apiError.js';
import { MAX_REGEX_RULES_PER_TENANT, resetUserRegex } from '../../utils/userRegex.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { jpeg, latin1, png } from '../../test/imageFixtures.js';

/**
 * Input and upload hardening: regex rules can't stall the server,
 * uploads are checked by their bytes and lose their metadata, and a
 * merchant's website is an http(s) link.
 */
describe('Input and upload hardening', () => {
  let tenant: TestTenant;
  let app: Express;
  let budgetItemId: number;
  let merchant: { id: number; uuid: string };
  let accountId: number;
  const uploadDir = path.join(process.cwd(), 'uploads');
  const writtenFiles: string[] = [];

  const q = (text: string, params: unknown[] = []) => tenant.pool.query(text, params);

  beforeAll(async () => {
    tenant = await createTestTenant('Input hardening');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/attachments', createAttachmentRoutes());
    // The app's global handler: a multer error raised before the route answers here.
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => answerError(err, res));

    budgetItemId = (await q(`INSERT INTO budget_items (name, expense_type, type) VALUES ('Groceries', 'Expense', 'Monthly') RETURNING id`)).rows[0].id;
    merchant = (await q(`INSERT INTO merchants (name) VALUES ('Corner Shop') RETURNING id, uuid`)).rows[0];
    accountId = (await q(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await resetUserRegex();
    await Promise.all(writtenFiles.map((f) => fsp.unlink(path.join(uploadDir, f)).catch(() => undefined)));
    await tenant?.cleanup();
  });

  describe('regex rules', () => {
    it('refuses a catastrophic pattern when a budget rule or a merchant rule is saved', async () => {
      const create = await request(app)
        .post('/api/budgets/item-matching-rules')
        .send({ budget_item_id: budgetItemId, method: 'regex', matching_text: '(a+)+$' });
      expect(create.status).toBe(400);
      expect(create.body).toMatchObject({ code: 'INVALID_PATTERN', message: expect.stringMatching(/another repeat/) });

      const ok = await request(app)
        .post('/api/budgets/item-matching-rules')
        .send({ budget_item_id: budgetItemId, method: 'regex', matching_text: '^SAMPLE GROCER\\s+#\\d+' })
        .expect(201);
      const update = await request(app)
        .put(`/api/budgets/item-matching-rules/${ok.body.uuid}`)
        .send({ budget_item_id: budgetItemId, method: 'regex', matching_text: '(\\w+\\s?)*$' });
      expect(update.status).toBe(400);
      expect(update.body.code).toBe('INVALID_PATTERN');

      const merchantRule = await request(app)
        .post(`/api/merchants/${merchant.uuid}/rules`)
        .send({ method: 'regex', matching_text: '(a*)*b' });
      expect(merchantRule.status).toBe(400);
      expect(merchantRule.body.code).toBe('INVALID_PATTERN');
      const saved = await request(app).post(`/api/merchants/${merchant.uuid}/rules`).send({ method: 'regex', matching_text: '^CORNER' }).expect(201);
      const merchantUpdate = await request(app).put(`/api/merchants/rules/${saved.body.uuid}`).send({ method: 'regex', matching_text: '(' });
      expect(merchantUpdate.status).toBe(400);
      expect(merchantUpdate.body.message).toBe('This isn’t a valid regular expression.');
      await q(`DELETE FROM merchant_matching_rules`);
      await q(`DELETE FROM budget_item_matching_rules`);
    });

    it('matches past a stored catastrophic budget rule without blocking the server', async () => {
      // Saved before the check existed: straight into the table.
      const fallback = (await q(`INSERT INTO budget_items (name, expense_type, type) VALUES ('Fallback', 'Expense', 'Monthly') RETURNING id`)).rows[0].id;
      await q(`INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, priority, is_active) VALUES ($1, 'regex', '(a+)+$', 1, true)`, [budgetItemId]);
      await q(`INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, priority, is_active) VALUES ($1, 'contains', 'a!', 2, true)`, [fallback]);

      // 28 a's: about 4 s of backtracking on the main thread; 40 would take hours.
      const description = `${'a'.repeat(28)}!`;
      let ticks = 0;
      const ticker = setInterval(() => (ticks += 1), 10);
      const started = Date.now();
      const match = await withTenant(tenant.tenantId, () => new BudgetItemMatcher().findBudgetItemMatch(null, description, -5));
      const elapsed = Date.now() - started;
      clearInterval(ticker);

      expect(match).toMatchObject({ budgetItemId: fallback, method: 'description-rule' });
      expect(elapsed).toBeLessThan(1_500);
      expect(ticks).toBeGreaterThan(2);
      await q(`DELETE FROM budget_item_matching_rules`);
    });

    it(`refuses an active regex budget rule past the ledger's ${MAX_REGEX_RULES_PER_TENANT}`, async () => {
      // Saved one by one, a ledger stops at the cap.
      await q(
        `INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, priority, is_active)
         SELECT $1, 'regex', '^CAP' || n, 100, true FROM generate_series(1, $2::int) n`,
        [budgetItemId, MAX_REGEX_RULES_PER_TENANT]
      );
      const refused = await request(app)
        .post('/api/budgets/item-matching-rules')
        .send({ budget_item_id: budgetItemId, method: 'regex', matching_text: '^ONE\\s+MORE' });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: 'TOO_MANY_REGEX_RULES', message: expect.stringContaining(String(MAX_REGEX_RULES_PER_TENANT)) });
      // Other methods aren't counted, nor is a rule saved turned off.
      await request(app).post('/api/budgets/item-matching-rules').send({ budget_item_id: budgetItemId, method: 'contains', matching_text: 'one more' }).expect(201);
      const existing = (await q(`SELECT uuid FROM budget_item_matching_rules WHERE method = 'regex' ORDER BY id LIMIT 1`)).rows[0].uuid;
      // A rule already counted may be changed.
      await request(app).put(`/api/budgets/item-matching-rules/${existing}`).send({ budget_item_id: budgetItemId, method: 'regex', matching_text: '^CHANGED' }).expect(200);
      // Turning one off makes room for another; turning it back on is then refused.
      await request(app).put(`/api/budgets/item-matching-rules/${existing}`).send({ budget_item_id: budgetItemId, method: 'regex', matching_text: '^CHANGED', is_active: false }).expect(200);
      await request(app).post('/api/budgets/item-matching-rules').send({ budget_item_id: budgetItemId, method: 'regex', matching_text: '^ONE\\s+MORE' }).expect(201);
      const reactivate = await request(app).put(`/api/budgets/item-matching-rules/${existing}`).send({ budget_item_id: budgetItemId, method: 'regex', matching_text: '^CHANGED', is_active: true });
      expect(reactivate.body.code).toBe('TOO_MANY_REGEX_RULES');
      await q(`DELETE FROM budget_item_matching_rules`);
    });

    it('keeps a ledger with more regex budget rules than the cap working, running only the first ones', async () => {
      // Saved before the cap: straight into the table. The ones past the cap would match.
      const late = (await q(`INSERT INTO budget_items (name, expense_type, type) VALUES ('Past the cap', 'Expense', 'Monthly') RETURNING id`)).rows[0].id;
      const fallback = (await q(`INSERT INTO budget_items (name, expense_type, type) VALUES ('Cap fallback', 'Expense', 'Monthly') RETURNING id`)).rows[0].id;
      await q(
        `INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, priority, is_active)
         SELECT $1, 'regex', '^NOPE' || n || '$', n, true FROM generate_series(1, $2::int) n`,
        [budgetItemId, MAX_REGEX_RULES_PER_TENANT]
      );
      await q(
        `INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, priority, is_active)
         SELECT $1, 'regex', '^GROCER', $2::int + n, true FROM generate_series(1, 5) n`,
        [late, MAX_REGEX_RULES_PER_TENANT]
      );
      await q(`INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, priority, is_active) VALUES ($1, 'contains', 'grocer', 1000, true)`, [fallback]);

      const match = await withTenant(tenant.tenantId, () => new BudgetItemMatcher().findBudgetItemMatch(null, 'GROCER MARKET 4', -5));
      expect(match).toMatchObject({ budgetItemId: fallback, method: 'description-rule' });
      // One of the first ones still matches.
      const first = await withTenant(tenant.tenantId, () => new BudgetItemMatcher().findBudgetItemMatch(null, 'NOPE7', -5));
      expect(first).toMatchObject({ budgetItemId, method: 'description-rule' });
      await q(`DELETE FROM budget_item_matching_rules`);
    });

    it("skips a merchant regex rule Postgres refuses in the rule preview, instead of failing it", async () => {
      // JavaScript accepts a named group; Postgres doesn't.
      await q(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'regex', '(?<n>CORNER)')`, [merchant.id]);
      await q(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'corner')`, [merchant.id]);
      await q(`INSERT INTO transactions (account_id, type, amount, transaction_date, description) VALUES ($1, 'expense', -3.00, '2026-10-01', 'CORNER SHOP 12')`, [accountId]);

      const res = await request(app).post(`/api/merchants/${merchant.uuid}/test-rules`).expect(200);
      expect(res.body.skippedRules).toEqual([expect.objectContaining({ method: 'regex', reason: 'invalid_pattern' })]);
      expect(res.body.matchingTransactions.map((t: { description: string }) => t.description)).toEqual(['CORNER SHOP 12']);
      await q(`DELETE FROM merchant_matching_rules`);
    });

    it('stops a slow regex preview at its own timeout and puts the statement timeout back', async () => {
      // About 10 ms of matching per 255-character description: 2 s for these 200.
      await q(
        `INSERT INTO transactions (account_id, type, amount, transaction_date, description)
         SELECT $1, 'expense', -1.00, '2026-10-01', repeat('a', 255) FROM generate_series(1, 200)`,
        [accountId]
      );
      const outcome = await withTenant(tenant.tenantId, async () => {
        const before = (await sql<{ t: string }>`SHOW statement_timeout`.execute(getDb())).rows[0].t;
        const started = Date.now();
        const ran = await runRegexPreview(
          () => sql`SELECT count(*) FROM transactions WHERE description ~* ${'(.*){1,255}(.*){1,255}b'}`.execute(getDb()),
          200
        );
        const elapsed = Date.now() - started;
        const after = (await sql<{ t: string }>`SHOW statement_timeout`.execute(getDb())).rows[0].t;
        // The transaction is still usable.
        const ok = (await sql<{ one: number }>`SELECT 1 AS one`.execute(getDb())).rows[0].one;
        return { ran, elapsed, before, after, ok };
      });
      expect(outcome.ran).toEqual({ ok: false, reason: 'too_slow' });
      expect(outcome.elapsed).toBeLessThan(1_500);
      expect(outcome.after).toBe(outcome.before);
      expect(outcome.ok).toBe(1);
      await q(`DELETE FROM transactions WHERE description = repeat('a', 255)`);
    });
  });

  describe("a merchant's website", () => {
    it('stores an http(s) link and refuses any other', async () => {
      const bad = await request(app).post('/api/merchants').send({ name: 'Evil', merchant_website: 'javascript:alert(document.cookie)' });
      expect(bad.status).toBe(400);
      expect(bad.body.details).toEqual([expect.objectContaining({ field: 'merchant_website' })]);

      const created = await request(app).post('/api/merchants').send({ name: 'Bakery', merchant_website: 'bakery.example' }).expect(201);
      expect(created.body.merchant_website).toBe('https://bakery.example');

      const update = await request(app).put(`/api/merchants/${created.body.uuid}`).send({ name: 'Bakery', merchant_website: 'https://bank.example@evil.example/' });
      expect(update.status).toBe(400);
      const cleared = await request(app).put(`/api/merchants/${created.body.uuid}`).send({ name: 'Bakery', merchant_website: '' }).expect(200);
      expect(cleared.body.merchant_website).toBeNull();
    });
  });

  describe('uploads', () => {
    const upload = () =>
      request(app).post('/api/attachments/upload').field('transaction_id', String(transactionId));
    let transactionId: number;

    beforeAll(async () => {
      transactionId = (await q(
        `INSERT INTO transactions (account_id, type, amount, transaction_date, description) VALUES ($1, 'expense', -9.00, '2026-10-03', 'Receipt') RETURNING id`,
        [accountId]
      )).rows[0].id;
    });

    it("keeps a file's name as the browser sent it, in UTF-8", async () => {
      const res = await upload().attach('attachments', latin1('%PDF-1.4 receipt'), 'Quittung für März.pdf').expect(201);
      writtenFiles.push(res.body.attachments[0].safe_filename);
      // multer read it as Latin-1: "Quittung fÃ¼r MÃ¤rz.pdf".
      expect(res.body.attachments[0].original_filename).toBe('Quittung für März.pdf');
    });

    it("downloads an attachment whose name isn't Latin-1", async () => {
      const res = await upload().attach('attachments', latin1('%PDF-1.4 receipt'), 'receipt.pdf').expect(201);
      const att = res.body.attachments[0];
      writtenFiles.push(att.safe_filename);
      // A client that sends filename*=UTF-8''… (or a name stored another way) gets this.
      await q(`UPDATE attachments SET original_filename = '領収書.pdf' WHERE uuid = $1`, [att.uuid]);
      const file = await request(app).get(`/api/attachments/file/${att.uuid}`).expect(200);
      expect(file.headers['content-disposition']).toBe(`inline; filename="___.pdf"; filename*=UTF-8''%E9%A0%98%E5%8F%8E%E6%9B%B8.pdf`);
    });

    it('refuses a file whose bytes are not what its name says', async () => {
      const res = await upload().attach('attachments', latin1('<html><script>alert(1)</script></html>'), 'invoice.pdf');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'UPLOAD_REJECTED', error: expect.stringMatching(/isn’t the kind of file its name says/) });
      const png2pdf = await upload().attach('attachments', png(), 'scan.pdf');
      expect(png2pdf.status).toBe(400);
      expect((await q(`SELECT count(*)::int AS n FROM attachments WHERE original_filename IN ('invoice.pdf', 'scan.pdf')`)).rows[0].n).toBe(0);
    });

    it('takes at most 10 files in one request', async () => {
      let req = upload();
      for (let i = 0; i < 11; i++) req = req.attach('attachments', latin1('%PDF-1.4 x'), `f${i}.pdf`);
      const res = await req;
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UPLOAD_REJECTED');
      expect((await q(`SELECT count(*)::int AS n FROM attachments WHERE original_filename LIKE 'f%.pdf'`)).rows[0].n).toBe(0);
    });

    it("stores a photo attachment without its metadata, as the type its bytes are", async () => {
      const res = await upload().attach('attachments', jpeg(), { filename: 'photo.jpg', contentType: 'application/octet-stream' }).expect(201);
      const att = res.body.attachments[0];
      writtenFiles.push(att.safe_filename);
      expect(att.mime_type).toBe('image/jpeg');
      const onDisk = await fsp.readFile(path.join(uploadDir, att.safe_filename));
      expect(onDisk.includes(latin1('SECRET'))).toBe(false);
      expect(att.file_size).toBe(onDisk.length);
    });

    it("stores a merchant's image without its metadata, as the type its bytes are", async () => {
      // A JPEG the browser called a PNG.
      const res = await request(app)
        .post(`/api/merchants/${merchant.uuid}/upload-image`)
        .attach('merchant_image', jpeg(), { filename: 'logo.png', contentType: 'image/png' })
        .expect(200);
      const uuid = /^\/api\/images\/(.+)$/.exec(res.body.merchant.merchant_image)?.[1];
      const stored = (await q(`SELECT mime_type, data FROM stored_images WHERE uuid = $1`, [uuid])).rows[0];
      expect(stored.mime_type).toBe('image/jpeg');
      expect((stored.data as Buffer).includes(latin1('SECRET'))).toBe(false);

      const fake = await request(app)
        .post(`/api/merchants/${merchant.uuid}/upload-image`)
        .attach('merchant_image', latin1('<svg onload="alert(1)"></svg>'), { filename: 'logo.png', contentType: 'image/png' });
      expect(fake.status).toBe(400);
      expect(fake.body.code).toBe('UPLOAD_REJECTED');
    });
  });
});
