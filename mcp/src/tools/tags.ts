import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TAG_REPORT_FLOW_MEASURES } from '@nuggets/shared';
import { apiPath } from '../client.js';
import { registerTool, type ToolContext } from './helpers.js';

/**
 * Tag tools.
 *
 * Tags in Nuggets are hierarchical (up to 4 levels deep). Each tag has a
 * uuid (used in URLs) AND a numeric id (used for parent_id references).
 * `list_tags` returns both, so when creating child tags an agent can pull the
 * parent's `id` from a previous list_tags call.
 *
 * Tag→transaction linking uses the UUID-based endpoint on the transactions
 * side (POST /api/transactions/:uuid/tags/:tagUuid), which is idempotent
 * (ON CONFLICT DO NOTHING). The same shape works for removal.
 *
 * REPORT NAMESPACES
 * Top-level tags can be marked as "report namespaces" via
 * `set_tag_report_root`. A namespace is the root tag plus its entire
 * descendant tree. A budget item may carry at most ONE tag per namespace
 * (enforced server-side). Use `set_budget_item_namespace_tag` to assign
 * a namespace tag — it replaces any existing namespace tagging in one call.
 *
 * GOALS ARE BUDGET ITEMS
 * After the December 2025 consolidation, a "goal" is just a budget item
 * with `goal_target_amount` set. To tag a goal, use the budget-item
 * tagging tools (`list_budget_item_tags`, `add_tag_to_budget_item`,
 * `remove_tag_from_budget_item`, `set_budget_item_namespace_tag`) with
 * the goal's uuid (returned by `list_goals`).
 */
