import { describe, it, expect } from 'vitest';
import { ownImageSrc, sameOriginPath, websiteHref } from '../safeUrls';

/** Stored URLs other members open or load. */
describe('safe URLs', () => {
  const origin = window.location.origin;

  it('loads only images the app serves, from this origin', () => {
    expect(ownImageSrc('/api/images/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe(`${origin}/api/images/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b`);
    expect(ownImageSrc('/uploads/logo.png')).toBe(`${origin}/uploads/logo.png`);
    // Glued onto the origin these became another host: http://localhost@evil.example/p.png.
    expect(ownImageSrc('@evil.example/p.png')).toBeUndefined();
    expect(ownImageSrc('//evil.example/p.png')).toBeUndefined();
    expect(ownImageSrc('https://evil.example/p.png')).toBeUndefined();
    expect(ownImageSrc('/api/images\\@evil.example')).toBeUndefined();
    expect(ownImageSrc(null)).toBeUndefined();
  });

  it('links a website only when it is http(s)', () => {
    expect(websiteHref('https://example.com/a')).toBe('https://example.com/a');
    expect(websiteHref('example.com')).toBe('https://example.com');
    expect(websiteHref('javascript:alert(1)')).toBeNull();
    expect(websiteHref('data:text/html,x')).toBeNull();
    expect(websiteHref('')).toBeNull();
  });

  // A page's returnTo is a path on this app, kept whole, or nothing.
  it('goes back only to a path on this app', () => {
    expect(sameOriginPath('/transactions?search=a%26b&page=2#top')).toBe('/transactions?search=a%26b&page=2#top');
    expect(sameOriginPath('/accounts/a-1')).toBe('/accounts/a-1');
    for (const elsewhere of ['https://evil.example/x', '//evil.example', '/\\evil.example', '/\t/evil.example', 'javascript:alert(1)', 'transactions', '', null, undefined]) {
      expect(sameOriginPath(elsewhere)).toBeNull();
    }
  });

  it("refuses a path that parses to another host's once its dot segments are gone", () => {
    // Each parses on this origin to the path //evil.example, which a link reads as another host.
    for (const dotted of [
      '/.//evil.example', '/..//evil.example', '/%2e//evil.example', '/%2E%2E//evil.example',
      '/a/..//evil.example', '/./\\evil.example', '/.\t//evil.example', '/.\n/\\evil.example',
    ]) {
      expect(sameOriginPath(dotted)).toBeNull();
    }
    // Same-origin paths that only look odd are kept.
    expect(sameOriginPath('/%2F/evil.example')).toBe('/%2F/evil.example');
    expect(sameOriginPath('/x#//evil.example')).toBe('/x#//evil.example');
    expect(sameOriginPath('/x?next=//evil.example')).toBe('/x?next=//evil.example');
    expect(sameOriginPath('/budgets/./items')).toBe('/budgets/items');
  });
});
