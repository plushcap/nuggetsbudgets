/**
 * Thin HTTP client that forwards an authenticated request to the Nuggets REST API.
 *
 * Every MCP tool gets a client instance scoped to the inbound Bearer token, so
 * user scoping and audit logging happen on the backend exactly as they do for
 * the website.
 *
 * The client only ever calls this API's own routes: a path must be
 * an `/api/...` path, which rules out an absolute URL (the token would go to another
 * host), and it must reach the server as written. The URL parser resolves `.` and `..`
 * segments, raw or percent-encoded, so `/api/annotations/../admin/...` would otherwise
 * call `/api/admin/...` with the caller's token. Tools build paths with {@link apiPath},
 * which percent-encodes each interpolated value as one path segment.
 */
export interface NuggetsApiClientOptions {
  baseUrl: string;
  authorization: string; // Full header value, e.g. "Bearer eyJ..."
  fetchImpl?: typeof fetch | undefined;
  /** The inbound MCP request's id, sent as `x-request-id` so the API's logs of these calls carry it. */
  requestId?: string | undefined;
}

/** A request's query: built text (`queryString`'s, '' or '?a=1'), or its values. */
export type QueryInput = string | Record<string, string | number | boolean | undefined>;

export class NuggetsApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
    public body: unknown
  ) {
    super(message);
    this.name = 'NuggetsApiError';
  }
}

/** A path the client won't call: not one of the API's own, or one the URL parser would rewrite. */
export class RefusedPathError extends Error {
  constructor(path: string, reason: string) {
    super(`Refused to call ${JSON.stringify(path)}: ${reason}`);
    this.name = 'RefusedPathError';
  }
}

/**
 * Build an API path from a template, percent-encoding each interpolated value as a single
 * path segment: apiPath`/api/annotations/${uuid}`. A value can't add a segment (`/` is
 * encoded), start a query (`?`, `#`), or be a `.`/`..` segment, which are refused because
 * percent-encoding leaves dots alone.
 */
export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  const segments = values.map((value) => {
    const text = String(value);
    if (text === '' || text === '.' || text === '..') {
      throw new RefusedPathError(strings.join('…'), `${JSON.stringify(text)} is not a path segment`);
    }
    return encodeURIComponent(text);
  });
  // String.raw interleaves the template's parts with the encoded segments; given the cooked
  // parts as `raw`, it joins them as written, with no index that could miss.
  return String.raw({ raw: strings }, ...segments);
}

export class NuggetsApiClient {
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly basePath: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestId: string | undefined;

  constructor(opts: NuggetsApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    const base = new URL(this.baseUrl);
    this.origin = base.origin;
    this.basePath = base.pathname.replace(/\/$/, '');
    this.authorization = opts.authorization;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestId = opts.requestId;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: { query?: QueryInput | undefined; body?: unknown } = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      authorization: this.authorization,
      accept: 'application/json',
    };
    if (this.requestId) headers['x-request-id'] = this.requestId;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const res = await this.fetchImpl(url, { method, headers, ...(body !== undefined && { body }) });
    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON body; leave as text
      }
    }

    if (!res.ok) {
      const errBody = (parsed && typeof parsed === 'object' ? parsed : {}) as {
        error?: string;
        code?: string;
        message?: string;
      };
      throw new NuggetsApiError(
        res.status,
        errBody.code,
        errBody.message || errBody.error || `HTTP ${res.status}`,
        parsed
      );
    }

    return parsed as T;
  }

  /**
   * GET `path`. `query` is the text `queryString(schema, values)` from @nuggets/shared builds
   * with the route's own query schema, or its values as a record.
   */
  get<T = unknown>(path: string, query?: QueryInput) {
    return this.request<T>('GET', path, { query });
  }

  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('POST', path, { body });
  }

  put<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, { body });
  }

  patch<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, { body });
  }

  /**
   * The URL for an API path, or a RefusedPathError when the path isn't one of the API's
   * own routes exactly as written. Query parameters go in `query`, never in the path.
   */
  private buildUrl(path: string, query?: QueryInput): string {
    if (!path.startsWith('/api/')) {
      throw new RefusedPathError(path, 'tools call the Nuggets API by its path, which starts with /api/');
    }
    if (path.slice(1).split('/').some((segment) => segment === '')) {
      throw new RefusedPathError(path, 'it has an empty path segment');
    }
    const url = new URL(`${this.baseUrl}${path}`);
    // The parser resolves dot segments (also as %2e), turns `\` into `/`, and splits off
    // `?` and `#`: any of those leaves a pathname other than the one written.
    if (url.origin !== this.origin || url.pathname !== `${this.basePath}${path}`) {
      throw new RefusedPathError(path, `it would reach ${url.pathname}${url.search}, not the route it names`);
    }
    if (typeof query === 'string') {
      // queryString's text: '' or '?a=1&b=2'. Read as parameters, so it can't carry a fragment.
      for (const [key, value] of new URLSearchParams(query)) url.searchParams.append(key, value);
    } else if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}
