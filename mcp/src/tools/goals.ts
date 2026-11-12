import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { goalProgressHistoryQuery, queryString } from '@nuggets/shared';
import { apiPath } from '../client.js';
import { registerTool, type ToolContext } from './helpers.js';

/** A calendar date, as the history route reads its range (it refuses anything else too). */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date (YYYY-MM-DD)');

export function registerGoalTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'list_goals',
    title: 'List goals',
    description: 'Return all goals with their current progress. A goal made as a budget item (Savings, type Goal) may have no target: its target_amount, target_date, progress_percentage and remaining_amount are then null, which means it has none, not zero.',
    inputSchema: {},
    readOnly: true,
    handler: async (_args, { client }) => client.get('/api/goals'),
  });

  registerTool(server, ctx, {
    name: 'get_goal',
    title: 'Get goal',
    description: 'Fetch a goal by UUID, including the accounts and budget items linked to it now, each with linked_since (the day it counts from). A goal with no target (one made as a budget item) has target_amount, target_date, progress_percentage, remaining_amount and the projection’s figures and dates null.',
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ uuid }, { client }) => client.get(apiPath`/api/goals/${uuid}`),
  });

  registerTool(server, ctx, {
    name: 'get_goal_progress_history',
    title: 'Goal progress history',
    description:
      "Return a goal's progress at each month end, and today, computed from the balances on those dates of the accounts and envelopes linked to it on each date (nothing is stored). " +
      'A link counts from the day it was made until the day it was removed, and an account not on the days it was hidden. ' +
      'Each point has snapshot_date, total_from_accounts, total_from_budget_items and total_progress (decimal text). ' +
      "Optional startDate and endDate (YYYY-MM-DD) bound the range (at most ten years; no point is after today); by default it is the goal's life so far. " +
      'So linking, unlinking, hiding or showing an account or envelope moves the history from that day: that step is not growth or a loss. ' +
      "For how fast the goal is growing and when it would be reached, use get_goal's projection, which measures growth on the accounts and envelopes the goal counts now.",
    inputSchema: { uuid: z.string().uuid(), startDate: calendarDate.optional(), endDate: calendarDate.optional() },
    readOnly: true,
    handler: async ({ uuid, startDate, endDate }, { client }) =>
      client.get(apiPath`/api/goals/${uuid}/progress-history`, queryString(goalProgressHistoryQuery, { start_date: startDate, end_date: endDate })),
  });

  registerTool(server, ctx, {
    name: 'get_goal_balance_history',
    title: 'Goal underlying balance history',
    description: 'Return the balance history of the accounts linked to a goal now: their total at each date.',
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ uuid }, { client }) => client.get(apiPath`/api/goals/${uuid}/balance-history`),
  });
}
