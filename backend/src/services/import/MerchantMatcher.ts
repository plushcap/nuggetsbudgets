/** The merchant of an imported transaction: by the ledger's matching rules, else by name. */
import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { findOrCreateMerchant, findMerchantByName } from '../merchantNames.js';
import { merchantMatchedByRegexRule, merchantRuleExactMatch, merchantRuleLikeMatch } from '../merchantRuleMatch.js';
import { createLogger } from '../../utils/logger.js';
import { rowErrorFields } from '../../utils/logSafeErrors.js';
import type { Savepoint } from './BudgetPeriodResolver.js';

export class MerchantMatcher {
  private logger = createLogger({ service: 'ImportService' });

  constructor(private readonly savepoint: Savepoint) {}

  /**
   * Resolve (or create) the merchant for an imported transaction.
   *
   * THE matching signal is the provider's `payee` when present (a pre-cleaned
   * merchant name: "Sample Mart"); the raw statement `description`
   * ("SAMPLE MART MKTPLACE SAMPLEMART.EXAMPLE/BILL XX") is used only when the provider
   * sent no payee. This is a deliberate full switch: description-based rules
   * do NOT fire on payee-bearing transactions, so stale description hacks go
   * visibly dead and the rules list converges on payee-based rules. The same
   * signal drives all three steps — matching rules, exact merchant-name
   * match, and the auto-created merchant's name.
   */
  async match(description: string, payee: string | null | undefined, enableMatchingRules: boolean = true): Promise<number | null> {
    return this.resolve(description, payee, enableMatchingRules, true);
  }

  /**
   * The merchant {@link match} would answer when it is one the ledger has, or null when it
   * would make one (or fails): what a bank sync locks before its transactions
   * (TransactionImporter.lockNamedReferences), making none, since a row it links to a manual
   * entry instead of adding needs no merchant.
   */
  async find(description: string, payee: string | null | undefined, enableMatchingRules: boolean = true): Promise<number | null> {
    return this.resolve(description, payee, enableMatchingRules, false);
  }

  private async resolve(description: string, payee: string | null | undefined, enableMatchingRules: boolean, create: boolean): Promise<number | null> {
    const cleanDescription = description?.trim() ?? '';
    const cleanPayee = payee?.trim() ?? '';
    const signal = cleanPayee || cleanDescription;
    const signalSource = cleanPayee ? 'payee' : 'description';
    if (signal === '') {
      return null;
    }

    try {
      return await this.savepoint(async () => {
        let foundMerchantId: number | null = null;

        // STEP 1: If matching rules are enabled, try the rules against the signal.
        if (enableMatchingRules) {
          // ILIKE pattern concatenation with ORDER BY CASE ranking — kept as raw sql. The
          // exact and LIKE methods are the rule preview's conditions (merchantRuleMatch.ts),
          // so the two agree: ignoring case, a rule's %, _ and \ matched as themselves.
          const signalSql = sql`${signal}::text`;
          const ruleText = sql.ref('mmr.matching_text');
          const ruleResult = await sql<{ id: number }>`
            SELECT m.id
            FROM merchant_matching_rules mmr
            JOIN merchants m ON m.id = mmr.merchant_id
            WHERE
              (mmr.method = 'exact' AND ${merchantRuleExactMatch(signalSql, ruleText)}) OR
              (mmr.method = 'contains' AND ${merchantRuleLikeMatch('contains', signalSql, ruleText)}) OR
              (mmr.method = 'starts_with' AND ${merchantRuleLikeMatch('starts_with', signalSql, ruleText)}) OR
              (mmr.method = 'ends_with' AND ${merchantRuleLikeMatch('ends_with', signalSql, ruleText)})
            ORDER BY
              CASE mmr.method
                WHEN 'exact' THEN 1
                WHEN 'starts_with' THEN 2
                WHEN 'ends_with' THEN 3
                WHEN 'contains' THEN 4
              END,
              LENGTH(mmr.matching_text) DESC
            LIMIT 1
          `.execute(getDb());

          // Regex rules come after the others, in the regex worker (merchantRuleMatch.ts).
          foundMerchantId = ruleResult.rows[0]?.id ?? (await merchantMatchedByRegexRule(signal));
          if (foundMerchantId) {
            this.logger.debug({ matchedOn: signalSource, merchantId: foundMerchantId }, 'Merchant matched via rules');
          }
        }

        // STEP 2: If no rule match (or rules disabled), the merchant with the
        // signal's name (any case).
        // STEP 3: If there's none, ALWAYS create one (essential for system
        // integrity) — named by the signal, so payee-bearing imports stop minting
        // merchants like "TST* SAMPLE CAFE - NORTHSIDE ANYTOWN XX". Names are unique
        // per ledger ignoring case: one created meanwhile is used.
        if (!foundMerchantId && !create) {
          const named = await findMerchantByName(signal);
          if (named) this.logger.debug({ matchedOn: signalSource, merchantId: named.id }, 'Merchant matched by exact name');
          return named?.id ?? null;
        }
        if (!foundMerchantId) {
          const merchant = await findOrCreateMerchant(signal, { notes: 'Auto-created from import' });
          foundMerchantId = merchant.id;
          if (merchant.created) {
            this.logger.info({
              matchedOn: signalSource,
              merchantId: foundMerchantId,
              rulesEnabled: enableMatchingRules
            }, 'Created new merchant from import');
          } else {
            this.logger.debug({ matchedOn: signalSource, merchantId: foundMerchantId }, 'Merchant matched by exact name');
          }
        }

        return foundMerchantId;

      });
    } catch (error) {
      // A unique key's detail names the merchant ("Key (…)=(the payee) already exists").
      this.logger.error({
        ...rowErrorFields(error),
        matchedOn: signalSource
      }, 'Error processing merchant');
      return null;
    }
  }
}
