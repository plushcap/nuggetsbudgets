import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './helpers.js';
import { registerTaskTools } from './tasks.js';
import { registerTransactionTools } from './transactions.js';
import { registerMerchantTools } from './merchants.js';
import { registerBudgetItemTools } from './budget_items.js';
import { registerBudgetPeriodTools } from './budget_periods.js';
import { registerAccountTools } from './accounts.js';
import { registerGoalTools } from './goals.js';
import { registerTagTools } from './tags.js';
import { registerBudgetMatchingRuleTools } from './budget_matching_rules.js';
import { registerTransferTools } from './transfers.js';
import { registerInvestmentTools } from './investments.js';
import { registerAnnotationTools } from './annotations.js';
import { registerNotificationTools } from './notifications.js';
import { registerSettingsTools } from './settings.js';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerTaskTools(server, ctx);
  registerTransactionTools(server, ctx);
  registerMerchantTools(server, ctx);
  registerBudgetItemTools(server, ctx);
  registerBudgetPeriodTools(server, ctx);
  registerAccountTools(server, ctx);
  registerGoalTools(server, ctx);
  registerTagTools(server, ctx);
  registerBudgetMatchingRuleTools(server, ctx);
  registerTransferTools(server, ctx);
  registerInvestmentTools(server, ctx);
  registerAnnotationTools(server, ctx);
  registerNotificationTools(server, ctx);
  registerSettingsTools(server, ctx);
}
