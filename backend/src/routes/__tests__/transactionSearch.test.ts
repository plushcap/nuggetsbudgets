import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createTransactionsRoutes } from '../transactions.js';
import { containsPattern } from '../../utils/likePattern.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The transaction list's search matches the description with
 * `strpos(lower(description), lower(term)) > 0` in place of `ILIKE '%term%'`, which
 * is faster under RLS. ILIKE on a multibyte database lowercases both sides and matches the
 * pattern, so the two should find the same rows: here, for each term, the list and the
 * paginated list answer exactly the rows ILIKE with the escaped pattern finds, with `%`,
 * `_` and `\` as themselves, any case, and letters whose lowercase differs from a simple
 * per-character map (ß, İ, final sigma, ligatures).
 */
describe('the transaction search matches the description as ILIKE did', () => {
  let app: Express;
  let tenant: TestTenant;

  const descriptions = [
    'SAMPLEMART Mktplace PMTS',
    'samplemart.example*AB12',
    'Refund 100%',
    'Refund 1000 and more',
    'Ref_1 fee',
    'RefX1 fee',
    'back\\slash',
    'backslash',
    'Straße 5',
    'STRASSE 6',
    'İstanbul kebab',
    'istanbul',
    'ΣΊΣΥΦΟΣ books',
    'σίσυφος café',
    'CAFÉ AU LAIT',
    'ﬁsh market',
    '😀 emoji store',
    '',
  ];
  const terms = ['samplemart', 'SAMPLEMART', '100%', '%', '_', 'Ref_1', '\\', 'back\\s', 'ß', 'strasse', 'İ', 'i', 'Σ', 'ς', 'é', 'É', 'ﬁ', 'fi', '😀', ' ', 'nothing here'];

  beforeAll(async () => {
    tenant = await createTestTenant('Transaction search strpos');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    // Names no term matches, so only the description arm decides.
    const account = (
      await tenant.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Q', 'checking', 'cash', 'Asset') RETURNING id`)
    ).rows[0].id;
    for (const description of [...descriptions, null]) {
      await tenant.pool.query(`INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -1, '2026-10-01', 'expense', $2)`, [
        account,
        description,
      ]);
    }
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  /** What ILIKE with the escaped pattern finds, as the search did before. */
  const byIlike = async (term: string) =>
    (
      await tenant.pool.query<{ uuid: string }>(`SELECT uuid FROM transactions WHERE description ILIKE $1 ORDER BY uuid`, [containsPattern(term)])
    ).rows.map((r) => r.uuid);

  it.each(terms)('%j', async (term) => {
    const expected = await byIlike(term);
    const page = await request(app).get('/api/transactions/paginated').query({ search: term, limit: 100 }).expect(200);
    expect(page.body.pagination.total, term).toBe(expected.length);
    expect(page.body.transactions.map((t: { uuid: string }) => t.uuid).sort(), term).toEqual(expected);
    const list = await request(app).get('/api/transactions').query({ search: term }).expect(200);
    const rows = (Array.isArray(list.body) ? list.body : list.body.transactions) as Array<{ uuid: string }>;
    expect(rows.map((t) => t.uuid).sort(), term).toEqual(expected);
  });

  it('finds the literal text, not a wildcard, for % and _', async () => {
    const found = async (term: string) =>
      ((await request(app).get('/api/transactions/paginated').query({ search: term, limit: 100 }).expect(200)).body.transactions as Array<{ description: string }>)
        .map((t) => t.description)
        .sort();
    expect(await found('100%')).toEqual(['Refund 100%']);
    expect(await found('Ref_1')).toEqual(['Ref_1 fee']);
    expect(await found('back\\s')).toEqual(['back\\slash']);
    expect(await found('strasse')).toEqual(['STRASSE 6']);
  });
});
