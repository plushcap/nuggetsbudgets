import { crc32 } from 'node:zlib';

/**
 * Small image files built byte by byte for the upload tests: each carries
 * metadata a member wouldn't mean to share, marked with the text `SECRET`, around image
 * data the stripper must keep. They aren't valid pictures beyond their structure.
 */

export const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1');

/** A JPEG segment: marker, then its length and payload. */
function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** An APP1 Exif payload: IFD0 with an orientation and a camera make, then GPS-ish text. */
export function exifPayload(orientation: number): Buffer {
  const tiff = Buffer.concat([
    latin1('II'), Buffer.from([42, 0, 8, 0, 0, 0]),
    Buffer.from([2, 0]),
    Buffer.from([0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0]),
    Buffer.from([0x0f, 0x01, 2, 0, 10, 0, 0, 0, 38, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0]),
    latin1('SECRETCAM\0GPS 48.8584N 2.2945E'),
  ]);
  return Buffer.concat([latin1('Exif\0\0'), tiff]);
}

/** The first scan and the end of a JPEG: copied unchanged by the stripper. */
export const jpegScan = Buffer.concat([
  segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
  Buffer.from([0xff, 0xd9]),
]);

export function jpeg(orientation = 6): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, latin1('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    segment(0xe1, exifPayload(orientation)),
    segment(0xe1, latin1('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>SECRET XMP</x:xmpmeta>')),
    segment(0xfe, latin1('SECRET comment')),
    segment(0xe2, latin1('ICC_PROFILE\0\x01\x01profile-bytes')),
    segment(0xdb, Buffer.alloc(65, 1)),
    jpegScan,
  ]);
}

/**
 * A progressive JPEG with a comment and an XMP block between its two scans, and a second
 * image with EXIF appended after its end marker, as phones write a gain map or a preview.
 */
export function jpegWithLaterMetadata(): Buffer {
  const secondScan = Buffer.concat([segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x77, 0xff, 0x00, 0xff, 0xd3, 0x88])]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, latin1('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    segment(0xdb, Buffer.alloc(65, 1)),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x11, 0x22]),
    segment(0xfe, latin1('SECRET between scans')),
    segment(0xe1, latin1('http://ns.adobe.com/xap/1.0/\0SECRET XMP')),
    segment(0xc4, Buffer.alloc(20, 2)),
    secondScan,
    Buffer.from([0xff, 0xd9]),
    // The appended image.
    Buffer.from([0xff, 0xd8]), segment(0xe1, exifPayload(1)), Buffer.from([0xff, 0xd9]),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([latin1(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** {@link png} with its eXIf carrying `orientation` (and the camera and GPS text). */
export function pngWithOrientation(orientation: number): Buffer {
  return png(orientation);
}

export function png(orientation = 1): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk('tEXt', latin1('Comment\0SECRET text')),
    pngChunk('eXIf', exifPayload(orientation).subarray(6)),
    pngChunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00])),
    pngChunk('tIME', Buffer.from([7, 234, 11, 2, 1, 2, 3])),
    pngChunk('caBX', latin1('SECRET content credentials')),
    pngChunk('IEND', Buffer.alloc(0)),
    latin1('SECRET trailing bytes'),
  ]);
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([latin1(fourcc), size, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** A WebP whose EXIF is text, or with `orientation`, EXIF data with it (and camera and GPS text). */
export function webp(orientation?: number): Buffer {
  const body = Buffer.concat([
    riffChunk('VP8X', Buffer.from([0x0c | 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    riffChunk('VP8 ', Buffer.from([1, 2, 3, 4, 5])),
    riffChunk('EXIF', orientation === undefined ? latin1('SECRET exif') : exifPayload(orientation).subarray(6)),
    riffChunk('XMP ', latin1('SECRET xmp!')),
    riffChunk('ABCD', latin1('SECRET own')),
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

export function gif(): Buffer {
  return Buffer.concat([
    latin1('GIF89a'), Buffer.from([1, 0, 1, 0, 0, 0, 0]),
    Buffer.from([0x21, 0xfe, 6]), latin1('SECRET'), Buffer.from([0]),
    Buffer.from([0x21, 0xff, 11]), latin1('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]),
    Buffer.from([0x21, 0xff, 11]), latin1('XMP DataXMP'), Buffer.from([6]), latin1('SECRET'), Buffer.from([0]),
    Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), Buffer.from([2, 2, 0x44, 0x01, 0]),
    Buffer.from([0x3b]),
  ]);
}
