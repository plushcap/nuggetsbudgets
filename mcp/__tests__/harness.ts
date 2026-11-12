import { vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NuggetsApiClient } from '../src/client.js';
import { registerAllTools } from '../src/tools/index.js';
import type { McpLogger } from '../src/tools/helpers.js';

/**
 * Test harness for the MCP tools: runs each tool's handler against a stubbed fetch and
 * records the requests its API client sends.
 *
 * The tools are read as registerAllTools registers them, through McpServer.registerTool's
 * public signature (name, config, callback), not the SDK's private registry, so an SDK
 * upgrade can't break the harness unnoticed. httpHandler.test.ts covers the same tools
 * through the real SDK server and transport.
 */

export const BASE_URL = 'http://test.local';
export const AUTHORIZATION = 'Bearer test-token';

export interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** The request options NuggetsApiClient passes to fetch. */
interface ClientRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

export interface RegisteredTool {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema: ZodRawShape;
    annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
  };
  callback: (args: unknown, extra: object) => Promise<ToolResult>;
}

/** A stubbed API answer: the JSON body, or a status and body for an error. */
export type StubResponse = unknown | { status: number; body: unknown };

const isStatusResponse = (r: unknown): r is { status: number; body: unknown } =>
  !!r && typeof r === 'object' && 'status' in r && typeof (r as { status: unknown }).status === 'number' && 'body' in r;

/**
 * A fetch stub that records every request. `response` is the body each call answers with,
 * or a function of the call (and its index) for answers that differ by call.
 */
export function makeFetchStub(response: StubResponse | ((call: CapturedCall, index: number) => StubResponse) = { ok: true }) {
  const calls: CapturedCall[] = [];
  const fetchImpl = vi.fn(async (input: string, init?: ClientRequestInit) => {
    const call: CapturedCall = {
      url: input,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = typeof response === 'function' ? response(call, calls.length - 1) : response;
    const { status, body } = isStatusResponse(answer) ? answer : { status: 200, body: answer };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** Every registered tool, by name, with its API client calling `fetchImpl`. */
export function registeredTools(fetchImpl: typeof fetch, logger?: McpLogger): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const recorder = {
    registerTool(name: string, config: RegisteredTool['config'], callback: RegisteredTool['callback']) {
      tools.set(name, { name, config, callback });
    },
  };
  const client = new NuggetsApiClient({ baseUrl: BASE_URL, authorization: AUTHORIZATION, fetchImpl });
  registerAllTools(recorder as unknown as McpServer, { client, logger, requestId: 'test-request-id' });
  return tools;
}

function toolNamed(fetchImpl: typeof fetch, toolName: string, logger?: McpLogger): RegisteredTool {
  const tool = registeredTools(fetchImpl, logger).get(toolName);
  if (!tool) throw new Error(`No tool named ${toolName}`);
  return tool;
}

/** A tool's input schema, as the SDK parses arguments with it. */
export const inputSchemaOf = (tool: RegisteredTool) => z.object(tool.config.inputSchema);

/** Call a tool's handler with `args` as given, skipping its input schema. */
export async function callTool(fetchImpl: typeof fetch, toolName: string, args: Record<string, unknown>, logger?: McpLogger) {
  return toolNamed(fetchImpl, toolName, logger).callback(args, {});
}

/**
 * Like callTool, but first validates/coerces args through the tool's registered Zod input
 * schema, the parse the MCP SDK runs before dispatch (it throws where the SDK would refuse
 * the call). Use this to test input coercion (e.g. stringified numeric ids from an LLM).
 */
export async function callToolValidated(fetchImpl: typeof fetch, toolName: string, args: Record<string, unknown>) {
  const tool = toolNamed(fetchImpl, toolName);
  return tool.callback(inputSchemaOf(tool).parse(args), {});
}

/** A request as tests compare it: method, path, query and body. */
export function describeCall(call: CapturedCall) {
  const url = new URL(call.url);
  return {
    method: call.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body: call.body,
  };
}

/** The JSON a tool returned. */
export const resultJson = (result: ToolResult): unknown => JSON.parse(result.content[0].text);
