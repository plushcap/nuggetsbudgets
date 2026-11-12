import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { queryString, transactionPageQuerySchema, transactionReviewStatus, type QueryValues } from '@nuggets/shared';
import { apiPath } from '../client.js';
import { registerTool, type ToolContext } from './helpers.js';

/**
 * "Tasks" in Nuggets are not a separate entity — they are transactions with
 * review_status = 'needs review'. These tools are domain-named facades over
 * /api/transactions so an agent has a clear classification inbox surface.
 */
export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'list_tasks',
    title: 'List classification tasks',
    description:
      'Return transactions awaiting classification (review_status = "needs review"). Mirrors the website Tasks page. Use assignedTo to scope to a specific user; set includeUnassigned to also include tasks with no assignee.',
    inputSchema: {
      assignedTo: z.coerce.number().int().positive().optional().describe('Filter to a specific assignee user id.'),
      includeUnassigned: z.boolean().optional().describe('When combined with assignedTo, also include unassigned tasks.'),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    },
    readOnly: true,
    handler: async (args, { client }) => {
      // The query GET /api/transactions/paginated reads, keyed by its own schema,
      // and checked with it: a key it doesn't name is a type error, and a value it would refuse
      // is refused here, with its message, before any request goes.
      const assignee: QueryValues<typeof transactionPageQuerySchema> =
        args.assignedTo === undefined
          ? {}
          : args.includeUnassigned
            ? { assigned_to_or_unassigned: args.assignedTo }
            : { assigned_to: args.assignedTo };
      return client.get(
        '/api/transactions/paginated',
        queryString(transactionPageQuerySchema, {
          review_status: transactionReviewStatus.enum['needs review'],
          page: args.page ?? 1,
          limit: args.limit ?? 25,
          ...assignee,
        })
      );
    },
  });

  registerTool(server, ctx, {
    name: 'accept_task',
    title: 'Accept a classification task',
    description:
      'Classify a transaction and mark it reviewed in a single atomic call. budgetItemId is required — the rest are optional. If both budgetItemId and budgetPeriodId are supplied the backend links the correct budget_period_item automatically.',
    inputSchema: {
      uuid: z.string().uuid(),
      budgetItemId: z.coerce.number().int().describe('Required. The budget category to assign.'),
      budgetPeriodId: z.coerce.number().int().optional(),
      merchantId: z.coerce.number().int().nullable().optional(),
      notes: z.string().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {
        budget_item_id: args.budgetItemId,
        review_status: transactionReviewStatus.enum.reviewed,
      };
      if (args.budgetPeriodId !== undefined) body.budget_period_id = args.budgetPeriodId;
      if (args.merchantId !== undefined) body.merchant_id = args.merchantId;
      if (args.notes !== undefined) body.notes = args.notes;
      return client.put(apiPath`/api/transactions/${args.uuid}`, body);
    },
  });
}
