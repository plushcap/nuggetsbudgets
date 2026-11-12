import { z } from 'zod';
import { BUDGET_PRIORITIES, budgetItemStatus, calendarDay } from '@nuggets/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPath } from '../client.js';
import { registerTool, type ToolContext } from './helpers.js';

/**
 * Nuggets separates "categories" (a top-level taxonomy with icons) from
 * "budget items" (the envelope rows you spend against). Both are exposed so
 * An agent can curate either level without recreating functionality.
 *
 * Budget-item fields are documented in detail (allowed values + the envelope /
 * event-sourced budget model) so an agent can create well-formed items without
 * guessing. The backend create/update accept these fields verbatim (snake_case)
 * and validation is loose, so the descriptions here are the agent's source of
 * truth for conventional values.
 */

// Field set shared by create + update. Values pass straight through to the
// backend as the request body, so keys stay snake_case.
const budgetItemFields = {
  description: z
    .string()
    .optional()
    .describe('User-facing description shown in the UI. Distinct from `instructions` (which is AI-facing).'),
  expense_type: z
    .enum(['Income', 'Expense'])
    .optional()
    .describe(
      "The item's top-level kind: 'Income' (money in, e.g. a paycheck) or 'Expense' (money out). " +
        'A "bill" is an Expense with `isbill: true` plus the recurring_* fields. Set this — it drives ' +
        'how the item is grouped and budgeted.',
    ),
  type: z
    .string()
    .optional()
    .describe(
      "Grouping/behavior label for the row. Common values: 'Monthly' (budgeted every period), " +
        "'Envelope' (accumulates a balance across periods — pair with rollover), 'Goal' (a savings goal), " +
        "'Fixed'. ('Non-Monthly' is legacy.) For income items this is typically the income label.",
    ),
  subtype: z
    .string()
    .optional()
    .describe(
      "Sub-grouping under `type`. Expenses: 'Flexible' (variable spend) or 'Fixed' (set amount); " +
        "bills use 'Fixed' or 'Recurring Payments'. Income: 'Paycheck' or 'Fixed'. Savings: 'Goal'.",
    ),
  priority: z
    .enum(BUDGET_PRIORITIES)
    .optional()
    .describe("How important the item is: 'Essential' (needs) or 'Optional' (wants)."),
  rollover: z
    .boolean()
    .optional()
    .describe(
      'Envelope behavior: when true, the unspent (or overspent) balance carries forward into the next ' +
        'period instead of resetting. Use for sinking funds / envelopes and for bills paid less often than monthly. ' +
        'It can only change while the item has no money recorded in a period before the current one (a budget ' +
        'change or a transaction); after that a change is refused with 409 ROLLOVER_LOCKED.',
    ),
  isbill: z
    .boolean()
    .optional()
    .describe('Marks an Expense as a bill (a recurring obligation). Pair with the recurring_* fields below.'),
  recurring_payment: z.boolean().optional().describe('Whether this item represents a recurring payment.'),
  recurring_payment_frequency: z
    .coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Interval in MONTHS between payments, at least 1: 1 = monthly, 3 = quarterly, 6 = semi-annual, 12 = annual.'),
  recurring_payment_amount: z
    .coerce
    .number()
    .optional()
    .describe('The amount due each time the bill is paid (the full payment, not the per-month set-aside).'),
  // A real day (the route refuses a timestamp), or null to clear it, as the route takes.
  recurring_next_payment_date: calendarDay
    .nullable()
    .optional()
    .describe('Next payment due date, YYYY-MM-DD; null clears it.'),
  default_budget_amount: z
    .coerce
    .number()
    .optional()
    .describe(
      'Default amount to budget for this item each period (a template/seed). NOTE: actual per-period ' +
        'budgeted/actual/remaining are event-sourced and computed per period — they are NOT stored on the ' +
        'item. This only sets the default a new period starts from.',
    ),
  rollover_target_amount: z
    .coerce
    .number()
    .optional()
    .describe('For envelopes/savings: the target balance to accumulate (e.g. a sinking-fund or goal target).'),
  rollover_target_date: z
    .string()
    .nullable()
    .optional()
    .describe(
      'For envelopes: the date to reach rollover_target_amount by, ISO 8601 (YYYY-MM-DD). The app checks ' +
        'the monthly amount covers what is left over the months until then. null clears it.',
    ),
  rollover_starting_balance: z
    .coerce
    .number()
    .optional()
    .describe(
      'Opening balance for a rollover envelope: the whole balance it starts with. On create this records a ' +
        'starting-balance event in the period of rollover_starting_balance_date (the current period when none); ' +
        'an update records the change. Only applied when `rollover` is true, and needs a budget period to exist.',
    ),
  rollover_starting_balance_date: z
    .string()
    .optional()
    .describe('Date the starting balance applies from, ISO 8601 (YYYY-MM-DD).'),
  category_id: z
    .coerce
    .number()
    .int()
    .optional()
    .describe('Numeric id of the parent category (use `list_categories` to resolve names → ids).'),
  merchant_id: z
    .coerce
    .number()
    .int()
    .optional()
    .describe('Numeric id of an associated merchant (use `list_merchants` to resolve names → ids).'),
  color: z.string().optional().describe('Hex color for the item, e.g. "#3B82F6".'),
  icon: z
    .string()
    .optional()
    .describe('Icon name as a canonical PascalCase Lucide name, e.g. "Wallet", "PiggyBank", "Car".'),
  instructions: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Free-form context for AI agents. Distinct from the user-facing `description`; the agent reads this ' +
        'when working with the budget item (e.g. classification hints, rules of thumb). Pass null to clear.',
    ),
};

