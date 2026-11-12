import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import type { FileFilterCallback } from 'multer';
import { imageFileFilter, isAllowedImageExtension, safeImageExtension } from '../imageUpload.js';

/**
 * Image uploads used to validate only the client-supplied MIME
 * type while keeping the attacker's original extension, so a file named
 * `evil.html` sent as `image/png` was stored as `.html` and later served from
 * our origin as executable content (stored XSS). The filter must now require an
 * image extension AND an image MIME, and the stored extension must be derived
 * server-side.
 */
function runFilter(originalname: string, mimetype: string) {
  const cb = vi.fn() as unknown as FileFilterCallback;
  imageFileFilter(
    {} as Request,
    { originalname, mimetype } as Express.Multer.File,
    cb
  );
  return cb as unknown as ReturnType<typeof vi.fn>;
}

describe('imageFileFilter', () => {
  it('accepts a real image (matching extension and MIME)', () => {
    const cb = runFilter('photo.png', 'image/png');
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('accepts case-insensitive extensions', () => {
    const cb = runFilter('PHOTO.JPG', 'image/jpeg');
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('rejects an HTML payload disguised with an image MIME (the XSS vector)', () => {
    const cb = runFilter('evil.html', 'image/png');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(cb.mock.calls[0][1]).toBeUndefined();
  });

  it('rejects SVG (an image type that can carry script)', () => {
    const cb = runFilter('logo.svg', 'image/svg+xml');
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('rejects an image extension with a non-image MIME', () => {
    const cb = runFilter('x.png', 'text/html');
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('uses the final extension of a double-extension name', () => {
    // evil.php.png -> extname is .png, MIME image/png -> allowed (served as image)
    const cb = runFilter('evil.php.png', 'image/png');
    expect(cb).toHaveBeenCalledWith(null, true);
  });
});

describe('safeImageExtension', () => {
  it('returns a lower-cased allowed extension', () => {
    expect(safeImageExtension('Photo.JPEG')).toBe('.jpeg');
  });

  it('falls back to .png for anything not on the allow-list', () => {
    expect(safeImageExtension('evil.html')).toBe('.png');
    expect(safeImageExtension('noext')).toBe('.png');
    expect(safeImageExtension('logo.svg')).toBe('.png');
  });
});

describe('isAllowedImageExtension', () => {
  it('accepts image extensions and rejects executable ones', () => {
    expect(isAllowedImageExtension('.webp')).toBe(true);
    expect(isAllowedImageExtension('.PNG')).toBe(true);
    expect(isAllowedImageExtension('.html')).toBe(false);
    expect(isAllowedImageExtension('.svg')).toBe(false);
  });
});
