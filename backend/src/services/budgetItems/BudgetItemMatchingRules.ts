import { sql, type Selectable } from 'kysely';
import { regexRuleProblem, type BudgetItemMatchingRuleFields } from '@nuggets/shared';
import type { DB } from '../../db/schema.generated.js';
import { getDb } from '../../db/withTenant.js';
import { DomainError } from '../domainErrors.js';
import { regexRuleCapReached, tooManyRegexRulesError } from '../regexRuleCap.js';
import { firstMissingReference, missingReferenceError } from '../tenantReferences.js';
import { centsToAmount, invalidAmountAnswer, readCents } from '../../utils/money.js';

/**
 * A budget item's matching rules: "a transaction that matches this
 * goes to that budget item". The rows the routes list, create, replace and delete; the
 * matching itself is BudgetItemMatcher's.
 *
 * Create and update take the same body, checked by budgetItemMatchingRuleSchema (shared)
 * before they run, and make the same checks here: the budget item and merchant it names
 * (by id or uuid) must be the ledger's (400 INVALID_REFERENCE), its amount bounds are
 * money (read in cents), a regex can't be one that stalls the server (400 INVALID_PATTERN),
 * and an active regex rule must fit the ledger's cap (400 TOO_MANY_REGEX_RULES).
 *
 * Runs on the request's tenant transaction (getDb(), under RLS). A refusal is a
 * BudgetItemMatchingRuleError, which the route wrapper answers.
 */

/** A matching-rule refusal: answered `{ ...details, error, code, message }` with its status. */
export class BudgetItemMatchingRuleError extends DomainError {}

/** No such rule in this ledger: 404. */
const ruleNotFound = () =>
  new BudgetItemMatchingRuleError(404, 'NOT_FOUND', 'The specified matching rule does not exist', {}, { heading: 'Rule not found' });

/** A reference that names no row of this ledger: 400 INVALID_REFERENCE, naming the field. */
function invalidReference(field: 'budget_item_id' | 'merchant_id' | 'budget_item_uuid' | 'merchant_uuid') {
  const error =
    field === 'budget_item_uuid' ? 'budget_item_uuid does not name a budget item in this tenant'
      : field === 'merchant_uuid' ? 'merchant_uuid does not name a merchant in this tenant'
        : missingReferenceError(field).error;
  return new BudgetItemMatchingRuleError(400, 'INVALID_REFERENCE', error, { field });
}

/** The columns a rule answers with. */
const RULE_COLUMNS = [
  'id', 'uuid', 'budget_item_id', 'merchant_id', 'method', 'matching_text',
  'amount_min', 'amount_max', 'priority', 'is_active', 'notes',
  'created_at', 'updated_at',
] as const;
type RuleRow = Pick<Selectable<DB['budget_item_matching_rules']>, (typeof RULE_COLUMNS)[number]>;

/**
 * A rule's amount bound as exact text for its NUMERIC(12,2) column; none is null. A bound of 0
 * is a bound (it was stored as none, so a maximum of 0 meant no maximum); the matcher
 * reads one with IS NULL, not by its truth.
 */
function amountBound(value: number | string | null | undefined, field: 'amount_min' | 'amount_max'): string | null {
  if (value == null) return null;
  const read = readCents(value);
  if (!('cents' in read)) {
    const answer = invalidAmountAnswer(field, read.problem);
    throw new BudgetItemMatchingRuleError(400, answer.code, answer.error);
  }
  return centsToAmount(read.cents);
}

/** The id of the row `uuid` names in `table`, or a 400 INVALID_REFERENCE for `field`. */
async function idOf(table: 'budget_items' | 'merchants', uuid: string, field: 'budget_item_uuid' | 'merchant_uuid'): Promise<number> {
  const row = await getDb().selectFrom(table).select('id').where('uuid', '=', uuid).executeTakeFirst();
  if (!row) throw invalidReference(field);
  return row.id;
}

