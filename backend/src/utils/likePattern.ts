import { sql, type RawBuilder } from 'kysely';

/**
 * LIKE / ILIKE patterns built from text a person typed or stored.
 *
 * In a LIKE pattern `%` matches any run of characters, `_` any one character, and `\`
 * (Postgres's default escape character) makes the next character literal. Search terms
 * and merchant-rule texts mean the characters themselves, so each of the three is
 * escaped before the pattern's own leading or trailing `%` is added: a search for
 * `100%` finds "100%", not every name that starts with "100", and a rule containing
 * `AB_C` matches "AB_C", not "ABXC".
 *
 * Every pattern here is meant for a plain `LIKE` / `ILIKE` with no `ESCAPE` clause.
 */

/** `term` with `\`, `%` and `_` escaped, so a LIKE pattern matches it literally. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `%term%`: the term anywhere. */
export function containsPattern(term: string): string {
  return `%${escapeLike(term)}%`;
}

/** `term%`: the term at the start. */
export function prefixPattern(term: string): string {
  return `${escapeLike(term)}%`;
}

/** `%term`: the term at the end. */
export function suffixPattern(term: string): string {
  return `%${escapeLike(term)}`;
}

/**
 * {@link escapeLike} in SQL, for a pattern built from a column rather than a value the
 * code holds (the import's merchant-rule matcher builds its patterns from
 * `merchant_matching_rules.matching_text`). The backslash is replaced first, so the
 * escapes the next two add aren't doubled. `chr(92)` is a backslash, which keeps the
 * literals independent of `standard_conforming_strings`.
 */
export function escapeLikeSql(text: RawBuilder<unknown> | ReturnType<typeof sql.ref>): RawBuilder<string> {
  return sql<string>`replace(replace(replace(${text}, chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_')`;
}
