import { DomainError, refusalFromBody, type RefusalBody, type RefusalStatus } from '../domainErrors.js';

/**
 * A refusal from the account services that the caller can act on: a {@link DomainError},
 * written as the answer body it has always had. The route wrapper answers it with its
 * status and the body (`{ error }`, its detail, and `message`: its own where it has one,
 * as the delete refusals do, else the error's text); the code is the status's (NOT_FOUND,
 * BAD_REQUEST) when the body names none.
 */
export class AccountError extends DomainError {
  constructor(status: RefusalStatus, body: RefusalBody) {
    super(...refusalFromBody(status, body));
  }
}

/** The account isn't there, or is another ledger's (RLS hides it). */
export const accountNotFound = (): AccountError => new AccountError(404, { error: 'Account not found' });
