import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpHandler } from '../src/httpHandler.js';
import { makeFetchStub, registeredTools } from './harness.js';

/**
 * The MCP HTTP transport, as the backend mounts it (express.json() in front, the handler
 * at a path): POST / speaks JSON-RPC over the SDK's Streamable HTTP transport.
 */

// Lets a test make building the per-request MCP server throw, as an SDK fault would.
const serverFault = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('../src/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server.js')>();
  return {
    ...actual,
    createMcpServer: (opts: Parameters<typeof actual.createMcpServer>[0]) => {
      if (serverFault.error) throw serverFault.error;
      return actual.createMcpServer(opts);
    },
  };
});

const logger = { warn: vi.fn(), error: vi.fn() };
let api = makeFetchStub();
let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // The backend's request logger (pino-http) gives each request an id.
  app.use((req, _res, next) => {
    (req as express.Request & { id?: string }).id = 'req-7';
    next();
  });
  app.use(
    '/api/mcp',
    createMcpHttpHandler({
      baseUrl: 'http://api.local',
      // The stub is replaced per test; the handler keeps this indirection.
      fetchImpl: ((...args: Parameters<typeof fetch>) => api.fetchImpl(...args)) as typeof fetch,
      logger,
    }) as express.RequestHandler
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  api = makeFetchStub();
  serverFault.error = null;
  logger.warn.mockClear();
  logger.error.mockClear();
});

const rpc = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer pat' }) =>
  fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });

describe('the HTTP transport', () => {
  const connect = async (headers: Record<string, string> = { Authorization: 'Bearer pat' }) => {
    const client = new Client({ name: 'nuggets-transport-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers } }));
    return client;
  };
  const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { text: string }[])[0].text;

  it('answers a POST without an Authorization header 401, with no tool run', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } }, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing Authorization header' }, id: null });
    expect(api.calls).toHaveLength(0);
  });

  it('answers GET and DELETE 405: it is stateless, with no stream or session', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(base, { method, headers: { authorization: 'Bearer pat', accept: 'application/json, text/event-stream' } });
      expect(res.status, method).toBe(405);
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32000);
    }
  });

  it('lets an MCP client connect, read the instructions and list every tool with its hints', async () => {
    const client = await connect();
    try {
      expect(client.getInstructions()).toContain('{"untrusted": ...}');
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...registeredTools(api.fetchImpl).keys()].sort());
      for (const tool of tools) {
        const a = tool.annotations ?? {};
        expect(a.readOnlyHint === true || (a.readOnlyHint === false && typeof a.destructiveHint === 'boolean'), tool.name).toBe(true);
      }
      const resolve = tools.find((t) => t.name === 'resolve_annotation')!;
      expect(resolve.inputSchema.properties?.uuid).toMatchObject({ type: 'string', format: 'uuid' });
    } finally {
      await client.close();
    }
  });

  it('runs a tool end to end: the API call carries the caller’s token, the answer comes back', async () => {
    api = makeFetchStub([{ uuid: '019a3b2c-1d2e-7f00-8a00-000000000001', name: 'Checking', notes: 'Joint account' }]);
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(text(result))).toEqual([
        { uuid: '019a3b2c-1d2e-7f00-8a00-000000000001', name: 'Checking', notes: { untrusted: 'Joint account' } },
      ]);
      expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET http://api.local/api/accounts']);
      expect(api.calls[0].headers.authorization).toBe('Bearer pat');
    } finally {
      await client.close();
    }
  });

  it('parses arguments with the tool’s schema: coerces a number sent as a string, refuses a path for a uuid', async () => {
    const client = await connect();
    try {
      const uuid = '019a3b2c-1d2e-7f00-8a00-000000000006';
      const classified = await client.callTool({ name: 'classify_transaction', arguments: { uuid, budgetItemId: '155' } });
      expect(classified.isError).toBeFalsy();
      expect(api.calls[0]).toMatchObject({ method: 'PUT', url: `http://api.local/api/transactions/${uuid}`, body: { budget_item_id: 155 } });

      const refused = await client.callTool({ name: 'resolve_annotation', arguments: { uuid: '../admin/users/x/deployment-admin' } });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/Input validation error/);
      expect(api.calls).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('hands the API’s refusal back as the tool’s error, as a read-only token gets it', async () => {
    api = makeFetchStub({ status: 403, body: { code: 'TOKEN_READ_ONLY', error: 'This token is read-only, so it cannot make changes.' } });
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'create_category', arguments: { name: 'Food', icon: 'Utensils' } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(text(result))).toMatchObject({ status: 403, code: 'TOKEN_READ_ONLY' });
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});

describe('MCP-layer failures are logged with the request id', () => {
  it('logs a request the transport couldn’t handle, and answers without the error’s text', async () => {
    serverFault.error = new Error('connect ECONNREFUSED 10.0.0.5:5432 (internal detail)');
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal MCP error' }, id: null });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatchObject({ requestId: 'req-7', err: serverFault.error });
  });

  it('logs a tool call that failed in the MCP layer, with the tool and request id', async () => {
    api = { calls: [], fetchImpl: vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch };
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatchObject({ tool: 'list_accounts', requestId: 'req-7' });
  });

  it('sends the request id on the tools’ API calls, so the API’s logs of them carry it', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } });
    expect(res.status).toBe(200);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].headers['x-request-id']).toBe('req-7');
    expect(api.calls[0].headers.authorization).toBe('Bearer pat');
  });
});
