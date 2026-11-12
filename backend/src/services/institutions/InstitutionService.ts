import { sql } from 'kysely';
import type { InstitutionWriteInput } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { DomainError, defaultErrorCode } from '../domainErrors.js';
import { lockRowsForDelete } from '../transactions/locks.js';

/**
 * A ledger's institutions (/api/institutions): the banks and brokers its accounts are at.
 * Every query runs on the request's tenant transaction (getDb(), RLS).
 */

/** An institution request refused: answered with its status, `{ error, code, message }`. */
export class InstitutionError extends DomainError {
  constructor(status: 400 | 404, message: string, heading?: string) {
    super(status, defaultErrorCode(status), message, {}, { heading });
  }
}

export const institutionNotFound = (): InstitutionError => new InstitutionError(404, 'Institution not found');

/** Accounts are at the institution: it can't be deleted until they're moved. */
export const institutionInUse = (accountCount: number): InstitutionError =>
  new InstitutionError(
    400,
    `This institution is currently used by ${accountCount} account${accountCount > 1 ? 's' : ''}. Please reassign or delete those accounts first.`,
    'Cannot delete institution'
  );

const INSTITUTION_COLUMNS = ['id', 'uuid', 'name', 'notes', 'created_at'] as const;

/** The columns a write sets from its (validated) body. */
const institutionValues = (input: InstitutionWriteInput) => ({ name: input.name, notes: input.notes || null });

export class InstitutionService {
  /** Every institution, by name, with how many accounts are at it. */
  async list() {
    // kept as raw sql: a grouped count over a join
    const result = await sql<{
      id: number;
      uuid: string | null;
      name: string;
      notes: string | null;
      created_at: Date | null;
      account_count: string;
    }>`
      SELECT
        ai.id,
        ai.uuid,
        ai.name,
        ai.notes,
        ai.created_at,
        COUNT(a.id) as account_count
      FROM account_institutions ai
      LEFT JOIN accounts a ON ai.id = a.institution_id
      GROUP BY ai.id, ai.uuid, ai.name, ai.notes, ai.created_at
      ORDER BY ai.name ASC
    `.execute(getDb());
    return result.rows;
  }

  /** The institution `uuid` names. */
  async find(uuid: string) {
    const institution = await getDb().selectFrom('account_institutions').select(INSTITUTION_COLUMNS).where('uuid', '=', uuid).executeTakeFirst();
    if (!institution) throw institutionNotFound();
    return institution;
  }

  create(input: InstitutionWriteInput) {
    return getDb().insertInto('account_institutions').values(institutionValues(input)).returning(INSTITUTION_COLUMNS).executeTakeFirstOrThrow();
  }

  /** Rewrites the institution `uuid` names; notes not sent are cleared. */
  async update(uuid: string, input: InstitutionWriteInput) {
    const updated = await getDb()
      .updateTable('account_institutions')
      .set(institutionValues(input))
      .where('uuid', '=', uuid)
      .returning(INSTITUTION_COLUMNS)
      .executeTakeFirst();
    if (!updated) throw institutionNotFound();
    return updated;
  }

  /**
   * Deletes the institution `uuid` names, unless an account is at it, and answers it. The
   * institution is locked first (FOR UPDATE): an account linked to it meanwhile (its foreign
   * key check takes the row FOR KEY SHARE) is either waited for and counted, or waits for the
   * delete and then fails its check. Without the lock, the count could miss an account being
   * linked, and the delete unlinked it (ON DELETE SET NULL). A wait past the pool's
   * lock_timeout is a 409 RECORD_BUSY.
   */
  async remove(uuid: string) {
    const locked = await lockRowsForDelete('this institution', () =>
      getDb().selectFrom('account_institutions').select('id').where('uuid', '=', uuid).forUpdate().executeTakeFirst()
    );
    if (!locked) throw institutionNotFound();

    const { count } = await getDb()
      .selectFrom('accounts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('institution_id', '=', locked.id)
      .executeTakeFirstOrThrow();
    const accounts = Number(count);
    if (accounts > 0) throw institutionInUse(accounts);

    const deleted = await getDb()
      .deleteFrom('account_institutions')
      .where('id', '=', locked.id)
      .returning(INSTITUTION_COLUMNS)
      .executeTakeFirst();
    if (!deleted) throw institutionNotFound();
    return deleted;
  }
}
