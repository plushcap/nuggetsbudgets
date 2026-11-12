import fsp from 'fs/promises';
import type { NextFunction, Request, Response } from 'express';
import { createLogger, pathOnly } from '../utils/logger.js';
import { hasMalformedId } from './routeParams.js';
import { nulTextMessage } from '@nuggets/shared';

const logger = createLogger({ service: 'Validation' });

const NUL = '\u0000';

/**
 * Where `body` holds a NUL character, in a string or a key: the field's path ('first_name',
 * 'splits.1.description', '(root)' for the body itself), or null when it holds none. JSON can
 * carry one as "\u0000", and a form as %00, which Postgres can't store in text or jsonb
 * (a 500 from the passkey, MCP-token and profile routes, among others). The walk is iterative,
 * so a deeply nested body can't run it out of stack, and a node's path is built only for the
 * one found.
 */
export function nulTextPath(body: unknown): string | null {
  interface Node { value: unknown; key: string | null; parent: Node | null }
  const pathOf = (node: Node): string => {
    const keys: string[] = [];
    for (let at: Node | null = node; at && at.key !== null; at = at.parent) keys.push(at.key.replaceAll(NUL, '\\u0000'));
    return keys.length === 0 ? '(root)' : keys.reverse().join('.');
  };
  const stack: Node[] = [{ value: body, key: null, parent: null }];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const { value } = node;
    if (typeof value === 'string') {
      if (value.includes(NUL)) return pathOf(node);
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      const childNode = { value: child, key, parent: node };
      if (key.includes(NUL)) return pathOf(childNode);
      stack.push(childNode);
    }
  }
  return null;
}

/** The longest field path an answer or a log line names (a body nested 200,000 deep has one of 400 KB). */
const MAX_FIELD_PATH = 200;

/** `path`, or its start and its end around an ellipsis when longer than MAX_FIELD_PATH. */
function shownPath(path: string): string {
  return path.length <= MAX_FIELD_PATH ? path : `${path.slice(0, 120)}…${path.slice(-(MAX_FIELD_PATH - 121))}`;
}

/** Answer 400 VALIDATION_ERROR for `path`, in validateBody's shape; the log line has the path, never the text. */
function answerNulText(req: Request, res: Response, path: string, part: 'body' | 'query'): void {
  const field = shownPath(path);
  const message = nulTextMessage(field);
  logger.warn({ details: [{ field }], url: pathOnly(req.originalUrl) }, `Request ${part} validation failed`);
  res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', message, details: [{ field, message }] });
}

/** The MCP endpoint, as Express routes it: case-insensitively, with or without a trailing part. */
const MCP_PATH = /^\/api\/mcp(?:\/|$)/i;

/**
 * Refuse a query string, or a parsed body (JSON or a form), with a NUL character in any of its
 * text, before any route runs: 400 VALIDATION_ERROR naming the field (`?search=%00` reached
 * Postgres, which can't read it, a 500). Registered after the body parsers. An
 * upload's multipart body is parsed later, by its route's multer, so its text fields are
 * checked there, by {@link refuseNulFields}. The MCP endpoint is left to answer in JSON-RPC: a
 * tool's call back to these routes is checked here as any other request.
 */
export function refuseNulText(req: Request, res: Response, next: NextFunction): void {
  if (MCP_PATH.test(req.path)) {
    next();
    return;
  }
  const inQuery = nulTextPath(req.query);
  if (inQuery !== null) {
    answerNulText(req, res, inQuery, 'query');
    return;
  }
  const inBody = nulTextPath(req.body);
  if (inBody === null) next();
  else answerNulText(req, res, inBody, 'body');
}

/** The files multer took for the request, one or several. */
function uploadedFiles(req: Request): Express.Multer.File[] {
  const { files } = req;
  const many = Array.isArray(files) ? files : Object.values(files ?? {}).flat();
  return req.file ? [req.file, ...many] : many;
}

/**
 * {@link refuseNulText} for a multipart body, whose text fields (and file names) a route's
 * multer parses: it goes right after the multer middleware of a route that saves them (the
 * profile form sends the names this way). A refused upload's files on disk are removed first,
 * as the route would have removed them.
 */
export async function refuseNulFields(req: Request, res: Response, next: NextFunction): Promise<void> {
  // A path that names nothing is the handler's 404, as validateBody leaves it.
  if (hasMalformedId(res)) {
    next();
    return;
  }
  const files = uploadedFiles(req);
  const named = files.find((file) => file.originalname.includes(NUL));
  const field = nulTextPath(req.body) ?? (named ? named.fieldname : null);
  if (field === null) {
    next();
    return;
  }
  await Promise.all(files.filter((file) => file.path).map((file) =>
    fsp.rm(file.path, { force: true }).catch((err: unknown) => {
      logger.warn({ err }, 'Could not remove a refused upload');
    })));
  answerNulText(req, res, field, 'body');
}
