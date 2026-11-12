import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// What userRegex logs, to check the warnings it gives.
const warnings = vi.hoisted(() => [] as Array<{ fields: Record<string, unknown>; msg: string }>);
vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>();
  const quiet = () => undefined;
  return {
    ...actual,
    createLogger: () => ({
      warn: (fields: Record<string, unknown>, msg: string) => warnings.push({ fields, msg }),
      error: quiet,
      info: quiet,
      debug: quiet,
    }),
  };
});

/**
 * Every worker userRegex starts, and every job it sends one, with when (Date.now(), the
 * clock userRegex budgets with). What ran is asserted from these rather than from how long
 * a call took, which on a loaded machine is mostly how long a worker took to start:
 * a worker's start isn't a pattern's run.
 */
const workers = vi.hoisted(() => ({ started: 0, jobs: [] as Array<{ at: number; patterns: number }> }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workers.started += 1;
    }
    override postMessage(value: unknown, transferList?: readonly import('node:worker_threads').Transferable[]): void {
      workers.jobs.push({ at: Date.now(), patterns: (value as { patterns: unknown[] }).patterns.length });
      super.postMessage(value, transferList);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

import {
  matchUserPatterns,
  regexRulesWithinCap,
  resetUserRegex,
  MATCH_TIME_BUDGET_MS,
  MAX_REGEX_RULES_PER_TENANT,
  PATTERN_TIME_LIMIT_MS,
} from '../userRegex.js';

/**
 * Rule regexes run off the main thread, under a time limit. `(a+)+$`
 * on forty a's and a `!` backtracks about 2^40 times: hours of a blocked event loop when
 * it ran in BudgetItemMatcher, which every request of every ledger waited behind.
 *
 * These are about what each pattern answers, not the per-call budget, so they run under a
 * long budget: on a loaded machine a fresh worker can take the whole 500 ms to start, and
 * the patterns after it would be skipped.
 */
describe('matchUserPatterns', () => {
  beforeEach(async () => {
    await resetUserRegex({ matchTimeBudgetMs: 60_000 });
  });
  afterEach(async () => {
    await resetUserRegex();
  });

  const catastrophic = '(a+)+$';
  const subject = `${'a'.repeat(40)}!`;

  it('stops a catastrophic pattern and keeps the event loop running', async () => {
    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 5);
    const started = Date.now();
    const outcomes = await matchUserPatterns([catastrophic], subject);
    const elapsed = Date.now() - started;
    clearInterval(ticker);

    // Stopped at its limit (run to the end it takes hours; the test's timeout bounds that).
    expect(outcomes).toEqual(['timeout']);
    expect(elapsed).toBeGreaterThanOrEqual(PATTERN_TIME_LIMIT_MS);
    // The main thread was free while the pattern ran: a 5 ms timer fired meanwhile.
    expect(ticks).toBeGreaterThan(0);
  });

  it('runs the patterns after a stopped one in a fresh worker, in order', async () => {
    const started = workers.started;
    const outcomes = await matchUserPatterns(['^aaa', catastrophic, 'a!$', '(', 'zzz'], subject);
    expect(outcomes).toEqual([true, 'timeout', true, 'invalid', false]);
    expect(workers.started - started).toBe(2);
  });

  it('skips a pattern that ran out of time before, without running it', async () => {
    await matchUserPatterns([catastrophic], subject);
    // Nothing to run: no worker starts and no job is sent.
    const before = { started: workers.started, jobs: workers.jobs.length };
    expect(await matchUserPatterns([catastrophic], subject)).toEqual(['timeout']);
    expect({ started: workers.started, jobs: workers.jobs.length }).toEqual(before);
    // The others still run, and only they are sent.
    expect(await matchUserPatterns([catastrophic, 'a'], subject)).toEqual(['timeout', true]);
    expect(workers.jobs.slice(before.jobs)).toEqual([expect.objectContaining({ patterns: 1 })]);
  });

  it('matches ignoring case, as rules always have', async () => {
    expect(await matchUserPatterns(['^samplemart\\s+mktp', 'SAMPLERIDE|ACMECAB'], 'SAMPLEMART  MKTP US*1A2B')).toEqual([true, false]);
  });

  it('answers concurrent callers each with their own outcomes', async () => {
    const [a, b, c] = await Promise.all([
      matchUserPatterns(['^x'], 'xyz'),
      matchUserPatterns([catastrophic], subject),
      matchUserPatterns(['z$'], 'xyz'),
    ]);
    expect([a, b, c]).toEqual([[true], ['timeout'], [true]]);
  });
});

/**
 * Many slow patterns at once: `^(a|aa)+$|zN` passes regexRuleProblem (the
 * overlap isn't a nested repeat) and takes seconds on 45 a's and a `!`. A thousand of them
 * took 140 s per call, the skip list was cleared at a thousand entries so it never held
 * them, and every ledger's calls waited behind that one queue.
 *
 * What the budget bounds is checked from the jobs the calls sent (`workers`), not from how
 * long they took, which on a loaded machine is mostly workers starting: a
 * call sends a job only while its budget lasts, and each pattern that runs to its limit
 * spends PATTERN_TIME_LIMIT_MS of it.
 */
describe('matchUserPatterns: many slow patterns', () => {
  beforeEach(async () => {
    // A worker running already, as there is after a server's first call: its start is
    // not what these test. Awaited, it is up once this returns, whatever it answered.
    await matchUserPatterns(['^warm$'], 'warm');
    warnings.length = 0;
  });
  afterEach(async () => {
    await resetUserRegex();
    warnings.length = 0;
  });

  const slowSubject = `${'a'.repeat(45)}!`;
  const slow = (n: number) => Array.from({ length: n }, (_, i) => `^(a|aa)+$|z${i}`);
  /**
   * The most patterns one call can run to their limit within its budget. One more: Date.now()
   * and the timers' clock can disagree by a millisecond or so either way.
   */
  const MOST_TIMEOUTS = Math.ceil(MATCH_TIME_BUDGET_MS / PATTERN_TIME_LIMIT_MS) + 1;
  const timeouts = (outcomes: readonly unknown[]) => outcomes.filter((o) => o === 'timeout').length;
  /** The jobs a call sent (from `from`, its first, on): each while its budget lasted. */
  const expectSentWithinBudget = (jobs: ReadonlyArray<{ at: number }>) => {
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    // The call's deadline is MATCH_TIME_BUDGET_MS after it began, which is before its first job.
    for (const job of jobs) expect(job.at - jobs[0].at).toBeLessThanOrEqual(MATCH_TIME_BUDGET_MS);
    // A job follows a pattern stopped at its limit, so the budget holds only so many.
    expect(jobs.length).toBeLessThanOrEqual(MOST_TIMEOUTS + 1);
  };

  it('spends at most its time budget on one call, and skips (no match) the rest', async () => {
    const from = workers.jobs.length;
    const outcomes = await matchUserPatterns([...slow(30), 'a!$'], slowSubject);

    expectSentWithinBudget(workers.jobs.slice(from));
    expect(timeouts(outcomes)).toBeGreaterThanOrEqual(1);
    expect(timeouts(outcomes)).toBeLessThanOrEqual(MOST_TIMEOUTS);
    expect(outcomes.filter((o) => o === 'skipped').length).toBeGreaterThan(20);
    expect(outcomes).not.toContain(true);
    // Said once for the call, not once per pattern.
    const said = warnings.filter((w) => w.msg.startsWith('Regex rules skipped'));
    expect(said).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ patterns: 31, budgetMs: MATCH_TIME_BUDGET_MS }) }),
    ]);
  });

  it('gets through the slow patterns over a few calls, each within its budget', { timeout: 60_000 }, async () => {
    const patterns = [...slow(8), 'a!$'];
    let last: Awaited<ReturnType<typeof matchUserPatterns>> = [];
    let calls = 0;
    // Each call runs at least one more of them, or (when a fresh worker's start used its
    // budget) leaves the worker up for the next.
    for (; calls < 20 && last[8] !== true; calls++) {
      const from = workers.jobs.length;
      last = await matchUserPatterns(patterns, slowSubject);
      const jobs = workers.jobs.slice(from);
      if (jobs.length > 0) expectSentWithinBudget(jobs);
    }
    // Every slow one is on the skip list now, and the fast one past them matched.
    expect(last).toEqual([...Array(8).fill('timeout'), true]);
    expect(calls).toBeGreaterThan(1);
  });

  it("doesn't keep another caller waiting behind a call of slow patterns for more than its budget", async () => {
    const from = workers.jobs.length;
    const busy = matchUserPatterns(slow(40), slowSubject);
    // Calls run one at a time: what the busy one sent is everything before it settled.
    let busyJobs = -1;
    void busy.then(() => (busyJobs = workers.jobs.length));
    const harmless = await matchUserPatterns(['^ok$'], 'ok');
    const busyOutcomes = await busy;

    expect(harmless).toEqual([true]);
    // The busy call held the queue only for its budget...
    expectSentWithinBudget(workers.jobs.slice(from, busyJobs));
    expect(timeouts(busyOutcomes)).toBeLessThanOrEqual(MOST_TIMEOUTS);
    // ...and the harmless one ran right after it, in a worker none of the slow ones held.
    expect(workers.jobs.slice(busyJobs)).toEqual([expect.objectContaining({ patterns: 1 })]);
  });

  it('forgets the least recently used slow pattern when the skip list is full, not all of them', async () => {
    // A long budget: each pattern below runs alone and must reach its limit.
    await resetUserRegex({ maxSlowPatterns: 3, matchTimeBudgetMs: 60_000 });
    const [a, b, c, d] = slow(4);
    for (const p of [a, b, c]) expect(await matchUserPatterns([p], slowSubject)).toEqual(['timeout']);
    // `a` is used again, so `b` is now the least recently used.
    expect(await matchUserPatterns([a], slowSubject)).toEqual(['timeout']);
    expect(await matchUserPatterns([d], slowSubject)).toEqual(['timeout']);

    /** Whether matching `p` sent it to a worker (rather than answer from the skip list). */
    const ran = async (p: string) => {
      const from = workers.jobs.length;
      expect(await matchUserPatterns([p], slowSubject)).toEqual(['timeout']);
      return workers.jobs.length > from;
    };
    // Skipped without running.
    expect(await ran(a)).toBe(false);
    expect(await ran(c)).toBe(false);
    expect(await ran(d)).toBe(false);
    // `b` was forgotten, so it ran (to its time limit) again.
    expect(await ran(b)).toBe(true);
  });
});

describe('regexRulesWithinCap', () => {
  afterEach(async () => {
    await resetUserRegex();
    warnings.length = 0;
  });

  it('keeps every rule up to the cap, and only the first MAX_REGEX_RULES_PER_TENANT past it, saying so once', () => {
    const under = Array.from({ length: MAX_REGEX_RULES_PER_TENANT }, (_, i) => i);
    expect(regexRulesWithinCap(under, 'budget-item')).toEqual(under);
    expect(warnings).toEqual([]);

    const over = Array.from({ length: MAX_REGEX_RULES_PER_TENANT + 5 }, (_, i) => i);
    expect(regexRulesWithinCap(over, 'budget-item')).toEqual(under);
    expect(regexRulesWithinCap(over, 'budget-item')).toEqual(under);
    expect(warnings).toEqual([
      expect.objectContaining({
        fields: { kind: 'budget-item', regexRules: MAX_REGEX_RULES_PER_TENANT + 5, cap: MAX_REGEX_RULES_PER_TENANT },
      }),
    ]);
  });
});
