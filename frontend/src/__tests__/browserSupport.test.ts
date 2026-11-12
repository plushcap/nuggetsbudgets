import { readFileSync } from 'node:fs';
import { Linter } from 'eslint';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The notice for a browser older than the build target: index.html holds it,
 * hidden, and public/browser-support.js, a classic ES5 script from the app's own origin,
 * shows it in place of the app when the browser lacks color-mix() (Chrome and Edge before
 * 111, Firefox before 113, Safari before 16.2) or CSS.registerProperty (Firefox before 128,
 * Safari before 16.4). Here the script runs against index.html's own markup and styles,
 * with the browser's CSS object stubbed as each kind of browser has it.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const script = read('../../public/browser-support.js');
const indexHtml = read('../../index.html');

const UNSUPPORTED = 'nuggets-unsupported';

interface FakeCss {
  supports?: (property: string, value: string) => boolean;
  registerProperty?: (definition: unknown) => void;
}

/** A browser's CSS object: color-mix() known or not, CSS.registerProperty there or not. */
function css({ colorMix, registerProperty }: { colorMix: boolean; registerProperty: boolean }): FakeCss {
  return {
    supports: (property, value) => property === 'color' && value.startsWith('color-mix(') && colorMix,
    ...(registerProperty && { registerProperty: () => undefined }),
  };
}

/** sessionStorage as a tab has it, or one that throws as blocked storage does. */
function memoryStorage(blocked = false) {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => {
      if (blocked) throw new DOMException('blocked', 'SecurityError');
      return items.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (blocked) throw new DOMException('blocked', 'SecurityError');
      items.set(key, value);
    },
  };
}

/** Run the script as the page would, in a browser whose `window` has these. */
function runScript(win: { CSS?: FakeCss | undefined; sessionStorage?: unknown; MutationObserver?: typeof MutationObserver }) {
  new Function('window', 'document', script)(win, document);
}

const notice = () => document.getElementById('unsupported-browser') as HTMLElement;
const app = () => document.getElementById('root') as HTMLElement;
const shown = (el: HTMLElement) => getComputedStyle(el).display !== 'none';
const classes = () => document.documentElement.className.split(/\s+/).filter(Boolean);

beforeEach(() => {
  // index.html as the browser parsed it: its styles and its body (no script runs from it here).
  const page = new DOMParser().parseFromString(indexHtml, 'text/html');
  document.head.replaceChildren(...[...page.head.querySelectorAll('style')].map((s) => document.importNode(s, true)));
  document.body.replaceChildren(
    ...[...page.body.children].filter((el) => el.tagName !== 'SCRIPT').map((el) => document.importNode(el, true))
  );
  document.documentElement.className = '';
});

