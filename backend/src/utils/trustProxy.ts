/**
 * TRUST_PROXY: which proxies in front of the app to believe about the client's address.
 * The sign-in rate limits are per address, so with the wrong setting
 * either every client behind the proxy shares one bucket (one attacker blocks everyone)
 * or a client can name any address it likes in X-Forwarded-For.
 *
 * - unset, `false` or `0`: trust none; req.ip is the connecting address.
 * - `true` or a number of hops (`1`, `2`, ...): trust that many proxies, counted back from
 *   the app (`true` is 1: a reverse proxy such as Caddy). Behind a CDN and a reverse
 *   proxy, that is 2.
 * - a comma-separated list of addresses, CIDR ranges or Express's names (`loopback`,
 *   `linklocal`, `uniquelocal`): trust proxies at those addresses.
 *
 * Anything else is refused with an error in the log and trusts none, as before.
 */
import { isIP } from 'net';
import type { Request, Response, NextFunction } from 'express';
import logger from './logger.js';
import { config } from '../config.js';

export type TrustProxySetting = false | number | string[];

const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isAddressOrRange(entry: string): boolean {
  if (NAMED.has(entry)) return true;
  const [address = '', bits, extra] = entry.split('/');
  if (extra !== undefined) return false;
  const family = isIP(address);
  if (!family) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return /^\d+$/.test(bits) && n >= 0 && n <= (family === 4 ? 32 : 128);
}

export function parseTrustProxy(raw: string | undefined): TrustProxySetting | { invalid: string } {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '' || value === 'false' || value === '0') return false;
  if (value === 'true') return 1;
  if (/^\d+$/.test(value)) return Number(value);
  const entries = value.split(',').map((e) => e.trim()).filter(Boolean);
  if (entries.length > 0 && entries.every(isAddressOrRange)) return entries;
  return { invalid: raw ?? '' };
}

let reportedInvalid: string | undefined;

/** The setting from TRUST_PROXY, logging an error (once) for one it can't use. */
export function resolveTrustProxy(raw: string | undefined = config().TRUST_PROXY): TrustProxySetting {
  const parsed = parseTrustProxy(raw);
  if (parsed !== false && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (reportedInvalid !== parsed.invalid) {
      reportedInvalid = parsed.invalid;
      logger.error(
        { TRUST_PROXY: parsed.invalid },
        'TRUST_PROXY must be true/false, a number of proxies, or a list of proxy addresses or CIDR ranges; trusting no proxy'
      );
    }
    return false;
  }
  return parsed;
}

/**
 * With no proxy trusted, warn once when a request arrives through one (it carries
 * X-Forwarded-For): every client then shares the proxy's address, and its rate limits.
 */
export function warnOnUntrustedForwarding() {
  let warned = false;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!warned && req.headers['x-forwarded-for'] !== undefined) {
      warned = true;
      logger.warn(
        { remoteAddress: req.socket?.remoteAddress },
        'A request arrived through a proxy (X-Forwarded-For) but TRUST_PROXY is off, so every client shares the proxy\'s address and its sign-in rate limits. Set TRUST_PROXY to the number of proxies in front of Nuggets.'
      );
    }
    next();
  };
}
