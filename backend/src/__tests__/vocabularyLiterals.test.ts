import { describe, it, expect } from 'vitest';
import { packageConfig, vocabularyFindings, type Finding } from '../test/vocabularyGuard.js';

/**
 * The backend, the pages and the MCP tools take a list's values from @nuggets/shared
 * (vocabulary.ts): where they compare or look up a field that has a list (a status, a type,
 * a review status, …), the value is the shared Zod enum's member
 * (`transactionStatus.enum.reconciled`, `budgetExpenseType.enum.Income`), never written out,
 * so a list that loses or renames a value fails to build there. The database enforces each list
 * on write (vocabulary.db.test.ts); this keeps the code's reading of them from drifting.
 *
 * Which fields have a list is told by the field's name and its table or type
 * (test/vocabularyGuard.ts), never by file: a budget period's, a backup's or an organization's
 * `status` has none, a budget item's does.
 *
 * The files the contract issue named for their writes and SQL (an account's opening balance,
 * the bank import, the manual-match check, the notification facts, a new transaction's
 * defaults, the sync's balance adjustment) hold no list value written out at all: their
 * inserts, defaults and SQL text take the enum's member (`sql.lit(...)` in SQL).
 */
const WRITES = [
  'services/accounts/AccountService.ts',
  'services/BalanceRebalanceService.ts',
  'services/import/TransactionImporter.ts',
  'services/import/manualMatch.ts',
  'services/notifications/facts.ts',
  'services/transactions/create.ts',
];

const format = (findings: Finding[]) => findings.map((f) => `${f.where} '${f.value}': ${f.why}`);

describe('vocabulary values come from @nuggets/shared', { timeout: 300_000 }, () => {
  it.each(['backend', 'frontend', 'mcp'] as const)('%s compares and looks up none written out', (pkg) => {
    const findings = vocabularyFindings({ ...packageConfig(pkg), writes: pkg === 'backend' ? WRITES : [] });
    expect(format(findings)).toEqual([]);
  });

  describe('catches (probes in the backend program)', () => {
    const probe = (source: string, writes = false) =>
      format(vocabularyFindings({ ...packageConfig('backend'), probes: { 'services/zzProbe.ts': source }, writes: writes ? ['services/zzProbe.ts'] : [] }));

    it('a comparison, a case, String(...), and a list looked up', () => {
      expect(probe(`
        declare const item: { status: string };
        if (item.status === 'archived') {}
        if (String(item.status) === 'archived') {}
        switch (item.status) { case 'paused': break; }
        if (['archived', 'paused'].includes(item.status)) {}
      `)).toHaveLength(5);
    });

    it('a Kysely condition, on its table, and by its column where the query has none it can tell', () => {
      expect(probe(`
        import { getDb } from '../db/withTenant.js';
        void getDb().selectFrom('budget_items').select('id').where('status', '=', 'archived').where('status', 'in', ['active', 'paused']);
        void getDb().selectFrom('transactions').select('id').where((eb) => eb('review_status', '=', 'needs review'));
      `)).toHaveLength(4);
      // A budget period's status has no list.
      expect(probe(`
        import { getDb } from '../db/withTenant.js';
        void getDb().selectFrom('budget_period').select('id').where('status', '=', 'active');
      `)).toEqual([]);
    });

    it("not a listless field of the same name: a row's table, a named type, literals that aren't a list", () => {
      expect(probe(`
        import type { BudgetPeriod } from '../db/schema.generated.js';
        declare const period: BudgetPeriod;
        declare const backup: { status: 'idle' | 'running' | 'completed' | 'failed' };
        interface Organization { status: string }
        declare const org: Organization;
        if (period.status === 'active') {}
        if (backup.status === 'completed') {}
        if (org.status === 'active') {}
      `)).toEqual([]);
      // And a list's field, by its table or its literals.
      expect(probe(`
        import type { BudgetItems, Transactions } from '../db/schema.generated.js';
        import type { Selectable } from 'kysely';
        import type { TransactionStatus } from '@nuggets/shared';
        declare const item: Selectable<BudgetItems>;
        declare const t: Selectable<Transactions>;
        declare const status: TransactionStatus;
        if (item.status === 'archived') {}
        if (t.review_status === 'flagged') {}
        if (status === 'reconciled') {}
      `)).toHaveLength(3);
    });

    it('in a clean file, a value set for a field or quoted in SQL, but not one a type says is listless', () => {
      expect(probe(`
        import { sql } from 'kysely';
        const row = { taggable_type: 'transaction', budget_matching_method: 'none' };
        const reviewStatus = Math.random() > 0.5 ? 'reviewed' : 'needs review';
        const q = sql\`SELECT 1 FROM taggings WHERE taggable_type = 'transaction'\`;
        type Result = { status: 'created' | 'skipped' | 'failed' };
        const r: Result = { status: 'failed' };
        void row; void reviewStatus; void q; void r;
      `, true)).toHaveLength(5);
    });
  });
});
