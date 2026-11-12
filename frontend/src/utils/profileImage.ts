/**
 * Resolve a stored profile-image path (e.g. "/uploads/abc.png") to a URL the
 * browser can load. The path is used as is, so the image loads from the app's own
 * origin: the reverse proxy routes /uploads to the backend in production, and the
 * Vite dev server proxies it in development. The backend only lets its own origin
 * embed what it serves (Cross-Origin-Resource-Policy: same-origin). Returns null
 * when there's no image so callers can fall back to an initial / icon.
 */
export const profileImageUrl = (path: string | null | undefined): string | null => {
  if (!path) return null;
  return path;
};
