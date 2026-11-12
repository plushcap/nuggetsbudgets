import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp, stdSerializers, type Options } from 'pino-http';
import logger, { pathOnly } from '../utils/logger.js';

/**
 * An inbound X-Request-Id we keep: up to 64 letters, digits and `._:-`. The MCP endpoint's
 * tool calls back into the API send theirs (mcp/src/client.ts), so one id covers both.
 * Anything else (too long, spaces, control characters a log viewer would render) is
 * replaced with an id of our own.
 */
const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The id of a request: its X-Request-Id when that is one we accept, else a new UUID. */
export function requestIdFor(header: string | string[] | undefined): string {
  const inbound = Array.isArray(header) ? header[0] : header;
  return typeof inbound === 'string' && ACCEPTED_REQUEST_ID.test(inbound) ? inbound : randomUUID();
}

/**
 * What a request line may say. Logs are read in Dozzle, by
 * anyone who can open it, so a line carries no query string (search terms, the OneDrive
 * callback's OAuth `code` and `state`), and only these headers: never a cookie, an
 * Authorization or CSRF header, or a Referer (a URL with its query).
 */
const LOGGED_REQUEST_HEADERS = ['host', 'user-agent', 'content-type', 'content-length', 'origin', 'x-forwarded-for', 'x-request-id'];
const LOGGED_RESPONSE_HEADERS = ['content-type', 'content-length'];

function pick(headers: unknown, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof headers !== 'object' || headers === null) return out;
  for (const name of names) {
    const value = (headers as Record<string, unknown>)[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

type SerializedRequest = {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: unknown;
  remoteAddress?: string;
  raw?: IncomingMessage & { originalUrl?: string; ip?: string };
};

/** The request as a log line shows it: method, path, a few headers, the client address. */
export function serializeRequest(req: SerializedRequest): Record<string, unknown> {
  const raw = req.raw;
  const headers = req.headers ?? raw?.headers;
  return {
    id: req.id,
    method: req.method ?? raw?.method,
    url: pathOnly(raw?.originalUrl ?? req.url ?? raw?.url),
    headers: pick(headers, LOGGED_REQUEST_HEADERS),
    remoteAddress: raw?.ip ?? req.remoteAddress,
  };
}

/** The response as a log line shows it: status and its type and length (never Set-Cookie). */
export function serializeResponse(res: { statusCode?: number; headers?: unknown; raw?: ServerResponse }): Record<string, unknown> {
  const headers = res.headers ?? res.raw?.getHeaders?.();
  return { statusCode: res.statusCode ?? res.raw?.statusCode, headers: pick(headers, LOGGED_RESPONSE_HEADERS) };
}

type RawRequest = IncomingMessage & { originalUrl?: string };
const describe = (req: RawRequest) => `${req.method} ${pathOnly(req.originalUrl ?? req.url)}`;

/** pino-http's options, apart from the logger (exported for the test that checks them). */
export const httpLoggerOptions: Omit<Options, 'logger'> = {
  // The request's id (req.id): middleware/requestScope.ts answers it as X-Request-Id and
  // puts it on every log line of the request.
  genReqId: (req) => requestIdFor(req.headers['x-request-id']),

  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },

  customSuccessMessage: (req, res) =>
    res.statusCode === 404 ? `${describe(req)} - Not Found` : `${describe(req)} - ${res.statusCode}`,
  customErrorMessage: (req, res) => `${describe(req)} - ${res.statusCode}`,

  customAttributeKeys: {
    req: 'request',
    res: 'response',
    err: 'error',
    responseTime: 'duration',
  },

  // The root logger's `redact` (utils/logger.ts) scrubs secrets that do get logged; these
  // keep the rest of a request out of the line in the first place.
  serializers: {
    req: serializeRequest,
    res: serializeResponse,
    err: stdSerializers.err,
  },

  // Don't log health check endpoints to reduce noise
  autoLogging: {
    ignore: (req) => {
      const path = pathOnly((req as RawRequest).originalUrl ?? req.url);
      return path === '/health' || path === '/api/health';
    },
  },
};

/**
 * HTTP request logging middleware using Pino: one line per request with its method,
 * path, status, duration, a few headers and its id.
 */
export const httpLogger = pinoHttp({ logger, ...httpLoggerOptions });

export default httpLogger;
