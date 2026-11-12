import type { Selectable } from 'kysely';
import type { Securities } from '../../db/schema.generated.js';
import { DomainError } from '../domainErrors.js';
import { notFoundError, type ControlPlaneError } from '../controlPlaneErrors.js';

/**
 * A refusal of the securities catalog's own routes (DELETE /securities/:uuid): the security is
 * held; a create or rename to a ticker another security has; or a write to several securities
 * that found them busy.
 * The investments services' other refusals are the
 * shared `notFoundError` / `invalidRequestError` (controlPlaneErrors.ts), whose
 * text and codes differ: these keep the ones the catalog routes answered before they moved
 * to SecurityService.
 */
export class SecurityError extends DomainError {}

/**
 * No security with this uuid in the ledger (RLS hides another ledger's): the one answer every
 * investments route gives for it, 404 SECURITY_NOT_FOUND 'Security not found' (the catalog
 * routes answered NOT_FOUND 'security not found' before).
 */
export const securityMissing = (): ControlPlaneError => notFoundError('security');

/**
 * A ledger's one security per ticker: UNIQUE NULLS NOT DISTINCT (tenant_id,
 * ticker_key, exchange), ticker_key being upper(ticker), so ABC and abc with no exchange are one.
 */
export const SECURITY_TICKER_KEY = 'securities_ticker_key_exchange_key';

/**
 * A create or rename to a ticker and exchange another security of the ledger has: 409
 * SECURITY_EXISTS, with that security as `security`, the one to use instead.
 */
export const securityExists = (existing: Selectable<Securities>): SecurityError =>
  new SecurityError(
    409,
    'SECURITY_EXISTS',
    `A security with the ticker ${existing.ticker} ${existing.exchange ? `on ${existing.exchange}` : 'and no exchange'} is already recorded: ${existing.name}. Use that one, or give this one another ticker or exchange.`,
    { security: existing }
  );

/** A delete of a security with lots or events: removing it would cascade them away. */
export const securityHeld = (): SecurityError =>
  new SecurityError(409, 'CONFLICT', 'Cannot delete: this security has positions or transaction history. Remove its holdings first.');

/** A write to several securities that couldn't lock them in time (another change held them): try again. */
export const securitiesBusy = (): SecurityError =>
  new SecurityError(409, 'RECORD_BUSY', 'Another change to these securities was being saved at the same time, so nothing was saved. Try again.');
