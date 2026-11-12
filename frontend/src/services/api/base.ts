/**
 * API Base Module - Shared HTTP Utilities
 *
 * This module provides the foundation for all API communication:
 * - Configuration (API_BASE_URL)
 * - Request headers
 * - Response handling (including error handling)
 * - Session management (401 handling)
 *
 * Authentication is handled via httpOnly session cookies,
 * which are automatically sent with each request via credentials: 'include'
 */

import { logger } from '../../utils/logger';
import { config } from '../../config/environment';

import { REQUEST_ID_HEADER, type ApiErrorBody } from '@nuggets/shared';

/**
 * What the API helpers reject with on an error answer. The body is the API's error shape
 * (`ApiErrorBody`: `{ error, code, requestId, message? }`), kept whole on `response.data`.
 */
export type ApiError = Error & {
  status?: number;
  statusText?: string;
  /** The machine-readable reason (`VALIDATION_ERROR`, `NOT_FOUND`, ...): branch on this. */
  code?: string | undefined;
  /** The request's id, from the body or the X-Request-Id header: the server log has it. */
  requestId?: string | undefined;
  response?: { data?: unknown };
  details?: unknown;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * The error for a failed answer, from its parsed JSON body (`undefined` when it had none).
 *
 * Its message is the server's reason, `message` before `error` (validation puts the
 * field's problem in `message`), in Ledger wording; without either, the status line. A
 * server error (5xx) also names the request's id, so whoever sees the toast can quote it
 * and the operator can find the request's log lines; its reason is generic by design.
 */
export const apiErrorFrom = (response: Response, errorData?: Record<string, unknown>): ApiError => {
  const body = errorData as Partial<ApiErrorBody> | undefined;
  const reason = nonEmptyString(body?.message) ?? nonEmptyString(body?.error);
  const requestId = nonEmptyString(body?.requestId) ?? nonEmptyString(response.headers?.get?.(REQUEST_ID_HEADER));
  const fallback = response.status === 403 ? 'Access denied' : `HTTP ${response.status}: ${response.statusText}`;
  let message = toLedgerWording(reason ?? fallback);
  if (response.status >= 500 && requestId) message = `${message} (reference ${requestId})`;

  const error = new Error(message) as ApiError;
  error.status = response.status;
  error.statusText = response.statusText;
  error.code = nonEmptyString(body?.code);
  error.requestId = requestId;
  if (errorData) {
    error.response = { data: errorData };
    error.details = errorData.details ?? null;
  }
  return error;
};

/**
 * Reject as {@link handleResponse} does when `response` failed, else return. For calls that
 * read the body some other way (a file download's blob).
 */
export const assertOk = async (response: Response): Promise<void> => {
  if (!response.ok) await handleResponse<never>(response);
};

/**
 * Thrown by {@link handleResponse} on a 401. Callers (and the central React
 * Query error handler) can recognize it by `name` and skip their own error
 * toast — AuthContext owns the "session expired" notification + redirect via
 * the `session-expired` event that is dispatched alongside this rejection.
 *
 * This replaces the old behavior of returning a never-resolving promise on
 * 401, which left every in-flight query/mutation hung in `isLoading` forever
 * (no error, no retry, no render).
 */
export class SessionExpiredError extends Error {
  status = 401;
  constructor() {
    super('Your session has expired');
    this.name = 'SessionExpiredError';
  }
}

/** True when an error is the shared session-expiry rejection. */
export const isSessionExpiredError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'SessionExpiredError';

/**
 * Translate backend error wording for display. The backend is multi-tenant
 * internally and its error text calls the isolation unit a "tenant"; the UI only
 * ever calls it a "Ledger" (see CLAUDE.md — "the isolation unit is a `tenant`
 * (the UI says Ledger)"). Users must never see "tenant", so rewrite the whole
 * word in any message we surface as an Error.message. The machine-readable
 * `code` on `response.data` is left untouched for callers that branch on it.
 */
export const toLedgerWording = (message: string): string =>
  message
    .replace(/\bTenants\b/g, 'Ledgers')
    .replace(/\bTenant\b/g, 'Ledger')
    .replace(/\btenants\b/g, 'ledgers')
    .replace(/\btenant\b/g, 'ledger');

/**
 * Base API URL for all requests
 * Uses centralized environment configuration for portable URL handling
 */
export const API_BASE_URL = config.apiBaseUrl;

/**
 * Read the double-submit CSRF token from the (non-httpOnly) csrf_token cookie.
 * The backend issues this cookie; we echo it in the X-CSRF-Token header so the
 * server can verify the pair on cookie-authenticated, state-changing requests.
 */
export const getCsrfToken = (): string | undefined => {
  // Production names it __Host-csrf_token; right after an upgrade the browser may
  // still hold the old csrf_token too, whose value no longer matches the session.
  const match =
    document.cookie.match(/(?:^|;\s*)__Host-csrf_token=([^;]+)/) ?? document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
};

/**
 * CSRF header alone (for FormData requests, which must not set Content-Type).
 */
const csrfHeaders = (): Record<string, string> => {
  const csrf = getCsrfToken();
  return csrf ? { 'X-CSRF-Token': csrf } : {};
};

/**
 * Get headers for API requests
 * No longer includes Authorization header - session is in httpOnly cookie
 */
export const getAuthHeaders = (): HeadersInit => {
  return {
    'Content-Type': 'application/json',
    ...csrfHeaders(),
  };
};

/**
 * Handle API responses with comprehensive error handling
 *
 * Features:
 * - Session expiry detection (401) with custom event dispatch
 * - Enhanced error objects with status codes and details
 * - 204 No Content handling for DELETE operations
 * - JSON parsing with fallback error handling
 *
 * @param response - Fetch API Response object
 * @returns Parsed JSON response data
 * @throws Enhanced Error with status, statusText, and details properties
 */
export const handleResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    // Handle authentication errors - 401 means session is invalid/expired
    if (response.status === 401) {
      // Dispatch session expired event to trigger logout and toast
      // (AuthContext listens, debounced, and owns the redirect + notification).
      window.dispatchEvent(new CustomEvent('session-expired'));

      // Reject with a recognizable error so callers settle instead of hanging.
      // React Query's central onError skips the toast for this error type.
      throw new SessionExpiredError();
    }

    let errorData: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = await response.json();
      errorData = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      errorData = undefined;
    }
    throw apiErrorFrom(response, errorData);
  }

  // Handle 204 No Content responses (like DELETE operations)
  if (response.status === 204) {
    return undefined as T;
  }

  // Read the body as text first, then JSON.parse it ourselves. This is
  // behaviorally identical to response.json() for valid JSON, but lets us
  // surface WHY a 2xx body failed to parse — an empty body, an HTML page
  // (e.g. an SPA/proxy fallback served with a 200), or truncated JSON all
  // land here and were previously indistinguishable behind a bare
  // "Failed to parse response JSON". The context is critical for diagnosing
  // it in production (server logs only show the 200; the bad body is invisible).
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = response.headers.get('content-type') ?? 'unknown';
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    const detail = snippet ? `: ${snippet}` : ' (empty body)';
    logger.error(
      { url: response.url, status: response.status, contentType, bodyLength: text.length, snippet },
      'Failed to parse response JSON',
    );
    throw new Error(
      `Failed to parse response JSON [${response.status} ${contentType}]${detail}`,
    );
  }
};

