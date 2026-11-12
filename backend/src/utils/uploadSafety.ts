import { UploadRejectedError } from './imageUpload.js';

/**
 * What an uploaded file's bytes are, and images without the metadata people don't mean
 * to share.
 *
 * - The extension and the browser's MIME type are whatever the uploader says; the first
 *   bytes say what the file is. A file whose bytes aren't the type its extension claims
 *   is refused.
 * - A photo carries metadata: EXIF (where it was taken, the camera, when), XMP, comments.
 *   Every member of a ledger can open its images and attachments, so it's removed before
 *   an image is stored. The image data itself is copied unchanged, nothing is decoded or
 *   re-encoded, and a JPEG, PNG or WebP keeps its EXIF orientation (in an EXIF block of its
 *   own) so a phone photo still shows the right way up.
 */

export type SniffedType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'application/pdf'
  /** A ZIP container: .docx, .xlsx. */
  | 'application/zip'
  /** An OLE2 compound file: .doc, .xls. */
  | 'application/x-ole-storage';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** The bytes needed by {@link sniffFileType}: a PDF's header may come anywhere in the first 1024. */
export const SNIFF_BYTES = 1024;

function startsWith(data: Buffer, prefix: Buffer | string, at = 0): boolean {
  const bytes = typeof prefix === 'string' ? Buffer.from(prefix, 'latin1') : prefix;
  return data.length >= at + bytes.length && data.subarray(at, at + bytes.length).equals(bytes);
}

/** The type the file's first bytes show, or null for none the app accepts. */
export function sniffFileType(head: Buffer): SniffedType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (startsWith(head, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(head, 'GIF87a') || startsWith(head, 'GIF89a')) return 'image/gif';
  if (startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8)) return 'image/webp';
  if (head.subarray(0, SNIFF_BYTES).includes(Buffer.from('%PDF-', 'latin1'))) return 'application/pdf';
  if (startsWith(head, 'PK\x03\x04')) return 'application/zip';
  if (startsWith(head, OLE_SIGNATURE)) return 'application/x-ole-storage';
  return null;
}

export const RASTER_IMAGE_TYPES: ReadonlySet<SniffedType> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

class Malformed extends Error {}

function need(data: Buffer, end: number): void {
  if (end > data.length) throw new Malformed('truncated');
}

// ---------------------------------------------------------------------------- JPEG

/** The EXIF orientation (1-8) in an APP1 Exif segment's payload, if it has a valid one. */
function exifOrientation(payload: Buffer): number | undefined {
  // "Exif\0\0", then a TIFF header: byte order, 42, offset of IFD0.
  if (!startsWith(payload, 'Exif\0\0')) return undefined;
  return tiffOrientation(payload.subarray(6));
}

/**
 * The EXIF orientation (1-8) in TIFF-structured EXIF data (a PNG eXIf chunk's or a WebP
 * EXIF chunk's payload; a JPEG's after its "Exif\0\0"), if it has a valid one.
 */
function tiffOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined;
  const little = startsWith(tiff, 'II');
  if (!little && !startsWith(tiff, 'MM')) return undefined;
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return undefined;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > tiff.length) return undefined;
    // Orientation: tag 0x0112, type SHORT (3), one value, held in the entry itself.
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

/** TIFF-structured EXIF data holding only an orientation. */
function orientationTiff(orientation: number): Buffer {
  return Buffer.concat([
    // Big-endian TIFF header, IFD0 at offset 8, one entry, then no next IFD.
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01]),
    Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]);
}

/** An APP1 segment holding only an EXIF orientation. */
function orientationSegment(orientation: number): Buffer {
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), orientationTiff(orientation)]);
  const header = Buffer.from([0xff, 0xe1, 0x00, 0x00]);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
}

/**
 * Where a scan's compressed data, starting at `pos`, ends: at the next marker that isn't a
 * stuffed 0xFF (FF 00), a restart marker or a fill byte. data.length when the file ends
 * inside the scan (a truncated JPEG, which browsers still show).
 */
function scanEnd(data: Buffer, pos: number): number {
  let at = pos;
  for (;;) {
    at = data.indexOf(0xff, at);
    if (at === -1 || at + 1 >= data.length) return data.length;
    const next = data.readUInt8(at + 1);
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
      at += next === 0xff ? 1 : 2;
      continue;
    }
    return at;
  }
}

/**
 * Where the next marker after stray bytes starting at `pos` begins (its first 0xFF), as a
 * decoder looks for it: past bytes that aren't 0xFF and stuffed FF 00 pairs. -1 when the
 * file has none.
 */
function nextMarker(data: Buffer, pos: number): number {
  let at = pos;
  for (;;) {
    at = data.indexOf(0xff, at);
    if (at === -1) return -1;
    let next = at + 1;
    while (next < data.length && data[next] === 0xff) next += 1;
    if (next >= data.length) return -1;
    if (data[next] !== 0x00) return at;
    at = next + 1;
  }
}

