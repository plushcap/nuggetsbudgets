import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { budgetItemMatchingRuleMethod, budgetItemMatchingRulesQuery, queryString } from '@nuggets/shared';
import { apiPath } from '../client.js';
import { registerTool, type ToolContext } from './helpers.js';

/**
 * Budget item matching rules — the automatic classification layer.
 *
 * Each rule says "when a transaction matches <criteria>, assign it to this
 * budget item". Criteria can combine a text match on the description
 * (`method` + `matchingText`), a merchant scope (`merchantUuid`), and an
 * amount range (`amountMin`/`amountMax`). Lower `priority` wins ties.
 *
 * The surface mirrors merchant rules but is scoped to budget items instead
 * of merchants.
 */

const ruleMethods = budgetItemMatchingRuleMethod.options;

export function registerBudgetMatchingRuleTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'list_budget_matching_rules',
    title: 'List budget matching rules',
    description:
      'Return every budget item matching rule, active or not (is_active says which; only active rules match imports), or those for a specific budget item. Rows include the budget item and merchant names so you can reason about them without a second lookup.',
    inputSchema: {
      budgetItemUuid: z.string().uuid().optional().describe('Optional — filter to rules for one budget item.'),
    },
    readOnly: true,
    handler: async ({ budgetItemUuid }, { client }) =>
      client.get('/api/budgets/item-matching-rules', queryString(budgetItemMatchingRulesQuery, { budget_item_uuid: budgetItemUuid })),
  });

  registerTool(server, ctx, {
    name: 'create_budget_matching_rule',
    title: 'Create budget matching rule',
    description:
      'Add a rule that will auto-categorise future transactions to this budget item. For text-based methods (exact/contains/starts_with/ends_with/regex) supply `matchingText`. For `merchant_exact`, supply `merchantUuid` instead of matchingText. Optional `amountMin`/`amountMax` let you scope a rule to a spend range. Lower `priority` wins; defaults to 100.',
    inputSchema: {
      budgetItemUuid: z.string().uuid(),
      method: z.enum(ruleMethods),
      matchingText: z.string().optional().describe('Required for text-based methods; ignored for merchant_exact.'),
      merchantUuid: z.string().uuid().optional().describe('Required when method is "merchant_exact".'),
      amountMin: z.coerce.number().optional(),
      amountMax: z.coerce.number().optional(),
      priority: z.coerce.number().int().optional().describe('Lower = higher priority. Defaults to 100.'),
      notes: z.string().optional(),
    },
    destructive: false,
    handler: async (args, { client }) => {
      if (args.method === 'merchant_exact' && !args.merchantUuid) {
        throw new Error('merchantUuid is required when method is "merchant_exact".');
      }
      const textBased = args.method !== 'merchant_exact';
      if (textBased && !(args.matchingText && args.matchingText.trim())) {
        throw new Error('matchingText is required for text-based methods.');
      }
      return client.post('/api/budgets/item-matching-rules', {
        budget_item_uuid: args.budgetItemUuid,
        merchant_uuid: args.merchantUuid,
        method: args.method,
        matching_text: args.matchingText,
        amount_min: args.amountMin,
        amount_max: args.amountMax,
        priority: args.priority,
        notes: args.notes,
      });
    },
  });

  registerTool(server, ctx, {
    name: 'update_budget_matching_rule',
    title: 'Update budget matching rule',
    description:
      'Update an existing rule. Fetches the current rule first and merges your changes on top, so fields you don’t touch stay as-is.',
    inputSchema: {
      ruleUuid: z.string().uuid(),
      budgetItemUuid: z.string().uuid().optional(),
      method: z.enum(ruleMethods).optional(),
      matchingText: z.string().optional(),
      merchantUuid: z.string().uuid().nullable().optional(),
      amountMin: z.coerce.number().nullable().optional(),
      amountMax: z.coerce.number().nullable().optional(),
      priority: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
      notes: z.string().nullable().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      // The backend PUT requires budget_item_id + method in every call — look up
      // the current rule and merge so callers can supply just what they’re
      // changing.
      type RuleRow = {
        uuid: string;
        budget_item_id: number;
        budget_item_uuid?: string;
        merchant_id: number | null;
        method: string;
        matching_text: string | null;
        amount_min: number | null;
        amount_max: number | null;
        priority: number;
        is_active: boolean;
        notes: string | null;
      };
      const all = await client.get<RuleRow[]>('/api/budgets/item-matching-rules');
      const current = Array.isArray(all) ? all.find((r) => r.uuid === args.ruleUuid) : undefined;
      if (!current) {
        throw new Error(`Budget matching rule ${args.ruleUuid} not found.`);
      }

      const body: Record<string, unknown> = {
        method: args.method ?? current.method,
        matching_text: args.matchingText !== undefined ? args.matchingText : current.matching_text,
        amount_min: args.amountMin !== undefined ? args.amountMin : current.amount_min,
        amount_max: args.amountMax !== undefined ? args.amountMax : current.amount_max,
        priority: args.priority ?? current.priority,
        is_active: args.isActive ?? current.is_active,
        notes: args.notes !== undefined ? args.notes : current.notes,
      };

      if (args.budgetItemUuid !== undefined) {
        body.budget_item_uuid = args.budgetItemUuid;
      } else {
        body.budget_item_id = current.budget_item_id;
      }

      if (args.merchantUuid !== undefined) {
        body.merchant_uuid = args.merchantUuid;
      } else if (current.merchant_id !== null) {
        body.merchant_id = current.merchant_id;
      }

      return client.put(apiPath`/api/budgets/item-matching-rules/${args.ruleUuid}`, body);
    },
  });

  registerTool(server, ctx, {
    name: 'delete_budget_matching_rule',
    title: 'Delete budget matching rule',
    description:
      'Remove a budget matching rule. Doesn’t retro-un-classify transactions it already matched; only stops future auto-classification on that pattern.',
    inputSchema: { ruleUuid: z.string().uuid() },
    destructive: true,
    handler: async ({ ruleUuid }, { client }) =>
      client.request('DELETE', apiPath`/api/budgets/item-matching-rules/${ruleUuid}`),
  });
}
