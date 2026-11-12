/**
 * URLs people type into the app, which other members' browsers then open or load.
 */

export const MAX_WEBSITE_URL_LENGTH = 2048;

/** `http://` or `https://` at the start, in any case. */
const HTTP_SCHEME = /^https?:\/\//i;
/** Some other scheme: `name:` not followed by a port number (so `example.com:8080` isn't one). */
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

export type WebsiteUrlResult = { url: string; problem: null } | { url: null; problem: string };

/**
 * A website link as it may be stored: an http(s) URL with a host and no user name or
 * password in it (`https://user@evil.example` reads as another site's address). A bare
 * host or path (`example.com/help`) gets `https://`. The URL comes back as the browser
 * parser writes it (control characters and spaces removed or encoded), without the `/`
 * it adds to a bare origin.
 */
export function websiteUrlProblem(text: string): WebsiteUrlResult {
  const trimmed = text.trim();
  if (trimmed.length > MAX_WEBSITE_URL_LENGTH) {
    return { url: null, problem: `A website can be up to ${MAX_WEBSITE_URL_LENGTH} characters.` };
  }
  if (!HTTP_SCHEME.test(trimmed) && (trimmed.includes('://') || OTHER_SCHEME.test(trimmed) || trimmed.startsWith('//'))) {
    return { url: null, problem: 'A website starts with http:// or https://.' };
  }
  let url: URL;
  try {
    url = new URL(HTTP_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { url: null, problem: 'This isn’t a website address.' };
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return { url: null, problem: 'A website starts with http:// or https://.' };
  }
  if (url.username || url.password) {
    return { url: null, problem: 'A website address can’t have a user name or password in it.' };
  }
  const bareOrigin = url.pathname === '/' && !url.search && !url.hash && !trimmed.endsWith('/');
  return { url: bareOrigin ? url.href.slice(0, -1) : url.href, problem: null };
}

/**
 * The link to open for a stored website, or null when it isn't an http(s) URL (a value
 * saved before websites were checked could be anything): show such a value as text.
 */
export function safeWebsiteHref(value: string | null | undefined): string | null {
  if (!value) return null;
  const result = websiteUrlProblem(value);
  return result.problem ? null : result.url;
}
