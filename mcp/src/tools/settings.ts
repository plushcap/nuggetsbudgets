import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, type ToolContext } from './helpers.js';

/**
 * The active tenant's general settings, which say how to read the other tools' amounts and
 * dates: the tools' money is in its currency, and its days are in its time zone.
 */
export function registerSettingsTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'get_general_settings',
    title: 'Get general settings',
    description:
      "Return the active tenant's general settings, each as { setting_key, setting_value, setting_type, description }: " +
      'application_currency (the ISO 4217 code every amount the tools send and receive is in, such as USD or EUR; USD until set), ' +
      'application_locale (the BCP 47 locale its people write amounts in, such as en-US or de-DE), and application_timezone ' +
      '(the IANA zone that decides which day is today for its budget periods, bills and reports). Call it before stating an ' +
      'amount to a person, so it is named in the right currency.',
    inputSchema: {},
    readOnly: true,
    handler: async (_args, { client }) => client.get('/api/settings/general'),
  });
}
