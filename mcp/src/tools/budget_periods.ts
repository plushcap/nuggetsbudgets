import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calculateActualRemaining, computeAllSubtotals, deriveBudgetSections, type SubtotalItem } from '@nuggets/shared';
import { apiPath } from '../client.js';
import { registerTool, type ToolContext } from './helpers.js';

export function registerBudgetPeriodTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'list_budget_periods',
    title: 'List budget periods',
    description:
      'Return every budget period (monthly or custom), with status and dates. Use this to find the current/active period id before classifying. A period with archived_at set was archived by a member: the app hides it from its period pickers, so prefer the others.',
    inputSchema: {},
    readOnly: true,
    handler: async (_args, { client }) => client.get('/api/budget-periods/management'),
  });

  registerTool(server, ctx, {
    name: 'get_budget_period_summary',
    title: 'Budget period summary',
    description: 'Return the spending/allocation summary for a budget period, per budget item.',
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ uuid }, { client }) => client.get(apiPath`/api/budgets/periods/${uuid}/summary`),
  });

  registerTool(server, ctx, {
    name: 'list_budget_period_items',
    title: 'Budget allocations for a period',
    description:
      'Return every budget item’s allocation and remaining spend for a given period, and the period’s totals as the Budget page and Close-Out show them ' +
      '(`totals`: actualIncome, monthlyActual, envelopeBudgetAmount, savingsBudgetAmount, remaining, fixedRemaining, estimatedRemaining; ' +
      '`subtotals`: the income, savings and expense sections’ budget, actual, transfers and remaining, and each expense type’s and subtype’s; savings counts the period’s goals, the active ones and any other with money in the period, as the Budget page lists them). ' +
      "Amounts are in the tenant's currency (get_general_settings), pre-signed (spending negative), worked out in whole cents.",
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ uuid }, { client }) => {
      const answer = await client.get<{ success?: boolean; data?: unknown }>(apiPath`/api/budgets/periods/${uuid}/items`);
      // The same figures, from the same code, as the Budget page's.
      const items = Array.isArray(answer?.data) ? (answer.data as SubtotalItem[]) : [];
      return {
        ...answer,
        totals: calculateActualRemaining(items),
        subtotals: computeAllSubtotals(deriveBudgetSections(items)),
      };
    },
  });
}