describe('the unsupported-browser notice', () => {
  it('stays hidden, and the app shown, in a browser at the build target or later', () => {
    runScript({ CSS: css({ colorMix: true, registerProperty: true }), sessionStorage: memoryStorage() });
    expect(classes()).toEqual([]);
    expect(shown(notice())).toBe(false);
    expect(shown(app())).toBe(true);
  });

  it.each([
    ['without CSS.registerProperty (Firefox 113–127, Safari 16.2–16.3)', { CSS: css({ colorMix: true, registerProperty: false }) }],
    ['without color-mix() (Chrome and Edge 78–110)', { CSS: css({ colorMix: false, registerProperty: true }) }],
    ['with neither (older still)', { CSS: css({ colorMix: false, registerProperty: false }) }],
    ['with no CSS object at all (Internet Explorer)', { CSS: undefined }],
    ['whose CSS.supports throws', { CSS: { supports: () => { throw new Error('no'); }, registerProperty: () => undefined } }],
  ])('shows in place of the app in a browser %s', (_label, win) => {
    runScript({ ...win, sessionStorage: memoryStorage() });
    expect(classes()).toEqual([UNSUPPORTED]);
    expect(shown(notice())).toBe(true);
    expect(shown(app())).toBe(false);
    expect(notice()).toHaveAccessibleName('Nuggets needs a newer browser');
    expect(notice()).toHaveTextContent('Chrome or Edge 111, Firefox 128 and Safari 16.4');
  });

  it("keeps the classes <html> already has, the theme's included", () => {
    document.documentElement.className = 'dark';
    runScript({ CSS: undefined, sessionStorage: memoryStorage() });
    expect(classes()).toEqual(['dark', UNSUPPORTED]);
  });

  it('shows the app when the person continues anyway, for the rest of the tab', () => {
    const storage = memoryStorage();
    document.documentElement.className = 'light';
    runScript({ CSS: undefined, sessionStorage: storage });
    expect(shown(app())).toBe(false);

    // The app has rendered behind the notice: its heading takes the focus the hidden button had.
    app().innerHTML = '<main><h1>Dashboard</h1></main>';
    const button = document.getElementById('unsupported-browser-continue') as HTMLButtonElement;
    button.focus();
    button.click();
    expect(classes()).toEqual(['light']);
    expect(shown(notice())).toBe(false);
    expect(shown(app())).toBe(true);
    expect(document.activeElement).toBe(app().querySelector('h1'));

    // The next page in this tab goes straight to the app.
    document.documentElement.className = '';
    runScript({ CSS: undefined, sessionStorage: storage });
    expect(classes()).toEqual([]);
  });

  it.each([
    ['with MutationObserver', { MutationObserver: globalThis.MutationObserver }],
    ['without it (polling)', {}],
  ])("takes the focus to the app's heading once it renders, when the app is still loading, %s", async (_label, extra) => {
    runScript({ CSS: undefined, sessionStorage: memoryStorage(), ...extra });
    const button = document.getElementById('unsupported-browser-continue') as HTMLButtonElement;
    button.focus();
    button.click();
    expect(document.activeElement).not.toBe(app().querySelector('h1'));
    app().innerHTML = '<main><h1>Dashboard</h1></main>';
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.activeElement).toBe(app().querySelector('h1'));
  });

  it("doesn't take the focus back once the person has put it somewhere", async () => {
    runScript({ CSS: undefined, sessionStorage: memoryStorage(), MutationObserver: globalThis.MutationObserver });
    (document.getElementById('unsupported-browser-continue') as HTMLButtonElement).click();
    app().innerHTML = '<input aria-label="Search">';
    const search = app().querySelector('input') as HTMLInputElement;
    search.focus();
    app().insertAdjacentHTML('beforeend', '<h1>Dashboard</h1>');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(search);
  });

  it('still continues when storage is blocked, for that page only', () => {
    runScript({ CSS: undefined, sessionStorage: memoryStorage(true) });
    (document.getElementById('unsupported-browser-continue') as HTMLButtonElement).click();
    expect(shown(app())).toBe(true);

    document.documentElement.className = '';
    runScript({ CSS: undefined, sessionStorage: memoryStorage(true) });
    expect(shown(notice())).toBe(true);
  });

  it("is ES5, so a browser that can't run the app can run it", () => {
    const problems = new Linter().verify(script, [{ languageOptions: { ecmaVersion: 5, sourceType: 'script' } }]);
    expect(problems.filter((p) => p.fatal).map((p) => `${p.line}:${p.column} ${p.message}`)).toEqual([]);
  });
});

/**
 * A page's <script> elements as the browser reads it, in document order: a tag in a
 * comment isn't one. A regex over the text counted a commented-out tag as loaded.
 */
const scriptTags = (html: string) => [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('script')];

describe('index.html', () => {
  it("loads the check as a deferred classic script, ahead of the app's module", () => {
    const scripts = scriptTags(indexHtml);
    const check = scripts.findIndex((tag) => tag.getAttribute('src') === '/browser-support.js');
    const appModule = scripts.findIndex((tag) => tag.getAttribute('type') === 'module');
    expect(check).toBeGreaterThanOrEqual(0);
    const tag = scripts[check];
    expect(tag?.hasAttribute('defer')).toBe(true);
    expect(tag?.hasAttribute('type') || tag?.hasAttribute('async')).toBe(false);
    expect(appModule).toBeGreaterThan(check);
  });

  it("doesn't count a commented-out tag as loaded", () => {
    const html = '<!-- <script src="/browser-support.js" defer></script> --><script type="module" src="/src/main.tsx"></script>';
    expect(scriptTags(html).map((tag) => tag.getAttribute('src'))).toEqual(['/src/main.tsx']);
  });

  it('names the browsers the build targets, which are the lines the check draws', () => {
    // When build.target moves, the check's features and the notice's text move with it:
    // update both (public/browser-support.js says which feature draws which line), then this.
    const target = read('../../vite.config.ts').match(/^\s*target:\s*\[([^\]]*)\]/m)?.[1];
    const targets = [...(target ?? '').matchAll(/'([a-z]+)([\d.]+)'/g)].map(([, browser, version]) => `${browser}${version}`);
    expect(targets).toEqual(['chrome111', 'edge111', 'firefox128', 'safari16.4', 'ios16.4']);
    const page = new DOMParser().parseFromString(indexHtml, 'text/html');
    expect(page.getElementById('unsupported-browser')?.textContent?.replace(/\s+/g, ' ')).toContain(
      'Chrome or Edge 111, Firefox 128 and Safari 16.4, and in any later version. On an iPhone or iPad, every browser needs iOS or iPadOS 16.4 or later.'
    );
  });
});
