/**
 * Centralized Environment Configuration for Portable Deployment
 * 
 * This module provides TRUE portability by detecting the runtime environment
 * instead of relying on build-time variables that get hardcoded.
 * 
 * Configuration Rules:
 * - Runtime domain detection: Uses window.location.origin in production
 * - Frontend uses relative URLs (/api/accounts, /uploads/image.jpg) 
 * - Reverse proxy routes /api/* to backend, everything else to frontend
 * - Single build works on ANY domain - truly portable
 */

/**
 * Detect if we're running in development mode
 * Check both NODE_ENV and if we're on localhost
 */
export const isDevelopment = (): boolean => {
  return process.env.NODE_ENV === 'development' || 
         (typeof window !== 'undefined' && window.location.hostname === 'localhost');
};

/**
 * Get the API base URL
 * Always use relative URLs so requests go through the proxy
 * Development: Vite proxy handles /api -> http://backend:5000/api
 * Production: Reverse proxy handles /api -> backend
 *
 * This ensures session cookies work correctly (same-origin requests)
 */
export const getApiBaseUrl = (): string => {
  // Always use relative URLs for session cookie compatibility
  return '/api';
};

/**
 * Get the backend base URL for assets (images, uploads, etc.)
 * Always use relative URLs so requests go through the proxy
 * Development: Vite proxy handles routing
 * Production: Reverse proxy serves assets
 */
export const getBackendBaseUrl = (): string => {
  // Always use relative URLs for consistency
  return '';
};

/**
 * Get the full domain URL (for external links, redirects, etc.)
 * Development: localhost with port
 * Production: Runtime domain detection from browser
 */
export const getDomainUrl = (): string => {
  if (isDevelopment()) {
    return 'http://localhost:3000';
  }
  
  // Production: Use actual domain from browser - truly portable!
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  
  // SSR fallback (shouldn't happen in our case)
  return 'https://localhost';
};

/**
 * Configuration object for easy access
 */
export const config = {
  apiBaseUrl: getApiBaseUrl(),
  backendBaseUrl: getBackendBaseUrl(), 
  domainUrl: getDomainUrl(),
  isDevelopment: isDevelopment(),
  
  // Debugging info
  env: {
    NODE_ENV: process.env.NODE_ENV,
    hostname: typeof window !== 'undefined' ? window.location.hostname : 'server',
  }
};

export default config;