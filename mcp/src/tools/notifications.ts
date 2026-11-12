import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { notificationFacts, notificationRulesSchema, setNotificationPreferencesRequestSchema } from '@nuggets/shared';
import { registerTool, type ToolContext } from './helpers.js';

const factList = Object.entries(notificationFacts)
  .map(([kind, facts]) => {
    const described = Object.entries(facts).map(([fact, type]) =>
      'values' in type ? `${fact} (one of ${type.values.join(', ')})` : `${fact} (${type.type})`
    );
    return `${kind}: ${described.join(', ')}`;
  })
  .join('. ');

const describesRules =
  'A tenant has up to 20 notification rules. Each has a unique `key` (lower case letters, digits, underscores), a `label` people see, `enabled`, ' +
  '`sendBy` ("both", "email" or "push": the channels the rule may use; each person can narrow it further but never add one; defaults to "both"), and a `kind`: ' +
  '"budget_item" (a budget item in the current period whose figures match `when`; once per item per period), ' +
  '"transaction" (a transaction added in the last week that matches `when`; `audience` "everyone" or "assignee"), ' +
  '"review_reminder" (a nudge to each person with transactions assigned to them that need review, while `when` holds, from `hour` 0-23 in the application time zone, at most once every `everyDays` days, 1-30), ' +
  'or "digest" (a weekly summary on `weekday` 1=Monday..7=Sunday at `hour` 0-23 in the application time zone; no `when`). ' +
  '`when` is a condition: {"all": [...]}, {"any": [...]}, {"not": {...}}, or a comparison of one fact: ' +
  '{"fact": f, "is": value}, {"fact": f, "in": [values]}, {"fact": f, "lt"|"lte"|"gt"|"gte": number} for number facts, ' +
  'or {"fact": f, "hasWords": ["phrase", ...]} for text facts (whole words, any case). Nest at most eight deep. ' +
  'Money facts are amounts in the tenant’s currency (get_general_settings), positive except a transaction’s signed `amount`. ' +
  `Facts by kind: ${factList}. ` +
  'Example: a purchase of 500 or more at Sample Wholesale is {"all": [{"fact": "direction", "is": "out"}, {"fact": "size", "gte": 500}, {"fact": "merchant", "hasWords": ["sample wholesale"]}]}.';

/**
 * Notification rule tools: the active tenant's rules (what Nuggets tells its
 * members about) and the caller's own choice of how each reaches them.
 * Changing the rules needs a tenant admin; the API enforces it.
 */
export function registerNotificationTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'get_notification_rules',
    title: 'Get notification rules',
    description: `Return the active tenant's notification rules (its saved ones, or the defaults). ${describesRules}`,
    inputSchema: {},
    readOnly: true,
    handler: async (_args, { client }) => client.get('/api/notifications/rules'),
  });

  registerTool(server, ctx, {
    name: 'set_notification_rules',
    title: 'Replace notification rules',
    description:
      `Replace ALL of the active tenant's notification rules with \`rules\` (read them first with get_notification_rules and send the full edited list; a rule left out stops). ` +
      'Needs a tenant admin. Give a new rule a new key: people’s choices are kept by key. Returns the saved rules, or a 400 naming each problem and where it is. ' +
      describesRules,
    inputSchema: { rules: notificationRulesSchema.shape.rules },
    destructive: true,
    handler: async ({ rules }, { client }) => client.put('/api/notifications/rules', { rules }),
  });

  registerTool(server, ctx, {
    name: 'get_my_notification_preferences',
    title: 'Get my notification preferences',
    description:
      'Return each enabled notification rule of the active tenant with the channels it sends by (`sendBy`) and whether the caller wants it by email and by push (phone/browser); a channel only counts when the rule sends by it. `emailAvailable` is false while no email server is set up.',
    inputSchema: {},
    readOnly: true,
    handler: async (_args, { client }) => client.get('/api/notifications/preferences'),
  });

  registerTool(server, ctx, {
    name: 'set_my_notification_preferences',
    title: 'Set my notification preferences',
    description:
      'Turn email and/or push on or off for some of the active tenant’s notification rules, for the caller only. `rules` is a list of { rule: <rule key>, email?: boolean, push?: boolean }; a channel left out keeps its current setting. Refuses a rule key the tenant doesn’t have. Returns the caller’s preferences.',
    inputSchema: { rules: setNotificationPreferencesRequestSchema.shape.rules },
    destructive: true,
    handler: async ({ rules }, { client }) => client.put('/api/notifications/preferences', { rules }),
  });
}
