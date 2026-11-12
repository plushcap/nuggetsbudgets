import { safeWebsiteHref } from '@nuggets/shared';

/**
 * URLs a member stored that other members' browsers open or load.
 * The server checks new values; these guard values saved before it did.
 */

/**
 * The link to open for a merchant's website: an http(s) URL (a bare host gets https),
 * or null to show the stored text without a link.
 */
export const websiteHref = (value: string | null | undefined): string | null => safeWebsiteHref(value);

/**
 * An image path the app serves (`/api/images/<uuid>`, or a legacy `/uploads/…`) as a
 * URL on this origin, or undefined for anything else. Gluing a stored value onto the
 * origin turned `@evil.example/p.png` into `https://app@evil.example/p.png`, a request
 * to another host from every member who opened the page.
 */
export const ownImageSrc = (path: string | null | undefined): string | undefined =>
  path && /^\/(api\/images|uploads)\/[^\\]*$/.test(path) ? `${window.location.origin}${path}` : undefined;

/**
 * A path on this app to send the person back to (a page's `returnTo`), or null for anything
 * else: another site's URL, `//host` or `/\host` (which browsers read as another host), a
 * scheme (`javascript:`), or a relative path. The router hands a path it can't push to
 * `location.assign`, so `returnTo=//evil.example` left the app.
 *
 * The parsed path is checked too, not only its origin: parsing drops dot segments and reads a
 * backslash as a slash, so `/.//evil.example`, `/%2e//evil.example` or `/./\evil.example` parse
 * on this origin to the path `//evil.example`, which a link or the browser reads as another
 * host again.
 */
export const sameOriginPath = (value: string | null | undefined): string | null => {
  if (!value?.startsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  return url.origin === window.location.origin && !path.startsWith('//') ? path : null;
};
