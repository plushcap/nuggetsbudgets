import { TAG_MAX_LEVELS } from '@nuggets/shared';
import { DomainError, refusalFromBody, type RefusalBody, type RefusalStatus } from '../domainErrors.js';
import { missingReferenceError, type TenantReferenceField } from '../tenantReferences.js';

/**
 * A refusal from the tag services (TagService, TaggingService, TagReportService): a
 * {@link DomainError} written as the answer body the tag routes have always given
 * (`{ error, message?, code?, ...details }`). The route wrapper answers it with its status;
 * the code is the status's (NOT_FOUND, CONFLICT, BAD_REQUEST) when the body names none.
 */
export class TagError extends DomainError {
  constructor(status: RefusalStatus, body: RefusalBody) {
    super(...refusalFromBody(status, body));
  }
}

/** The tag a uuid names isn't there (or is another ledger's). */
export const tagNotFound = (): TagError => new TagError(404, { error: 'Tag not found', message: 'No tag found with the provided UUID' });

/** The tag summary's own 404, with its code. */
export const tagSummaryNotFound = (): TagError => new TagError(404, { error: 'Tag not found', code: 'TAG_NOT_FOUND' });

export const tagNameTaken = (): TagError => new TagError(409, { error: 'Tag exists', message: 'A tag with this name already exists' });

export const parentMissing = (): TagError => new TagError(400, { error: 'Invalid parent', message: 'Parent tag does not exist' });

/** The tag (and the tags below it, on a move) would go past the deepest level; `verb` is what was being done. */
export const tooDeep = (verb: 'create' | 'move'): TagError =>
  new TagError(400, {
    error: 'Maximum depth exceeded',
    message: `Cannot ${verb} tag: maximum hierarchy depth of ${TAG_MAX_LEVELS} levels exceeded`,
  });

export const ownParent = (): TagError => new TagError(400, { error: 'Invalid parent', message: 'Cannot set tag as its own parent' });

export const circularParent = (): TagError =>
  new TagError(400, { error: 'Circular reference', message: 'Cannot move tag: would create circular reference' });

/** A report root is a top-level tag: it can't move under another. */
export const reportRootTopLevel = (): TagError =>
  new TagError(400, {
    error: 'Invalid operation',
    code: 'REPORT_ROOT_TOP_LEVEL',
    message: 'A report root is a top-level tag: unmark it as a report root before moving it under another tag',
  });

/** Moving the tag would put two tags of one report namespace on a budget item. */
export const moveNamespaceConflict = (): TagError =>
  new TagError(409, {
    error: 'Namespace conflict',
    code: 'NAMESPACE_CONFLICT',
    message: 'Moving this tag would put two tags from the same report namespace on a single budget item. Resolve the conflicting taggings first.',
  });

export const notTopLevel = (): TagError =>
  new TagError(400, { error: 'Invalid operation', message: 'Only top-level tags (parent_id = null, level = 0) can be marked as report roots' });

export const tagHasChildren = (): TagError =>
  new TagError(400, { error: 'Tag has children', message: 'Cannot delete tag with child tags. Delete or reassign children first.' });

/** A numeric tag id that names no tag of this ledger's: 400 INVALID_REFERENCE, naming the field. */
export const tagInvalidReference = (field: TenantReferenceField): TagError => new TagError(400, missingReferenceError(field));

export const transactionNotFound = (): TagError =>
  new TagError(404, { error: 'Transaction not found', message: 'No transaction found with the provided UUID' });

export const budgetItemNotFound = (): TagError =>
  new TagError(404, { error: 'Budget item not found', message: 'No budget item found with the provided UUID' });

export const merchantNotFound = (): TagError =>
  new TagError(404, { error: 'Merchant not found', message: 'No merchant found with the provided UUID' });

export const transactionAlreadyTagged = (): TagError =>
  new TagError(409, { error: 'Tag already added', message: 'This tag is already associated with the transaction' });

export const budgetItemAlreadyTagged = (): TagError =>
  new TagError(409, { error: 'Duplicate tag', message: 'This tag is already associated with the budget item' });

/** The tag isn't on the transaction or budget item. */
export const taggingNotFound = (on: 'transaction' | 'budget item'): TagError =>
  new TagError(404, { error: 'Tag association not found', message: `This tag is not associated with the ${on}` });

/** The budget item has another tag of the tag's report namespace (`existing`). */
export const namespaceTaken = (existing: unknown): TagError =>
  new TagError(409, {
    error: 'Namespace conflict',
    code: 'NAMESPACE_CONFLICT',
    message: 'This budget item already has a tag in the same report namespace. Remove it first or use the namespace-replace endpoint.',
    existing_tag: existing,
  });

export const reportRootNotFound = (): TagError =>
  new TagError(404, { error: 'Report root not found', message: 'No tag found with the provided rootTagUuid' });

export const notReportRoot = (): TagError =>
  new TagError(400, { error: 'Invalid report root', message: 'The provided rootTagUuid is not marked as a report namespace root' });

export const namespaceTagNotFound = (): TagError =>
  new TagError(404, { error: 'Tag not found', message: 'No tag found with the provided tag_uuid' });

export const notInNamespace = (): TagError =>
  new TagError(400, { error: 'Tag not in namespace', message: 'The provided tag does not belong to the specified report namespace' });

/** A concurrent write made the namespace replace conflict. */
export const namespaceReplaceConflict = (): TagError =>
  new TagError(409, { error: 'Namespace conflict', code: 'NAMESPACE_CONFLICT', message: 'A concurrent write produced a namespace conflict. Retry.' });
