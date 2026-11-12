// Shared validation for user-uploaded image files.
//
// Uploaded images are written to disk under `uploads/` and served back from the
// app's own origin. `express.static` sets the response Content-Type from the
// on-disk file extension, so a file stored with an executable extension (.html,
// .svg) is served as that type and — being same-origin — can run script under
// our CSP. The client-supplied MIME type is not trustworthy on its own.
//
// Therefore every image upload must be validated on BOTH the extension and the
// MIME type, and stored with a safe, server-derived extension. SVG is excluded
// deliberately: it is an image type that can carry <script>.

import path from 'path';
import type { Request } from 'express';
import type { FileFilterCallback } from 'multer';

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * An upload a file filter refused (wrong type). The global error handler answers it
 * 400 with this message; a plain Error from a filter used to become a 500.
 */
export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadRejectedError';
  }
}

/**
 * multer `limits` for a form with one image (an account, goal, merchant or profile
 * picture) and its other fields. multer's defaults bound nothing but
 * a field's size (1 MB): one request could carry any number of fields or files. The
 * account form, the largest, sends about 26 fields. A request over a limit is answered
 * 400 UPLOAD_REJECTED (413 for a file over its size), by answerError.
 */
export const IMAGE_UPLOAD_LIMITS = {
  fileSize: 5 * 1024 * 1024,
  files: 1,
  fields: 50,
  parts: 51,
  fieldSize: 64 * 1024,
} as const;

/** True when `ext` (e.g. ".png") is an allowed, non-executable image extension. */
export function isAllowedImageExtension(ext: string): boolean {
  return ALLOWED_IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * multer `fileFilter` that accepts a file only when its extension AND its MIME
 * type are both a recognised raster image. Reject anything else (including
 * image/svg+xml) so an attacker cannot smuggle an .html/.svg/.js payload past a
 * MIME-only check.
 */
export function imageFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
): void {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_IMAGE_EXTENSIONS.has(ext) && ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new UploadRejectedError('Only image files (JPG, PNG, GIF, WebP) are allowed'));
  }
}

/**
 * A safe, lower-cased image extension derived from the original filename. Never
 * trust the raw `originalname` extension for the on-disk name — normalise it to
 * a known-good value (defaulting to .png) so the stored file is always served as
 * a harmless image type. Pair with {@link imageFileFilter}.
 */
export function safeImageExtension(originalname: string): string {
  const ext = path.extname(originalname).toLowerCase();
  return ALLOWED_IMAGE_EXTENSIONS.has(ext) ? ext : '.png';
}