export function registerTagTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'list_tags',
    title: 'List tags',
    description:
      'Return all tags with hierarchy info (level, parent, transaction count). Use this to find tag uuids before adding them to transactions, or to find parent ids before creating child tags.',
    inputSchema: {},
    readOnly: true,
    handler: async (_args, { client }) => client.get('/api/tags'),
  });

  registerTool(server, ctx, {
    name: 'get_tag',
    title: 'Get tag',
    description: 'Fetch a single tag by uuid, including hierarchy path and counts.',
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ uuid }, { client }) => client.get(apiPath`/api/tags/${uuid}`),
  });

  registerTool(server, ctx, {
    name: 'create_tag',
    title: 'Create tag',
    description:
      'Create a new tag. Only `name` is required. To create a child tag, supply the parent’s numeric `parentId` (from list_tags). Hierarchy is capped at 4 levels. Namespace/flow-measure flags are set separately via `set_tag_report_root`.',
    inputSchema: {
      name: z.string().min(1).max(100),
      color: z.string().optional().describe('Hex color, e.g. "#3B82F6". Defaults to a Nuggets blue.'),
      icon: z.string().optional().describe('Lucide icon name. Defaults to "Tag".'),
      description: z.string().optional(),
      parentId: z.coerce.number().int().optional().describe('Numeric id of the parent tag. Pull from list_tags.'),
      sortOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    },
    destructive: false,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = { name: args.name };
      if (args.color !== undefined) body.color = args.color;
      if (args.icon !== undefined) body.icon = args.icon;
      if (args.description !== undefined) body.description = args.description;
      if (args.parentId !== undefined) body.parent_id = args.parentId;
      if (args.sortOrder !== undefined) body.sort_order = args.sortOrder;
      if (args.isActive !== undefined) body.is_active = args.isActive;
      return client.post('/api/tags', body);
    },
  });

  registerTool(server, ctx, {
    name: 'update_tag',
    title: 'Update tag',
    description:
      'Update an existing tag. The backend’s PUT requires `name`, so this tool first GETs the current tag and merges your changes on top before sending the PUT — unsent fields stay as-is.',
    inputSchema: {
      uuid: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      color: z.string().optional(),
      icon: z.string().optional(),
      description: z.string().nullable().optional(),
      parentId: z.coerce.number().int().nullable().optional(),
      sortOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const current = await client.get<{
        name?: string;
        color?: string | null;
        icon?: string | null;
        description?: string | null;
        parent_id?: number | null;
        sort_order?: number | null;
        is_active?: boolean | null;
      }>(apiPath`/api/tags/${args.uuid}`);

      const body: Record<string, unknown> = {
        name: args.name ?? current.name,
        color: args.color !== undefined ? args.color : current.color,
        icon: args.icon !== undefined ? args.icon : current.icon,
        description: args.description !== undefined ? args.description : current.description,
        parent_id: args.parentId !== undefined ? args.parentId : current.parent_id,
        sort_order: args.sortOrder !== undefined ? args.sortOrder : current.sort_order,
        is_active: args.isActive !== undefined ? args.isActive : current.is_active,
      };

      return client.put(apiPath`/api/tags/${args.uuid}`, body);
    },
  });

  // -- Transaction tagging --

  registerTool(server, ctx, {
    name: 'list_transaction_tags',
    title: 'List tags on a transaction',
    description: 'Return all tags currently associated with a transaction.',
    inputSchema: { transactionUuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ transactionUuid }, { client }) =>
      client.get(apiPath`/api/tags/transaction/${transactionUuid}`),
  });

  registerTool(server, ctx, {
    name: 'add_tag_to_transaction',
    title: 'Tag a transaction',
    description:
      'Apply a tag to a transaction. Idempotent — calling it twice with the same pair is a no-op rather than an error.',
    inputSchema: {
      transactionUuid: z.string().uuid(),
      tagUuid: z.string().uuid(),
    },
    destructive: false,
    handler: async ({ transactionUuid, tagUuid }, { client }) =>
      client.post(apiPath`/api/transactions/${transactionUuid}/tags/${tagUuid}`),
  });

  registerTool(server, ctx, {
    name: 'remove_tag_from_transaction',
    title: 'Remove a tag from a transaction',
    description: 'Detach a tag from a transaction. No-op if the tag wasn’t attached.',
    inputSchema: {
      transactionUuid: z.string().uuid(),
      tagUuid: z.string().uuid(),
    },
    destructive: true,
    handler: async ({ transactionUuid, tagUuid }, { client }) =>
      client.request('DELETE', apiPath`/api/transactions/${transactionUuid}/tags/${tagUuid}`),
  });

  // -- Report namespaces --

  registerTool(server, ctx, {
    name: 'list_report_roots',
    title: 'List report-namespace tags',
    description:
      'Return all tags marked as report namespaces (is_report_root = true), with their flow measure, descendant count, and how many budget items are tagged inside the namespace. Use this to discover existing namespaces before tagging budget items or running a Sankey report.',
    inputSchema: {},
    readOnly: true,
    handler: async (_args, { client }) => client.get('/api/tags/report-roots'),
  });

  registerTool(server, ctx, {
    name: 'set_tag_report_root',
    title: 'Mark a tag as a report namespace (or unmark it)',
    description:
      'Set or unset a top-level tag as a report namespace root. Only level-0 tags (parent_id = null) qualify. Optionally set the flow measure: "actual" (transactions only), "allocated" (budget allocations only), or "effective" (hybrid, default — recommended).',
    inputSchema: {
      uuid: z.string().uuid(),
      isReportRoot: z.boolean(),
      reportFlowMeasure: z.enum(TAG_REPORT_FLOW_MEASURES).optional()
        .describe('Only meaningful when is_report_root = true. Defaults to "effective" on new namespaces.'),
    },
    destructive: true,
    handler: async ({ uuid, isReportRoot, reportFlowMeasure }, { client }) => {
      const body: Record<string, unknown> = { is_report_root: isReportRoot };
      if (reportFlowMeasure !== undefined) body.report_flow_measure = reportFlowMeasure;
      return client.put(apiPath`/api/tags/${uuid}/report-root`, body);
    },
  });

  // -- Budget-item tagging (covers goals too, since goals are budget_items) --

  registerTool(server, ctx, {
    name: 'list_budget_item_tags',
    title: 'List tags on a budget item (or goal)',
    description:
      'Return all tags currently applied to the given budget item, grouped by namespace via report_root_id / report_root_name. Goals are budget items — pass a goal\'s uuid to see its tags.',
    inputSchema: { budgetItemUuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ budgetItemUuid }, { client }) =>
      client.get(apiPath`/api/tags/budget-items/${budgetItemUuid}/tags`),
  });

  registerTool(server, ctx, {
    name: 'add_tag_to_budget_item',
    title: 'Add a tag to a budget item (or goal)',
    description:
      'Attach a tag to a budget item. For freeform (non-namespace) tags this is the right tool. For namespace tags, prefer `set_budget_item_namespace_tag` — this tool will fail with NAMESPACE_CONFLICT if the budget item already has a tag in the same report namespace. Pass a goal\'s uuid as `budgetItemUuid` to tag a goal.',
    inputSchema: {
      budgetItemUuid: z.string().uuid(),
      tagId: z.coerce.number().int().describe('Numeric id of the tag (from list_tags).'),
    },
    destructive: false,
    handler: async ({ budgetItemUuid, tagId }, { client }) =>
      client.post(apiPath`/api/tags/budget-items/${budgetItemUuid}/tags`, { tag_id: tagId }),
  });

  registerTool(server, ctx, {
    name: 'remove_tag_from_budget_item',
    title: 'Remove a tag from a budget item (or goal)',
    description:
      'Detach a specific tag from a budget item. Pass a goal\'s uuid as `budgetItemUuid` for goal taggings.',
    inputSchema: {
      budgetItemUuid: z.string().uuid(),
      tagId: z.coerce.number().int().describe('Numeric id of the tag to remove (from list_budget_item_tags).'),
    },
    destructive: true,
    handler: async ({ budgetItemUuid, tagId }, { client }) =>
      client.request('DELETE', apiPath`/api/tags/budget-items/${budgetItemUuid}/tags/${tagId}`),
  });

  registerTool(server, ctx, {
    name: 'set_budget_item_namespace_tag',
    title: 'Set or clear a budget item\'s tag within a report namespace',
    description:
      'Replace-or-clear the budget item\'s namespace-scoped tag in one call. Pass tagUuid = null to clear the existing namespace tag. The provided tag must descend from the given report root, or the call fails. PRIMARY TOOL for assigning namespace tags — handles the one-tag-per-namespace rule automatically. Works for goals (just pass the goal\'s uuid).',
    inputSchema: {
      budgetItemUuid: z.string().uuid(),
      rootTagUuid: z.string().uuid().describe('The report-namespace root tag\'s uuid (from list_report_roots).'),
      tagUuid: z.string().uuid().nullable().describe('Uuid of the tag to apply, or null to clear the namespace tag for this item.'),
    },
    destructive: true,
    handler: async ({ budgetItemUuid, rootTagUuid, tagUuid }, { client }) =>
      client.put(
        apiPath`/api/tags/budget-items/${budgetItemUuid}/namespace/${rootTagUuid}`,
        { tag_uuid: tagUuid }
      ),
  });
}
