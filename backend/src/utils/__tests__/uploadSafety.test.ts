import { describe, it, expect } from 'vitest';
import { validateHeaderValue } from 'node:http';
import { crc32 } from 'node:zlib';
import { sanitizeImage, sniffFileType, contentDisposition } from '../uploadSafety.js';
import { UploadRejectedError } from '../imageUpload.js';
import { gif, jpeg, jpegScan, jpegWithLaterMetadata, latin1, png, pngWithOrientation, webp } from '../../test/imageFixtures.js';

/** Upload sniffing, image metadata stripping and download names. */

const has = (data: Buffer, text: string) => data.includes(latin1(text));

describe('sniffFileType', () => {
  it('reads the type from the first bytes', () => {
    expect(sniffFileType(jpeg())).toBe('image/jpeg');
    expect(sniffFileType(png())).toBe('image/png');
    expect(sniffFileType(gif())).toBe('image/gif');
    expect(sniffFileType(webp())).toBe('image/webp');
    expect(sniffFileType(latin1('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffFileType(Buffer.concat([Buffer.alloc(100, 0x20), latin1('%PDF-1.4')]))).toBe('application/pdf');
    expect(sniffFileType(latin1('PK\x03\x04rest'))).toBe('application/zip');
    expect(sniffFileType(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe('application/x-ole-storage');
    expect(sniffFileType(latin1('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffFileType(latin1('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});

describe('sanitizeImage', () => {
  it('removes a JPEG’s EXIF, XMP and comments, keeps its colour profile, scan and orientation', () => {
    const { mimeType, data } = sanitizeImage(jpeg(6));
    expect(mimeType).toBe('image/jpeg');
    expect(has(data, 'SECRET')).toBe(false);
    expect(has(data, 'JFIF')).toBe(true);
    expect(has(data, 'ICC_PROFILE')).toBe(true);
    expect(data.subarray(data.length - jpegScan.length).equals(jpegScan)).toBe(true);
    // The orientation is in an EXIF block of its own, which the browser reads.
    const at = data.indexOf(latin1('Exif\0\0'));
    expect(at).toBeGreaterThan(0);
    expect(data.subarray(at, at + 32).includes(Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 6]))).toBe(true);
  });

  it('removes metadata between a progressive JPEG’s scans, and what is appended after its end', () => {
    const { data } = sanitizeImage(jpegWithLaterMetadata());
    expect(has(data, 'SECRET') || has(data, 'Exif')).toBe(false);
    // Both scans and their table survive, stuffed bytes and restart marker included.
    expect(data.includes(Buffer.from([0x11, 0x22]))).toBe(true);
    expect(data.includes(Buffer.from([0x77, 0xff, 0x00, 0xff, 0xd3, 0x88]))).toBe(true);
    expect(data.includes(Buffer.from([0xff, 0xc4]))).toBe(true);
    expect(data.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    expect(data.indexOf(Buffer.from([0xff, 0xd8]), 2)).toBe(-1);
  });

  it('keeps a JPEG that ends inside its scan, as browsers show it', () => {
    const truncated = jpeg().subarray(0, jpeg().length - 2);
    expect(sanitizeImage(truncated).data.subarray(-3).equals(Buffer.from([0xff, 0x00, 0x56]))).toBe(true);
  });

  it('adds no EXIF to a JPEG that is upright', () => {
    expect(has(sanitizeImage(jpeg(1)).data, 'Exif')).toBe(false);
  });

  it('removes a PNG’s text, EXIF and time chunks and anything after IEND', () => {
    const { mimeType, data } = sanitizeImage(png());
    expect(mimeType).toBe('image/png');
    expect(has(data, 'SECRET')).toBe(false);
    expect(['tEXt', 'eXIf', 'tIME', 'caBX'].some((t) => has(data, t))).toBe(false);
    expect(has(data, 'IHDR') && has(data, 'IDAT') && has(data, 'gAMA')).toBe(true);
    expect(data.subarray(-8).equals(Buffer.concat([latin1('IEND'), Buffer.from([0xae, 0x42, 0x60, 0x82])]))).toBe(true);
  });

  it('removes a WebP’s EXIF and XMP chunks and their flags, and keeps the RIFF size right', () => {
    const { data } = sanitizeImage(webp());
    expect(has(data, 'SECRET') || has(data, 'EXIF') || has(data, 'XMP ')).toBe(false);
    expect(data.readUInt32LE(4)).toBe(data.length - 8);
    expect(data[20] & 0x0c).toBe(0);
    expect(data[20] & 0x10).toBe(0x10);
    expect(has(data, 'VP8 ')).toBe(true);
  });

  it('removes a GIF’s comments and application data, keeping its looping', () => {
    const { data } = sanitizeImage(gif());
    expect(has(data, 'SECRET') || has(data, 'XMP DataXMP')).toBe(false);
    expect(has(data, 'NETSCAPE2.0')).toBe(true);
    expect(data[data.length - 1]).toBe(0x3b);
  });

  // Only a JPEG kept it; a phone's PNG or WebP turned on its side.
  it('keeps a PNG’s EXIF orientation, alone, in an eXIf chunk before its image data', () => {
    const { data } = sanitizeImage(pngWithOrientation(6));
    expect(has(data, 'SECRET')).toBe(false);
    const at = data.indexOf(latin1('eXIf'));
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(data.indexOf(latin1('IDAT')));
    const length = data.readUInt32BE(at - 4);
    const tiff = data.subarray(at + 4, at + 4 + length);
    expect(tiff.includes(Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 6]))).toBe(true);
    // A chunk whose CRC is right, which a reader checks.
    expect(data.readUInt32BE(at + 4 + length)).toBe(crc32(data.subarray(at, at + 4 + length)));
    // Upright: no EXIF at all.
    expect(has(sanitizeImage(pngWithOrientation(1)).data, 'eXIf')).toBe(false);
  });

  it('keeps a WebP’s EXIF orientation, alone, in an EXIF chunk, with its flag', () => {
    const { data } = sanitizeImage(webp(6));
    expect(has(data, 'SECRET') || has(data, 'XMP ')).toBe(false);
    expect(data.readUInt32LE(4)).toBe(data.length - 8);
    expect(data[20] & 0x08).toBe(0x08); // EXIF present
    expect(data[20] & 0x04).toBe(0); // no XMP
    const at = data.indexOf(latin1('EXIF'));
    expect(at).toBeGreaterThan(data.indexOf(latin1('VP8 ')));
    const tiff = data.subarray(at + 8, at + 8 + data.readUInt32LE(at + 4));
    expect(tiff.includes(Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 6]))).toBe(true);
    // Upright, or no orientation: no EXIF, and the flag off.
    for (const upright of [webp(1), webp()]) {
      const stripped = sanitizeImage(upright).data;
      expect(has(stripped, 'EXIF')).toBe(false);
      expect(stripped[20] & 0x0c).toBe(0);
    }
  });

  // Both were refused, and browsers show both.
  it('accepts a GIF without its trailer byte, and gives it one', () => {
    const noTrailer = gif().subarray(0, gif().length - 1);
    const { mimeType, data } = sanitizeImage(noTrailer);
    expect(mimeType).toBe('image/gif');
    expect(has(data, 'SECRET') || has(data, 'XMP DataXMP')).toBe(false);
    expect(data.equals(Buffer.concat([sanitizeImage(gif()).data.subarray(0, -1), Buffer.from([0x3b])]))).toBe(true);
    // Not one with no picture in it at all.
    expect(() => sanitizeImage(gif().subarray(0, 13))).toThrow(UploadRejectedError);
  });

  it('accepts a JPEG with stray bytes between its segments, and drops them', () => {
    const clean = sanitizeImage(jpeg(6)).data;
    const jfifEnd = 4 + jpeg(6).readUInt16BE(4);
    // Zero padding after the JFIF header, and stray text before the scan (FF 00 in it too).
    const strayText = latin1('SECRET stray');
    const padded = Buffer.concat([
      jpeg(6).subarray(0, jfifEnd),
      Buffer.from([0, 0]),
      jpeg(6).subarray(jfifEnd, jpeg(6).length - jpegScan.length),
      strayText, Buffer.from([0xff, 0x00, 0x41]),
      jpegScan,
    ]);
    const { mimeType, data } = sanitizeImage(padded);
    expect(mimeType).toBe('image/jpeg');
    expect(has(data, 'SECRET')).toBe(false);
    expect(data.equals(clean)).toBe(true);
    // Stray bytes and no picture at all: still refused.
    expect(() => sanitizeImage(Buffer.concat([Buffer.from([0xff, 0xd8]), latin1('SECRET only')]))).toThrow(UploadRejectedError);
  });

  it('refuses what isn’t an image, and an image it can’t read through', () => {
    expect(() => sanitizeImage(latin1('<svg onload="alert(1)"/>'))).toThrow(UploadRejectedError);
    expect(() => sanitizeImage(latin1('%PDF-1.4'))).toThrow(UploadRejectedError);
    expect(() => sanitizeImage(jpeg().subarray(0, 40))).toThrow(UploadRejectedError);
    expect(() => sanitizeImage(png().subarray(0, 30))).toThrow(UploadRejectedError);
  });
});

describe('contentDisposition', () => {
  it('names any file in a header Node accepts, with the exact name in filename*', () => {
    const value = contentDisposition('inline', '領収書 "May".pdf');
    expect(() => validateHeaderValue('Content-Disposition', value)).not.toThrow();
    expect(value).toBe(`inline; filename="___ _May_.pdf"; filename*=UTF-8''%E9%A0%98%E5%8F%8E%E6%9B%B8%20%22May%22.pdf`);
    // The bug: the raw name in the header made Node throw ERR_INVALID_CHAR.
    expect(() => validateHeaderValue('Content-Disposition', 'inline; filename="領収書.pdf"')).toThrow();
  });

  it('drops line breaks and control characters', () => {
    expect(contentDisposition('attachment', 'a\r\nSet-Cookie: x=y.pdf')).toBe(
      `attachment; filename="aSet-Cookie: x=y.pdf"; filename*=UTF-8''aSet-Cookie%3A%20x%3Dy.pdf`
    );
    expect(contentDisposition('attachment', '\n')).toBe(`attachment; filename="download"; filename*=UTF-8''download`);
  });
});
