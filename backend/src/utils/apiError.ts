import { STATUS_CODES } from 'node:http';
import type { Response } from 'express';
import multer from 'multer';
import type { ApiErrorBody } from '@nuggets/shared';
import { getRequestId } from '../context/requestContext.js';
import { DomainError, defaultErrorCode } from '../services/domainErrors.js';
import { UploadRejectedError } from './imageUpload.js';
import { errorCode } from './errors.js';
import { createLogger } from './logger.js';

/**
 * One error shape for the API (`ApiErrorBody` in @nuggets/shared):
 * `{ error, code, requestId }`, plus whatever a route adds (`message`, `details`, ...).
 *
 * An error answer never carries an internal error's text (a database error, a library's
 * message, a stack): those name tables, constraints, hosts and paths. The server log has
 * them, on lines that carry the same requestId. Expected failures a client can act on are
 * thrown as a {@link DomainError} (status, code and a message written for people).
 */

const logger = createLogger({ service: 'ApiError' });

/** The answer text for a failure the client can't act on; the log has the details. */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

export { defaultErrorCode };

/**
 * SQLSTATEs of a lock a statement couldn't get: a wait past the pool's lock_timeout (55P03), and
 * a deadlock Postgres broke by failing this transaction (40P01). Either aborted the transaction,
 * which the error answer rolls back: nothing was saved, and trying again may well work.
 */
const LOCK_CONFLICTS = new Set(['55P03', '40P01']);

/** What a lock conflict no service answered itself is answered (it was a 500). */
export const RECORD_BUSY_MESSAGE = 'Another change was being saved at the same time, so nothing was saved. Try again.';

/** Whether `err` is a lock a statement couldn't get in time, or a deadlock (55P03, 40P01). */
export function isLockConflictError(err: unknown): boolean {
  return LOCK_CONFLICTS.has(errorCode(err) ?? '');
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);

/**
 * `body`, completed to the error shape: a `code` when it has none (from the status), the
 * request's id, and an `error` text when it has none (its `message`, else the code). For
 * the hand-written `res.status(4xx).json({ error })` answers across the routes, so each
 * reaches the client in the one shape. Anything but a JSON object is left alone, and so is
 * a JSON-RPC answer (the MCP endpoint's), whose members its protocol fixes.
 */
export function completeErrorBody(body: unknown, status: number, requestId: string | undefined): unknown {
  if (!isPlainObject(body) || 'jsonrpc' in body) return body;
  const completed: Record<string, unknown> = { ...body };
  if (completed.error === undefined) {
    completed.error = typeof completed.message === 'string' && completed.message
      ? completed.message
      : STATUS_CODES[status] ?? 'Request failed';
  }
  if (completed.code === undefined) completed.code = defaultErrorCode(status);
  if (completed.requestId === undefined && requestId) completed.requestId = requestId;
  return completed;
}

/** Answer `status` in the error shape. `extra` fields (e.g. `success: false`) come first. */
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {}
): void {
  const body: ApiErrorBody = { ...extra, error: message, code };
  const requestId = getRequestId();
  if (requestId) body.requestId = requestId;
  res.status(status).json(body);
}

/**
 * The messages busboy (multer's parser) fails a multipart body with when the body itself is
 * malformed: a part's header it can't read (a NUL character in a field name or a file name),
 * a form cut off before its end.
 */
const MALFORMED_MULTIPART = new Set([
  'Malformed part header',
  'Unexpected end of form',
  'Unexpected end of file',
]);

/**
 * What busboy throws as multer starts it, for a content type it can't read (no boundary). It
 * comes before any file is written, so multer passes it on unmarked; no storage engine has
 * run to fail with it.
 */
const MALFORMED_MULTIPART_TYPE = new Set([
  'Multipart: Boundary not found',
  'Malformed content type',
]);

/**
 * Whether `err` is busboy's refusal of a malformed multipart body, as multer passes it on. Once
 * the body is being read, multer removes the files it had written first and marks the error
 * with what that removal hit (`storageErrors`); a storage engine's own failure carries the
 * mark too, with its own message. One about the content type comes before that, unmarked.
 */
function isMalformedMultipart(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (MALFORMED_MULTIPART_TYPE.has(err.message)) return true;
  return MALFORMED_MULTIPART.has(err.message) && Array.isArray((err as { storageErrors?: unknown }).storageErrors);
}

/**
 * Answer an error a route threw or passed on (the route wrapper, asyncHandler, and the
 * global error handler both come here), with the status that fits it:
 * - a refusal (a DomainError): its status, and `{ ...details, error, code, message }`;
 * - a refused upload: 413 when the file is too large, else 400 (UPLOAD_REJECTED);
 * - a multipart body busboy can't read (a NUL in a part's header, a form cut off): 400
 *   VALIDATION_ERROR, as a body that fails its checks, where it was a 500;
 * - a body the parser refused (malformed JSON, too large, an unknown charset), which
 *   body-parser marks `expose` with a 4xx status: 400/413 INVALID_BODY, without the
 *   parser's text, which names its internals;
 * - a lock a statement couldn't get in time, or a deadlock (55P03, 40P01), that no service
 *   answered with its own refusal: 409 RECORD_BUSY, to try again (it was a 500);
 * - anything else: logged with `log` and its stack, and answered 500 INTERNAL_ERROR
 *   "Internal server error". Never the error's message: a database error's names its
 *   tables and columns.
 */
export function answerError(err: unknown, res: Response, log: Record<string, unknown> = {}): void {
  if (res.headersSent) {
    // A streamed answer already sent its status; the caller cuts the connection.
    logger.error({ err, ...log }, 'Error in request after its answer started');
    return;
  }
  if (err instanceof DomainError) {
    sendError(res, err.status, err.code, err.heading, { ...err.details, message: err.message });
    return;
  }
  if (err instanceof UploadRejectedError || err instanceof multer.MulterError) {
    const tooLarge = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
    sendError(res, tooLarge ? 413 : 400, 'UPLOAD_REJECTED', err.message);
    return;
  }
  if (isMalformedMultipart(err)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Validation failed', {
      message: "The form can't be read: a field's or a file's name holds a character it can't have (such as a NUL), the form was cut off, or its content type names no boundary.",
    });
    return;
  }
  const { status, expose } = (typeof err === 'object' && err !== null ? err : {}) as { status?: unknown; expose?: unknown };
  if (expose === true && typeof status === 'number' && status >= 400 && status < 500) {
    sendError(res, status, 'INVALID_BODY', status === 413 ? 'Request body too large' : 'Malformed request body');
    return;
  }
  if (isLockConflictError(err)) {
    logger.warn({ err, ...log }, 'A request could not get a lock in time, or deadlocked; nothing saved');
    sendError(res, 409, 'RECORD_BUSY', RECORD_BUSY_MESSAGE);
    return;
  }
  logger.error({ err, ...log }, 'Unhandled error in request');
  sendError(res, 500, 'INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE);
}

/**
 * The text a caught error may show a client: a refusal's own message (a DomainError's,
 * written for people), else `fallback`. For answers and stored results (a sync log's
 * error_message, a bulk call's per-row result) that would otherwise carry `err.message`.
 */
export function publicErrorMessage(err: unknown, fallback: string): string {
  return err instanceof DomainError ? err.message : fallback;
}