/**
 * Generic GET request helper
 *
 * @param endpoint - API endpoint (relative to API_BASE_URL)
 * @returns Parsed response data
 */
export const apiGet = async <T>(endpoint: string): Promise<T> => {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'GET',
      headers: getAuthHeaders(),
      credentials: 'include', // Include session cookie
    });
    return await handleResponse<T>(response);
  } catch (error) {
    logger.error({ err: error, endpoint, method: 'GET' }, 'API GET request failed');
    throw error;
  }
};

/**
 * Generic POST request helper
 *
 * @param endpoint - API endpoint (relative to API_BASE_URL)
 * @param data - Request body (will be JSON stringified)
 * @returns Parsed response data
 */
export const apiPost = async <T>(endpoint: string, data?: unknown): Promise<T> => {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: getAuthHeaders(),
      credentials: 'include', // Include session cookie
      // null, not a spread: no body, and the API contract test reads the call (apiCallScanner).
      body: data ? JSON.stringify(data) : null,
    });
    return await handleResponse<T>(response);
  } catch (error) {
    logger.error({ err: error, endpoint, method: 'POST' }, 'API POST request failed');
    throw error;
  }
};

/**
 * Generic PUT request helper
 *
 * @param endpoint - API endpoint (relative to API_BASE_URL)
 * @param data - Request body (will be JSON stringified)
 * @returns Parsed response data
 */
