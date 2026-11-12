import { describe, it, expect, vi, afterEach } from 'vitest';
import { getGeneralSettings } from '../settings';
import { getImportSettings } from '../import';
import { generalSetting, importSettings } from '../../../test/fixtures';

/**
 * The settings pages show the descriptions the server sends, and the server calls a ledger a
 * tenant (CLAUDE.md): they reach the pages in Ledger wording, as its errors do.
 */
describe('setting descriptions are shown in Ledger wording', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const serverAnswers = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
    );

  it('general settings', async () => {
    serverAnswers([generalSetting({ description: "This tenant's time zone (an IANA name such as America/New_York)" })]);
    expect(await getGeneralSettings()).toEqual([
      generalSetting({ description: "This ledger's time zone (an IANA name such as America/New_York)" }),
    ]);
  });

  it('import settings', async () => {
    const answer = importSettings({ import_enabled: 'true' });
    answer.settings.import_enabled.description = "Import this tenant's bank transactions automatically";
    serverAnswers(answer);
    const read = await getImportSettings();
    expect(read.settings.import_enabled).toEqual({ value: 'true', type: 'string', description: "Import this ledger's bank transactions automatically" });
    expect(read.settings.import_days_back).toEqual({ value: null, type: 'integer', description: 'The import_days_back setting' });
  });
});