const CREATE_DESCRIPTION = [
  'Create a budget item (an "envelope" you budget and spend against). `name` is required; supply only the',
  'fields you need.',
  '',
  'Model: a budget item is a template. Creating it seeds a row for every existing budget period; the actual',
  'budgeted/actual/remaining for a period are event-sourced and computed per period — never stored on the item.',
  '`default_budget_amount` is just the per-period default.',
  '',
  'Recipes:',
  "• Income (paycheck): expense_type 'Income', type 'Monthly', subtype 'Paycheck', priority 'Essential'.",
  "• Variable expense envelope (e.g. Groceries): expense_type 'Expense', type 'Monthly', subtype 'Flexible',",
  '  default_budget_amount set; rollover true if leftover should carry forward.',
  "• Sinking fund / envelope (e.g. Car Repairs): expense_type 'Expense', type 'Envelope', rollover true,",
  '  rollover_target_amount set.',
  "• Bill (e.g. Insurance every 6 months): expense_type 'Expense', isbill true, subtype 'Fixed',",
  '  recurring_payment true, recurring_payment_amount = full payment, recurring_payment_frequency = 6,',
  '  rollover true (so the monthly set-aside accumulates between payments).',
].join('\n');

export function registerBudgetItemTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'list_budget_items',
    title: 'List budget items',
    description:
      'Return the budget items (envelope categories) with their configuration. Archived items (status ' +
      "'archived') are left out unless includeArchived is true: they keep their history but take no new " +
      'transactions, so never assign one.',
    inputSchema: {
      includeArchived: z.boolean().optional().describe('Include archived budget items. Defaults to false.'),
    },
    readOnly: true,
    handler: async ({ includeArchived }, { client }) => {
      const items = await client.get<{ status?: string | null }[]>('/api/budgets/items');
      return includeArchived ? items : items.filter((item) => item.status !== budgetItemStatus.enum.archived);
    },
  });

  registerTool(server, ctx, {
    name: 'create_budget_item',
    title: 'Create budget item',
    description: CREATE_DESCRIPTION,
    inputSchema: { name: z.string().min(1).describe('Display name of the budget item (required).'), ...budgetItemFields },
    destructive: false,
    handler: async (args, { client }) => client.post('/api/budgets/items', args),
  });

  registerTool(server, ctx, {
    name: 'update_budget_item',
    title: 'Update budget item',
    description:
      'Update fields on an existing budget item. Only supplied fields change. Useful for setting the AI ' +
      '`instructions` field, retargeting an envelope, or reclassifying. See `create_budget_item` for the ' +
      'envelope / event-sourced budget model and field conventions.',
    inputSchema: {
      uuid: z.string().uuid().describe('Public uuid of the budget item to update (from `list_budget_items`).'),
      name: z.string().min(1).optional().describe('New display name.'),
      ...budgetItemFields,
    },
    destructive: true,
    handler: async (args, { client }) => {
      const { uuid, ...updates } = args as { uuid: string } & Record<string, unknown>;
      return client.put(apiPath`/api/budgets/items/${uuid}`, updates);
    },
  });

  // --- Categories (higher-level taxonomy) ---

  registerTool(server, ctx, {
    name: 'list_categories',
    title: 'List budget categories',
    description: 'Return the top-level category taxonomy used to group budget items.',
    inputSchema: {},
    readOnly: true,
    handler: async (_args, { client }) => client.get('/api/categories'),
  });

  registerTool(server, ctx, {
    name: 'create_category',
    title: 'Create budget category',
    description: 'Create a new top-level category. `name` and `icon` are both required by the backend.',
    inputSchema: {
      name: z.string().min(1).max(100),
      icon: z.string().min(1),
      description: z.string().optional(),
      priority: z.string().optional(),
      notes: z.string().optional(),
    },
    destructive: false,
    handler: async (args, { client }) => client.post('/api/categories', args),
  });

  registerTool(server, ctx, {
    name: 'update_category',
    title: 'Update budget category',
    description: 'Update an existing category. `name` and `icon` are required by the backend even on partial updates.',
    inputSchema: {
      uuid: z.string().uuid(),
      name: z.string().min(1).max(100),
      icon: z.string().min(1),
      description: z.string().optional(),
      priority: z.string().optional(),
      notes: z.string().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const { uuid, ...body } = args;
      return client.put(apiPath`/api/categories/${uuid}`, body);
    },
  });
}
