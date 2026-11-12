import { describe, it, expect } from 'vitest';
import { MAX_LOGGED_PATH_LENGTH, maskEmail, maskEmailsIn, pathOnly } from '../logger.js';

/**
 * maskEmailsIn runs on every string of every security event, and one of those is the path
 * any client sends (the CSRF refusal's `endpoint`). It was a regex that took time in the
 * square of a run of letters' length (a 15,000-character path took a quarter of a second,
 * 100,000 took eleven): one client could keep the event loop busy.
 */
const OLD_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const oldMaskEmailsIn = (text: string) => text.replace(OLD_REGEX, (address) => maskEmail(address) ?? '…');

/**
 * The fastest of `runs` runs of each of `fns`, in ms, the runs taken in turn: a pause a busy
 * machine adds to some runs (a garbage collection, another process on the core) falls on
 * either function's alike, and the fastest run of each is left without one.
 */
function fastestMsEach(fns: Array<() => void>, runs = 7): number[] {
  const best = fns.map(() => Infinity);
  for (let i = 0; i < runs; i++) {
    fns.forEach((fn, j) => {
      const start = performance.now();
      fn();
      best[j] = Math.min(best[j], performance.now() - start);
    });
  }
  return best;
}

describe('maskEmailsIn', () => {
  it('masks the addresses it did', () => {
    expect(maskEmailsIn('User jane.doe+bank@example.co.uk logged in')).toBe('User j…@example.co.uk logged in');
    expect(maskEmailsIn('a@b.c and x_y%z@d-e.fg.')).toBe('a…@b.c and x…@d-e.fg.');
    expect(maskEmailsIn('no address @ here, nor at me@localhost')).toBe('no address @ here, nor at me@localhost');
    expect(maskEmailsIn('ab@cd@e.fg')).toBe('ab@c…@e.fg');
    expect(maskEmailsIn('')).toBe('');
  });

  it('gives the same answer as the regex it replaces, for any text', () => {
    // Short random strings over the characters that matter, so the edge cases (an `@` in a
    // domain, a trailing dot, two in a row, an address right after another) come up often.
    const alphabet = 'aZ9.-_%+@ @.a';
    let seed = 582;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let n = 0; n < 20000; n++) {
      const length = Math.floor(random() * 16);
      let text = '';
      for (let i = 0; i < length; i++) text += alphabet[Math.floor(random() * alphabet.length)];
      expect(maskEmailsIn(text), JSON.stringify(text)).toBe(oldMaskEmailsIn(text));
    }
  });

  it('takes time linear in the length of the text, whatever it is', () => {
    // Each text at an eighth of the length and at the whole: linear, the whole takes about 8
    // times as long; the regex it replaces took about 64 times (11 s on 100,000 characters
    // of each of the first five). Compared with each other in the same run, so a busy
    // machine slows both, rather than with a fixed 50 ms, which a loaded run once passed,
    // and their runs taken in turn, so a busy spell slows both alike. The bound is 24
    // times plus 3 ms: three times linear's ratio, and under half the old regex's. Against a
    // quarter (linear 4, bound 10), a loaded run once measured 8.04. The 3 ms covers
    // the timer's resolution and a scheduler pause on texts this quick.
    const n = 100_000;
    const texts: Record<string, (length: number) => string> = {
      letters: (length) => 'a'.repeat(length),
      'letters then @': (length) => `${'a'.repeat(length)}@`,
      'dotted letters': (length) => 'a.'.repeat(length / 2),
      'an @ then letters': (length) => `x@${'a'.repeat(length)}`,
      'an @ then labels without a dot': (length) => `x@${'a-'.repeat(length / 2)}`,
      'many @': (length) => '@a'.repeat(length / 2),
      'many addresses': (length) => 'a@b.c '.repeat(length / 6),
    };
    for (const [name, make] of Object.entries(texts)) {
      const [eighth, whole] = [make(n / 8), make(n)];
      maskEmailsIn(whole); // optimized before it is timed
      const [small, large] = fastestMsEach([() => maskEmailsIn(eighth), () => maskEmailsIn(whole)]);
      expect(large, `${name}: ${large.toFixed(2)} ms for ${n} characters, ${small.toFixed(2)} ms for ${n / 8}`).toBeLessThan(
        24 * small + 3
      );
    }
  });
});

describe('pathOnly', () => {
  it('drops the query and fragment, and cuts a long path', () => {
    expect(pathOnly('/api/onedrive/callback?code=x#y')).toBe('/api/onedrive/callback');
    expect(pathOnly('/api/a#b?c')).toBe('/api/a');
    expect(pathOnly(undefined)).toBe('');
    const long = `/api/health${'a'.repeat(15_000)}`;
    expect(pathOnly(long)).toBe(`${long.slice(0, MAX_LOGGED_PATH_LENGTH)}…`);
    expect(pathOnly(`${long}?q=1`)).toHaveLength(MAX_LOGGED_PATH_LENGTH + 1);
  });
});
