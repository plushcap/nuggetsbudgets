import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { REVIEW_STATUSES, TRANSACTION_STATUSES, TRANSACTION_TYPES, calendarDay, queryString, transactionPageQuerySchema } from '@nuggets/shared';
import { apiPath } from '../client.js';
import { registerTool, type ToolArgs, type ToolContext } from './helpers.js';

// The list routes take a calendar day, YYYY-MM-DD, and answer anything else (a timestamp
// such as 2026-01-01T00:00:00Z) 400; ids are positive whole numbers. A date a tool writes is
// @nuggets/shared's calendarDay: a real day, from 1800 to 2999, refused here otherwise.
const filterDay = z.iso.date();
const positiveId = z.coerce.number().int().positive();
/** A new transaction's status: pending or cleared, the two the tools have always offered. */
const createdStatus = z.enum(TRANSACTION_STATUSES).exclude(['reconciled']);

const transactionFilters = {
  search: z.string().optional().describe('Free-text substring match against description, account, merchant, or budget item name.'),
  dateFrom: filterDay.optional().describe('Inclusive lower bound, a calendar day YYYY-MM-DD (no time).'),
  dateTo: filterDay.optional().describe('Inclusive upper bound, a calendar day YYYY-MM-DD (no time).'),
  accountUuid: z.string().uuid().optional(),
  merchantUuid: z.string().uuid().optional().describe('Preferred. Filter to transactions for this merchant.'),
  merchantId: positiveId.optional().describe('Alternative to merchantUuid if you only have the numeric id.'),
  budgetItemUuid: z.string().uuid().optional().describe('Preferred. Filter to transactions categorised under this budget item.'),
  budgetItemId: positiveId.optional().describe('Alternative to budgetItemUuid if you only have the numeric id.'),
  budgetPeriodId: positiveId.optional(),
  reviewStatus: z.enum(REVIEW_STATUSES).optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  assignedTo: positiveId.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
};

/** The list's query, written and checked with GET /api/transactions/paginated's own schema. */
function buildTxQuery(args: Partial<ToolArgs<typeof transactionFilters>>): string {
  return queryString(transactionPageQuerySchema, {
    search: args.search,
    date_from: args.dateFrom,
    date_to: args.dateTo,
    account_uuid: args.accountUuid,
    merchant_uuid: args.merchantUuid,
    merchant_id: args.merchantId,
    budget_item_uuid: args.budgetItemUuid,
    budget_item_id: args.budgetItemId,
    budget_period_id: args.budgetPeriodId,
    review_status: args.reviewStatus,
    type: args.type,
    assigned_to: args.assignedTo,
    page: args.page ?? 1,
    limit: args.limit ?? 25,
  });
}

