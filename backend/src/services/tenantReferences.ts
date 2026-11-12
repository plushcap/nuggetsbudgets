import { getDb } from '../db/withTenant.js';

/**
 * Numeric ids a client sends for a ledger row (a transaction's merchant_id, a tagging's
 * tag_id), checked before they are written.
 *
 * The database refuses a reference to another ledger's row: every foreign key between
 * ledger tables includes tenant_id. This lookup runs first, on
 * getDb() and so under RLS, so the client gets a 400 naming the field instead of a failed
 * write, and learns nothing about ids outside its ledger: another ledger's row and no row
 * answer alike.
 */

const TABLE_FOR = {
  account_id: 'accounts',
  source_account_id: 'accounts',
  destination_account_id: 'accounts',
  merchant_id: 'merchants',
  budget_item_id: 'budget_items',
  budget_period_id: 'budget_period',
  budget_period_item_id: 'budget_period_items',
  tag_id: 'tags',
  transaction_auto_tag_id: 'tags',
  category_id: 'categories',
  institution_id: 'account_institutions',
} as const;

export type TenantReferenceField = keyof typeof TABLE_FOR;

/** The largest `integer`, which every id these name is: a larger one names no row. */
const MAX_ID = 2147483647;

/**
 * A positive integer id from a JSON body or form field, or null for anything else,
 * including one past `integer` (Postgres refused it in the query, a 500). Text is read
 * only as plain decimal digits (spaces around them allowed): `Number()` also read '0x3',
 * '3e0' and '0b11' as 3.
 */
export function asId(value: unknown): number | null {
  const n = typeof value === 'string' ? (/^\s*\d{1,10}\s*$/.test(value) ? Number(value) : null) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_ID ? n : null;
}

/**
 * The first field of `refs` whose value is set (not null, undefined or '') but doesn't
 * name a row of the current ledger, or null when they all do.
 *
 * With `lock`, each row found is locked FOR KEY SHARE, as the write's foreign key check
 * locks it, but before the write rather than at it. A delete of the row that locks it first
 * (FOR UPDATE: a category's or an institution's) then either waits for this request and
 * counts its link, or this request waits for the delete and finds the row gone, a 400: a
 * check without the lock passed, and the write's foreign key check then failed on the
 * deleted row, a 500. Opt-in: a caller that takes other row locks first decides
 * where this one goes in its order.
 */
export async function firstMissingReference(
  refs: Partial<Record<TenantReferenceField, unknown>>,
  { lock = false }: { lock?: boolean } = {}
): Promise<TenantReferenceField | null> {
  for (const [field, value] of Object.entries(refs) as Array<[TenantReferenceField, unknown]>) {
    if (value === undefined || value === null || value === '') continue;
    const id = asId(value);
    if (id === null) return field;
    const query = getDb().selectFrom(TABLE_FOR[field]).select('id').where('id', '=', id);
    const row = await (lock ? query.forKeyShare() : query).executeTakeFirst();
    if (!row) return field;
  }
  return null;
}

/** The error a route answers (400) for a field {@link firstMissingReference} names. */
export function missingReferenceError(field: TenantReferenceField): { error: string; code: string; field: string } {
  const row = TABLE_FOR[field].replace(/_/g, ' ').replace(/ies$/, 'y').replace(/s$/, '');
  return {
    error: `${field} does not name ${/^[aeiou]/.test(row) ? 'an' : 'a'} ${row} in this tenant`,
    code: 'INVALID_REFERENCE',
    field,
  };
}

/** The ids in `ids` that name a tag of the current ledger (the others are dropped). */
export async function tenantTagIds(ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await getDb().selectFrom('tags').select('id').where('id', 'in', [...new Set(ids)]).execute();
  const found = new Set(rows.map((r) => r.id));
  return ids.filter((id) => found.has(id));
}