export const apiPut = async <T>(endpoint: string, data?: unknown): Promise<T> => {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      credentials: 'include', // Include session cookie
      // null, not a spread: no body, and the API contract test reads the call (apiCallScanner).
      body: data ? JSON.stringify(data) : null,
    });
    return await handleResponse<T>(response);
  } catch (error) {
    logger.error({ err: error, endpoint, method: 'PUT' }, 'API PUT request failed');
    throw error;
  }
};

/**
 * Generic PATCH request helper
 *
 * @param endpoint - API endpoint (relative to API_BASE_URL)
 * @param data - Request body (will be JSON stringified)
 * @returns Parsed response data
 */
export const apiPatch = async <T>(endpoint: string, data?: unknown): Promise<T> => {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      credentials: 'include', // Include session cookie
      // null, not a spread: no body, and the API contract test reads the call (apiCallScanner).
      body: data ? JSON.stringify(data) : null,
    });
    return await handleResponse<T>(response);
  } catch (error) {
    logger.error({ err: error, endpoint, method: 'PATCH' }, 'API PATCH request failed');
    throw error;
  }
};

/**
 * Generic DELETE request helper
 *
 * @param endpoint - API endpoint (relative to API_BASE_URL)
 * @returns Parsed response data (may be undefined for 204 responses)
 */
export const apiDelete = async <T>(endpoint: string): Promise<T> => {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      credentials: 'include', // Include session cookie
    });
    return await handleResponse<T>(response);
  } catch (error) {
    logger.error({ err: error, endpoint, method: 'DELETE' }, 'API DELETE request failed');
    throw error;
  }
};

/**
 * POST request with FormData (for file uploads)
 * Does NOT set Content-Type header (browser sets it with boundary)
 *
 * @param endpoint - API endpoint (relative to API_BASE_URL)
 * @param formData - FormData object with files/fields
 * @returns Parsed response data
 */
export const apiPostFormData = async <T>(endpoint: string, formData: FormData): Promise<T> => {
  try {
    // DO NOT set Content-Type - browser will set it with multipart boundary
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: csrfHeaders(),
      credentials: 'include', // Include session cookie
      body: formData,
    });
    return await handleResponse<T>(response);
  } catch (error) {
    logger.error({ err: error, endpoint, method: 'POST (FormData)' }, 'API POST FormData request failed');
    throw error;
  }
};

/**
 * PUT request with FormData (for file uploads)
 * Does NOT set Content-Type header (browser sets it with boundary)
 *
 * @param endpoint - API endpoint (relative to API_BASE_URL)
 * @param formData - FormData object with files/fields
 * @returns Parsed response data
 */
export const apiPutFormData = async <T>(endpoint: string, formData: FormData): Promise<T> => {
  try {
    // DO NOT set Content-Type - browser will set it with multipart boundary
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'PUT',
      headers: csrfHeaders(),
      credentials: 'include', // Include session cookie
      body: formData,
    });
    return await handleResponse<T>(response);
  } catch (error) {
    logger.error({ err: error, endpoint, method: 'PUT (FormData)' }, 'API PUT FormData request failed');
    throw error;
  }
};
