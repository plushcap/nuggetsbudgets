import { sql } from 'kysely';
import { getDb } from '../db/withTenant.js';
import { createLogger } from '../utils/logger.js';
import { rowErrorFields } from '../utils/logSafeErrors.js';
import { matchUserPatterns, regexRulesWithinCap, type PatternOutcome } from '../utils/userRegex.js';

const logger = createLogger({ service: 'BudgetItemMatcher' });

/** A budget item an imported transaction is matched to (none: budgetItemId null), and how. */
export interface BudgetItemMatch {
  budgetItemId: number | null;
  confidence: number;
  method: string;
  ruleId?: number;
}
type MatchResult = BudgetItemMatch;

/**
 * What the rows a bank sync adds before this one add to the history the matcher reads:
 * a sync now matches its rows before it writes any, so their own transactions aren't in
 * the ledger yet, where the loop that matched each as it wrote it saw the ones before it.
 */
export interface PendingHistory {
  /** This row's merchant's rows with a budget item and a period (tier 2): per item, how many and the latest day. */
  merchant?: ReadonlyMap<number, { count: number; lastDate: string }>;
  /** Every row with a budget item (tier 3 ranks items by their transactions): how many, per item. */
  usage?: ReadonlyMap<number, number>;
}



/**
 * Budget Item Matching Service
 * Automatically matches imported transactions to budget items using multiple strategies
 */
/**
 * Budget items new transactions may be assigned to: not archived. An archived
 * item keeps its rules and history, but nothing new lands in it.
 */
const assignableItems = sql<number>`(SELECT id FROM budget_items WHERE COALESCE(status, 'active') <> 'archived')`;

interface TextRule {
  id: number;
  method: string;
  matching_text: string | null;
}

/**
 * The first of `rules` (in their order) that matches `description`, ignoring case.
 * Regex rules run in a worker with a time limit (utils/userRegex.ts), never on this
 * thread: a pattern that backtracks catastrophically would otherwise stall the server
 * for every ledger. They're run together, once the first one is reached, within
 * one time budget; one that is invalid, runs out of time or isn't reached in the budget
 * doesn't match. Only the first MAX_REGEX_RULES_PER_TENANT regex rules run (a ledger with
 * more saved them before the cap).
 */
async function firstMatchingRule<R extends TextRule>(rules: readonly R[], description: string): Promise<R | null> {
  const subject = description.toLowerCase();
  const runnable = new Set(regexRulesWithinCap(rules.filter((r) => r.method === 'regex'), 'budget-item').map((r) => r.id));
  let regexOutcomes: Map<number, PatternOutcome | undefined> | null = null;
  for (const [i, rule] of rules.entries()) {
    const text = (rule.matching_text ?? '').toLowerCase();
    let isMatch = false;
    switch (rule.method) {
      case 'merchant_exact':
        isMatch = true;
        break;
      case 'exact':
        isMatch = subject === text;
        break;
      case 'contains':
        isMatch = subject.includes(text);
        break;
      case 'starts_with':
        isMatch = subject.startsWith(text);
        break;
      case 'ends_with':
        isMatch = subject.endsWith(text);
        break;
      case 'regex': {
        if (!runnable.has(rule.id)) break; // past the cap
        if (regexOutcomes === null) {
          const pending = rules.slice(i).filter((r) => r.method === 'regex' && runnable.has(r.id));
          const outcomes = await matchUserPatterns(pending.map((r) => r.matching_text ?? ''), description);
          regexOutcomes = new Map(pending.map((r, k) => [r.id, outcomes[k]]));
        }
        const outcome = regexOutcomes.get(rule.id);
        if (outcome === 'invalid') {
          logger.warn({ ruleId: rule.id }, 'Invalid regex in budget rule');
        } else if (outcome === 'timeout') {
          logger.warn({ ruleId: rule.id }, 'Regex budget rule skipped: it ran past its time limit');
        }
        isMatch = outcome === true;
        break;
      }
    }
    if (isMatch) return rule;
  }
  return null;
}

/** The share of words two texts have in common (Jaccard over their words of three letters or more). */
function stringSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(str2.split(/\s+/).filter(w => w.length > 2));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

/** How alike a description and a budget item's name and description must be for tier 3 to match them. */
const SIMILARITY_THRESHOLD = 0.6;

/** The text tier 3 compares a description with: the item's name and description, lower case. */
const similarityText = (item: { name: string | null; description: string | null }) =>
  (item.name + ' ' + (item.description || '')).toLowerCase();

