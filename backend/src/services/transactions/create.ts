import { sql } from 'kysely';
import type { BulkTransactionsCreateInput, TransactionCreateInput } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { firstMissingReference, tenantTagIds } from '../tenantReferences.js';
import { createLogger } from '../../utils/logger.js';
import { readCents, invalidAmountAnswer, centsToAmount, MAX_AMOUNT_TEXT } from '../../utils/money.js';
import { badRequest, incomeOnLiability, invalidReference, invalidTagReference, notFound, TransactionRefusal } from './refusal.js';
import { periodItemId, recordNetWorth } from './lookup.js';
import {
  INCOME_ON_LIABILITY_REASON,
  INVALID_TYPE_ERROR,
  TRANSACTION_TYPES,
  isIncomeOnLiability,
  sentId,
  signForType,
} from './rules.js';
import { present } from '../../utils/present.js';
import { transactionType, transactionReviewStatus, transactionStatus, taggableType } from '@nuggets/shared';

/** Adding transactions: one (POST /api/transactions) or a statement's worth (POST /bulk). */

const logger = createLogger({ service: 'TransactionCreate' });

/**
 * First key of the transaction-scoped advisory lock a bulk create holds on its ledger
 * (ASCII "BULK"); the second is the tenant id.
 */
const BULK_CREATE_LOCK_CLASS = 0x42554c4b;

/** A created transaction, as POST /api/transactions answers it. */
export interface CreatedTransaction {
  uuid: string | null;
  account_id: number | null;
  account_uuid: string | null;
  account_name: string | null;
  merchant_id: number | null;
  merchant_name: string | null;
  amount: number;
  description: string | null;
  transaction_date: string;
  type: string;
  budget_period_id: number | null;
  budget_period_name: string | null;
  budget_item_id: number | null;
  budget_item_name: string | null;
  status: string | null;
  review_status: string | null;
  institution_transaction_status: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}

/** The id of the row of `table` with this uuid, or the 404 `error` when none has it. */
async function idForUuid(table: 'merchants' | 'budget_items' | 'budget_period', uuid: unknown, error: string): Promise<number> {
  const row = await getDb().selectFrom(table).select('id').where('uuid', '=', uuid as string).executeTakeFirst();
  if (!row?.id) throw notFound(error);
  return row.id;
}

/**
 * The tags a new transaction names, by id and by uuid (lists of them, which
 * transactionCreateSchema checked), as ids: each one of this ledger's tags, or 400
 * INVALID_REFERENCE naming the list, as a split's are (splits.ts). One that named another
 * ledger's tag, or none, was dropped, and the transaction saved without it.
 */
async function requestedTagIds(body: TransactionCreateInput): Promise<number[]> {
  const tagIds: number[] = [];
  if (body.tag_ids && body.tag_ids.length > 0) {
    const asked = body.tag_ids;
    const found = await tenantTagIds(asked);
    if (found.length !== asked.length) throw invalidTagReference('tag_ids');
    tagIds.push(...found);
  }
  if (body.tag_uuids && body.tag_uuids.length > 0) {
    const uuids = body.tag_uuids;
    const rows = await getDb().selectFrom('tags').select(['id', 'uuid']).where('uuid', 'in', uuids).execute();
    // Postgres reads a uuid in either case and answers it in lower case.
    const byUuid = new Map(rows.map((row) => [row.uuid.toLowerCase(), row.id]));
    for (const uuid of uuids) {
      const id = byUuid.get(uuid.toLowerCase());
      if (id === undefined) throw invalidTagReference('tag_uuids');
      tagIds.push(id);
    }
  }
  return Array.from(new Set(tagIds));
}

/**
 * Create one transaction. `account_uuid`, a non-zero `amount`, `transaction_date` and
 * `type` were checked by transactionCreateSchema (shared). A merchant, budget item or
 * period may be named by id or by uuid (the schema checked each is one); tags by
 * `tag_uuids` or `tag_ids`. The amount
 * is whole cents, signed for its type.
 */