export function registerTransactionTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'list_transactions',
    title: 'List transactions',
    description:
      'Return a paginated list of transactions with optional filters. Use this for general browsing, or to pull all transactions for a given merchant (merchantUuid), budget item (budgetItemUuid), account (accountUuid), or date range. For the classification inbox use list_tasks instead. Each row has its account\'s account_class: Asset or Liability (a liability account takes no income).',
    inputSchema: transactionFilters,
    readOnly: true,
    handler: async (args, { client }) => {
      return client.get('/api/transactions/paginated', buildTxQuery(args));
    },
  });

  registerTool(server, ctx, {
    name: 'get_transaction',
    title: 'Get transaction',
    description:
      "Fetch a single transaction by UUID, including account, merchant, budget item and tags. account_class is its account's Asset or Liability (a liability account takes no income: record money paid toward it as a payment).",
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ uuid }, { client }) => {
      return client.get(apiPath`/api/transactions/${uuid}`);
    },
  });

  registerTool(server, ctx, {
    name: 'classify_transaction',
    title: 'Classify a transaction',
    description:
      'Update the classification fields on a transaction — budget item, period, merchant — and optionally attach tags, WITHOUT marking it reviewed. Tags are added idempotently (existing tags are kept; use remove_tag_from_transaction to detach). Use accept_task for "classify and accept" in one call.',
    inputSchema: {
      uuid: z.string().uuid(),
      budgetItemId: z.coerce.number().int().nullable().optional(),
      budgetPeriodId: z.coerce.number().int().nullable().optional(),
      merchantId: z.coerce.number().int().nullable().optional(),
      tagUuids: z
        .array(z.string().uuid())
        .optional()
        .describe('Tags to attach to the transaction (idempotent, additive). Existing tags are left in place.'),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {};
      if (args.budgetItemId !== undefined) body.budget_item_id = args.budgetItemId;
      if (args.budgetPeriodId !== undefined) body.budget_period_id = args.budgetPeriodId;
      if (args.merchantId !== undefined) body.merchant_id = args.merchantId;

      // Classification fields go through PUT; tags are attached via the per-tag
      // endpoint (PUT /:uuid does not accept tags). Skip the PUT for a tags-only call.
      const putResult =
        Object.keys(body).length > 0 ? await client.put(apiPath`/api/transactions/${args.uuid}`, body) : null;

      if (args.tagUuids && args.tagUuids.length > 0) {
        // Idempotent: attaching an already-present tag is a no-op on the backend.
        for (const tagUuid of args.tagUuids) {
          await client.post(apiPath`/api/transactions/${args.uuid}/tags/${tagUuid}`);
        }
        // Re-fetch so the response reflects the freshly attached tags.
        return client.get(apiPath`/api/transactions/${args.uuid}`);
      }

      return putResult ?? client.get(apiPath`/api/transactions/${args.uuid}`);
    },
  });

  registerTool(server, ctx, {
    name: 'update_transaction',
    title: 'Edit transaction fields',
    description:
      'Edit non-classification fields on a transaction (description, amount, date, notes, assignment, and external transaction id/link). Does not mark the transaction reviewed. A split transaction\'s amount (or one split\'s) can\'t be changed here: use split_transaction. Changing the amount of one side of a transfer changes the other side to match.',
    inputSchema: {
      uuid: z.string().uuid(),
      description: z.string().optional(),
      amount: z.coerce
        .number()
        .optional()
        .describe('Same as create_transaction: a magnitude is fine, the backend signs income positive and expenses negative. A side of a transfer keeps its direction. Other types keep the sign given. At most 2 decimal places.'),
      transactionDate: calendarDay.optional().describe('YYYY-MM-DD'),
      notes: z.string().optional(),
      assignedTo: z.coerce.number().int().nullable().optional(),
      externalTransactionId: z
        .string()
        .nullable()
        .optional()
        .describe('Source-system id for this transaction (e.g. an online order number). Pass null to clear.'),
      externalLink: z
        .string()
        .url()
        .nullable()
        .optional()
        .describe('http(s) URL deep-linking to the external transaction. Pass null to clear.'),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {};
      if (args.description !== undefined) body.description = args.description;
      if (args.amount !== undefined) body.amount = args.amount;
      if (args.transactionDate !== undefined) body.transaction_date = args.transactionDate;
      if (args.notes !== undefined) body.notes = args.notes;
      if (args.assignedTo !== undefined) body.assigned_to = args.assignedTo;
      if (args.externalTransactionId !== undefined) body.external_transaction_id = args.externalTransactionId;
      if (args.externalLink !== undefined) body.external_link = args.externalLink;
      return client.put(apiPath`/api/transactions/${args.uuid}`, body);
    },
  });

  registerTool(server, ctx, {
    name: 'create_transaction',
    title: 'Create a transaction',
    description:
      'Manually record a new transaction on an account. Required: accountUuid, amount (always positive — the backend will negate it for expenses automatically), transactionDate (YYYY-MM-DD), and type. Optional: description, merchantUuid, budgetItemUuid + budgetPeriodUuid (the backend auto-links the right budget_period_item), tagUuids (attached after insert), reviewStatus (defaults to "needs review" so it appears in the classification inbox). For a transaction that needs to be split across multiple budget items, create it first and then call split_transaction. For statement/CSV backfills of many rows, use create_transactions (bulk, idempotent) instead.',
    inputSchema: {
      accountUuid: z.string().uuid(),
      amount: z.coerce.number().describe('Magnitude of the transaction. For income/expense the backend will sign it correctly; for payment/transfer/balance adjustment the sign is preserved.'),
      transactionDate: calendarDay.describe('YYYY-MM-DD'),
      type: z.enum(TRANSACTION_TYPES),
      description: z.string().optional().describe('Short description shown in lists and search.'),
      merchantUuid: z.string().uuid().optional(),
      budgetItemUuid: z.string().uuid().optional(),
      budgetPeriodUuid: z.string().uuid().optional().describe('Supply alongside budgetItemUuid so the transaction lands in the right period’s envelope.'),
      tagUuids: z.array(z.string().uuid()).optional().describe('Tags to attach after the transaction is created. Idempotent.'),
      reviewStatus: z.enum(REVIEW_STATUSES).optional().describe('Defaults to "needs review" so the transaction shows up in list_tasks.'),
      status: createdStatus.optional().describe('Defaults to "cleared".'),
      externalTransactionId: z.string().optional().describe('The source system\'s id for this transaction (statement/confirmation line id). Set it when importing so re-imports can be detected (search list_transactions first) and the row traces back to its source.'),
    },
    destructive: false,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {
        account_uuid: args.accountUuid,
        amount: args.amount,
        transaction_date: args.transactionDate,
        type: args.type,
      };
      if (args.description !== undefined) body.description = args.description;
      if (args.merchantUuid !== undefined) body.merchant_uuid = args.merchantUuid;
      if (args.budgetItemUuid !== undefined) body.budget_item_uuid = args.budgetItemUuid;
      if (args.budgetPeriodUuid !== undefined) body.budget_period_uuid = args.budgetPeriodUuid;
      if (args.reviewStatus !== undefined) body.review_status = args.reviewStatus;
      if (args.status !== undefined) body.status = args.status;
      if (args.externalTransactionId !== undefined) body.external_transaction_id = args.externalTransactionId;
      if (args.tagUuids && args.tagUuids.length > 0) body.tag_uuids = args.tagUuids;
      return client.post('/api/transactions', body);
    },
  });

  registerTool(server, ctx, {
    name: 'create_transactions',
    title: 'Bulk-create transactions',
    description:
      'Create up to 500 transactions in one call — the batch path for statement/CSV backfills (the banking counterpart of batch_import_lots). Each row is account-scoped. ' +
      'Rows whose externalTransactionId already exists on that account are skipped, so re-running an import is safe (idempotent); rows with unresolvable account/merchant/budget uuids are reported as failed per-row without aborting the batch. ' +
      'Pass dryRun=true to preview per-row results without persisting — dry-run validates exactly what the real write validates. ' +
      'Returns { total, created, skipped, failed, results: [{index, status, transaction_uuid?, reason?}] }. For a single entry use create_transaction.',
    inputSchema: {
      transactions: z.array(z.object({
        accountUuid: z.string().uuid(),
        amount: z.coerce.number().describe('Magnitude; income/expense are auto-signed by the backend, other types keep the given sign.'),
        transactionDate: calendarDay.describe('YYYY-MM-DD'),
        type: z.enum(TRANSACTION_TYPES),
        description: z.string().optional(),
        merchantUuid: z.string().uuid().optional(),
        budgetItemUuid: z.string().uuid().optional(),
        budgetPeriodUuid: z.string().uuid().optional().describe('Supply alongside budgetItemUuid so the row lands in the right period\'s envelope.'),
        externalTransactionId: z.string().optional().describe('Source-system id (statement line id). Strongly recommended for imports — it is the idempotency key.'),
        reviewStatus: z.enum(REVIEW_STATUSES).optional().describe('Defaults to "needs review".'),
        status: createdStatus.optional().describe('Defaults to "cleared".'),
      })).min(1).max(500),
      dryRun: z.boolean().optional(),
    },
    destructive: false,
    handler: async (args, { client }) => {
      const transactions = args.transactions.map((row) => {
        const body: Record<string, unknown> = {
          account_uuid: row.accountUuid,
          amount: row.amount,
          transaction_date: row.transactionDate,
          type: row.type,
        };
        if (row.description !== undefined) body.description = row.description;
        if (row.merchantUuid !== undefined) body.merchant_uuid = row.merchantUuid;
        if (row.budgetItemUuid !== undefined) body.budget_item_uuid = row.budgetItemUuid;
        if (row.budgetPeriodUuid !== undefined) body.budget_period_uuid = row.budgetPeriodUuid;
        if (row.externalTransactionId !== undefined) body.external_transaction_id = row.externalTransactionId;
        if (row.reviewStatus !== undefined) body.review_status = row.reviewStatus;
        if (row.status !== undefined) body.status = row.status;
        return body;
      });
      return client.post('/api/transactions/bulk', { transactions, dry_run: args.dryRun ?? false });
    },
  });

  registerTool(server, ctx, {
    name: 'split_transaction',
    title: 'Split a transaction across budget items',
    description:
      'Split an existing transaction into 2+ child transactions, each with its own amount, budget item, and optional tags. Children inherit the parent’s account, merchant, date, type, and review status. The split amounts must sum to the parent’s amount exactly, to the cent, with at most 2 decimal places each. Re-splitting an already-split transaction replaces the existing children. A side of a transfer (one with a transfer_transaction_id) is not split: the server answers 409 TRANSFER_SPLIT_REFUSED. Nor is one split (a child) split again: 409 SPLIT_OF_SPLIT_REFUSED; split its parent instead. Use this when a single charge covers multiple categories (e.g. a Target run that’s part Groceries, part Household).',
    inputSchema: {
      uuid: z.string().uuid().describe('UUID of the parent transaction to split.'),
      splits: z
        .array(
          z.object({
            amount: z.coerce.number().describe('Signed amount for this child. Must use the same sign convention as the parent (e.g. negative for an expense).'),
            description: z.string().optional().describe('Per-split description; defaults to the parent’s description if omitted.'),
            budgetItemUuid: z.string().uuid().optional(),
            budgetPeriodUuid: z.string().uuid().optional().describe('Pair with budgetItemUuid so the child links to the right budget_period_item.'),
            tagUuids: z.array(z.string().uuid()).optional(),
          })
        )
        .min(2)
        .describe('At least 2 splits. Sum of amounts must equal the parent’s amount exactly.'),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const splits = args.splits.map((s) => {
        const out: Record<string, unknown> = { amount: s.amount };
        if (s.description !== undefined) out.description = s.description;
        if (s.budgetItemUuid !== undefined) out.budget_item_uuid = s.budgetItemUuid;
        if (s.budgetPeriodUuid !== undefined) out.budget_period_uuid = s.budgetPeriodUuid;
        if (s.tagUuids && s.tagUuids.length > 0) out.tag_uuids = s.tagUuids;
        return out;
      });
      return client.post(apiPath`/api/transactions/${args.uuid}/split`, { splits });
    },
  });

  registerTool(server, ctx, {
    name: 'bulk_classify',
    title: 'Bulk classify transactions',
    description:
      'Apply the same classification updates to multiple transactions at once. Reuses the backend bulk-update endpoint.',
    inputSchema: {
      uuids: z.array(z.string().uuid()).min(1),
      budgetItemId: z.coerce.number().int().nullable().optional(),
      budgetPeriodId: z.coerce.number().int().nullable().optional(),
      merchantId: z.coerce.number().int().nullable().optional(),
      reviewStatus: z.enum(REVIEW_STATUSES).optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const updates: Record<string, unknown> = {};
      if (args.budgetItemId !== undefined) updates.budget_item_id = args.budgetItemId;
      if (args.budgetPeriodId !== undefined) updates.budget_period_id = args.budgetPeriodId;
      if (args.merchantId !== undefined) updates.merchant_id = args.merchantId;
      if (args.reviewStatus !== undefined) updates.review_status = args.reviewStatus;
      return client.put('/api/transactions/bulk', { transactionUuids: args.uuids, updates });
    },
  });
}
