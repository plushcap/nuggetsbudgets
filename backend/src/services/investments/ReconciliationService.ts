import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { BalanceRebalanceService } from '../BalanceRebalanceService.js';
import { reconcile } from './reconcile.js';
import { CENTS, SHARE_VALUE_SCALE, centsNumber, numericUnits, shareValueToCents } from '../../utils/decimal.js';

/**
 * Account reconciliation: compares each investment account's
 * value in Nuggets against the balance the broker reports, flagging discrepancies
 * beyond max(1%, $50). Read-only; does not touch net worth or bank syncing.
 *
 * The broker's balance is `import_balance`, which the SimpleFin sync writes
 * (this read `institution_current_balance`, which nothing writes, so it
 * never flagged anything). It is the account's total: securities plus cash. So the
 * calculated value is the open lots at their latest prices plus the account's cash,
 * its own balance in Nuggets without what is still pending (deposits, withdrawals
 * and the cash side of buys, sells and dividends; the posted figure the broker
 * reports). An account that auto-rebalances to the imported balance has a balance
 * that is the broker's total by construction, not cash, so Nuggets has no cash
 * figure for it and it isn't compared (calculated_value null, with the reason).
 */
export class ReconciliationService {
  async getStatus(opts: { pct?: number; abs?: number } = {}) {
    const rows = await sql<{
      id: number; uuid: string; name: string; imported: string | null; imported_at: string | null;
      rebalances: boolean | null; holdings: string;
    }>`
      SELECT a.id, a.uuid, a.name,
             a.import_balance AS imported,
             a.import_balance_date AS imported_at,
             a.import_account_rebalance AS rebalances,
             COALESCE((
               SELECT SUM(tl.shares_remaining * lp.close)
               FROM tax_lots tl
               JOIN LATERAL (SELECT close FROM security_prices sp WHERE sp.security_id = tl.security_id ORDER BY sp.price_date DESC LIMIT 1) lp ON true
               WHERE tl.is_open = true AND tl.account_id = a.id
             ), 0) AS holdings
      FROM accounts a
      WHERE (a.account_type = 'investment' OR a.account_group = 'investments')
        AND COALESCE(a.close_account, false) = false
      ORDER BY a.name
    `.execute(getDb());

    const balances = new BalanceRebalanceService();
    const accounts = [];
    for (const r of rows.rows) {
      // In cents: the holdings' exact SUM(shares × close) rounded once, plus the cash.
      const holdingsCents = shareValueToCents(numericUnits(r.holdings, SHARE_VALUE_SCALE));
      const holdings = centsNumber(holdingsCents);
      const importedCents = r.imported != null ? numericUnits(r.imported, CENTS.scale) : null;
      const imported = importedCents != null ? centsNumber(importedCents) : null;
      const cashCents = r.rebalances ? null : numericUnits((await balances.calculateBankComparableBalance(r.id)).posted, CENTS.scale);
      const cash = cashCents != null ? centsNumber(cashCents) : null;
      const calculatedCents = cashCents != null ? holdingsCents + cashCents : null;
      const calculated = calculatedCents != null ? centsNumber(calculatedCents) : null;
      accounts.push({
        account_uuid: r.uuid,
        account_name: r.name,
        calculated_value: calculated,
        holdings_value: holdings,
        cash_value: cash,
        imported_balance: imported,
        imported_balance_date: r.imported_at,
        ...reconcile(calculatedCents, importedCents, opts.pct, opts.abs),
        reason: imported == null
          ? 'No imported balance: the account isn\'t synced.'
          : cash == null
            ? 'The account auto-rebalances to the imported balance, so its balance in Nuggets is the broker\'s total, not its cash: there is nothing separate to compare.'
            : null,
      });
    }

    return {
      accounts,
      flagged_count: accounts.filter((a) => a.flagged).length,
      note: 'Imported balance is the broker\'s total (securities and cash) from the SimpleFin sync. Calculated is the open lots at their latest prices plus the account\'s cash: its balance in Nuggets, without pending transactions. Resolve discrepancies by recording the missing event, adding a lot, updating prices, or correcting the account\'s transactions.',
    };
  }
}
