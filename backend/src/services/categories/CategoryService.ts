import { sql } from 'kysely';
import type { CategoryWriteInput } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { DomainError, defaultErrorCode } from '../domainErrors.js';
import { lockRowsForDelete } from '../transactions/locks.js';
import { errorCode, errorConstraint } from '../../utils/errors.js';

/**
 * A ledger's categories (/api/categories): the groups its budget items fall in. A name is
 * unique in the ledger ignoring case and the spaces around it: checked here first, and by
 * the unique index {@link CATEGORY_NAME_INDEX}, which a write that raced another past the
 * check hits (answered with the same 409). Every query runs on the request's tenant
 * transaction (getDb(), RLS).
 */

/**
 * UNIQUE (tenant_id, name_key), name_key being lower(btrim(name)), stored: the comparison
 * {@link nameTaken} makes.
 */
export const CATEGORY_NAME_INDEX = 'uq_categories_tenant_name_key';

/** A category request refused: answered with its status, `{ error: heading, code, message }`. */
export class CategoryError extends DomainError {
  constructor(status: 404 | 409, heading: string, message: string) {
    super(status, defaultErrorCode(status), message, {}, { heading });
  }
}

export const categoryNotFound = (): CategoryError =>
  new CategoryError(404, 'Category not found', 'The specified category does not exist');
export const categoryNameTaken = (): CategoryError =>
  new CategoryError(409, 'Category exists', 'A category with this name already exists');
export const categoryInUse = (): CategoryError =>
  new CategoryError(409, 'Category in use', 'Cannot delete category that is assigned to budget items');

const CATEGORY_COLUMNS = ['id', 'uuid', 'name', 'description', 'priority', 'notes', 'icon', 'created_at'] as const;

/** The columns a write sets from its (validated) body. */
function categoryValues(input: CategoryWriteInput) {
  return {
    name: input.name,
    description: input.description?.trim() || null,
    priority: input.priority || 'Undefined',
    notes: input.notes?.trim() || null,
    icon: input.icon,
  };
}

/** A write that hit {@link CATEGORY_NAME_INDEX} answers the 409 the check does; anything else is rethrown. */
function nameTakenOnWrite(err: unknown): never {
  if (errorCode(err) === '23505' && errorConstraint(err) === CATEGORY_NAME_INDEX) throw categoryNameTaken();
  throw err;
}

/**
 * Whether another category than `exceptUuid` has `name`, ignoring case and surrounding spaces.
 * On the stored name_key: an = on a plain column, which the unique index serves under RLS,
 * where lower(btrim(name)), not leakproof, was filtered on every category of the ledger.
 */
async function nameTaken(name: string, exceptUuid?: string): Promise<boolean> {
  let query = getDb().selectFrom('categories').select('id').where('name_key', '=', sql<string>`lower(btrim(${name}::text))`);
  if (exceptUuid !== undefined) query = query.where('uuid', '!=', exceptUuid);
  return (await query.executeTakeFirst()) !== undefined;
}

export class CategoryService {
  /** Every category, by name. */
  list() {
    return getDb().selectFrom('categories').select(CATEGORY_COLUMNS).orderBy('name', 'asc').execute();
  }

  /** A new category, unless its name is taken. */
  async create(input: CategoryWriteInput) {
    if (await nameTaken(input.name)) throw categoryNameTaken();
    return getDb()
      .insertInto('categories')
      .values(categoryValues(input))
      .returning(CATEGORY_COLUMNS)
      .executeTakeFirstOrThrow()
      .catch(nameTakenOnWrite);
  }

  /** Rewrites the category `uuid` names; fields not sent are cleared. Its own name in another case is no clash. */
  async update(uuid: string, input: CategoryWriteInput) {
    const current = await getDb().selectFrom('categories').select(['id', 'name']).where('uuid', '=', uuid).executeTakeFirst();
    if (!current) throw categoryNotFound();
    if (input.name.toLowerCase() !== current.name.toLowerCase() && (await nameTaken(input.name, uuid))) throw categoryNameTaken();
    const updated = await getDb()
      .updateTable('categories')
      .set(categoryValues(input))
      .where('id', '=', current.id)
      .returning(CATEGORY_COLUMNS)
      .executeTakeFirst()
      .catch(nameTakenOnWrite);
    if (!updated) throw categoryNotFound();
    return updated;
  }

  /**
   * Deletes the category `uuid` names, unless a budget item is in it. The category is locked
   * first (FOR UPDATE): a budget item put in it meanwhile (its foreign key check takes the
   * row FOR KEY SHARE) is either waited for and counted, or waits for the delete and then
   * fails its check; without the lock the delete emptied its category (ON DELETE SET NULL).
   * A wait past the pool's lock_timeout is a 409 RECORD_BUSY. Answers the deleted id.
   */
  async remove(uuid: string): Promise<number> {
    const locked = await lockRowsForDelete('this category', () =>
      getDb().selectFrom('categories').select('id').where('uuid', '=', uuid).forUpdate().executeTakeFirst()
    );
    if (!locked) throw categoryNotFound();

    const inUse = await getDb().selectFrom('budget_items').select('id').where('category_id', '=', locked.id).limit(1).executeTakeFirst();
    if (inUse) throw categoryInUse();

    await getDb().deleteFrom('categories').where('id', '=', locked.id).execute();
    return locked.id;
  }
}
