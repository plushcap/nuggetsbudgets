import type { NextFunction, Request, Response } from 'express';
import { runInRequestScope } from '../context/requestContext.js';
import { completeErrorBody } from '../utils/apiError.js';
import { requestIdFor } from './logger.js';

/**
 * The request's id, everywhere it is needed. Mounted right after the
 * request logger (pino-http), which gave the request its id (`req.id`):
 * - answered as the `X-Request-Id` header, on every response;
 * - put on every log line of the request (utils/logger.ts reads it from the request
 *   scope entered here, which the rest of the request runs in);
 * - in every JSON error body, with a `code`: a route's `res.status(4xx).json({ error })`
 *   reaches the client in the one error shape (utils/apiError.ts).
 */
export function requestScope(req: Request, res: Response, next: NextFunction): void {
  const requestId = typeof req.id === 'string' && req.id ? req.id : requestIdFor(req.headers['x-request-id']);
  res.setHeader('X-Request-Id', requestId);

  const json = res.json.bind(res);
  res.json = (body?: unknown) => json(res.statusCode >= 400 ? completeErrorBody(body, res.statusCode, requestId) : body);

  runInRequestScope({ requestId }, next);
}

export default requestScope;
