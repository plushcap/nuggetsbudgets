import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { MAX_COMPILED_PATTERNS, WORKER_SOURCE } from '../userRegex.js';

/**
 * The regex worker keeps the MAX_COMPILED_PATTERNS most recently used compiled patterns,
 * and forgets the least recently used one to make room (it had forgotten the
 * oldest compiled, so a rule every transaction runs was compiled again once a thousand
 * others had been). Runs the worker's own source with a stand-in parentPort, counting
 * what it compiles.
 */
function startWorker() {
  const port = new EventEmitter() as EventEmitter & { postMessage: (m: unknown) => void };
  const answers: Array<{ job: number; index: number; outcome: unknown }> = [];
  port.postMessage = (m) => answers.push(m as (typeof answers)[number]);
  const compiledPatterns: string[] = [];
  class CountingRegExp extends RegExp {
    constructor(pattern: string, flags?: string) {
      super(pattern, flags);
      compiledPatterns.push(pattern);
    }
  }
  const run = new Function('require', 'RegExp', WORKER_SOURCE) as (req: (id: string) => unknown, re: unknown) => void;
  run((id) => {
    if (id !== 'node:worker_threads') throw new Error(`unexpected require ${id}`);
    return { parentPort: port };
  }, CountingRegExp);
  let job = 0;
  const test = (patterns: string[], subject: string) => {
    answers.length = 0;
    port.emit('message', { job: ++job, patterns, subject });
    return answers.map((a) => a.outcome);
  };
  return { test, compiledPatterns };
}

describe('the regex worker’s compiled patterns', () => {
  it('compiles each once, case-insensitive, and answers an invalid one as such', () => {
    const { test, compiledPatterns } = startWorker();
    expect(test(['^coffee', '(', 'SHOP$'], 'Coffee shop')).toEqual([true, 'invalid', true]);
    expect(test(['^coffee', 'SHOP$', '('], 'tea')).toEqual([false, false, 'invalid']);
    expect(compiledPatterns).toEqual(['^coffee', 'SHOP$']);
  });

  it('forgets the least recently used one, not the oldest', () => {
    const { test, compiledPatterns } = startWorker();
    const hot = '^hot rule';
    test([hot], 'x');
    // Fill the cache, using the hot rule now and then, as each transaction does.
    for (let i = 1; i < MAX_COMPILED_PATTERNS; i++) {
      test([`^rule ${i}$`], 'x');
      if (i % 100 === 0) test([hot], 'x');
    }
    expect(compiledPatterns).toHaveLength(MAX_COMPILED_PATTERNS);
    test([hot], 'x');
    // One more makes room: '^rule 1$' goes (the least recently used), the hot rule stays.
    test(['^one more$'], 'x');
    compiledPatterns.length = 0;
    test([hot], 'x');
    expect(compiledPatterns).toEqual([]);
    test(['^rule 1$'], 'x');
    expect(compiledPatterns).toEqual(['^rule 1$']);
    // Each new one forgets one: '^rule 1$' back made room by forgetting '^rule 2$', and
    // '^rule 3$' is still kept.
    compiledPatterns.length = 0;
    test(['^rule 3$'], 'x');
    expect(compiledPatterns).toEqual([]);
  });
});
