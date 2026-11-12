import { DomainError } from './domainErrors.js';

/**
 * A refusal from the control-plane services (Membership/Organization/TenantAdmin) and
 * the ones that grew up beside them (imports, backups, budgets, investments): not found,
 * forbidden, last-admin, already running, … A {@link DomainError} with nothing of its
 * own: the route wrapper answers it with its status, code, message and details.
 */
export class ControlPlaneError extends DomainError {}

/**
 * A uuid in a request that names no security or account the caller can see (RLS
 * hides other ledgers' rows): a 404, which asyncHandler answers with its code. A
 * plain Error here used to become a 500.
 */
export function notFoundError(what: 'security' | 'account'): ControlPlaneError {
  return new ControlPlaneError(404, `${what.toUpperCase()}_NOT_FOUND`, `${what === 'security' ? 'Security' : 'Account'} not found`);
}

/**
 * A request the caller can correct (too few shares to sell, a lot that isn't open,
 * weights that don't add up): a 400 with the reason. The investment services marked
 * these with an `error:` prefix on a plain Error, which became a 500.
 */
export function invalidRequestError(message: string): ControlPlaneError {
  return new ControlPlaneError(400, 'INVALID_REQUEST', message.replace(/^error: /, ''));
}
