import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { extractAuthorization } from './auth.js';
import type { McpLogger } from './tools/helpers.js';

export type { McpLogger } from './tools/helpers.js';

/**
 * Minimal structural handler type — intentionally does NOT reference
 * @types/express from inside this package, so consumers that also install
 * @types/express don’t collide on duplicate type identities.
 * Matches the shape of an Express middleware / Router.
 */
export type McpRequestHandler = (req: unknown, res: unknown, next?: unknown) => unknown;

export interface CreateMcpHttpHandlerOptions {
  /**
   * Base URL the MCP tools use for the Nuggets REST API.
   * Typically http://localhost:<port> when the MCP server is mounted inside
   * the same Express process as the API it calls.
   */
  baseUrl: string;

  /** Optional fetch override (used in tests). */
  fetchImpl?: typeof fetch;

  /**
   * Where MCP-layer failures are logged, with the request's id: a request
   * the transport couldn't handle, and a tool call that failed other than by the API's
   * own answer. Without one they go unlogged.
   */
  logger?: McpLogger;
}

/** The request's id: the one the host's request logger gave it (pino-http's req.id), else x-request-id. */
function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id ?? req.headers['x-request-id'];
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

/**
 * Build an Express router that serves MCP requests at POST /.
 *
 * Stateless mode: a fresh McpServer + transport is created for every request
 * so that each tool invocation runs with the inbound user’s Bearer token.
 * No session state lives inside the MCP layer — the backend REST API is the
 * source of truth.
 *
 * The router assumes an auth-enforcing middleware is mounted in front of it
 * (the caller mounts it behind `authenticateToken`). This handler only reads
 * the Authorization header to pass through to the REST client.
 */
/**
 * Return a plain Express RequestHandler so consumers of this package don’t
 * pick up a second copy of @types/express that fights with their own.
 */
export function createMcpHttpHandler(opts: CreateMcpHttpHandlerOptions): McpRequestHandler {
  const router = express.Router();

  router.post('/', async (req: Request, res: Response) => {
    const authorization = extractAuthorization(req);
    if (!authorization) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing Authorization header' },
        id: null,
      });
      return;
    }

    const requestId = requestIdOf(req);
    let server: ReturnType<typeof createMcpServer> | undefined;
    let transport: StreamableHTTPServerTransport | undefined;

    res.on('close', () => {
      transport?.close().catch(() => undefined);
      server?.close().catch(() => undefined);
    });

    try {
      server = createMcpServer({
        baseUrl: opts.baseUrl,
        authorization,
        fetchImpl: opts.fetchImpl,
        logger: opts.logger,
        requestId,
      });
      transport = new StreamableHTTPServerTransport({
        // No sessionIdGenerator: stateless mode, a fresh transport per request.
        enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      opts.logger?.error({ err, requestId }, 'MCP request failed');
      if (!res.headersSent) {
        // The error's own text can name internals; the log has it.
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal MCP error' },
          id: null,
        });
      }
    }
  });

  // GET and DELETE are not supported in stateless mode; respond with a clear
  // error so clients don’t hang waiting for a stream we’ll never open.
  router.get('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'This MCP server is stateless; use POST.' },
      id: null,
    });
  });

  router.delete('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'This MCP server is stateless; no session to terminate.' },
      id: null,
    });
  });

  return router as unknown as McpRequestHandler;
}
