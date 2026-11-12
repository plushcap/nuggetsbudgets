import type { Request } from 'express';

/**
 * Extract the inbound Authorization header verbatim so the MCP layer can
 * forward it to the Nuggets REST API. The backend does the real verification.
 */
export function extractAuthorization(req: Request): string | null {
  const raw = req.headers['authorization'];
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value.trim()) return null;
  return value;
}
