import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Lucide's icon modules, one per icon (`.../lucide-react/dist/esm/icons/<kebab name>.mjs`). */
const LUCIDE_ICON = /[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/]([a-z0-9-]+)\.mjs$/;

/** The icon chunks, by first letter: 90-160 KB each before compression, 25-45 KB gzipped. */
const ICON_CHUNKS: Array<[RegExp, string]> = [
  [/^[ab]/, 'icons-a-b'],
  [/^c/, 'icons-c'],
  [/^[d-h]/, 'icons-d-h'],
  [/^[i-p]/, 'icons-i-p'],
  [/^[q-s]/, 'icons-q-s'],
  [/^[t-z0-9]/, 'icons-t-z'],
];

/**
 * The icons the app imports by name (`import { Plus } from 'lucide-react'`), as Lucide's file
 * names: each name looked up in Lucide's own export list (lucide-react.mjs, aliases included),
 * since a name doesn't always spell its file (`BarChart3` is chart-column-increasing.mjs).
 * They go in one chunk of their own, so a page doesn't load a whole letter's chunk for the few
 * it shows by name (login + dashboard was 254 KB gzipped, then 339 with them in
 * the letter chunks).
 */
function namedIcons(root: string): Set<string> {
  const files = new Map<string, string>();
  // Lucide's ESM entry, dist/esm/lucide-react.mjs in its package, wherever the workspace
  // installed it (the repository root's node_modules, as a rule): its directory is the
  // nearest one up from the entry Node resolves (dist/cjs/lucide-react.js) that holds its
  // package.json.
  let lucide = path.dirname(fileURLToPath(import.meta.resolve('lucide-react')));
  while (!fs.existsSync(path.join(lucide, 'package.json')) && path.dirname(lucide) !== lucide) lucide = path.dirname(lucide);
  const barrel = fs.readFileSync(path.join(lucide, 'dist/esm/lucide-react.mjs'), 'utf8');
  for (const [, names, file] of barrel.matchAll(/export \{([^}]+)\} from '\.\/icons\/([a-z0-9-]+)\.mjs'/g)) {
    for (const name of names.matchAll(/default as (\w+)/g)) files.set(name[1], file);
  }
  // A Lucide that lays its entry out otherwise would leave the named chunk empty, silently.
  if (files.size === 0) throw new Error(`vite.config.ts: no icon exports found in ${lucide}/dist/esm/lucide-react.mjs`);
  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'test') walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const [, names] of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g)) {
          for (const name of names.split(',')) {
            const file = files.get(name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]);
            if (file) used.add(file);
          }
        }
      }
    }
  };
  walk(path.join(root, 'src'));
  return used;
}
const NAMED_ICONS = namedIcons(import.meta.dirname);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    port: 3000,
    host: '0.0.0.0', // Important for Docker
    proxy: {
      '/api': {
        target: 'http://backend:5000',
        changeOrigin: true,
        cookieDomainRewrite: 'localhost',
      },
      '/uploads': {
        target: 'http://backend:5000',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: 'build',
    // The browsers the app supports: Safari 16.4 (macOS and iOS),
    // Chrome and Edge 111, Firefox 128. Vite 8's default
    // ('baseline-widely-available') has Firefox 114, so the target is set here.
    target: ['chrome111', 'edge111', 'firefox128', 'safari16.4', 'ios16.4'],
    // No sourcemaps in the served build: they'd publish the whole source tree.
    sourcemap: false,
    cssCodeSplit: false, // Bundle all CSS into one file to prevent FOUC
    rolldownOptions: {
      output: {
        // Pin only the heavy/stable shared libs into their own cacheable chunks.
        // The `charts` chunk isolates @nivo + its d3 deps so they're
        // fetched only when a chart page opens and shared across chart pages.
        // react/react-router are long-cache vendors used app-wide. Everything
        // else is intentionally left for Rolldown to auto-split per lazy route, so
        // page-specific deps ride along with their page instead of bloating one
        // always-loaded vendor chunk.
        //
        // A group also takes the dependencies of what it matches (as
        // manualChunks did), unless a group of higher priority has them: so
        // React, which @nivo and react-router import, stays in `react` and is
        // never pulled into `charts` (which would then load on every page).
        // `charts` does take @nivo's other dependencies (lodash, @react-spring,
        // ...): a page that imports one of them loads `charts` with it.
        //
        // `zod-core` holds src/zodConfig.ts with the Zod modules the first page
        // load runs ($initial; the rest stay with the lazy pages that use them),
        // so jitless is set as soon as Zod loads: a chunk that builds a schema
        // imports this one, which runs first. Left to Rolldown, the
        // @nuggets/shared schemas land in a chunk the entry imports, which runs
        // before the entry's own first import (zodConfig): Zod's eval probe then
        // breaks the CSP on every page load (see src/zodConfig.ts).
        codeSplitting: {
          groups: [
            {
              name: 'zod-core',
              test: /[\\/]node_modules[\\/]zod[\\/]|[\\/]src[\\/]zodConfig\.ts$/,
              tags: ['$initial'],
              priority: 4,
            },
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 3,
            },
            {
              name: 'react-router',
              test: /[\\/]node_modules[\\/]react-router(-dom)?[\\/]/,
              priority: 2,
            },
            {
              name: 'charts',
              test: /[\\/]node_modules[\\/](@nivo[\\/]|d3-)/,
              priority: 1,
            },
            // Lucide's icons. The app shows a chosen icon (an account's, a budget item's) through
            // Lucide's per-icon dynamic imports (utils/iconCatalog.ts), so left to Rolldown each
            // icon was a chunk of its own: 1,995 files under 10 KB, of which the icon picker's full
            // set imported 1,991. Over plain HTTP (HTTP/1.1, about six connections a host: a LAN
            // install without TLS) they queued a few at a time. In six chunks by first letter, a
            // page's icons or the picker's whole set come in one round on those six connections,
            // and stay cached for every page after. The icons the first page load imports by name
            // go in a chunk of their own (`$initial`), so the first load doesn't wait for the six,
            // and the other icons the app imports by name in one more (NAMED_ICONS), so a page
            // doesn't load a whole letter for the few it shows. The letter chunks are left the
            // icons only a chosen icon or the picker shows. None takes the icons' dependencies
            // (createLucideIcon, React), which the pages share.
            {
              name: 'icons-initial',
              test: LUCIDE_ICON,
              tags: ['$initial'],
              includeDependenciesRecursively: false,
              priority: 2,
            },
            {
              name: 'icons-named',
              test: (id: string) => NAMED_ICONS.has(LUCIDE_ICON.exec(id)?.[1] ?? ''),
              includeDependenciesRecursively: false,
              priority: 1,
            },
            {
              // The chunks are icons-a-b, icons-c, ... (ICON_CHUNKS); this names the group in
              // the bundler's timing report, which a name function can't (it changes no chunk).
              debugName: 'icons-by-letter',
              name: (id: string) => {
                const icon = LUCIDE_ICON.exec(id)?.[1];
                // icons/index.mjs re-exports them all, for the picker's import * alone: it stays with it.
                if (!icon || icon === 'index') return null;
                return ICON_CHUNKS.find(([first]) => first.test(icon))?.[1] ?? null;
              },
              test: LUCIDE_ICON,
              includeDependenciesRecursively: false,
              priority: 0,
            },
          ],
        },
      },
    },
  },

  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
    // One Zod. @nuggets/shared is a linked workspace package, so its imports resolve
    // from shared/, and a zod of its own there (another version than the app's) would put a
    // second copy in the bundle. The workspace hoists one zod for both; this keeps it so.
    dedupe: ['zod'],
  },
});
