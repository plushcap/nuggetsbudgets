import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import '../zodConfig';

/**
 * The production image serves the app with `serve`, which sends the headers in
 * public/serve.json (copied into build/). They are the app's only security headers: the
 * backend's apply to the API, not to the SPA document. Without them any site could
 * frame the app, and a DOM-XSS bug would have no CSP behind it.
 *
 * style-src keeps 'unsafe-inline': react-hot-toast (goober), Radix's scroll lock and
 * ScrollArea/Select inject <style> elements, and a static server can't hand out nonces.
 * Scripts stay 'self' only.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

type HeaderRule = { source: string; headers: { key: string; value: string }[] };
const rules: HeaderRule[] = JSON.parse(read('../../public/serve.json')).headers;
const everyFile = Object.fromEntries(
  (rules.find((r) => r.source === '**')?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value])
);
const csp = new Map(
  (everyFile['content-security-policy'] ?? '')
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .filter((parts) => parts[0])
    .map(([name, ...values]) => [name, values])
);
const indexHtml = read('../../index.html');

describe('the headers the frontend container sends', () => {
  it('forbid framing, MIME sniffing and plugins', () => {
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(everyFile['x-frame-options']).toBe('DENY');
    expect(everyFile['x-content-type-options']).toBe('nosniff');
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(everyFile['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(everyFile['permissions-policy']).toBeTruthy();
  });

  it("run only the app's own scripts, and talk only to its own origin", () => {
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('connect-src')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
  });
});

describe('index.html, under that policy', () => {
  it('has no inline script', () => {
    const scripts = [...indexHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [tag, body] of scripts) {
      expect(tag).toMatch(/\ssrc="/);
      expect(body.trim()).toBe('');
    }
  });

  it('loads nothing from another origin', () => {
    const urls = [...indexHtml.matchAll(/\s(?:src|href)="([^"]+)"/gi)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^\/(?!\/)/);
  });
});

describe('Zod under that policy', () => {
  it("never probes for eval, which the policy refuses (and reports on every page)", () => {
    expect(z.config().jitless).toBe(true);
  });

  it('is configured before anything else the app imports', () => {
    const firstImport = read('../index.tsx').match(/^import\s.*$/m)?.[0];
    expect(firstImport).toBe("import './zodConfig';");
  });
});
