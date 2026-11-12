import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Static guard: FilePickerButton is the app's one file input. A raw `<input type="file">`
 * is one more control outside the design system: hidden behind a button it is a second,
 * unthemed tab stop or a mouse-only label, and shown it can't take the theme. Each was moved to
 * FilePickerButton, which keeps the input out of sight and out of the tab order and empties it
 * after each pick.
 */

const SRC = join(import.meta.dirname, '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'test' ? [] : walk(path);
    return /\.tsx$/.test(entry.name) ? [path] : [];
  });

describe('file inputs', () => {
  it('are FilePickerButton, and only it', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100);
    const withFileInput = files.filter((file) => /type=["'{]\s*['"]?file['"]?/.test(readFileSync(file, 'utf8')));
    expect(withFileInput.map((file) => relative(SRC, file))).toEqual(['components/forms/FilePickerButton.tsx']);
  });
});
