import { describe, it, expect } from 'vitest';
import { shutdownSettings } from '../../services/ApplicationLifecycleService.js';
import { ProductionConfigError } from '../../utils/productionConfig.js';

/**
 * The shutdown's two settings, read as config.ts defines them, with its
 * defaults and ranges, and checked against each other; index.ts runs this at startup with
 * the rest of the configuration.
 */
describe('shutdownSettings', () => {
  it("takes config.ts's defaults: 55 s, and a 2 s drain in production only", () => {
    expect(shutdownSettings({})).toEqual({ timeoutMs: 55_000, drainMs: 0 });
    expect(shutdownSettings({ NODE_ENV: 'production' })).toEqual({ timeoutMs: 55_000, drainMs: 2000 });
  });

  it('reads both', () => {
    expect(shutdownSettings({ SHUTDOWN_TIMEOUT_MS: '30000', SHUTDOWN_DRAIN_MS: ' 500 ' })).toEqual({ timeoutMs: 30_000, drainMs: 500 });
  });

  it("refuses a value config.ts can't use, in its words", () => {
    for (const [env, problem] of [
      [{ SHUTDOWN_TIMEOUT_MS: 'soon' }, 'SHUTDOWN_TIMEOUT_MS must be a whole number from 1000 to 600000, not "soon"'],
      [{ SHUTDOWN_TIMEOUT_MS: '999' }, 'SHUTDOWN_TIMEOUT_MS must be a whole number from 1000 to 600000, not "999"'],
      [{ SHUTDOWN_DRAIN_MS: '-1' }, 'SHUTDOWN_DRAIN_MS must be a whole number from 0 to 600000, not "-1"'],
    ] as const) {
      expect(() => shutdownSettings(env)).toThrow(new ProductionConfigError(problem));
    }
  });

  it('refuses a drain as long as the timeout, or longer', () => {
    expect(() => shutdownSettings({ SHUTDOWN_TIMEOUT_MS: '5000', SHUTDOWN_DRAIN_MS: '5000' })).toThrow(
      'SHUTDOWN_DRAIN_MS (5000) must be less than SHUTDOWN_TIMEOUT_MS (5000), or every shutdown runs out of time'
    );
    expect(() => shutdownSettings({ NODE_ENV: 'production', SHUTDOWN_TIMEOUT_MS: '1000' })).toThrow(ProductionConfigError);
  });
});
