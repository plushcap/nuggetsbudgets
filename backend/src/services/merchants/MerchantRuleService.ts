import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { merchantRuleExactMatch, merchantRuleLikeMatch } from '../merchantRuleMatch.js';
import { regexRuleCapReached } from '../regexRuleCap.js';
import { merchantNotFound, merchantNotFoundBrief, ruleExists as ruleExistsError, ruleNotFound, tooManyRegexRules } from './MerchantError.js';
import { lockTransactions } from '../transactions/locks.js';
import { merchantIdOf } from './MerchantService.js';
import { runRegexPreview, type RegexPreviewSkip } from './regexPreview.js';

const logger = createLogger({ service: 'MerchantRuleService' });

/** How a merchant matching rule compares its text with a transaction's payee or description. */
export const MERCHANT_RULE_METHODS = ['exact', 'contains', 'starts_with', 'ends_with', 'regex'] as const;

/** A rule as the rule routes answer it. */
const RULE_COLUMNS = ['id', 'uuid', 'merchant_id', 'method', 'matching_text', 'created_at', 'updated_at'] as const;

/** How many transactions one rule's preview shows at most. */
const PREVIEW_LIMIT = 50;

async function ruleIdOf(uuid: string): Promise<number | null> {
  const result = await sql<{ rule_id: number | null }>`SELECT get_merchant_rule_id_by_uuid(${uuid}) as rule_id`.execute(getDb());
  return result.rows[0]?.rule_id ?? null;
}

/** Whether merchant `merchantId` has a rule of this method and text other than `exceptId`. */
async function ruleExists(merchantId: number | null, method: string, matchingText: string, exceptId?: number): Promise<boolean> {
  let query = getDb()
    .selectFrom('merchant_matching_rules')
    .select('id')
    .where('merchant_id', '=', merchantId)
    .where('method', '=', method)
    .where('matching_text', '=', matchingText);
  if (exceptId !== undefined) query = query.where('id', '!=', exceptId);
  return (await query.execute()).length > 0;
}

/**
 * Merchant matching rules: which merchant a transaction gets from its payee (or its
 * description when it has none). A merchant has one rule of each method and text. The
 * preview builds its conditions as the import does (merchantRuleExactMatch,
 * merchantRuleLikeMatch), so what it shows a rule matching is what a sync assigns; a regex
 * rule runs under a time limit (runRegexPreview), and a ledger has at most
 * MAX_REGEX_RULES_PER_TENANT of them (regexRuleCap.ts). Callers check a rule's method and
 * pattern before writing it.
 */
export class MerchantRuleService {
  /** The rules of the merchant `merchantUuid` names, by method, then text. */
  async list(merchantUuid: string) {
    const merchantId = await merchantIdOf(merchantUuid);
    if (!merchantId) throw merchantNotFoundBrief();
    return getDb()
      .selectFrom('merchant_matching_rules')
      .select(RULE_COLUMNS)
      .where('merchant_id', '=', merchantId)
      .orderBy('method')
      .orderBy('matching_text')
      .execute();
  }

