import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { INT4_MAX, merchantPageQuery, merchantRuleMethod, merchantSearchQuery, queryString } from '@nuggets/shared';
import { apiPath } from '../client.js';
import { registerTool, type ToolContext } from './helpers.js';

const ruleMethods = merchantRuleMethod.options;

export function registerMerchantTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'list_merchants',
    title: 'List merchants (paginated)',
    description:
      'Return a paginated page of merchants with their transaction and rule counts. The merchant table can be large; this tool always paginates (default 50, max 100 per page) and returns `{ merchants, pagination: { total, totalPages, page, limit } }`. Use `search` to substring-match name / website / notes if you’re hunting for a specific merchant rather than browsing. Pass `lite: true` to skip the transaction/rule counts (id, uuid, name, website, image only) — faster when you just need id→name.',
    inputSchema: {
      page: z.coerce.number().int().min(1).optional().describe('1-indexed page. Defaults to 1.'),
      limit: z.coerce.number().int().min(1).max(100).optional().describe('Max 100. Defaults to 50.'),
      search: z.string().optional().describe('Substring match against merchant name, website, or notes.'),
      lite: z.boolean().optional().describe('Skip the (expensive) transaction_count / rule_count aggregation; return id, uuid, name, website, image only.'),
    },
    readOnly: true,
    // A merchant made from a bank's payee is named by it.
    untrustedFields: ['name'],
    handler: async (args, { client }) =>
      client.get(
        '/api/merchants/paginated',
        queryString(merchantPageQuery, {
          page: args.page ?? 1,
          limit: args.limit ?? 50,
          search: args.search,
          fields: args.lite ? 'lite' : undefined,
        })
      ),
  });

  registerTool(server, ctx, {
    name: 'search_merchants',
    title: 'Search merchants by name (autocomplete-style)',
    description:
      'Lightweight name-only search; faster and slimmer than list_merchants for "find me a merchant by approximate name" lookups.',
    inputSchema: {
      // The route answers its own number of matches; it reads no limit.
      q: z.string().min(1),
    },
    readOnly: true,
    // A merchant made from a bank's payee is named by it.
    untrustedFields: ['name'],
    handler: async (args, { client }) => client.get('/api/merchants/search', queryString(merchantSearchQuery, { q: args.q })),
  });

  registerTool(server, ctx, {
    name: 'get_merchant',
    title: 'Get merchant',
    description: 'Fetch a single merchant by UUID.',
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    // A merchant made from a bank's payee is named by it.
    untrustedFields: ['name'],
    handler: async ({ uuid }, { client }) => client.get(apiPath`/api/merchants/${uuid}`),
  });

  registerTool(server, ctx, {
    name: 'create_merchant',
    title: 'Create merchant',
    description: 'Create a new merchant. Name must be unique (case-insensitive).',
    inputSchema: {
      name: z.string().min(1).max(255),
      website: z.string().optional(),
      accountId: z.string().optional().describe('Optional external account id at the merchant.'),
      notes: z.string().optional().describe('User-facing notes.'),
      instructions: z.string().optional().describe('Free-form context for AI agents. Distinct from user-facing notes; the agent reads this when working with the merchant.'),
    },
    destructive: false,
    handler: async (args, { client }) =>
      client.post('/api/merchants', {
        name: args.name,
        merchant_website: args.website,
        merchant_accountid: args.accountId,
        notes: args.notes,
        instructions: args.instructions,
      }),
  });

  registerTool(server, ctx, {
    name: 'update_merchant',
    title: 'Update merchant',
    description:
      'Update an existing merchant. Only fields you supply will be changed; everything else stays as-is. The backend’s PUT replaces every column unconditionally, so this tool first GETs the current merchant and merges your changes on top before sending the PUT. That avoids wiping fields like merchant_image to NULL when you only meant to rename.',
    inputSchema: {
      uuid: z.string().uuid(),
      name: z.string().min(1).max(255).optional(),
      website: z.string().optional(),
      accountId: z.string().optional(),
      notes: z.string().optional(),
      instructions: z.string().nullable().optional().describe('Free-form context for AI agents (replaces any existing instructions; pass null to clear).'),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const current = await client.get<{
        name?: string;
        merchant_website?: string | null;
        merchant_accountid?: string | null;
        merchant_image?: string | null;
        notes?: string | null;
        instructions?: string | null;
        transaction_auto_tag_id?: number | null;
      }>(apiPath`/api/merchants/${args.uuid}`);

      const body: Record<string, unknown> = {
        // Start from the current row so unsent fields preserve their value.
        name: args.name ?? current.name,
        merchant_website: args.website !== undefined ? args.website : current.merchant_website,
        merchant_accountid: args.accountId !== undefined ? args.accountId : current.merchant_accountid,
        merchant_image: current.merchant_image,
        notes: args.notes !== undefined ? args.notes : current.notes,
        instructions: args.instructions !== undefined ? args.instructions : current.instructions,
      };
      if (current.transaction_auto_tag_id !== undefined && current.transaction_auto_tag_id !== null) {
        body.transaction_auto_tag_id = current.transaction_auto_tag_id;
      }

      return client.put(apiPath`/api/merchants/${args.uuid}`, body);
    },
  });

  registerTool(server, ctx, {
    name: 'list_merchant_rules',
    title: 'List merchant matching rules',
    description: 'Return the auto-match rules for a merchant.',
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ uuid }, { client }) => client.get(apiPath`/api/merchants/${uuid}/rules`),
  });

  registerTool(server, ctx, {
    name: 'create_merchant_rule',
    title: 'Create merchant matching rule',
    description:
      'Add an auto-match rule so future imported transactions get linked to this merchant. Rules evaluate against the provider\'s pre-cleaned PAYEE when the transaction has one (import_payee, e.g. "Sample Mart"), and against the raw description only when it doesn\'t — author matchingText against the payee for bank-synced accounts. Note a rule is often unnecessary: a payee that exactly equals the merchant\'s name auto-matches without one. Useful to offer after classifying a transaction for the first time.',
    inputSchema: {
      uuid: z.string().uuid(),
      method: z.enum(ruleMethods),
      matchingText: z.string().min(1),
    },
    destructive: false,
    handler: async (args, { client }) =>
      client.post(apiPath`/api/merchants/${args.uuid}/rules`, {
        method: args.method,
        matching_text: args.matchingText,
      }),
  });

  registerTool(server, ctx, {
    name: 'update_merchant_rule',
    title: 'Update merchant matching rule',
    description:
      'Change the method and/or matching text on an existing merchant rule. The backend requires both fields even for partial updates, so supply both.',
    inputSchema: {
      ruleUuid: z.string().uuid().describe('The matching rule’s uuid (from list_merchant_rules).'),
      method: z.enum(ruleMethods),
      matchingText: z.string().min(1),
    },
    destructive: true,
    handler: async (args, { client }) =>
      client.put(apiPath`/api/merchants/rules/${args.ruleUuid}`, {
        method: args.method,
        matching_text: args.matchingText,
      }),
  });

  registerTool(server, ctx, {
    name: 'delete_merchant_rule',
    title: 'Delete merchant matching rule',
    description:
      'Remove a merchant matching rule. Does not affect transactions already linked to the merchant; only stops future auto-matching on that pattern.',
    inputSchema: {
      ruleUuid: z.string().uuid(),
    },
    destructive: true,
    handler: async ({ ruleUuid }, { client }) =>
      client.request('DELETE', apiPath`/api/merchants/rules/${ruleUuid}`),
  });

  registerTool(server, ctx, {
    name: 'test_merchant_rules',
    title: 'Preview merchant-rule matches',
    description: 'Preview which existing transactions would be matched by a merchant’s rules, without applying. Rules match each transaction’s import_payee when set, otherwise its description (same signal the import sync uses).',
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ uuid }, { client }) => client.post(apiPath`/api/merchants/${uuid}/test-rules`),
  });

  registerTool(server, ctx, {
    name: 'apply_merchant_rules',
    title: 'Apply merchant rules to transactions',
    description:
      'Give the merchant the existing transactions named by `transactionIds`, setting their merchant_id: the ids test_merchant_rules lists as matching its rules. Only the transactions sent change.',
    inputSchema: {
      uuid: z.string().uuid(),
      // At most INT4_MAX, the largest id: a larger one names no transaction, refused here.
      transactionIds: z.array(z.coerce.number().int().positive().max(INT4_MAX)).min(1).describe('Transaction ids, from test_merchant_rules.'),
    },
    destructive: true,
    // The route takes the ids to give the merchant (merchantApplyRulesSchema): a call without them was refused.
    handler: async ({ uuid, transactionIds }, { client }) =>
      client.post(apiPath`/api/merchants/${uuid}/apply-rules`, { transactionIds }),
  });

  registerTool(server, ctx, {
    name: 'merge_merchants',
    title: 'Merge one merchant into another',
    description:
      'Merge the source merchant into the target merchant. All transactions, budget items, recurring items, and matching rules pointing at the source are moved onto the target; duplicate matching rules are collapsed; and the source merchant is then DELETED. Use this to consolidate duplicate merchants (e.g. "Example Grocer" + "EXAMPLE GROCER STORE 123" into one). The operation is transactional — either everything moves and the source is gone, or nothing changes. Irreversible; prefer renaming over merging if you’re unsure.',
    inputSchema: {
      sourceUuid: z.string().uuid().describe('The merchant that will be deleted. Its references are migrated to the target.'),
      targetUuid: z.string().uuid().describe('The merchant that survives and inherits everything from source.'),
    },
    destructive: true,
    handler: async ({ sourceUuid, targetUuid }, { client }) => {
      if (sourceUuid === targetUuid) {
        throw new Error('sourceUuid and targetUuid must differ — cannot merge a merchant with itself.');
      }
      return client.post(apiPath`/api/merchants/${sourceUuid}/merge`, {
        targetMerchantUuid: targetUuid,
      });
    },
  });
}
