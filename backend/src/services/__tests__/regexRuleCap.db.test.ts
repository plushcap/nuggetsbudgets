import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { getDb, withTenant } from '../../db/withTenant.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { MAX_REGEX_RULES_PER_TENANT } from '../../utils/userRegex.js';
import { BudgetItemMatchingRules } from '../budgetItems/BudgetItemMatchingRules.js';
import { MerchantRuleService } from '../merchants/MerchantRuleService.js';

/**
 * The cap on a ledger's regex rules (regexRuleCap.ts) holds when two creates run at once.
 * The count had no lock: a create whose rule wasn't committed yet didn't count
 * for the other, so both went in past the cap. Each case holds one create's transaction open
 * after its insert and starts the second: it must wait for the first, then count its rule and
 * be refused, leaving the ledger at the cap.
 */
describe('the regex rule cap, with two creates at once', () => {
  let tenant: TestTenant;
  let merchant: { id: number; uuid: string };
  let budgetItemId: number;

  beforeAll(async () => {
    tenant = await createTestTenant('Regex rule cap race');
    merchant = (await tenant.pool.query<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ('Regex cap merchant') RETURNING id, uuid`)).rows[0]!;
    budgetItemId = (await tenant.pool.query<{ id: number }>(`INSERT INTO budget_items (name, expense_type) VALUES ('Regex cap item', 'Expense') RETURNING id`)).rows[0]!.id;
    // One short of the cap, of each kind.
    await tenant.pool.query(
      `INSERT INTO merchant_matching_rules (merchant_id, method, matching_text)
       SELECT $1, 'regex', '^seed ' || g FROM generate_series(1, $2::int) AS g`,
      [merchant.id, MAX_REGEX_RULES_PER_TENANT - 1]
    );
    await tenant.pool.query(
      `INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, is_active)
       SELECT $1, 'regex', '^seed ' || g, true FROM generate_series(1, $2::int) AS g`,
      [budgetItemId, MAX_REGEX_RULES_PER_TENANT - 1]
    );
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  /**
   * Run `create('first')` in a transaction held open after it, then `create('second')` in
   * another; let the first commit once the second has waited for it (or finished: what the
   * race allowed before). Answers how the second ended.
   */
  async function race(create: (text: string) => Promise<unknown>): Promise<{ ok: true } | { ok: false; code: unknown }> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let firstPid!: number;
    let firstInserted!: () => void;
    const inserted = new Promise<void>((resolve) => (firstInserted = resolve));
    const first = withTenant(tenant.tenantId, async () => {
      firstPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb())).rows[0]!.pid;
      await create('^first');
      firstInserted();
      await released;
    });
    try {
      await inserted;
      let settled = false;
      const second = withTenant(tenant.tenantId, () => create('^second')).then(
        () => ({ ok: true as const }),
        (err: { code?: unknown }) => ({ ok: false as const, code: err.code })
      ).finally(() => (settled = true));
      const deadline = Date.now() + 5_000;
      while (!settled) {
        const waiting = await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [firstPid]);
        if (waiting.rowCount) break;
        if (Date.now() > deadline) throw new Error('the second create neither waited nor finished');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      await first;
      return await second;
    } finally {
      release();
      await first.catch(() => undefined);
    }
  }

  const count = async (table: 'merchant_matching_rules' | 'budget_item_matching_rules') =>
    Number((await tenant.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE method = 'regex'`)).rows[0]!.n);

  it('refuses the second of two merchant regex rules created at once past the cap', async () => {
    const rules = new MerchantRuleService();
    const second = await race((text) => rules.create(merchant.uuid, 'regex', text));
    expect(second).toEqual({ ok: false, code: 'TOO_MANY_REGEX_RULES' });
    expect(await count('merchant_matching_rules')).toBe(MAX_REGEX_RULES_PER_TENANT);
  });

  it('refuses the second of two budget item regex rules created at once past the cap', async () => {
    const rules = new BudgetItemMatchingRules();
    const second = await race((text) => rules.create({ budget_item_id: budgetItemId, method: 'regex', matching_text: text }));
    expect(second).toEqual({ ok: false, code: 'TOO_MANY_REGEX_RULES' });
    expect(await count('budget_item_matching_rules')).toBe(MAX_REGEX_RULES_PER_TENANT);
  });
});