export class BudgetItemMatchingRules {
  /**
   * Every rule, active or not (`is_active` says), with their budget items' and merchants' names:
   * the active ones first, then by priority (lowest first), the newest first among equals; one
   * budget item's when it is named (by uuid, or by its id). An inactive rule is listed so it can
   * be found, edited and switched on again (one created or saved inactive vanished from the
   * rules page, its edit page and the MCP update tool). The matcher reads the active ones itself
   * (BudgetItemMatcher).
   */
  async list(filter: { budgetItemUuid?: string | undefined; budgetItemId?: number | undefined } = {}) {
    const itemFilter =
      filter.budgetItemUuid !== undefined ? sql` AND bi.uuid = ${filter.budgetItemUuid}`
        : filter.budgetItemId !== undefined ? sql` AND bimr.budget_item_id = ${filter.budgetItemId}`
          : sql``;
    // Raw sql: a multi-join with aliased columns.
    const { rows } = await sql<Record<string, unknown>>`
      SELECT
        bimr.id,
        bimr.uuid,
        bimr.budget_item_id,
        bimr.merchant_id,
        bimr.method,
        bimr.matching_text,
        bimr.amount_min,
        bimr.amount_max,
        bimr.priority,
        bimr.is_active,
        bimr.notes,
        bimr.created_at,
        bimr.updated_at,
        bi.name as budget_item_name,
        bi.uuid as budget_item_uuid,
        bi.icon as budget_item_icon,
        bi.color as budget_item_color,
        m.name as merchant_name
      FROM budget_item_matching_rules bimr
      LEFT JOIN budget_items bi ON bimr.budget_item_id = bi.id
      LEFT JOIN merchants m ON bimr.merchant_id = m.id
      WHERE TRUE${itemFilter}
      ORDER BY bimr.is_active DESC, bimr.priority ASC, bimr.created_at DESC
    `.execute(getDb());
    return rows;
  }

  /** A new rule: active unless the body says it isn't (the add form's "Rule is active"). */
  async create(rule: BudgetItemMatchingRuleFields): Promise<RuleRow> {
    const values = await this.columns(rule, { isActive: rule.is_active ?? true, exceptId: null });
    return getDb().insertInto('budget_item_matching_rules').values(values).returning(RULE_COLUMNS).executeTakeFirstOrThrow();
  }

  /** Replace the rule `uuid` names with `rule` (a PUT: a field not sent takes its default). */
  async update(uuid: string, rule: BudgetItemMatchingRuleFields): Promise<RuleRow> {
    const existing = await getDb().selectFrom('budget_item_matching_rules').select('id').where('uuid', '=', uuid).executeTakeFirst();
    if (!existing) throw ruleNotFound();
    const values = await this.columns(rule, { isActive: rule.is_active ?? true, exceptId: existing.id });
    const updated = await getDb()
      .updateTable('budget_item_matching_rules')
      .set({ ...values, updated_at: sql<Date>`CURRENT_TIMESTAMP` })
      .where('id', '=', existing.id)
      .returning(RULE_COLUMNS)
      .executeTakeFirst();
    // Deleted meanwhile, by a request that committed after the lookup.
    if (!updated) throw ruleNotFound();
    return updated;
  }

  /** Delete the rule `uuid` names. */
  async delete(uuid: string): Promise<void> {
    const deleted = await getDb().deleteFrom('budget_item_matching_rules').where('uuid', '=', uuid).executeTakeFirst();
    if (Number(deleted.numDeletedRows) === 0) throw ruleNotFound();
  }

  /**
   * The columns a rule body writes, after the checks create and update share: the budget
   * item and merchant are the ledger's (an id is checked; a uuid is looked up, an id given
   * too winning, as before), the amount bounds are money, and a regex rule's pattern is safe
   * and, active, within the ledger's cap.
   */
  private async columns(rule: BudgetItemMatchingRuleFields, options: { isActive: boolean; exceptId: number | null }) {
    const missing = await firstMissingReference({ budget_item_id: rule.budget_item_id, merchant_id: rule.merchant_id });
    if (missing === 'budget_item_id' || missing === 'merchant_id') throw invalidReference(missing);
    const budgetItemId = rule.budget_item_id ?? (rule.budget_item_uuid ? await idOf('budget_items', rule.budget_item_uuid, 'budget_item_uuid') : null);
    const merchantId = rule.merchant_id ?? (rule.merchant_uuid ? await idOf('merchants', rule.merchant_uuid, 'merchant_uuid') : null);
    const amountMin = amountBound(rule.amount_min, 'amount_min');
    const amountMax = amountBound(rule.amount_max, 'amount_max');

    // A regex rule runs on every imported transaction: one that can stall is refused.
    if (rule.method === 'regex') {
      const problem = regexRuleProblem(rule.matching_text ?? '');
      if (problem) throw new BudgetItemMatchingRuleError(400, 'INVALID_PATTERN', problem, {}, { heading: 'Invalid pattern' });
    }
    if (await regexRuleCapReached('budget_item_matching_rules', { method: rule.method, isActive: options.isActive, exceptId: options.exceptId })) {
      const answer = tooManyRegexRulesError('budget_item_matching_rules');
      throw new BudgetItemMatchingRuleError(400, answer.code, answer.message, {}, { heading: answer.error });
    }

    return {
      budget_item_id: budgetItemId,
      merchant_id: merchantId,
      method: rule.method,
      // Trimmed by the schema; an empty one is none.
      matching_text: rule.matching_text || null,
      amount_min: amountMin,
      amount_max: amountMax,
      priority: rule.priority || 100,
      notes: rule.notes?.trim() || null,
      is_active: options.isActive,
    };
  }
}
