import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStored, readStoredJson, writeStored, writeStoredJson } from '../storage';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('storage', () => {
  it('reads and writes each area', () => {
    expect(writeStored('local', 'k', 'v')).toBe(true);
    expect(readStored('local', 'k')).toBe('v');
    expect(readStored('session', 'k')).toBeNull();
    writeStoredJson('session', 'j', { a: 1 });
    expect(readStoredJson('session', 'j', null)).toEqual({ a: 1 });
    expect(writeStored('local', 'k', null)).toBe(true);
    expect(readStored('local', 'k')).toBeNull();
  });

  it('reads as empty and refuses writes when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(readStored('session', 'k')).toBeNull();
    expect(readStoredJson('session', 'k', 7)).toBe(7);
    expect(writeStored('session', 'k', 'v')).toBe(false);
  });

  it('falls back when the stored JSON does not parse', () => {
    sessionStorage.setItem('j', '{not json');
    expect(readStoredJson('session', 'j', [])).toEqual([]);
  });
});