export async function createTransaction(body: TransactionCreateInput): Promise<CreatedTransaction> {
  const {
    account_uuid,
    amount,
    description,
    transaction_date,
    type,
    status = transactionStatus.enum.cleared,
    review_status = transactionReviewStatus.enum['needs review'],
    external_transaction_id,
  } = body;

  // An income's account is read FOR KEY SHARE, as the database's check of it reads it:
  // an edit making the account a liability is waited for, so its type is the one the
  // income is written against, and refused here (400) rather than by the database (a 500).
  const accountQuery = getDb().selectFrom('accounts').select(['id', 'type']).where('uuid', '=', account_uuid);
  const account = await (type === transactionType.enum.income ? accountQuery.forKeyShare() : accountQuery).executeTakeFirst();
  if (!account) throw notFound('Account not found');

  // Either an id or a uuid, resolved to the id.
  let merchant_id = sentId(body.merchant_id);
  if (!merchant_id && body.merchant_uuid) {
    merchant_id = await idForUuid('merchants', body.merchant_uuid, 'Merchant not found for merchant_uuid');
  }
  let budget_item_id = sentId(body.budget_item_id);
  if (!budget_item_id && body.budget_item_uuid) {
    budget_item_id = await idForUuid('budget_items', body.budget_item_uuid, 'Budget item not found for budget_item_uuid');
  }
  let budget_period_id = sentId(body.budget_period_id);
  if (!budget_period_id && body.budget_period_uuid) {
    budget_period_id = await idForUuid('budget_period', body.budget_period_uuid, 'Budget period not found for budget_period_uuid');
  }

  // Numeric ids from the body name rows of this ledger, and so do its tags.
  const missing = await firstMissingReference({ merchant_id, budget_item_id, budget_period_id });
  if (missing) throw invalidReference(missing);
  const tagIds = await requestedTagIds(body);

  // Income is always positive and an expense always negative; payments, transfers,
  // starting balances and balance adjustments keep the sign given.
  // The amount as it was sent (the schema doesn't coerce it): a number, or decimal text.
  const read = readCents(amount);
  if (!('cents' in read)) throw new TransactionRefusal(400, invalidAmountAnswer('amount', read.problem));
  const amountCents = read.cents;
  if (!TRANSACTION_TYPES.includes(type)) throw badRequest(INVALID_TYPE_ERROR);
  if (isIncomeOnLiability(type, account.type)) throw incomeOnLiability();

  const budget_period_item_id =
    budget_item_id && budget_period_id ? await periodItemId(budget_item_id, budget_period_id) : null;

  const created = await getDb()
    .insertInto('transactions')
    .values({
      account_id: account.id,
      merchant_id,
      amount: centsToAmount(signForType(type, amountCents)),
      description: description as string | null | undefined,
      transaction_date,
      type,
      budget_period_id,
      budget_item_id,
      budget_period_item_id,
      status: status as string,
      review_status: review_status as string,
      // Source-system id (statement/confirmation line id) so agent-driven
      // imports can detect re-imports and trace a row to its source.
      external_transaction_id:
        typeof external_transaction_id === 'string' && external_transaction_id.trim() !== '' ? external_transaction_id : null,
    })
    .returning(['uuid', 'id'])
    .executeTakeFirstOrThrow();

  // Its tags (checked above), in one insert.
  if (tagIds.length > 0) {
    await sql`
      INSERT INTO taggings (tag_id, taggable_type, taggable_id)
      SELECT t, ${sql.lit(taggableType.enum.transaction)}, ${created.id} FROM UNNEST(${tagIds}::int[]) AS t
      ON CONFLICT (tenant_id, tag_id, taggable_type, taggable_id) DO NOTHING
    `.execute(getDb());
  }

  await recordNetWorth();

  // The transaction with its names, as the answer has it — multi-join select, kept as raw sql
  const result = await sql<Omit<CreatedTransaction, 'amount'> & { amount: string }>`
    SELECT
      t.uuid, t.account_id, a.uuid as account_uuid, a.name as account_name,
      t.merchant_id, m.name as merchant_name, t.amount, t.description,
      t.transaction_date::TEXT as transaction_date, t.type,
      t.budget_period_id, bp.name as budget_period_name, t.budget_item_id, bi.name as budget_item_name,
      t.status, t.review_status, t.institution_transaction_status,
      t.created_at, t.updated_at
    FROM transactions t
    LEFT JOIN budget_period bp ON t.budget_period_id = bp.id
    LEFT JOIN budget_items bi ON t.budget_item_id = bi.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    LEFT JOIN accounts a ON t.account_id = a.id
    WHERE t.uuid = ${created.uuid}
  `.execute(getDb());
  const row = result.rows[0];
  // The row was just inserted in this transaction: not finding it is an internal failure (a 500).
  if (!row) throw new Error('The created transaction could not be read back');

  logger.info(
    { transactionId: created.id, uuid: row.uuid, accountId: row.account_id, type: row.type },
    'Transaction created successfully',
  );
  return { ...row, amount: parseFloat(row.amount) };
}