  /** A new rule for the merchant `merchantUuid` names. */
  async create(merchantUuid: string, method: string, matchingText: string) {
    const merchantId = await merchantIdOf(merchantUuid);
    if (!merchantId) throw merchantNotFound();
    if (await regexRuleCapReached('merchant_matching_rules', { method })) throw tooManyRegexRules();
    if (await ruleExists(merchantId, method, matchingText)) throw ruleExistsError();

    return getDb()
      .insertInto('merchant_matching_rules')
      .values({ merchant_id: merchantId, method, matching_text: matchingText })
      .returning(RULE_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Rewrites the rule `ruleUuid` names. */
  async update(ruleUuid: string, method: string, matchingText: string) {
    const ruleId = await ruleIdOf(ruleUuid);
    if (!ruleId) throw ruleNotFound();
    if (await regexRuleCapReached('merchant_matching_rules', { method, exceptId: ruleId })) throw tooManyRegexRules();

    const { merchant_id: merchantId } = await getDb()
      .selectFrom('merchant_matching_rules')
      .select('merchant_id')
      .where('id', '=', ruleId)
      .executeTakeFirstOrThrow();
    if (await ruleExists(merchantId, method, matchingText, ruleId)) throw ruleExistsError();

    return getDb()
      .updateTable('merchant_matching_rules')
      .set({ method, matching_text: matchingText, updated_at: sql<Date>`CURRENT_TIMESTAMP` })
      .where('id', '=', ruleId)
      .returning(RULE_COLUMNS)
      .executeTakeFirst();
  }

  /** Deletes the rule `ruleUuid` names. */
  async remove(ruleUuid: string): Promise<void> {
    const ruleId = await ruleIdOf(ruleUuid);
    if (!ruleId) throw ruleNotFound();
    await getDb().deleteFrom('merchant_matching_rules').where('id', '=', ruleId).execute();
  }

  /**
   * The transactions the merchant's rules match that aren't its already: up to 50 per
   * rule, newest first, each once (with the first rule that matched it). Regex rules the
   * database refuses or stops are skipped and listed. `ruleCount` is 0 when the merchant
   * has no rules.
   */
  async preview(merchantUuid: string) {
    const merchantId = await merchantIdOf(merchantUuid);
    if (!merchantId) throw merchantNotFoundBrief();

    const rules = await getDb()
      .selectFrom('merchant_matching_rules')
      .select(['id', 'method', 'matching_text'])
      .where('merchant_id', '=', merchantId)
      .orderBy('method')
      .orderBy('matching_text')
      .execute();
    if (rules.length === 0) return { ruleCount: 0, matchingTransactions: [], skippedRules: [] };

    // The signal the import matches: the provider's cleaned payee when there is one, the
    // raw description otherwise (description rules don't fire on payee-bearing ones).
    const matchSignal = sql`COALESCE(NULLIF(t.import_payee, ''), t.description)`;

    const matches = [];
    const skippedRules: Array<{ id: number; method: string; matching_text: string; reason: RegexPreviewSkip }> = [];
    for (const rule of rules) {
      let matchCondition;
      switch (rule.method) {
        case 'exact':
          // The import's condition (merchantRuleExactMatch): ignoring case.
          matchCondition = merchantRuleExactMatch(matchSignal, sql`${rule.matching_text}::text`);
          break;
        case 'contains':
        case 'starts_with':
        case 'ends_with':
          // The rule's %, _ and \ match themselves, as when a sync assigns merchants.
          matchCondition = merchantRuleLikeMatch(rule.method, matchSignal, sql`${rule.matching_text}::text`);
          break;
        case 'regex':
          matchCondition = sql<boolean>`${matchSignal} ~* ${rule.matching_text}`;
          break;
        default:
          continue; // An unknown method matches nothing.
      }

      const query = getDb()
        .selectFrom('transactions as t')
        .leftJoin('accounts as a', 't.account_id', 'a.id')
        .select(['t.id', 't.uuid', 't.description', 't.import_payee', 't.amount', 't.transaction_date', 't.type', 'a.name as account_name'])
        .where((eb) => eb.or([eb('t.merchant_id', 'is', null), eb('t.merchant_id', '!=', merchantId)]))
        .where(matchCondition)
        .orderBy('t.transaction_date', 'desc')
        .limit(PREVIEW_LIMIT);

      let rows;
      if (rule.method === 'regex') {
        const ran = await runRegexPreview(() => query.execute());
        if (!ran.ok) {
          logger.warn({ ruleId: rule.id, reason: ran.reason }, 'Merchant regex rule preview skipped');
          skippedRules.push({ id: rule.id, method: rule.method, matching_text: rule.matching_text, reason: ran.reason });
          continue;
        }
        rows = ran.rows;
      } else {
        rows = await query.execute();
      }

      for (const transaction of rows) {
        matches.push({ ...transaction, matchingRule: { id: rule.id, method: rule.method, matching_text: rule.matching_text } });
      }
    }

    const seen = new Set<number>();
    const matchingTransactions = matches.filter((match) => !seen.has(match.id) && seen.add(match.id));
    return { ruleCount: rules.length, matchingTransactions, skippedRules };
  }

  /** Gives the transactions `transactionIds` to the merchant `merchantUuid` names; how many, and its name. */
  async apply(merchantUuid: string, transactionIds: number[]): Promise<{ updatedCount: number; merchantName: string }> {
    const merchantId = await merchantIdOf(merchantUuid);
    if (!merchantId) throw merchantNotFoundBrief();

    const { name } = await getDb().selectFrom('merchants').select('name').where('id', '=', merchantId).executeTakeFirstOrThrow();
    // In id order, as every write of several transactions locks them.
    if (transactionIds.length > 0) await lockTransactions((eb) => eb('id', 'in', transactionIds));
    const updated = await getDb()
      .updateTable('transactions')
      .set({ merchant_id: merchantId, updated_at: sql<Date>`CURRENT_TIMESTAMP` })
      .where('id', 'in', transactionIds)
      .returning(['id', 'description'])
      .execute();
    return { updatedCount: updated.length, merchantName: name };
  }
}
