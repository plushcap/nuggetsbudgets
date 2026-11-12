import { configFor, settingProblem } from '../config.js';

/**
 * Whether the backend's cookies are Secure, which also decides their SameSite and, for
 * the session and CSRF cookies, the `__Host-` prefix (it requires Secure).
 * Read on each call, so a test can change the environment.
 *
 * It followed NODE_ENV alone: any server not run with NODE_ENV=production (the
 * development stack, exposed at an https address say) sent its session cookie without
 * Secure and with SameSite=Lax. Now:
 *   - in production, always Secure (DOMAIN_URL must be https:// there, or http:// on
 *     localhost, which browsers treat as secure); COOKIE_SECURE=false is ignored, with a
 *     warning at startup (utils/productionConfig.ts);
 *   - elsewhere COOKIE_SECURE=true or false says, or else the scheme of DOMAIN_URL:
 *     Secure for https://, not for http:// (the dev stack at http://localhost:3000) or
 *     when it isn't set.
 * Secure cookies get SameSite=Strict and the `__Host-` names; the others SameSite=Lax and
 * the plain names, as development always had.
 *
 * The settings are read through config.ts (configFor), which parses COOKIE_SECURE.
 */
export function cookiesAreSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  const settings = configFor(env);
  if (settings.NODE_ENV === 'production') return true;
  if (settings.COOKIE_SECURE !== undefined) return settings.COOKIE_SECURE;
  const domain = settings.DOMAIN_URL?.trim();
  if (!domain) return false;
  try {
    return new URL(domain).protocol === 'https:';
  } catch {
    // Refused at startup (resolveWebAuthnConfig reads DOMAIN_URL too).
    return false;
  }
}

/** COOKIE_SECURE as set: true, false, or undefined when unset (or not true/false). */
export function cookieSecureSetting(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  return configFor(env).COOKIE_SECURE;
}

/** The startup problem with COOKIE_SECURE, if any: a value other than true or false. */
export function cookieSecureProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  return settingProblem('COOKIE_SECURE', env) ?? null;
}