type BulkRowResult = { index: number; status: 'created' | 'skipped' | 'failed'; transaction_uuid?: string; reason?: string };

export interface BulkCreateResult {
  dry_run: boolean;
  total: number;
  created: number;
  skipped: number;
  failed: number;
  results: BulkRowResult[];
}

/**
 * Bulk-create transactions (agent-driven statement/CSV backfill; the banking
 * counterpart of the investments batch_import_lots). Row semantics:
 *   * a row whose (account, external_transaction_id) already exists -> 'skipped'
 *     (idempotent re-imports);
 *   * a row whose referenced account/merchant/budget uuids don't resolve, or
 *     that the ledger's rules refuse (an amount with more than 2 decimals, an
 *     income on a liability account) -> 'failed' with a reason (reported per
 *     row, never aborts the batch);
 *   * dry_run previews the same per-row results without persisting — the
 *     request schema is strict, so dry-run validates what the real write
 *     validates.
 * All inserts happen in the request's withTenant transaction (atomic), and net worth
 * is recorded once.
 */
export async function bulkCreateTransactions({ transactions: rows, dry_run }: BulkTransactionsCreateInput): Promise<BulkCreateResult> {
  // uuid -> id caches so a 500-row statement doesn't re-resolve the same
  // account/merchant/budget refs hundreds of times.
  const idCache = new Map<string, number | null>();
  const resolveId = async (table: 'merchants' | 'budget_items' | 'budget_period', uuid: string): Promise<number | null> => {
    const key = `${table}:${uuid}`;
    if (!idCache.has(key)) {
      const row = await getDb().selectFrom(table).select('id').where('uuid', '=', uuid).executeTakeFirst();
      idCache.set(key, row?.id ?? null);
    }
    return idCache.get(key)!;
  };
  // An account with its type (Asset, Liability), which decides whether it takes an income.
  // Read FOR KEY SHARE, as the database reads an income's: the rows' inserts take that
  // lock anyway (their foreign key), and an edit making the account a liability is waited for.
  const accountCache = new Map<string, { id: number; type: string | null } | null>();
  const resolveAccount = async (uuid: string): Promise<{ id: number; type: string | null } | null> => {
    if (!accountCache.has(uuid)) {
      const row = await getDb().selectFrom('accounts').select(['id', 'type']).where('uuid', '=', uuid).forKeyShare().executeTakeFirst();
      accountCache.set(uuid, row ?? null);
    }
    return accountCache.get(uuid)!;
  };
  const periodItemCache = new Map<string, number | null>();
  const resolvePeriodItem = async (budgetItemId: number, budgetPeriodId: number): Promise<number | null> => {
    const key = `${budgetItemId}:${budgetPeriodId}`;
    if (!periodItemCache.has(key)) periodItemCache.set(key, await periodItemId(budgetItemId, budgetPeriodId));
    return periodItemCache.get(key)!;
  };

  const results: BulkRowResult[] = [];
  type PreparedInsert = {
    index: number;
    values: {
      account_id: number; merchant_id: number | null; amount: string; description: string | null;
      transaction_date: string; type: string; budget_period_id: number | null; budget_item_id: number | null;
      budget_period_item_id: number | null; status: string; review_status: string; external_transaction_id: string | null;
    };
  };
  const prepared: PreparedInsert[] = [];
  // (account, external id) of the rows this request creates: a statement listing a line
  // twice gets it once. Only a row that is created claims its id; one that fails
  // leaves it to a later row.
  const seenExternalIds = new Set<string>();

  // A retry sent while the first call is still running would find none of its rows yet
  // and add them all again. Bulk creates of one ledger take turns, so the second
  // finds what the first saved. Not on a dry run, which saves nothing.
  if (!dry_run) {
    await sql`SELECT pg_advisory_xact_lock(${BULK_CREATE_LOCK_CLASS}::int, current_tenant_id())`.execute(getDb());
  }

  for (const [i, row] of rows.entries()) {
    const reasons: string[] = [];

    const account = await resolveAccount(row.account_uuid);
    const accountId = account?.id ?? null;
    if (accountId == null) reasons.push('account not found');

    // Idempotent re-import: this source row was already recorded on this account.
    const externalKey = accountId != null && row.external_transaction_id ? `${accountId}:${row.external_transaction_id}` : null;
    if (externalKey && accountId != null && row.external_transaction_id) {
      if (seenExternalIds.has(externalKey)) {
        results.push({ index: i, status: 'skipped', reason: 'duplicate external_transaction_id (an earlier row of this request)' });
        continue;
      }
      const dup = await getDb()
        .selectFrom('transactions')
        .select('uuid')
        .where('account_id', '=', accountId)
        .where('external_transaction_id', '=', row.external_transaction_id)
        .executeTakeFirst();
      if (dup) {
        results.push({ index: i, status: 'skipped', transaction_uuid: dup.uuid, reason: 'duplicate external_transaction_id' });
        continue;
      }
    }

    let merchantId: number | null = null;
    if (row.merchant_uuid) {
      merchantId = await resolveId('merchants', row.merchant_uuid);
      if (merchantId == null) reasons.push('merchant not found');
    }
    let budgetItemId: number | null = null;
    if (row.budget_item_uuid) {
      budgetItemId = await resolveId('budget_items', row.budget_item_uuid);
      if (budgetItemId == null) reasons.push('budget item not found');
    }
    let budgetPeriodId: number | null = null;
    if (row.budget_period_uuid) {
      budgetPeriodId = await resolveId('budget_period', row.budget_period_uuid);
      if (budgetPeriodId == null) reasons.push('budget period not found');
    }
    // Whole cents: 12.345 is refused, not rounded, and so is one too large for an amount.
    const read = readCents(row.amount);
    const amountCents = 'cents' in read ? read.cents : null;
    if (!('cents' in read)) {
      reasons.push(read.problem === 'range'
        ? `amount must be between -${MAX_AMOUNT_TEXT} and ${MAX_AMOUNT_TEXT}`
        : 'amount must have at most 2 decimal places');
    }
    if (account && isIncomeOnLiability(row.type, account.type)) reasons.push(INCOME_ON_LIABILITY_REASON);

    if (reasons.length > 0 || amountCents === null) {
      results.push({ index: i, status: 'failed', reason: reasons.join('; ') });
      continue;
    }

    // Same signing rules as the single create: income/expense are forced to
    // the correct sign; the other types keep the caller's sign.
    const amount = centsToAmount(signForType(row.type, amountCents));

    const budgetPeriodItemId =
      budgetItemId != null && budgetPeriodId != null ? await resolvePeriodItem(budgetItemId, budgetPeriodId) : null;

    // This row is created (or would be, on a dry run): later rows with its id are duplicates.
    if (externalKey) seenExternalIds.add(externalKey);

    if (dry_run) {
      results.push({ index: i, status: 'created' });
      continue;
    }

    prepared.push({
      index: i,
      values: {
        account_id: accountId as number,
        merchant_id: merchantId,
        amount,
        description: row.description ?? null,
        transaction_date: row.transaction_date,
        type: row.type,
        budget_period_id: budgetPeriodId,
        budget_item_id: budgetItemId,
        budget_period_item_id: budgetPeriodItemId,
        status: row.status,
        review_status: row.review_status,
        external_transaction_id: row.external_transaction_id ?? null,
      },
    });
  }

  if (prepared.length > 0) {
    // One multi-row INSERT; RETURNING preserves VALUES order, so uuids zip
    // back to the prepared rows by position. uuid comes from the column
    // default (uuidv7), tenant_id from the RLS GUC.
    const inserted = await getDb()
      .insertInto('transactions')
      .values(prepared.map((p) => p.values))
      .returning(['uuid'])
      .execute();
    for (const [j, { index }] of prepared.entries()) {
      results.push({ index, status: 'created', transaction_uuid: present(inserted[j], 'a row for each insert').uuid });
    }
    await recordNetWorth();
  }

  results.sort((a, b) => a.index - b.index);
  const created = results.filter((r) => r.status === 'created').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  logger.info({ total: rows.length, created, skipped, failed, dryRun: dry_run }, 'Bulk transaction import');
  return { dry_run, total: rows.length, created, skipped, failed, results };
}
