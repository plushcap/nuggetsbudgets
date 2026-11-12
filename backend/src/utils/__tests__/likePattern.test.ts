import { describe, it, expect } from 'vitest';
import { escapeLike, containsPattern, prefixPattern, suffixPattern } from '../likePattern.js';

describe('LIKE patterns', () => {
  it('escapes the backslash, percent and underscore, and nothing else', () => {
    expect(escapeLike('50% off_now\\x')).toBe('50\\% off\\_now\\\\x');
    expect(escapeLike('plain [text] *.?')).toBe('plain [text] *.?');
  });

  it('adds only its own wildcards', () => {
    expect(containsPattern('a_b')).toBe('%a\\_b%');
    expect(prefixPattern('a%')).toBe('a\\%%');
    expect(suffixPattern('\\')).toBe('%\\\\');
  });
});