export class BudgetItemMatcher {
  /**
   * Find the best budget item match for an imported transaction
   * Uses a three-tier approach: rules -> merchant history -> description similarity
   */
  async findBudgetItemMatch(
    merchantId: number | null,
    description: string,
    amount: number,
    pending: PendingHistory = {}
  ): Promise<MatchResult> {
    
    // Tier 1: Rule-based matching (highest priority)
    // This now includes both merchant-specific and general description rules
    const ruleMatch = await this.matchByRules(merchantId, description, amount);
    if (ruleMatch.budgetItemId) {
      return ruleMatch; // Return as-is with specific method name (merchant-rule or description-rule)
    }

    // Tier 2: Merchant usage history (medium priority)
    // Query transactions directly for most commonly used budget item with this merchant, and
    // the rows of this sync before this one (a merchant it makes has only those)
    if (merchantId || (pending.merchant && pending.merchant.size > 0)) {
      const historyMatch = await this.matchByMerchantHistory(merchantId, pending.merchant);
      if (historyMatch.budgetItemId) {
        return { ...historyMatch, method: 'merchant-history' };
      }
    }

    // Tier 3: Description similarity matching (lower priority)
    const similarityMatch = await this.matchByDescriptionSimilarity(description, pending.usage);
    if (similarityMatch.budgetItemId) {
      return { ...similarityMatch, method: 'description-similarity' };
    }

    // No match found - leave budget_item_id as null
    return { budgetItemId: null, confidence: 0, method: 'none' };
  }

  /**
   * Tier 1: Rule-based matching
   */
  private async matchByRules(
    merchantId: number | null,
    description: string,
    amount: number
  ): Promise<MatchResult> {
    try {
      // Stage 1: Try merchant-specific rules first (highest priority)
      if (merchantId) {
        const merchantRules = await getDb()
          .selectFrom('budget_item_matching_rules')
          .select(['id', 'budget_item_id', 'method', 'matching_text', 'amount_min', 'amount_max', 'priority'])
          .where('is_active', '=', true)
          .where('merchant_id', '=', merchantId)
          .where('budget_item_id', 'in', assignableItems)
          // amount_min/max are numeric; compare against the numeric param directly.
          .where(sql<boolean>`(amount_min IS NULL OR amount_min <= ${amount})`)
          .where(sql<boolean>`(amount_max IS NULL OR amount_max >= ${amount})`)
          .orderBy('priority', 'asc')
          .orderBy('created_at', 'asc')
          .orderBy('id', 'asc')
          .execute();

        const rule = await firstMatchingRule(merchantRules, description);
        if (rule) {
          return {
            budgetItemId: rule.budget_item_id,
            confidence: 0.98, // Higher confidence for merchant-specific rules
            ruleId: rule.id,
            method: 'merchant-rule'
          };
        }
      }

      // Stage 2: Try general description-based rules (lower priority)
      const generalRules = await getDb()
        .selectFrom('budget_item_matching_rules')
        .select(['id', 'budget_item_id', 'method', 'matching_text', 'amount_min', 'amount_max', 'priority'])
        .where('is_active', '=', true)
        .where('merchant_id', 'is', null)
        .where('budget_item_id', 'in', assignableItems)
        .where(sql<boolean>`(amount_min IS NULL OR amount_min <= ${amount})`)
        .where(sql<boolean>`(amount_max IS NULL OR amount_max >= ${amount})`)
        .orderBy('priority', 'asc')
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute();

      // merchant_exact needs a merchant, so it never matches here.
      const rule = await firstMatchingRule(generalRules.filter((r) => r.method !== 'merchant_exact'), description);
      if (rule) {
        return {
          budgetItemId: rule.budget_item_id,
          confidence: 0.90, // Lower confidence for general description rules
          ruleId: rule.id,
          method: 'description-rule'
        };
      }

      return { budgetItemId: null, confidence: 0, method: 'none' };
    } catch (error) {
      logger.error({ ...rowErrorFields(error) }, 'Error in rule-based budget matching');
      return { budgetItemId: null, confidence: 0, method: 'error' };
    }
  }

