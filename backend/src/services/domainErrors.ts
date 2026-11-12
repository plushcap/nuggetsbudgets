/**
 * Refusals: a request a service won't carry out, for a reason its caller can act on.
 *
 * Each domain subclasses {@link DomainError} (TransactionRefusal, AccountError, UserError,
 * BillError, the budget-item errors, ControlPlaneError, …) and exports factories for its
 * refusals (`notFound`, `accountNotFound`, …). The service throws one; the route lets it
 * propagate, and the route wrapper (`answerError`, utils/apiError.ts) answers it with its
 * status and `{ ...details, error, code, message, requestId }`. The request's transaction
 * rolls back, as for any answer of 400 or more.
 *
 * Never for an internal failure (a row that should be there and isn't, a database error):
 * that is a plain Error, answered 500 "Internal server error" without its text, and logged.
 */

/** The statuses a refusal answers with: the caller's request (4xx), or a service it depends on (502–504). */
export type RefusalStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 502 | 503 | 504;

const CODE_FOR_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

/** The `code` an error answer gets when it names none: what the request scope fills in. */
export function defaultErrorCode(status: number): string {
  return CODE_FOR_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
}

export class DomainError extends Error {
  /** The answer's `error`: the message, unless the refusal has a shorter heading for it. */
  readonly heading: string;

  /**
   * @param status the answer's status
   * @param code what went wrong, for programs (clients branch on it)
   * @param message what went wrong, for people: the answer's `message` and `error`
   * @param details more of the answer (what the refusal names), spread into its body
   * @param options.heading the answer's `error` when it differs from `message`
   */
  constructor(
    readonly status: RefusalStatus,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options: { heading?: string | undefined } = {}
  ) {
    super(message);
    this.name = new.target.name;
    this.heading = options.heading ?? message;
  }
}

/** An answer body as the transaction and account services write a refusal: `{ error, code?, message?, ...details }`. */
export type RefusalBody = { error: string } & Record<string, unknown>;

/**
 * The DomainError arguments for a refusal written as its answer body: its `code` (from the
 * status when it has none), its `message` (else its `error`), the rest as details, and
 * its `error` as the heading when it has a separate message.
 */
export function refusalFromBody(
  status: RefusalStatus,
  body: RefusalBody
): [RefusalStatus, string, string, Record<string, unknown>, { heading: string }] {
  const { error, code, message, ...details } = body;
  return [
    status,
    typeof code === 'string' ? code : defaultErrorCode(status),
    typeof message === 'string' ? message : error,
    details,
    { heading: error },
  ];
}
