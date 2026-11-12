import { describe, it, expect } from 'vitest';
import { imageUploadProblem } from '../imageUploads';

const file = (name: string, type = 'image/png') => new File(['x'], name, { type });
const WRONG_EXTENSION = (extension: string) =>
  `A picture named ${extension} isn't taken: choose a .jpg, .jpeg, .png, .gif or .webp file (a JPEG can be renamed .jpg).`;

/** The image checks beside the pickers, as the server's imageFileFilter makes them (path.extname). */
describe('imageUploadProblem', () => {
  it('takes the four types by their extension, in any case, after any name', () => {
    const taken: Array<[string, string]> = [
      ['photo.png', 'image/png'], ['PHOTO.PNG', 'image/png'], ['..png', 'image/png'], ['x .png', 'image/png'],
      ['a.b.jpeg', 'image/jpeg'], ['photo.jpg', 'image/jpeg'], ['logo.gif', 'image/gif'], ['logo.webp', 'image/webp'],
    ];
    for (const [name, type] of taken) expect(imageUploadProblem(file(name, type)), name).toBeNull();
  });

  // `.png` was taken here, and refused by the server, whose path.extname gives a
  // name that starts with its only dot no extension.
  it('refuses a name that is only its type, and says what to call it', () => {
    for (const name of ['.png', '.PNG', '.jpg']) {
      expect(imageUploadProblem(file(name)), name).toBe('A picture needs a name before its type, like photo.png.');
    }
  });

  it('refuses a name without a type, or with another, and a type it does not take', () => {
    expect(imageUploadProblem(file('photo'))).toBe(
      'A picture needs its type at the end of its name: choose a .jpg, .jpeg, .png, .gif or .webp file (a JPEG can be renamed .jpg).',
    );
    expect(imageUploadProblem(file('photo.', 'image/png'))).toBe(
      'A picture needs its type at the end of its name: choose a .jpg, .jpeg, .png, .gif or .webp file (a JPEG can be renamed .jpg).',
    );
    expect(imageUploadProblem(file('logo.jfif', 'image/jpeg'))).toBe(WRONG_EXTENSION('.jfif'));
    expect(imageUploadProblem(file('logo.svg', 'image/svg+xml'))).toBe('Choose a JPEG, PNG, GIF or WebP image.');
  });
});
