import pino from 'pino';
import { getCurrentTenantId, getCurrentUserId, getRequestScope } from '../context/requestContext.js';
import { config } from '../config.js';

/**
 * The fields that tie a log line to what caused it, read from the async context: the
 * HTTP request's id (`requestId`, also its X-Request-Id answer header), the signed-in
 * user (`userId`), and the tenant whose data it touches (`tenantId`; a background job's
 * per-tenant work has it too). Fields the call logs itself take precedence.
 */
export function logContext(): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const scope = getRequestScope();
  if (scope) fields.requestId = scope.requestId;
  const userId = scope?.userId ?? getCurrentUserId();
  if (userId !== undefined) fields.userId = userId;
  const tenantId = getCurrentTenantId();
  if (typeof tenantId === 'number') fields.tenantId = tenantId;
  return fields;
}

/**
 * Centralized logger for Nuggets application using Pino
 *
 * Features:
 * - JSON structured logging to stdout (captured by Docker's json-file driver
 *   and viewed in real time with Dozzle)
 * - Automatic log levels based on environment
 * - Pretty printing in development
 * - Built-in redaction of sensitive fields on every log line
 */

const isDevelopment = config().NODE_ENV !== 'production';
const logLevel = config().LOG_LEVEL;

/**
 * Field names that hold a secret wherever they appear in a logged object: at the top
 * level and up to three objects down (`err.config.headers.authorization`, a body's
 * `connection.access_url`), since pino's `*` matches one level only.
 */
const SECRET_KEYS = [
  'password', 'newPassword', 'currentPassword', 'password_hash',
  'token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'setup_token', 'setupToken',
  'accessUrl', 'access_url',
  'secret', 'clientSecret', 'client_secret', 'smtpPassword', 'apiKey', 'api_key',
  // A backup's file key (it opens that backup), the old backup key, and age private keys.
  'fileKey', 'encryptionKey', 'identity', 'identities',
  'authorization', 'cookie',
];
/** Headers that carry a credential, in any `headers` object (a request's, a response's, an HTTP client's). */
const SECRET_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-csrf-token', 'x-api-key', 'x-auth-token'];
const DEPTHS = ['', '*.', '*.*.', '*.*.*.'];

/** Every path pino redacts: each secret key and header at depths 0 to 3, and an OAuth callback's query. */
export const REDACT_PATHS: string[] = [
  ...SECRET_KEYS.flatMap((key) => DEPTHS.map((depth) => `${depth}${key}`)),
  ...SECRET_HEADERS.flatMap((header) => DEPTHS.map((depth) => `${depth}headers["${header}"]`)),
  'request.query.code',
  'request.query.state',
];

/**
 * A Postgres error's fields that carry row values or SQL: `detail` ("Failing row contains
 * (…)", with amounts and descriptions), `where` and `internalQuery`. Every `{ err }` line
 * leaves them out, its causes' included; the code, constraint and table stay.
 */
const PG_ROW_FIELDS = ['detail', 'where', 'internalQuery'] as const;

/** pino's error serializer, without {@link PG_ROW_FIELDS} on the error or any of its causes. */
export function serializeError(err: unknown): unknown {
  const out: unknown = pino.stdSerializers.err(err as Error);
  for (let node: unknown = out, depth = 0; node && typeof node === 'object' && depth < 10; depth++) {
    const record = node as Record<string, unknown>;
    for (const field of PG_ROW_FIELDS) delete record[field];
    node = record.cause;
  }
  return out;
}

/** The serializers every logger here uses (tests build theirs with these too). */
export const LOG_SERIALIZERS = { err: serializeError };

// Create Pino logger instance
const logger = pino({
  level: logLevel,

  // Redact sensitive fields from every log line. Pino's built-in redaction runs
  // before any transport, so it covers dev pretty-print and prod JSON alike, and
  // (unlike a per-middleware header list) it also catches secrets logged by
  // application code. Covers request auth headers and the response Set-Cookie
  // (session token), plus common credential field names.
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },

  serializers: LOG_SERIALIZERS,

  // Format options
  ...(isDevelopment
    ? {
        // Pretty print in development for readability
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
            singleLine: false,
          },
        },
      }
    : {
        // JSON to stdout in production (collected by the container runtime)
        formatters: {
          level: (label) => {
            return { level: label.toUpperCase() };
          },
        },
      }),

  // requestId / userId / tenantId on every line logged while a request (or a tenant's
  // background work) runs, child loggers included: one id finds all of a request's lines.
  mixin: logContext,

  // Base fields added to all logs; in an image the release workflow built, also which
  // build it is (utils/appVersion.ts), so a line says what was running when it was logged.
  base: {
    app: 'nuggets-backend',
    environment: config().NODE_ENV,
    ...(config().APP_VERSION ? { appVersion: config().APP_VERSION } : {}),
    ...(config().GIT_SHA ? { appCommit: config().GIT_SHA!.slice(0, 12) } : {}),
  },

  // Timestamp configuration
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** The most of a path a log line carries; a longer one is cut, and ends in `…`. */
export const MAX_LOGGED_PATH_LENGTH = 256;

