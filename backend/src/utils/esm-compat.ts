/**
 * ESM Compatibility Utilities
 *
 * Provides __dirname and __filename equivalents for ES modules
 */

import { fileURLToPath } from 'url';
import { dirname } from 'path';

/**
 * Get the current directory path (__dirname equivalent)
 * Usage: const __dirname = getDirname(import.meta.url);
 */
export function getDirname(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
