import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import { TRIMMED_SPACE_CODE_POINTS, trimSpaces } from '@nuggets/shared';

/**
 * The API and the database trim a ticker and an exchange of the same characters:
 * the database trimmed only spaces, tabs and line breaks, the API (JavaScript's trim()) no-break
 * spaces, U+FEFF, the vertical tab and the other Unicode spaces too, so a ticker stored with a
 * no-break space was a second security beside the bare one. TRIMMED_SPACE_CODE_POINTS is the set;
 * public.trim_space trims it in the database.
 */

/** Every code point of the Basic Multilingual Plane but the surrogates (all trim() looks at). */
const BMP = Array.from({ length: 0xffff }, (_, i) => i + 1).filter((c) => c < 0xd800 || c > 0xdfff);

describe('The characters a ticker and an exchange are trimmed of', () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
  afterAll(async () => {
    await owner.end();
  });

  it("are exactly those JavaScript's trim() removes", () => {
    const trimmedByJs = BMP.filter((c) => `${String.fromCharCode(c)}X${String.fromCharCode(c)}`.trim() === 'X');
    expect([...TRIMMED_SPACE_CODE_POINTS].sort((a, b) => a - b)).toEqual(trimmedByJs);
    for (const c of BMP) {
      const text = `${String.fromCharCode(c)}A${String.fromCharCode(c)}B${String.fromCharCode(c)}`;
      if (trimSpaces(text) !== text.trim()) throw new Error(`trimSpaces and trim() differ on U+${c.toString(16)}`);
    }
  });

  it('are those the database trims (public.trim_space), and no other', async () => {
    const { rows } = await owner.query<{ c: number }>(
      `SELECT c FROM generate_series(1, 65535) AS c
        WHERE c NOT BETWEEN 55296 AND 57343
          AND public.trim_space(chr(c) || 'X' || chr(c)) = 'X'
        ORDER BY c`
    );
    expect(rows.map((r) => r.c)).toEqual([...TRIMMED_SPACE_CODE_POINTS].sort((a, b) => a - b));
    // Inside a value, nothing is trimmed.
    expect((await owner.query(`SELECT public.trim_space(E'\\u00a0A\\u00a0B\\ufeff') AS t`)).rows[0].t).toBe('A B');
  });
});
