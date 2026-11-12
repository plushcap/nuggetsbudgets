/**
 * Outbound requests to SimpleFin.
 *
 * The setup token an org admin pastes is a URL the server POSTs to, and the access URL
 * that answer contains is one the server then GETs with the bank credentials. Unchecked,
 * either could point at a host on the server's own network: the router, Docker services,
 * a cloud metadata endpoint. So every request checks its URL first: https only, and only
 * to a SimpleFin bridge host. It also doesn't follow redirects (a redirect could lead
 * anywhere), times out, and caps the size of the answer.
 *
 * The bridges SimpleFin runs are allowed by default. An operator with their own bridge
 * adds it to SIMPLEFIN_ALLOWED_HOSTS (comma-separated; `host` for port 443, `host:port`
 * for another port).
 */

import { config } from '../config.js';

const DEFAULT_ALLOWED_HOSTS = ['bridge.simplefin.org', 'beta-bridge.simplefin.org'];

/** A SimpleFin URL that isn't https or isn't on an allowed host. */
export class SimpleFinUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimpleFinUrlError';
  }
}

/** The answer was larger than the request allows. */
export class SimpleFinResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`SimpleFin answered with more than ${maxBytes} bytes`);
    this.name = 'SimpleFinResponseTooLargeError';
  }
}

export function allowedSimpleFinHosts(): Set<string> {
  const extra = (config().SIMPLEFIN_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_HOSTS, ...extra]);
}

/** `raw` parsed, and the allowed host it names, as the allowlist spells it; else a SimpleFinUrlError. */
function parseAllowed(raw: string | URL): { url: URL; allowedHost: string } {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new SimpleFinUrlError('Not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new SimpleFinUrlError('SimpleFin URLs must use https');
  }
  // URL normalizes the host to lowercase and drops the default port (443).
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const allowedHost = [...allowedSimpleFinHosts()].find((allowed) => allowed === host);
  if (allowedHost === undefined) {
    throw new SimpleFinUrlError(`${url.hostname} is not an allowed SimpleFin host (SIMPLEFIN_ALLOWED_HOSTS)`);
  }
  return { url, allowedHost };
}

/** Parse `raw` and throw a SimpleFinUrlError unless it may be requested. */
export function assertSimpleFinUrl(raw: string | URL): URL {
  return parseAllowed(raw).url;
}

export interface SimpleFinRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Give up after this long. */
  timeoutMs?: number;
  /** Refuse an answer larger than this. */
  maxBytes?: number;
}

export interface SimpleFinResponse {
  status: number;
  ok: boolean;
  text: string;
}

/**
 * Request a SimpleFin URL (without credentials in it; send them in `headers`). Throws
 * SimpleFinUrlError before connecting if the URL isn't allowed, a TimeoutError when it
 * times out, SimpleFinResponseTooLargeError for an oversized answer, and a TypeError for
 * a redirect or a network failure.
 */
export async function simplefinRequest(raw: string | URL, options: SimpleFinRequest = {}): Promise<SimpleFinResponse> {
  const { url, allowedHost } = parseAllowed(raw);
  const { method = 'GET', headers, timeoutMs = 15_000, maxBytes = 1024 * 1024 } = options;
  // The host connected to is the allowlist's own entry; only the path and query come from
  // `raw`. Written out after the host, a path can't name another one (`//host` included).
  const response = await fetch(`https://${allowedHost}${url.pathname}${url.search}`, {
    method,
    ...(headers && { headers }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, ok: response.ok, text: await readCapped(response, maxBytes) };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new SimpleFinResponseTooLargeError(maxBytes);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new SimpleFinResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
