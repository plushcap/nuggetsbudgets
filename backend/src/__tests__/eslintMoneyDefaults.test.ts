import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ESLint } from 'eslint';

/**
 * The server serves every ledger, so it never sets formatMoney's defaults (one client's
 * ledger's, the SPA's): the backend's ESLint refuses setFormatMoneyDefaults by its name and by a
 * string naming it, which a computed access (`shared['setFormatMoneyDefaults']`) uses.
 */
describe("the backend's ESLint refuses setFormatMoneyDefaults", () => {
  const eslint = new ESLint({ cwd: join(import.meta.dirname, '..', '..') });
  const refusals = async (code: string) => {
    const [result] = await eslint.lintText(code, { filePath: 'src/services/probe.ts' });
    return (result?.messages ?? []).filter((m) => m.message.includes('never setFormatMoneyDefaults')).length;
  };

  it.each([
    ["import { setFormatMoneyDefaults } from '@nuggets/shared';\nsetFormatMoneyDefaults({});\n", 3],
    ["import * as shared from '@nuggets/shared';\nshared.setFormatMoneyDefaults({});\n", 1],
    ["import * as shared from '@nuggets/shared';\nshared['setFormatMoneyDefaults']({});\n", 1],
    ["import * as shared from '@nuggets/shared';\nshared[`setFormatMoneyDefaults`]({});\n", 1],
    ["import * as shared from '@nuggets/shared';\nconst { setFormatMoneyDefaults: set } = shared;\nset({});\n", 1],
  ])('%s', async (code, expected) => {
    expect(await refusals(code)).toBe(expected);
  });

  it('lets the per-call format through', async () => {
    expect(await refusals("import { formatMoney } from '@nuggets/shared';\nformatMoney(1, { currency: 'EUR', locale: 'de-DE' });\n")).toBe(0);
  });
});
