import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calendarDay, transferCreateSchema } from '@nuggets/shared';
import { registerTool, type ToolContext } from './helpers.js';

/**
 * Transfers create two linked transactions in a single backend call:
 *   - Source account: negative `amount`
 *   - Destination account: positive `amount`
 *
 * The two rows reference each other via `transfer_transaction_id` so the UI
 * (and any future logic) can treat them as a pair.
 *
 * Type semantics:
 *   - `transfer` — moving your own money between accounts (e.g. checking → savings)
 *   - `payment`  — paying down a liability account (e.g. checking → credit card)
 *
 * The backend auto-creates / reuses a synthetic merchant
 * (`Transfer: <Destination Account>` or `Payment: <Destination Account>`) so
 * the pair shows up sensibly in transaction lists.
 */
export function registerTransferTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'create_transfer',
    title: 'Create a transfer or payment between accounts',
    description:
      'Move money between two accounts. Creates a pair of linked transactions: a negative on the source and a positive on the destination, both pre-marked reviewed. Use type "transfer" for moving your own money (checking → savings) and type "payment" for paying down a liability account (checking → credit card). The backend creates/reuses a synthetic merchant per destination so the pair groups together in lists. `amount` is always positive — the backend signs each side. Both pre-existing accounts must be different.',
    inputSchema: {
      sourceAccountUuid: z.string().uuid().describe('Account the money leaves from. Will receive a negative transaction.'),
      destinationAccountUuid: z.string().uuid().describe('Account the money lands in. Will receive a positive transaction.'),
      amount: z.coerce.number().positive().describe('Positive magnitude. Backend negates the source side automatically.'),
      transactionDate: calendarDay.describe('YYYY-MM-DD'),
      type: z.enum(transferCreateSchema.shape.type.options).describe('"transfer" between your own accounts; "payment" to pay down a liability.'),
      description: z.string().optional(),
      budgetPeriodUuid: z.string().uuid().optional().describe('Optional — attach both linked transactions to this budget period.'),
    },
    destructive: false,
    handler: async (args, { client }) => {
      if (args.sourceAccountUuid === args.destinationAccountUuid) {
        throw new Error('sourceAccountUuid and destinationAccountUuid must differ.');
      }
      const body: Record<string, unknown> = {
        source_account_uuid: args.sourceAccountUuid,
        destination_account_uuid: args.destinationAccountUuid,
        amount: args.amount,
        transaction_date: args.transactionDate,
        type: args.type,
      };
      if (args.description !== undefined) body.description = args.description;
      if (args.budgetPeriodUuid !== undefined) body.budget_period_uuid = args.budgetPeriodUuid;
      return client.post('/api/transfer', body);
    },
  });
}
