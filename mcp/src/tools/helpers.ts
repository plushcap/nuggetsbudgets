import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { QueryStringError } from '@nuggets/shared';
import { NuggetsApiClient, NuggetsApiError } from '../client.js';

/** The logging the MCP layer needs (pino's signature), so it can log through the host's logger. */
export interface McpLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ToolContext {
  client: NuggetsApiClient;
  /** Where tool failures that aren't the API's own answer are logged. */
  logger?: McpLogger | undefined;
  /** The inbound MCP request's id, for those logs. */
  requestId?: string | undefined;
}

export type ToolHandler<Args> = (args: Args, ctx: ToolContext) => Promise<unknown>;

/** A tool's arguments: what its input schema parses to. */
export type ToolArgs<Shape extends ZodRawShape> = { [K in keyof Shape]: z.infer<Shape[K]> };

/**
 * What a tool does to the ledger, which every tool states and clients
 * read from its annotations: `readOnly: true` for a tool that changes nothing; otherwise
 * `destructive`, true when it may change or remove what's there (an update, a delete, a
 * merge, a replace) and false when it only adds (a create, a record, a reply). MCP clients
 * take a write tool that doesn't say as destructive.
 */
type ToolEffect = { readOnly: true; destructive?: undefined } | { readOnly?: false; destructive: boolean };

export type ToolDefinition<Shape extends ZodRawShape> = ToolEffect & {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  /**
   * Fields of this tool's result, besides UNTRUSTED_FIELDS, whose text people outside the
   * household can write (a merchant's `name`, which a bank's payee can create).
   */
  untrustedFields?: readonly string[];
  handler: ToolHandler<ToolArgs<Shape>>;
};

/**
 * Result fields whose text can come from outside the household: a bank's or card network's
 * transaction text (description, payee, memo, which lands in `notes`, and the raw import
 * fields), the merchant names made from it, and annotation bodies. A tool's result carries
 * each as `{ "untrusted": <value> }`, and the server's instructions tell the model that
 * what's inside is data, never instructions. The tools themselves read
 * the API's answers unwrapped; only what the model sees is marked.
 */
export const UNTRUSTED_FIELDS: readonly string[] = [
  'description',
  'import_description',
  'import_payee',
  'import_extra',
  'notes',
  'merchant_name',
  'body',
];

/** `value` with every field named in `fields`, at any depth, wrapped as `{ untrusted }`. */
export function markUntrusted(value: unknown, fields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => markUntrusted(item, fields));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      fields.has(key) && field !== null && field !== undefined && field !== ''
        ? { untrusted: field }
        : markUntrusted(field, fields),
    ])
  );
}

function jsonContent(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

function errorContent(err: unknown) {
  // A query the route's own schema refused before the request (queryString):
  // the route's 400, as the caller would have had it, with its message.
  if (err instanceof QueryStringError) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({ status: 400, code: 'VALIDATION_ERROR', message: err.message }, null, 2) }],
    };
  }
  if (err instanceof NuggetsApiError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { status: err.status, code: err.code, message: err.message, body: err.body },
            null,
            2
          ),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: err instanceof Error ? err.message : String(err),
      },
    ],
  };
}

export function registerTool<Shape extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  def: ToolDefinition<Shape>
): void {
  const annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint?: boolean;
  } = { title: def.title, readOnlyHint: def.readOnly === true };
  if (def.readOnly !== true) annotations.destructiveHint = def.destructive;
  const untrusted = new Set([...UNTRUSTED_FIELDS, ...(def.untrustedFields ?? [])]);

  // The SDK types the callback by a conditional on the schema's type, which TypeScript
  // can't resolve for a generic Shape. Registered with the plain shape type instead, the
  // SDK passes the arguments it parsed with def.inputSchema: the handler's ToolArgs.
  const inputSchema: ZodRawShape = def.inputSchema;
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema,
      annotations,
    },
    async (args) => {
      try {
        const result = await def.handler(args as ToolArgs<Shape>, ctx);
        return jsonContent(markUntrusted(result ?? { ok: true }, untrusted));
      } catch (err) {
        // The API's own answers (a 404, a 403 for a read-only token) are the caller's to
        // read; anything else (the API unreachable, a refused path, a bug) is the operator's.
        if (!(err instanceof NuggetsApiError) && !(err instanceof QueryStringError)) {
          ctx.logger?.warn({ err, tool: def.name, requestId: ctx.requestId }, 'MCP tool call failed');
        }
        return errorContent(err);
      }
    }
  );
}
