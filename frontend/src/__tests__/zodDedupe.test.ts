import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveConfig } from 'vite';

/**
 * @nuggets/shared is a linked package (a workspace, before that file:../shared), so
 * a build resolved its `zod` from shared/ (its own node_modules, then) and the bundle carried
 * two copies of Zod. The build's resolver (vite.config.ts) must give the schemas the app's
 * one.
 */
describe('the build has one Zod', () => {
  it('resolves zod from @nuggets/shared to the copy the app imports', async () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const config = await resolveConfig({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'silent' }, 'build');
    const resolve = config.createResolver();
    const appModule = path.join(root, 'src/zodConfig.ts');
    const sharedEntry = await resolve('@nuggets/shared', appModule);
    expect(sharedEntry).toBeTruthy();

    const fromApp = await resolve('zod', appModule);
    const fromShared = await resolve('zod', sharedEntry);

    expect(fromApp).toContain(`${path.sep}node_modules${path.sep}zod${path.sep}`);
    expect(path.relative(path.dirname(root), fromApp ?? '')).not.toMatch(/^shared[\\/]/);
    expect(fromShared).toBe(fromApp);
  });
});
