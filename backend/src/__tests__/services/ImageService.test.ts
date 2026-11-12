import { describe, it, expect } from 'vitest';
import {
  imageUrl,
  mimeTypeForFilename,
  isAllowedImageMimeType,
  deleteImageByUrl,
} from '../../services/ImageService.js';

/**
 * Pure-unit tests for the ImageService URL/MIME helpers — no database needed.
 * The store/serve round-trip (RLS isolation, bytea) is exercised against a real
 * DB in CI / manual validation, not here.
 */
describe('ImageService helpers', () => {
  it('builds the public image URL from a uuid', () => {
    expect(imageUrl('018f0a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b')).toBe(
      '/api/images/018f0a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b'
    );
  });

  it('maps known extensions to safe raster MIME types', () => {
    expect(mimeTypeForFilename('a.jpg')).toBe('image/jpeg');
    expect(mimeTypeForFilename('a.JPEG')).toBe('image/jpeg');
    expect(mimeTypeForFilename('/uploads/x.png')).toBe('image/png');
    expect(mimeTypeForFilename('logo.webp')).toBe('image/webp');
    expect(mimeTypeForFilename('anim.gif')).toBe('image/gif');
  });

  it('returns null for unknown / unsafe extensions', () => {
    expect(mimeTypeForFilename('evil.svg')).toBeNull();
    expect(mimeTypeForFilename('doc.pdf')).toBeNull();
    expect(mimeTypeForFilename('noext')).toBeNull();
  });

  it('accepts only raster image MIME types (never SVG)', () => {
    expect(isAllowedImageMimeType('image/jpeg')).toBe(true);
    expect(isAllowedImageMimeType('image/png')).toBe(true);
    expect(isAllowedImageMimeType('image/svg+xml')).toBe(false);
    expect(isAllowedImageMimeType('text/html')).toBe(false);
  });

  it('deleteImageByUrl is a no-op for null / legacy / non-matching values (never touches the db)', async () => {
    // A db that would throw if used — proves these inputs short-circuit before any query.
    const explodingDb = {
      deleteFrom() {
        throw new Error('db should not be touched');
      },
    } as never;

    await expect(deleteImageByUrl(explodingDb, null)).resolves.toBeUndefined();
    await expect(deleteImageByUrl(explodingDb, undefined)).resolves.toBeUndefined();
    await expect(deleteImageByUrl(explodingDb, '/uploads/account-images/x.png')).resolves.toBeUndefined();
    await expect(deleteImageByUrl(explodingDb, '/api/images/not-a-uuid')).resolves.toBeUndefined();
  });
});
