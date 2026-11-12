import { z } from 'zod';

/**
 * The body of every API error answer (a 4xx or 5xx with a JSON body).
 *
 * - `error`: what went wrong, for people. Safe to show: a server error says only that
 *   one happened ("Internal server error"); its details are in the server log.
 * - `code`: what went wrong, for programs (`VALIDATION_ERROR`, `NOT_FOUND`,
 *   `INTERNAL_ERROR`, ...). Branch on this, never on the text.
 * - `requestId`: the request's id, also sent as the `X-Request-Id` header and carried by
 *   every server log line of that request. Quote it when reporting a problem.
 * - `message`: a fuller explanation, when a route has one (validation answers the first
 *   field's problem here). Show it in preference to `error`.
 *
 * Routes may add their own fields (`details`, `issues`, ...). The backend fills in `code`
 * and `requestId` on any error body a route answers without them.
 */
export const apiErrorBodySchema = z
  .object({
    error: z.string(),
    code: z.string(),
    requestId: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** The response header that carries a request's id (lower case, as fetch's Headers reads it). */
export const REQUEST_ID_HEADER = 'x-request-id';