/**
 * A URL's path, without its query string or fragment, for a log line: a query carries
 * search terms and, on the OneDrive callback, an OAuth code and state. At most
 * {@link MAX_LOGGED_PATH_LENGTH} characters of it: a path is whatever a client sent, and
 * anyone can send one of thousands.
 */
export function pathOnly(url: unknown): string {
  if (typeof url !== 'string') return '';
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  return path.length > MAX_LOGGED_PATH_LENGTH ? `${path.slice(0, MAX_LOGGED_PATH_LENGTH)}…` : path;
}

/**
 * A request body's field names, for a log line about it: never its values, which are
 * amounts, payees and notes.
 */
export function bodyKeys(body: unknown): string[] {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.keys(body) : [];
}

/**
 * An email address as a log line may show it: the first character of the name and the
 * domain (`j…@example.com`), enough to tell deliveries apart without the address.
 */
export function maskEmail(email: unknown): string | undefined {
  if (typeof email !== 'string' || !email) return undefined;
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email[0]}…${email.slice(at)}` : '…';
}

/** A character of a domain label: `[A-Za-z0-9-]`. */
function isLabelChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45;
}

/** A character of an address's name: `[A-Za-z0-9._%+-]`. */
function isNameChar(c: number): boolean {
  return isLabelChar(c) || c === 46 || c === 95 || c === 37 || c === 43;
}

/**
 * `text` with every email address in it masked as {@link maskEmail} does. An address is
 * what `/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g` matches, found from each
 * `@` instead of by that regex: the regex tries every starting point and runs to the end of
 * the text from each, so a long run of letters took time in the square of its length (a
 * 15,000-character path took a quarter of a second, and a security event logs the path any
 * client sends). Neither the name nor the domain contains an `@`, so each
 * character is looked at at most twice: the time is linear in the text's length.
 */
export function maskEmailsIn(text: string): string {
  let out = '';
  let copied = 0; // text before this index is in `out` (or is the end of the last match)
  let at = text.indexOf('@');
  while (at !== -1) {
    // The name: the run of name characters right before the `@`, not reaching back into
    // the last address.
    let start = at;
    while (start > copied && isNameChar(text.charCodeAt(start - 1))) start--;
    // The domain: a label, then one or more `.label`.
    let end = -1;
    if (start < at) {
      let i = at + 1;
      while (i < text.length && isLabelChar(text.charCodeAt(i))) i++;
      if (i > at + 1) {
        let labels = 0;
        while (i + 1 < text.length && text.charCodeAt(i) === 46 && isLabelChar(text.charCodeAt(i + 1))) {
          i += 1;
          while (i < text.length && isLabelChar(text.charCodeAt(i))) i++;
          labels++;
        }
        if (labels > 0) end = i;
      }
    }
    if (end === -1) {
      at = text.indexOf('@', at + 1);
      continue;
    }
    out += text.slice(copied, start) + (maskEmail(text.slice(start, end)) ?? '…');
    copied = end;
    at = text.indexOf('@', end);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Create a child logger with additional context
 * @param context Additional fields to include in all logs from this child
 */
export function createLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Log levels available:
 * - trace: Very detailed debugging (level 10)
 * - debug: Debugging information (level 20)
 * - info: General informational messages (level 30)
 * - warn: Warning messages (level 40)
 * - error: Error messages (level 50)
 * - fatal: Fatal errors that crash the application (level 60)
 *
 * Usage examples:
 *
 * logger.info('Server started successfully');
 * logger.info({ port: 3000 }, 'Server listening on port');
 * logger.error({ err: error }, 'Failed to connect to database');
 *
 * // Create child logger with context (requestId / userId / tenantId come from
 * // logContext on every line; don't log them by hand)
 * const serviceLogger = createLogger({ service: 'ImportService' });
 * serviceLogger.info('Processing request');
 */

export default logger;