/**
 * A JPEG without its APPn and COM segments, other than the JFIF header (APP0), an ICC
 * colour profile (APP2) and Adobe's colour-transform marker (APP14), which change how it
 * looks, wherever they are (before the first scan or between a progressive JPEG's scans),
 * and without anything after its end marker (a phone's appended images, each with EXIF of
 * its own). The compressed data is copied as it is. Stray bytes between segments (padding
 * some writers leave; decoders skip it with a warning, and browsers show the picture) are
 * dropped, so they carry nothing through either.
 */
function stripJpeg(data: Buffer): Buffer {
  const out: Buffer[] = [data.subarray(0, 2)];
  let orientation: number | undefined;
  let orientationAt = -1;
  let sawScan = false;
  let pos = 2;
  for (;;) {
    if (pos >= data.length) break; // ended inside a scan, with no end marker
    if (data[pos] !== 0xff) {
      const next = nextMarker(data, pos);
      if (next === -1) {
        // Only stray bytes to the end: what came before is the picture, if it had one.
        if (!sawScan) throw new Malformed('no image data');
        break;
      }
      pos = next;
      continue;
    }
    need(data, pos + 2);
    // Fill bytes: any number of 0xFF before a marker.
    let marker = data.readUInt8(pos + 1);
    while (marker === 0xff) {
      pos += 1;
      need(data, pos + 2);
      marker = data.readUInt8(pos + 1);
    }
    if (marker === 0xd9) {
      out.push(data.subarray(pos, pos + 2));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(data.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    need(data, pos + 4);
    const length = data.readUInt16BE(pos + 2);
    if (length < 2) throw new Malformed('bad segment length');
    const end = pos + 2 + length;
    need(data, end);
    if (marker === 0xda) {
      // A scan: its header, then its compressed data, unchanged.
      sawScan = true;
      const dataEnd = scanEnd(data, end);
      out.push(data.subarray(pos, dataEnd));
      pos = dataEnd;
      continue;
    }
    const payload = data.subarray(pos + 4, end);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    let keep = !isApp && marker !== 0xfe;
    if (marker === 0xe0 && startsWith(payload, 'JFIF\0')) keep = true;
    if (marker === 0xe2 && startsWith(payload, 'ICC_PROFILE\0')) keep = true;
    if (marker === 0xee && startsWith(payload, 'Adobe')) keep = true;
    if (marker === 0xe1 && orientation === undefined) {
      orientation = exifOrientation(payload);
      if (orientation !== undefined) orientationAt = out.length;
    }
    if (keep) out.push(data.subarray(pos, end));
    pos = end;
  }
  if (orientation !== undefined && orientation !== 1) out.splice(orientationAt, 0, orientationSegment(orientation));
  return Buffer.concat(out);
}

// ----------------------------------------------------------------------------- PNG

/**
 * The ancillary chunks that change how the picture looks or animates, which are kept;
 * every other ancillary chunk goes: text (tEXt, zTXt, iTXt), EXIF (eXIf), the time (tIME),
 * and ones this list doesn't know (C2PA's caBX, a camera's own). Critical chunks (an
 * upper-case first letter: IHDR, PLTE, IDAT, IEND) are always kept.
 */
const PNG_KEPT_ANCILLARY = new Set([
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'hIST', 'sPLT',
  'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT',
]);

/** The orientation in an eXIf or EXIF chunk's payload: TIFF data, "Exif\0\0" first or not. */
function exifChunkOrientation(payload: Buffer): number | undefined {
  return tiffOrientation(startsWith(payload, 'Exif\0\0') ? payload.subarray(6) : payload);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** The CRC-32 a PNG chunk ends with (of its type and data). */
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8); // & 0xff: one of its 256 entries
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/**
 * A PNG with only the chunks that draw it, ending at IEND. An EXIF orientation other than
 * upright is kept, as for a JPEG: in an eXIf chunk of its own, after IHDR (so before the
 * image data, where browsers read it).
 */
function stripPng(data: Buffer): Buffer {
  const out: Buffer[] = [data.subarray(0, 8)];
  let orientation: number | undefined;
  let pos = 8;
  for (;;) {
    need(data, pos + 8);
    const length = data.readUInt32BE(pos);
    const type = data.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + length;
    need(data, end);
    const critical = /^[A-Z]/.test(type);
    if (critical || PNG_KEPT_ANCILLARY.has(type)) out.push(data.subarray(pos, end));
    if (type === 'eXIf' && orientation === undefined) orientation = exifChunkOrientation(data.subarray(pos + 8, end - 4));
    pos = end;
    if (type === 'IEND') break;
  }
  if (orientation !== undefined && orientation !== 1) out.splice(2, 0, pngChunk('eXIf', orientationTiff(orientation)));
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------- WebP

/** The WebP chunks that draw the picture; EXIF, XMP and anything unknown are dropped. */
const WEBP_KEPT_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

/** A WebP with only the chunks that draw it, its VP8X flags for EXIF and XMP cleared. */
function stripWebp(data: Buffer): Buffer {
  need(data, 12);
  const riffEnd = Math.min(data.length, 8 + data.readUInt32LE(4));
  const chunks: Buffer[] = [];
  let vp8x: Buffer | undefined;
  let orientation: number | undefined;
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const fourcc = data.toString('latin1', pos, pos + 4);
    const size = data.readUInt32LE(pos + 4);
    const end = pos + 8 + size + (size % 2);
    need(data, pos + 8 + size);
    const chunk = Buffer.from(data.subarray(pos, Math.min(end, data.length)));
    if (fourcc === 'VP8X' && size >= 1) {
      chunk.writeUInt8(chunk.readUInt8(8) & ~0x0c, 8); // XMP (0x04) and EXIF (0x08) present flags
      vp8x ??= chunk;
    }
    if (fourcc === 'EXIF' && orientation === undefined) orientation = exifChunkOrientation(data.subarray(pos + 8, pos + 8 + size));
    if (WEBP_KEPT_CHUNKS.has(fourcc)) chunks.push(chunk);
    pos = end;
  }
  // An orientation other than upright is kept, as for a JPEG: in an EXIF chunk of its own,
  // after the image data as the format has it, with its flag set again.
  if (orientation !== undefined && orientation !== 1 && vp8x) {
    vp8x.writeUInt8(vp8x.readUInt8(8) | 0x08, 8);
    const exif = orientationTiff(orientation);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(exif.length);
    chunks.push(Buffer.concat([Buffer.from('EXIF', 'latin1'), size, exif, exif.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]));
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

// ----------------------------------------------------------------------------- GIF

/** Application extensions that only control animation. */
const GIF_ANIMATION_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

/** Where the data sub-blocks starting at `pos` end (after their zero terminator). */
function skipSubBlocks(data: Buffer, pos: number): number {
  for (;;) {
    need(data, pos + 1);
    const size = data.readUInt8(pos);
    pos += 1 + size;
    if (size === 0) return pos;
  }
}

/**
 * A GIF without comment extensions and application extensions other than looping. One that
 * ends after a whole block without its trailer byte (browsers show it) gets the trailer.
 */
function stripGif(data: Buffer): Buffer {
  need(data, 13);
  const out: Buffer[] = [];
  const screenFlags = data.readUInt8(10);
  let pos = 13 + (screenFlags & 0x80 ? 3 * 2 ** ((screenFlags & 0x07) + 1) : 0);
  need(data, pos);
  out.push(data.subarray(0, pos));
  let sawImage = false;
  for (;;) {
    if (pos >= data.length) {
      if (!sawImage) throw new Malformed('no image');
      out.push(Buffer.from([0x3b]));
      break;
    }
    const introducer = data[pos];
    if (introducer === 0x3b) {
      out.push(data.subarray(pos, pos + 1));
      break;
    }
    if (introducer === 0x21) {
      need(data, pos + 2);
      const label = data[pos + 1];
      const end = skipSubBlocks(data, pos + 2);
      let keep = label !== 0xfe;
      if (label === 0xff) {
        need(data, pos + 3);
        const appId = data.toString('latin1', pos + 3, pos + 3 + Math.min(11, data.readUInt8(pos + 2)));
        keep = GIF_ANIMATION_APPS.has(appId);
      }
      if (keep) out.push(data.subarray(pos, end));
      pos = end;
    } else if (introducer === 0x2c) {
      sawImage = true;
      need(data, pos + 10);
      const imageFlags = data.readUInt8(pos + 9);
      let end = pos + 10 + (imageFlags & 0x80 ? 3 * 2 ** ((imageFlags & 0x07) + 1) : 0);
      need(data, end + 1);
      end = skipSubBlocks(data, end + 1); // after the LZW minimum code size
      out.push(data.subarray(pos, end));
      pos = end;
    } else {
      throw new Malformed('unknown GIF block');
    }
  }
  return Buffer.concat(out);
}

// --------------------------------------------------------------------------- public

const NOT_AN_IMAGE = 'This file isn’t a JPG, PNG, GIF or WebP image, or it is damaged.';

/**
 * An uploaded image's type, from its bytes, and the bytes without their metadata. Throws
 * UploadRejectedError (answered 400) when the bytes aren't a JPEG, PNG, GIF or WebP image
 * the stripper can read through.
 */
export function sanitizeImage(data: Buffer): { mimeType: SniffedType; data: Buffer } {
  const mimeType = sniffFileType(data);
  if (!mimeType || !RASTER_IMAGE_TYPES.has(mimeType)) throw new UploadRejectedError(NOT_AN_IMAGE);
  try {
    const stripped =
      mimeType === 'image/jpeg' ? stripJpeg(data)
        : mimeType === 'image/png' ? stripPng(data)
          : mimeType === 'image/webp' ? stripWebp(data)
            : stripGif(data);
    return { mimeType, data: stripped };
  } catch (err) {
    if (err instanceof Malformed || err instanceof RangeError) throw new UploadRejectedError(NOT_AN_IMAGE);
    throw err;
  }
}

/**
 * A Content-Disposition header value for a download named `filename` (RFC 6266): a
 * plain-ASCII `filename` for old clients and the exact name as UTF-8 in `filename*`.
 * Node refuses a header with characters outside Latin-1, so writing a name like
 * 「領収書.pdf」 straight into `filename="…"` failed the download with a 500.
 */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  // eslint-disable-next-line no-control-regex
  const name = filename.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'download';
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
