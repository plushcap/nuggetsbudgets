import { sql, type RawBuilder } from 'kysely';
import { getDb } from '../db/withTenant.js';
import { escapeLikeSql } from '../utils/likePattern.js';
import { createLogger } from '../utils/logger.js';
import { matchUserPatterns, regexRulesWithinCap } from '../utils/userRegex.js';

const logger = createLogger({ service: 'MerchantRuleMatch' });

/**
 * Whether `signal` is the text of an `exact` merchant rule, ignoring case, as the other
 * methods match. The import and the rule preview both
 * use it: the import compared case-sensitively and the preview didn't, so the preview
 * showed transactions an import would not give the merchant.
 */
export function merchantRuleExactMatch(
  signal: RawBuilder<unknown>,
  text: RawBuilder<unknown> | ReturnType<typeof sql.ref>
): RawBuilder<boolean> {
  return sql<boolean>`(lower(${signal}) = lower(${text}))`;
}

/**
 * The merchant of the first `regex` merchant rule whose pattern matches `signal` (ignoring
 * case), or null. The import calls it when no other rule matched, so a regex rule comes after
 * exact, starts-with, ends-with and contains ones, and among regex rules the longest pattern
 * first (then the oldest), as the import ranks the others by length.
 *
 * The rule form and the MCP tools say a merchant rule links future imported transactions to
 * the merchant; for a regex rule the import never did, while the preview
 * showed its matches. The patterns run in the regex worker, under its time limits
 * (utils/userRegex.ts), never on this thread; at most MAX_REGEX_RULES_PER_TENANT of them.
 */
export async function merchantMatchedByRegexRule(signal: string): Promise<number | null> {
  const rules = await getDb()
    .selectFrom('merchant_matching_rules as mmr')
    .innerJoin('merchants as m', 'm.id', 'mmr.merchant_id')
    .select(['mmr.id', 'mmr.merchant_id', 'mmr.matching_text'])
    .where('mmr.method', '=', 'regex')
    .orderBy(sql`length(mmr.matching_text)`, 'desc')
    .orderBy('mmr.id', 'asc')
    .execute();
  if (rules.length === 0) return null;
  const runnable = regexRulesWithinCap(rules, 'merchant');
  const outcomes = await matchUserPatterns(runnable.map((r) => r.matching_text), signal);
  for (const [i, rule] of runnable.entries()) {
    const outcome = outcomes[i];
    if (outcome === true) return rule.merchant_id;
    if (outcome === 'invalid') logger.warn({ ruleId: rule.id }, 'Invalid regex in merchant rule');
    else if (outcome === 'timeout') logger.warn({ ruleId: rule.id }, 'Regex merchant rule skipped: it ran past its time limit');
  }
  return null;
}

/** The merchant-rule methods that match with a LIKE pattern. */
export type MerchantLikeMethod = 'contains' | 'starts_with' | 'ends_with';

/**
 * Whether `signal` matches a contains / starts_with / ends_with merchant rule whose text
 * is `text`, ignoring case. The rule's text is matched literally: a `%`, `_` or `\` in it
 * is that character, not a wildcard.
 *
 * The import (MerchantMatcher.match in services/import, with `text` the rule's column) and the
 * rule preview (POST /merchants/:uuid/test-rules, with `text` a parameter) both build
 * their condition here, and the exact one with merchantRuleExactMatch, so a transaction
 * the preview shows a rule matching is one the import gives that rule's merchant.
 */
export function merchantRuleLikeMatch(
  method: MerchantLikeMethod,
  signal: RawBuilder<unknown>,
  text: RawBuilder<unknown> | ReturnType<typeof sql.ref>
): RawBuilder<boolean> {
  const escaped = escapeLikeSql(text);
  switch (method) {
    case 'contains':
      return sql<boolean>`(${signal} ILIKE ('%' || ${escaped} || '%'))`;
    case 'starts_with':
      return sql<boolean>`(${signal} ILIKE (${escaped} || '%'))`;
    case 'ends_with':
      return sql<boolean>`(${signal} ILIKE ('%' || ${escaped}))`;
  }
}
