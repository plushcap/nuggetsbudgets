import { sql } from 'kysely';
import { getDb } from '../db/withTenant.js';
import { createLogger } from '../utils/logger.js';
import { MAX_REGEX_RULES_PER_TENANT } from '../utils/userRegex.js';
import { DomainError } from './domainErrors.js';
import { isLockConflict } from './transactions/locks.js';

const logger = createLogger({ service: 'regexRuleCap' });

/**
 * The cap on a ledger's regex rules (utils/userRegex.ts): each active
 * regex rule may run on every imported transaction, so a ledger may have at most
 * {@link MAX_REGEX_RULES_PER_TENANT} of each kind. Counted under RLS, so the ledger's own,
 * under a per-ledger lock the count and its write hold to the end of the transaction.
 */
export type RegexRuleTable = 'budget_item_matching_rules' | 'merchant_matching_rules';

/** The ledger's active regex rules in `table`, other than `exceptId` (the rule being changed). */
async function activeRegexRules(table: RegexRuleTable, exceptId: number | null): Promise<number> {
  const db = getDb();
  const row =
    table === 'budget_item_matching_rules'
      ? await db
        .selectFrom('budget_item_matching_rules')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('method', '=', 'regex')
        .where('is_active', '=', true)
        .$if(exceptId !== null, (qb) => qb.where('id', '!=', exceptId as number))
        .executeTakeFirstOrThrow()
      : await db
        .selectFrom('merchant_matching_rules')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('method', '=', 'regex')
        .$if(exceptId !== null, (qb) => qb.where('id', '!=', exceptId as number))
        .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** pg_advisory_xact_lock's class for a ledger's regex rules ('RGXR'). */
const REGEX_RULES_LOCK_CLASS = 0x52475852;

/**
 * The ledger's lock on its regex rules, held to the end of the request's transaction: the
 * cap's count and the write after it run one request at a time. Without it two
 * creates at once each counted the other's rule as not there yet (it wasn't committed), and
 * both went in past the cap. One lock for both kinds of rule: a ledger saves few at a time.
 * A wait past the lock timeout, or a deadlock, is a 409 to try again, nothing saved.
 */
async function lockRegexRules(): Promise<void> {
  try {
    await sql`SELECT pg_advisory_xact_lock(${REGEX_RULES_LOCK_CLASS}::int, current_tenant_id())`.execute(getDb());
  } catch (err) {
    if (!isLockConflict(err)) throw err;
    logger.warn({ err }, 'Could not take the regex rules lock in time');
    throw new DomainError(409, 'RECORD_BUSY', 'Another rule was being saved at the same time, so this one was not. Try again.');
  }
}

/**
 * Whether saving an active regex rule in `table` would give the ledger more than the cap.
 * Other methods, and an inactive rule, aren't counted. For a rule that counts, it takes the
 * ledger's regex rules lock first ({@link lockRegexRules}), so call it in the transaction
 * that then writes the rule.
 */
export async function regexRuleCapReached(
  table: RegexRuleTable,
  rule: { method: unknown; isActive?: boolean; exceptId?: number | null }
): Promise<boolean> {
  if (rule.method !== 'regex' || rule.isActive === false) return false;
  await lockRegexRules();
  return (await activeRegexRules(table, rule.exceptId ?? null)) >= MAX_REGEX_RULES_PER_TENANT;
}

/** The 400 answered for a rule {@link regexRuleCapReached} refuses. */
export function tooManyRegexRulesError(table: RegexRuleTable): { error: string; code: string; message: string } {
  const kind = table === 'merchant_matching_rules' ? 'merchant' : 'budget item';
  return {
    error: 'Too many regular expression rules',
    code: 'TOO_MANY_REGEX_RULES',
    message: `A tenant can have up to ${MAX_REGEX_RULES_PER_TENANT} active regular-expression ${kind} rules. Remove or turn off one, or use a contains, starts-with or ends-with rule.`,
  };
}
