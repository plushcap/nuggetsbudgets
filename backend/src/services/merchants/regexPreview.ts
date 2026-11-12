import { sql } from 'kysely';
import { getDb, withSavepoint } from '../../db/withTenant.js';
import { errorCode } from '../../utils/errors.js';
import { oneRow } from '../../utils/present.js';

/**
 * How long one regex rule's preview query may run. Postgres stops a
 * running match at the statement timeout, but the pool's 30 s would let a few previews
 * of a slow pattern hold every connection for half a minute.
 */
export const REGEX_PREVIEW_TIMEOUT_MS = 5_000;

export type RegexPreviewSkip = 'invalid_pattern' | 'too_slow';

/**
 * Run a regex rule's preview query under {@link REGEX_PREVIEW_TIMEOUT_MS}, in a
 * savepoint: a pattern Postgres refuses (it accepts a little less than JavaScript does,
 * no named groups for one) or one that runs out of time skips that rule, rather than
 * failing the request. The statement timeout is put back afterwards.
 */
export async function runRegexPreview<T>(
  run: () => Promise<T>,
  timeoutMs: number = REGEX_PREVIEW_TIMEOUT_MS
): Promise<{ ok: true; rows: T } | { ok: false; reason: RegexPreviewSkip }> {
  try {
    const rows = await withSavepoint(async () => {
      const previous = oneRow((await sql<{ timeout: string }>`SELECT current_setting('statement_timeout') AS timeout`.execute(getDb())).rows, 'current_setting').timeout;
      await sql`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`.execute(getDb());
      const result = await run();
      await sql`SELECT set_config('statement_timeout', ${previous}, true)`.execute(getDb());
      return result;
    });
    return { ok: true, rows };
  } catch (err) {
    // invalid_regular_expression; query_canceled (the timeout); program_limit_exceeded
    // ("regular expression is too complex" can come as either 2201B or 54000).
    const code = errorCode(err);
    if (code === '2201B') return { ok: false, reason: 'invalid_pattern' };
    if (code === '57014' || code === '54000' || code === '54001') return { ok: false, reason: 'too_slow' };
    throw err;
  }
}