  /**
   * Tier 2: Merchant usage history (direct from transactions)
   * Finds the most commonly used budget item for this merchant
   */
  private async matchByMerchantHistory(
    merchantId: number | null,
    pending?: ReadonlyMap<number, { count: number; lastDate: string }>
  ): Promise<MatchResult> {
    try {
      const query = (limit: number | null) => {
        const q = getDb()
          .selectFrom('transactions')
          .select((eb) => [
            'budget_item_id',
            eb.fn.countAll().as('usage_count'),
            eb.fn.max('transaction_date').as('last_used_date'),
          ])
          .where('merchant_id', '=', merchantId!)
          .where('budget_item_id', 'in', assignableItems)
          .where('budget_period_id', 'is not', null)
          .groupBy('budget_item_id')
          .orderBy('usage_count', 'desc')
          .orderBy('last_used_date', 'desc')
          // Ties to the lowest id, here and in the merge below, so both give one match.
          .orderBy('budget_item_id');
        return limit === null ? q : q.limit(limit);
      };
      let history: { budget_item_id: number | null; usage_count: unknown; last_used_date: unknown } | undefined;
      if (!pending || pending.size === 0) {
        history = merchantId === null ? undefined : await query(1).executeTakeFirst();
      } else {
        // The ledger's history with this sync's rows before this one, ranked as the query ranks it.
        const merged = new Map<number, { count: number; lastDate: string }>();
        for (const row of merchantId === null ? [] : await query(null).execute()) {
          if (row.budget_item_id !== null) merged.set(row.budget_item_id, { count: Number(row.usage_count), lastDate: String(row.last_used_date) });
        }
        for (const [itemId, add] of pending) {
          const was = merged.get(itemId);
          merged.set(itemId, was
            ? { count: was.count + add.count, lastDate: was.lastDate > add.lastDate ? was.lastDate : add.lastDate }
            : add);
        }
        const [top] = [...merged].sort(([aId, a], [bId, b]) => b.count - a.count || (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0) || aId - bId);
        history = top && { budget_item_id: top[0], usage_count: top[1].count, last_used_date: top[1].lastDate };
      }

      if (history) {
        const usageCount = Number(history.usage_count);

        // Calculate confidence based on usage frequency and recency
        const daysSinceLastUse = Math.floor(
          (Date.now() - new Date(history.last_used_date as string | Date).getTime()) / (1000 * 60 * 60 * 24)
        );

        // Higher confidence for recent and frequent usage
        let confidence = Math.min(0.85, 0.5 + (usageCount * 0.05));
        if (daysSinceLastUse > 90) {
          confidence *= 0.7; // Reduce confidence for old usage
        }

        return { 
          budgetItemId: history.budget_item_id, 
          confidence,
          method: 'merchant-history'
        };
      }

      return { budgetItemId: null, confidence: 0, method: 'none' };
    } catch (error) {
      logger.error({ ...rowErrorFields(error), merchantId }, 'Error in merchant history matching');
      return { budgetItemId: null, confidence: 0, method: 'error' };
    }
  }

  /**
   * Tier 3: Description similarity matching
   */
  private async matchByDescriptionSimilarity(description: string, pending?: ReadonlyMap<number, number>): Promise<MatchResult> {
    try {
      // Find budget items with similar names or descriptions: the 20 most used, this sync's
      // rows before this one counted too
      const query = getDb()
        .selectFrom('budget_items as bi')
        .leftJoin('transactions as t', 't.budget_item_id', 'bi.id')
        .select((eb) => [
          'bi.id', 'bi.name', 'bi.description',
          eb.fn.count('t.id').as('usage_count'),
        ])
        .where('bi.name', 'is not', null)
        .where(sql<boolean>`COALESCE(bi.status, 'active') <> 'archived'`)
        .groupBy(['bi.id', 'bi.name', 'bi.description'])
        .orderBy('usage_count', 'desc')
        // Ties to the lowest id: the 20 kept, and their order (the first of equal similarity wins),
        // are the same here and in the merge below (before, a tie fell either way).
        .orderBy('bi.id');
      const rows = !pending || pending.size === 0
        ? await query.limit(20).execute()
        : (await query.execute())
            .map((row) => ({ ...row, usage_count: Number(row.usage_count) + (pending.get(row.id) ?? 0) }))
            .sort((a, b) => b.usage_count - a.usage_count || a.id - b.id)
            .slice(0, 20);

      let bestMatch: MatchResult = { budgetItemId: null, confidence: 0, method: 'none' };

      for (const item of rows) {
        const similarity = stringSimilarity(description.toLowerCase(), similarityText(item));

        if (similarity > SIMILARITY_THRESHOLD && similarity > bestMatch.confidence) {
          bestMatch = { 
            budgetItemId: item.id, 
            confidence: similarity * 0.7, // Max 70% confidence
            method: 'description-similarity'
          };
        }
      }

      return bestMatch;
    } catch (error) {
      logger.error({ ...rowErrorFields(error) }, 'Error in description similarity matching');
      return { budgetItemId: null, confidence: 0, method: 'error' };
    }
  }

}
