import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { REVOKE_DOWNLOAD_URL_AFTER_MS, saveBlob } from '../saveBlob';

// The one way the app saves a file.
describe('saveBlob', () => {
  let clicked: Array<{ name: string; href: string; attached: boolean }>;

  beforeEach(() => {
    vi.useFakeTimers();
    clicked = [];
    // jsdom has no object URLs.
    URL.createObjectURL = vi.fn(() => 'blob:download-1');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.getAttribute('href') ?? '', attached: document.body.contains(this) });
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clicks a link that downloads the file under its name, and removes the link', () => {
    const blob = new Blob(['a,b\n1,2\n'], { type: 'text/csv' });
    saveBlob(blob, 'accounts_2026-11-04.csv');
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ name: 'accounts_2026-11-04.csv', href: 'blob:download-1', attached: true }]);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('keeps the URL until the save has had time to start, then revokes it', () => {
    saveBlob(new Blob(['key']), 'nuggets-backup-key.txt');
    // Revoking at once can cancel the save in browsers that start it after click() returns.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_DOWNLOAD_URL_AFTER_MS - 1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download-1');
  });
});
