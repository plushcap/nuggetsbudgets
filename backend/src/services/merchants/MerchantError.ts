import { DomainError, refusalFromBody, type RefusalBody, type RefusalStatus } from '../domainErrors.js';
import { missingReferenceError, type TenantReferenceField } from '../tenantReferences.js';
import { tooManyRegexRulesError } from '../regexRuleCap.js';
import type { MerchantUsage } from './MerchantService.js';

/**
 * A refusal from the merchant services (MerchantService, MerchantRuleService): a
 * {@link DomainError} written as the answer body the merchant routes have always given
 * (`{ error, message?, code?, ...details }`). The route wrapper answers it with its status;
 * the code is the status's (NOT_FOUND, CONFLICT, BAD_REQUEST) when the body names none.
 */
export class MerchantError extends DomainError {
  constructor(status: RefusalStatus, body: RefusalBody) {
    super(...refusalFromBody(status, body));
  }
}

/** The merchant a uuid names isn't there (or is another ledger's). */
export const merchantNotFound = (): MerchantError =>
  new MerchantError(404, { error: 'Merchant not found', message: 'The specified merchant does not exist' });

/** The merchant isn't there: the shorter answer the reads and the rule routes give. */
export const merchantNotFoundBrief = (): MerchantError => new MerchantError(404, { error: 'Merchant not found' });

/** Another merchant of the ledger has the name, ignoring case. */
export const merchantNameTaken = (): MerchantError =>
  new MerchantError(409, { error: 'Merchant exists', message: 'A merchant with this name already exists' });

/** merchant_image isn't one of the ledger's images. */
export const merchantImageNotAllowed = (): MerchantError =>
  new MerchantError(400, {
    error: 'Invalid input',
    message: 'merchant_image must be an image uploaded to this tenant (POST /merchants/:uuid/upload-image)',
  });

/** A numeric id in the body names nothing of this ledger's: 400 INVALID_REFERENCE, naming the field. */
export const merchantInvalidReference = (field: TenantReferenceField): MerchantError =>
  new MerchantError(400, missingReferenceError(field));

/** The merchant is in use: deleting it takes a replacement, which takes its uses. */
export const merchantInUse = (usage: MerchantUsage): MerchantError =>
  new MerchantError(409, {
    error: 'Merchant in use',
    message: 'This merchant is associated with budget items, transactions, recurring items, or attachments. Please provide a replacement merchant ID.',
    usage,
  });

export const replacementNotFound = (): MerchantError =>
  new MerchantError(400, { error: 'Invalid replacement merchant', message: 'The specified replacement merchant does not exist' });

export const replacesItself = (): MerchantError =>
  new MerchantError(400, { error: 'Invalid replacement merchant', message: 'A merchant cannot replace itself' });

/** A merge's source or target isn't there. */
export const mergeMerchantNotFound = (): MerchantError =>
  new MerchantError(404, { error: 'Merchant not found', message: 'One or both merchants do not exist' });

export const mergeWithItself = (): MerchantError =>
  new MerchantError(400, { error: 'Invalid operation', message: 'Cannot merge a merchant with itself' });

export const noImageUploaded = (): MerchantError =>
  new MerchantError(400, { error: 'No file uploaded', message: 'Please select an image file to upload' });

export const ruleNotFound = (): MerchantError =>
  new MerchantError(404, { error: 'Rule not found', message: 'The specified matching rule does not exist' });

/** The merchant has a rule of this method and text already. */
export const ruleExists = (): MerchantError =>
  new MerchantError(409, { error: 'Rule exists', message: 'A matching rule with this method and text already exists for this merchant' });

/** Saving the rule would give the ledger more regular-expression rules than the cap (regexRuleCap.ts). */
export const tooManyRegexRules = (): MerchantError => new MerchantError(400, tooManyRegexRulesError('merchant_matching_rules'));
