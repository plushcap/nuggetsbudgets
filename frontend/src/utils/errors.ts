/**
 * Reading a caught value without `any`.
 *
 * A `catch` binding is `unknown`: usually an Error from the API helpers in
 * services/api/base.ts, which attach `status`, `details` and the parsed JSON
 * body as `response.data`, but it can be anything that was thrown. These read
 * those fields only when they are there, so a handler never trips over a
 * missing one.
 */

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** The caught value's `message`, or `fallback` when it has none (an empty message counts as none). */
export function errorMessage(error: unknown, fallback: string): string {
  return nonEmptyString(field(error, 'message')) ?? fallback;
}

/**
 * The server's reason for a failed API call (the API helpers make it the error's message,
 * in Ledger wording), or `fallback` for anything that didn't come from an API answer.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  return errorStatus(error) !== undefined ? errorMessage(error, fallback) : fallback;
}

/** The HTTP status the API helpers attached to a caught error, if any. */
export function errorStatus(error: unknown): number | undefined {
  const status = field(error, 'status');
  return typeof status === 'number' ? status : undefined;
}

/** The API's machine-readable reason (`code` in its error body), if the caught error has one. */
export function errorCode(error: unknown): string | undefined {
  return nonEmptyString(field(error, 'code'));
}

/** The failed request's id (the server log has it), if the caught error came from the API. */
export function errorRequestId(error: unknown): string | undefined {
  return nonEmptyString(field(error, 'requestId'));
}

/** The parsed JSON error body the API helpers attached (`error.response.data`), if any. */
export function errorResponseData(error: unknown): Record<string, unknown> | undefined {
  const data = field(field(error, 'response'), 'data');
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
}

/** The `message` field of the attached error body, when it is a non-empty string. */
export function errorResponseMessage(error: unknown): string | undefined {
  return nonEmptyString(errorResponseData(error)?.message);
}

/** The `details` the API helpers copied from the error body, when they are a non-empty string. */
export function errorDetailsText(error: unknown): string | undefined {
  return nonEmptyString(field(error, 'details'));
}
