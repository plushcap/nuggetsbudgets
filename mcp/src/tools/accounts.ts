import { z } from 'zod';
import { ACCOUNT_GROUPS, ACCOUNT_TYPES, ASSET_TYPES, accountBalanceHistoryQuery, queryString, uuid } from '@nuggets/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPath } from '../client.js';
import { registerTool, type ToolContext } from './helpers.js';

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'list_accounts',
    title: 'List accounts',
    description: 'Return all accounts with their current Nuggets balances.',
    inputSchema: {},
    readOnly: true,
    handler: async (_args, { client }) => client.get('/api/accounts'),
  });

  registerTool(server, ctx, {
    name: 'get_account',
    title: 'Get account',
    description: 'Fetch a single account by UUID.',
    inputSchema: { uuid },
    readOnly: true,
    handler: async ({ uuid }, { client }) => client.get(apiPath`/api/accounts/${uuid}`),
  });

  registerTool(server, ctx, {
    name: 'get_account_balance',
    title: 'Get account balance',
    description: 'Return the current Nuggets balance for an account: the sum of its transactions (the opening balance is a starting-balance transaction). `balance` is null with `balance_unavailable: true` when it could not be computed.',
    inputSchema: { uuid },
    readOnly: true,
    handler: async ({ uuid }, { client }) => client.get(apiPath`/api/accounts/${uuid}/balance`),
  });

  registerTool(server, ctx, {
    name: 'get_account_balance_history',
    title: 'Account balance history',
    description: 'Return month-end balances for an account (newest first, starting with today), computed from its transactions, for trend questions. limit = number of points (max 120).',
    inputSchema: {
      uuid,
      limit: z.coerce.number().int().min(1).max(500).optional(),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get(apiPath`/api/accounts/${args.uuid}/balance-history`, queryString(accountBalanceHistoryQuery, { limit: args.limit })),
  });

  registerTool(server, ctx, {
    name: 'set_account_instructions',
    title: 'Set account AI instructions',
    description:
      'Record free-form context on an account for future AI-agent reads. Distinct from the user-facing `notes` field. Pass null to clear. ' +
      'Use this to make statement→account routing deterministic: store a broker sub-account identifier or goal name (e.g. a goal id at a robo-advisor) here, then map each statement section to the account whose instructions carry the matching id. One Nuggets account per broker goal/sub-account.',
    inputSchema: {
      uuid,
      instructions: z.string().nullable().describe('Free-form instructions text, or null to clear.'),
    },
    destructive: true,
    handler: async (args, { client }) =>
      client.put(apiPath`/api/accounts/${args.uuid}/instructions`, { instructions: args.instructions }),
  });

  registerTool(server, ctx, {
    name: 'create_account',
    title: 'Create account',
    description:
      'Create a new account (e.g. when importing data for an account that does not exist yet — one Nuggets account per real-world account/broker goal). ' +
      'Required: name, accountType. category is Asset|Liability (defaults Asset); accountGroup groups it in lists (defaults cash). ' +
      'initialBalance creates a starting-balance transaction. Set instructions to give future agents routing/context for this account.',
    inputSchema: {
      name: z.string().min(1).max(255),
      category: z.enum(ASSET_TYPES).optional().describe('Balance-sheet side. Defaults to Asset.'),
      accountType: z.enum(ACCOUNT_TYPES)
        .describe('Asset types: checking, savings, investment, business, cash, other. Liability types: credit_card, loan, mortgage, line_of_credit.'),
      // Not the legacy 'credit_cards' spelling, which only older rows hold.
      accountGroup: z.enum(ACCOUNT_GROUPS).exclude(['credit_cards']).optional()
        .describe('Grouping used by account lists. Defaults to cash.'),
      initialBalance: z.coerce.number().optional().describe('Starting balance; recorded as a starting-balance transaction. Defaults to 0.'),
      notes: z.string().optional().describe('User-facing notes.'),
      instructions: z.string().optional().describe('Free-form context for AI agents (same field set_account_instructions writes).'),
      icon: z.string().optional().describe('Lucide icon name. Defaults to CreditCard.'),
    },
    destructive: false,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {
        name: args.name,
        account_type: args.accountType,
      };
      if (args.category !== undefined) body.type = args.category;
      if (args.accountGroup !== undefined) body.account_group = args.accountGroup;
      if (args.initialBalance !== undefined) body.initial_balance = args.initialBalance;
      if (args.notes !== undefined) body.notes = args.notes;
      if (args.instructions !== undefined) body.instructions = args.instructions;
      if (args.icon !== undefined) body.icon = args.icon;
      return client.post('/api/accounts', body);
    },
  });

  registerTool(server, ctx, {
    name: 'adjust_account_balance',
    title: 'Adjust account balance',
    description:
      'Set an account\'s CURRENT balance to a target value: the backend computes the difference and records a balance-adjustment transaction (no-op if it already matches). ' +
      'Use after reconciling against a statement. For a HISTORICAL (dated) adjustment, use create_transaction with type "balance adjustment", a signed amount, and the transactionDate instead.',
    inputSchema: {
      uuid,
      targetBalance: z.coerce.number().describe('The balance the account should show right now (signed; liabilities are typically negative).'),
    },
    destructive: false,
    handler: async (args, { client }) =>
      client.post(apiPath`/api/accounts/${args.uuid}/adjust-balance`, { targetBalance: args.targetBalance }),
  });
}
