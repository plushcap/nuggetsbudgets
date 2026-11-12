import { describe, it, expect, afterEach, vi } from 'vitest';
import { mockApi } from '../../../test/apiServer';

// As a production build reads an answer: a mismatch is logged and read as it came, not thrown.
vi.mock('../parseAnswer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parseAnswer')>();
  return { ...actual, parseAnswer: (schema: never, raw: unknown, answer: string) => actual.parseAnswer(schema, raw, answer, false) };
});
import { getGeneralSettings } from '../settings';
import { getImportSettings } from '../import';
import { logger } from '../../../utils/logger';

/**
 * In a production build, a setting the server sent without a description is read as it came
 * (parseAnswer's salvage): it is shown with none, not a failure of the whole page.
 */
describe('setting descriptions in a production build', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads a setting without a description as one with none', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockApi({
      'GET /settings/general': [{ setting_key: 'application_timezone', setting_type: 'string', setting_value: 'UTC', is_user_configurable: true }],
      'GET /import/settings': { settings: { import_enabled: { value: 'true', type: 'boolean' } } },
    });
    await expect(getGeneralSettings()).resolves.toEqual([expect.objectContaining({ setting_key: 'application_timezone', description: '' })]);
    await expect(getImportSettings()).resolves.toEqual({ settings: { import_enabled: { value: 'true', type: 'boolean', description: '' } } });
  });
});
