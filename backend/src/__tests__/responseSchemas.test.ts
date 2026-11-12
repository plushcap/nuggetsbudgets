import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  accountResponseSchema,
  answerProblem,
  dayText,
  droppedKeys,
  instant,
  nullableStoredValue,
  responseAmount,
  responseDecimal,
  storedValue,
  transactionResponseSchema,
} from '@nuggets/shared';

/**
 * The response schemas' parts: what an answer's money, dates and checked
 * columns may hold, and `answerProblem`, which the route tests and the frontend's parse use
 * to report a field a schema refuses or doesn't name. The route tests parse real answers
 * with the entity schemas; this pins the parts on their own.
 */
describe('response schemas', () => {
  it('reads an amount as pg or the server sends it, and refuses one that is not an amount to the cent', () => {
    expect(['-12.50', '0.00', '1000', 12.5, -0.3, 0].map((v) => responseAmount.parse(v))).toEqual([-12.5, 0, 1000, 12.5, -0.3, 0]);
    for (const bad of ['', ' 1', '1.234', 'abc', '1e2', 0.1 + 0.2, Number.NaN, Infinity, null, true]) {
      expect(responseAmount.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('reads a share count, price or percentage at any scale, and refuses text that is not a decimal', () => {
    expect(['0.00012345', '-3', 2.5, 1e-7, 100 / 3].map((v) => responseDecimal.parse(v))).toEqual([0.00012345, -3, 2.5, 1e-7, 100 / 3]);
    for (const bad of ['', 'NaN', '1,5', '0x10', '1e-7', Number.NaN, Infinity]) expect(responseDecimal.safeParse(bad).success, String(bad)).toBe(false);
  });

  it('takes an instant with its offset and a calendar date as text, and refuses the naive or the other form', () => {
    expect(instant.safeParse('2026-06-14T23:40:00.000Z').success).toBe(true);
    expect(instant.safeParse('2026-06-14T23:40:00+02:00').success).toBe(true);
    expect(instant.safeParse('2026-06-14 23:40:00').success).toBe(false);
    expect(dayText.safeParse('2026-06-14').success).toBe(true);
    expect(dayText.safeParse('2026-06-14T00:00:00.000Z').success).toBe(false);
  });

  it("takes a checked column's legacy value, which a row may keep, but not an empty one", () => {
    const kind = storedValue(['checking', 'savings'] as const);
    expect(kind.parse('savings')).toBe('savings');
    expect(kind.parse('Checking (old)')).toBe('Checking (old)');
    expect(kind.safeParse('').success).toBe(false);
    expect(kind.safeParse(3).success).toBe(false);
  });

  it("reads a nullable checked column's empty text as none", () => {
    const kind = nullableStoredValue(['Asset', 'Liability'] as const);
    expect(kind.parse('')).toBeNull();
    expect(kind.parse(null)).toBeNull();
    expect(kind.parse('Asset')).toBe('Asset');
    expect(kind.parse('asset')).toBe('asset');
    expect(kind.safeParse(3).success).toBe(false);
    expect(kind.safeParse(undefined).success).toBe(false);
  });

  it('names each field, however deep, that a schema would drop', () => {
    const schema = z.object({ rows: z.array(z.object({ id: z.number() })), meta: z.object({ n: z.number() }) });
    const raw = { rows: [{ id: 1 }, { id: 2, extra: true }], meta: { n: 1, more: 'x' }, top: null };
    expect(droppedKeys(raw, schema.parse(raw))).toEqual(['rows[1].extra', 'meta.more', 'top']);
    expect(answerProblem(schema, raw)).toBe("fields the schema doesn't name: rows[1].extra, meta.more, top");
    expect(answerProblem(schema, { rows: [{ id: 1 }], meta: { n: 1 } })).toBeNull();
    expect(answerProblem(schema, { rows: [{ id: '1' }], meta: { n: 1 } })).toMatch(/rows\[0\]\.id/);
  });

  it('refuses an account or transaction answer a fixture could have got wrong', () => {
    const transaction = {
      id: 1, uuid: '0190a000-0001-7000-8000-000000000001', amount: '-12.50', type: 'expense', status: 'cleared',
      review_status: 'reviewed', transaction_date: '2026-06-01', description: null, budget_item_id: null,
      budget_period_id: null, budget_period_item_id: null, merchant_id: null, is_split_parent: false,
      parent_transaction_id: null, created_at: '2026-06-01T00:00:00.000Z', updated_at: null,
    };
    expect(answerProblem(transactionResponseSchema, transaction)).toBeNull();
    expect(transactionResponseSchema.parse(transaction).amount).toBe(-12.5);
    for (const [field, value] of [['amount', ''], ['amount', '1.234'], ['uuid', 'x'], ['transaction_date', '2026-06-01T00:00:00Z'], ['type', '']] as const) {
      expect(answerProblem(transactionResponseSchema, { ...transaction, [field]: value }), field).toMatch(field);
    }
    expect(answerProblem(transactionResponseSchema, { ...transaction, user_id: 3 })).toMatch(/doesn't name: user_id/);
    expect(accountResponseSchema.safeParse({ id: 1, uuid: transaction.uuid, name: 'x' }).success).toBe(false);
  });
});
