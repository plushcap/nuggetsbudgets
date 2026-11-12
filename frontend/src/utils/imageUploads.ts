/**
 * The images the server takes, for a profile picture, an account's, a goal's or a merchant's:
 * every image upload has the same filter and limits (backend utils/imageUpload.ts:
 * `imageFileFilter`, `IMAGE_UPLOAD_LIMITS`). It checks the type and the name's extension, both,
 * and the size. A JPEG named .jfif or .pjpeg, which Windows offers for the JPEG type, is
 * refused there by its name.
 */
export const IMAGE_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const IMAGE_UPLOAD_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A file name's extension, lower-cased ("" for none), as the server's `path.extname` reads it:
 * a name that is only a dot and a type (`.png`) has none (it was taken here, and
 * refused there).
 */
const extensionOf = (name: string): string => /[^/](\.[^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

/** Why the server won't take `file` as an image, for beside its picker; null when it will. */
export function imageUploadProblem(file: File): string | null {
  if (!IMAGE_UPLOAD_TYPES.includes(file.type)) return 'Choose a JPEG, PNG, GIF or WebP image.';
  const extension = extensionOf(file.name);
  if (!IMAGE_UPLOAD_EXTENSIONS.includes(extension)) {
    if (/^\.[^./\\]+$/.test(file.name)) return 'A picture needs a name before its type, like photo.png.';
    return `${extension ? `A picture named ${extension} isn't taken` : 'A picture needs its type at the end of its name'}: choose a .jpg, .jpeg, .png, .gif or .webp file (a JPEG can be renamed .jpg).`;
  }
  if (file.size > IMAGE_UPLOAD_MAX_BYTES) return 'Choose an image of 5 MB or less.';
  return null;
}
