import { Worker } from 'node:worker_threads';
import type { Response } from 'express';
import { regexRuleProblem } from '@nuggets/shared';
import { createLogger } from './logger.js';
import { getCurrentTenantId } from '../context/requestContext.js';

const logger = createLogger({ service: 'UserRegex' });

/**
 * Regular expressions people wrote (budget-item rules with method `regex`), run where
 * they can't stall the server.
 *
 * A regex runs to completion once it starts: Node can't interrupt it, and a pattern such
 * as `(a+)+$` takes minutes on a 40-character description. Run on the main thread, that
 * blocks every request of every ledger, again on each sync. So patterns run in a worker
 * thread, and a pattern still running after {@link PATTERN_TIME_LIMIT_MS} has the worker
 * terminated (V8 stops a running regex for that), its outcome is `'timeout'`, and the
 * patterns after it run in a fresh worker. A pattern that timed out isn't run again for
 * {@link SLOW_PATTERN_SKIP_MS}, so a bad rule costs one time limit per quarter hour, not
 * one per transaction.
 *
 * Saving a rule refuses most such patterns already (regexRuleProblem in @nuggets/shared);
 * this bounds the ones that check misses and the ones saved before it existed.
 *
 * Many slow patterns at once are bounded too: one call runs for at most
 * {@link MATCH_TIME_BUDGET_MS} in all, and the patterns it hasn't reached by then are
 * `'skipped'` (no match), so a thousand slow rules cost half a second per call (a
 * transaction makes one or two), not a hundred seconds. The skip list forgets its least recently used
 * pattern first, one at a time, so it keeps as many slow patterns as it has room for. A
 * ledger may have up to {@link MAX_REGEX_RULES_PER_TENANT} active regex rules of each kind.
 *
 * Calls run one at a time, on one worker: a running regex can't be interrupted short of
 * stopping its thread, so two calls can't share a worker, and a worker per ledger would
 * cost a thread and up to 64 MB each. The budget is what keeps one ledger from holding the
 * queue: a call waits at most for the calls ahead of it, each at most the budget (and a
 * worker's start), and an import makes its calls one after another, so another ledger's
 * call waits behind one of them at a time, not behind the whole import.
 */

/** How long one pattern may run on one subject. Rules take microseconds. */
export const PATTERN_TIME_LIMIT_MS = 100;
/** How long one call may run its patterns in all; the ones it hasn't reached are skipped. */
export const MATCH_TIME_BUDGET_MS = 500;
/** The budget calls run under: MATCH_TIME_BUDGET_MS, or a test's (resetUserRegex). */
let matchTimeBudgetMs = MATCH_TIME_BUDGET_MS;
/** How long a pattern that ran past the limit is skipped. */
export const SLOW_PATTERN_SKIP_MS = 15 * 60 * 1000;
/**
 * The active regex rules of each kind (budget-item rules, merchant rules) a ledger may
 * have. Saving one more is refused; a ledger that has more (saved before the cap) has only
 * the first this many, in rule order, run on a transaction, and a warning says so.
 */
export const MAX_REGEX_RULES_PER_TENANT = 100;

/**
 * A pattern's outcome: matched, didn't, not a valid regex, not run to the end in its time
 * limit, or not run at all because the call's time budget ran out first.
 */
export type PatternOutcome = boolean | 'invalid' | 'timeout' | 'skipped';

/** How many compiled patterns the worker keeps. */
export const MAX_COMPILED_PATTERNS = 1000;

/**
 * The worker: compiles each pattern once (case-insensitive, as rules always were) and
 * answers each pattern of a job as soon as it has run, so the one that hangs is known.
 * It keeps the MAX_COMPILED_PATTERNS most recently used compiled patterns: a Map keeps
 * insertion order, and a pattern used again moves to the end, so the one forgotten to
 * make room is the least recently used (it was the oldest compiled, however often used).
 * Exported for its test, which runs it with a stand-in parentPort.
 */
export const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const compiled = new Map();
function compile(pattern) {
  let re = compiled.get(pattern);
  if (re !== undefined) {
    compiled.delete(pattern);
    compiled.set(pattern, re);
    return re;
  }
  re = new RegExp(pattern, 'i');
  if (compiled.size >= ${MAX_COMPILED_PATTERNS}) compiled.delete(compiled.keys().next().value);
  compiled.set(pattern, re);
  return re;
}
parentPort.on('message', ({ job, patterns, subject }) => {
  for (let i = 0; i < patterns.length; i++) {
    let outcome;
    try {
      outcome = compile(patterns[i]).test(subject);
    } catch {
      outcome = 'invalid';
    }
    parentPort.postMessage({ job, index: i, outcome });
  }
});
`;

/**
 * Patterns that ran past the limit, and until when they're skipped, least recently used
 * first (a Map keeps insertion order; a pattern used again moves to the end).
 */
const slowPatterns = new Map<string, number>();
export const MAX_SLOW_PATTERNS = 1000;
let slowPatternCapacity = MAX_SLOW_PATTERNS;

function isSkipped(pattern: string, now: number): boolean {
  const until = slowPatterns.get(pattern);
  if (until === undefined) return false;
  slowPatterns.delete(pattern);
  if (until <= now) return false;
  slowPatterns.set(pattern, until);
  return true;
}

/** Skip `pattern` until `until`, making room by forgetting the least recently used one. */
function rememberSlow(pattern: string, until: number): void {
  slowPatterns.delete(pattern);
  while (slowPatterns.size >= slowPatternCapacity) {
    const oldest = slowPatterns.keys().next();
    if (oldest.done) break;
    slowPatterns.delete(oldest.value);
  }
  slowPatterns.set(pattern, until);
}

interface LiveWorker {
  worker: Worker;
  /** Settles once the worker runs (or failed to start), so startup isn't timed as a pattern. */
  online: Promise<void>;
}

let current: LiveWorker | null = null;
let jobCounter = 0;
/** Jobs run one at a time, so a job's time limit isn't spent waiting behind another's. */
let queue: Promise<unknown> = Promise.resolve();

function liveWorker(): LiveWorker {
  if (!current) {
    const worker = new Worker(WORKER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    // An idle worker mustn't keep the process alive; a job in flight holds its timer.
    worker.unref();
    const online = new Promise<void>((resolve) => {
      worker.once('online', () => resolve());
      worker.once('exit', () => resolve());
    });
    const live: LiveWorker = { worker, online };
    worker.on('error', (err) => {
      logger.error({ err }, 'Regex worker failed');
    });
    worker.on('exit', () => {
      if (current === live) current = null;
    });
    current = live;
  }
  return current;
}

function stopWorker(live: LiveWorker): void {
  if (current === live) current = null;
  void live.worker.terminate();
}

/** Where a run in the worker stopped: all done, or at a pattern out of time or out of budget. */
type RunEnd = { stoppedAt: null } | { stoppedAt: number; reason: 'timeout' | 'budget' };

/**
 * Run `patterns` from index `from` on in the worker, writing each outcome into
 * `outcomes`, until `deadline` (the end of the call's budget). Settles with the index of
 * the pattern that ran past its limit (or was running when the worker died, or when the
 * budget ran out), or null when all of them finished.
 */
async function runInWorker(
  patterns: readonly string[],
  subject: string,
  outcomes: PatternOutcome[],
  from: number,
  deadline: number
): Promise<RunEnd> {
  const live = liveWorker();
  await live.online;
  if (current !== live) throw new Error('The regex worker exited before it could run anything');
  // Starting the worker took the rest of the budget.
  if (Date.now() >= deadline) return { stoppedAt: from, reason: 'budget' };
  const { worker } = live;
  return new Promise((resolve) => {
    const job = ++jobCounter;
    let next = from;
    let timer: NodeJS.Timeout | undefined;

    const finish = (end: RunEnd) => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      resolve(end);
    };
    const arm = () => {
      clearTimeout(timer);
      const left = deadline - Date.now();
      // The budget stops the pattern when less of it is left than the pattern's own limit.
      const reason = left < PATTERN_TIME_LIMIT_MS ? 'budget' : 'timeout';
      timer = setTimeout(() => {
        stopWorker(live);
        finish({ stoppedAt: next, reason });
      }, Math.max(0, Math.min(PATTERN_TIME_LIMIT_MS, left)));
    };
    const onMessage = (message: { job: number; index: number; outcome: PatternOutcome }) => {
      if (message.job !== job) return;
      outcomes[from + message.index] = message.outcome;
      next = from + message.index + 1;
      if (next >= patterns.length) finish({ stoppedAt: null });
      else arm();
    };
    // The worker died (out of memory, say) while running pattern `next`.
    const onExit = () => finish({ stoppedAt: next, reason: 'timeout' });

    worker.on('message', onMessage);
    worker.on('exit', onExit);
    arm();
    worker.postMessage({ job, patterns: patterns.slice(from), subject });
  });
}

async function evaluate(patterns: readonly string[], subject: string): Promise<PatternOutcome[]> {
  const now = Date.now();
  const deadline = now + matchTimeBudgetMs;
  const outcomes: PatternOutcome[] = patterns.map((p) => (isSkipped(p, now) ? 'timeout' : false));
  const todo = patterns.flatMap((_p, i) => (outcomes[i] === 'timeout' ? [] : [i]));
  if (todo.length === 0) return outcomes;

  const toRun = patterns.filter((_p, i) => outcomes[i] !== 'timeout'); // todo's patterns, in its order
  // Each is written as the worker answers it; what the budget doesn't reach stays skipped.
  const results: PatternOutcome[] = new Array<PatternOutcome>(toRun.length).fill('skipped');
  let from = 0;
  while (from < toRun.length) {
    let end: RunEnd;
    try {
      end = await runInWorker(toRun, subject, results, from, deadline);
    } catch (err) {
      // No worker could start: run no pattern, rather than run one on the main thread.
      logger.error({ err }, 'Regex worker unavailable; regex rules skipped');
      for (let i = from; i < toRun.length; i++) results[i] = 'timeout';
      break;
    }
    if (end.stoppedAt === null) break;
    // Out of budget: this pattern and the rest stay skipped. It isn't known to be slow,
    // so it isn't put on the skip list.
    if (end.reason === 'budget') break;
    results[end.stoppedAt] = 'timeout';
    const slow = toRun[end.stoppedAt];
    if (slow !== undefined) rememberSlow(slow, Date.now() + SLOW_PATTERN_SKIP_MS);
    logger.warn(
      { patternLength: slow?.length, limitMs: PATTERN_TIME_LIMIT_MS },
      'A regex rule ran past its time limit; it is skipped for a while'
    );
    from = end.stoppedAt + 1;
  }
  const skipped = results.filter((r) => r === 'skipped').length;
  if (skipped > 0) {
    logger.warn(
      { skipped, patterns: patterns.length, budgetMs: matchTimeBudgetMs },
      'Regex rules skipped: the time budget for one subject ran out'
    );
  }
  todo.forEach((patternIndex, k) => {
    outcomes[patternIndex] = results[k] ?? 'skipped'; // results has one per todo; 'skipped' is its fill
  });
  return outcomes;
}

/**
 * The outcome of each of `patterns` (case-insensitive) on `subject`, without running any
 * of them on the main thread. Never throws.
 */
export function matchUserPatterns(patterns: readonly string[], subject: string): Promise<PatternOutcome[]> {
  if (patterns.length === 0) return Promise.resolve([]);
  const run = queue.then(() => evaluate(patterns, subject));
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Answer 400 INVALID_PATTERN when a rule being saved is a regex rule whose pattern
 * regexRuleProblem refuses, and say so (true); false when it may be saved.
 */
export function answerInvalidPattern(res: Response, method: unknown, matchingText: unknown): boolean {
  if (method !== 'regex') return false;
  const problem = regexRuleProblem(typeof matchingText === 'string' ? matchingText.trim() : String(matchingText ?? ''));
  if (!problem) return false;
  res.status(400).json({ error: 'Invalid pattern', code: 'INVALID_PATTERN', message: problem });
  return true;
}

/** When each ledger (and kind of rule) was last told it has more regex rules than the cap. */
const capWarnedAt = new Map<string, number>();

/**
 * The regex rules of `rules` (in rule order) a matching call may run: the first
 * {@link MAX_REGEX_RULES_PER_TENANT}. A ledger can't save more, but one may have them from
 * before the cap: its rules keep working, past the cap they don't match, and a warning
 * (once a quarter hour per ledger and kind) says so.
 */
export function regexRulesWithinCap<R>(rules: readonly R[], kind: 'budget-item' | 'merchant'): readonly R[] {
  if (rules.length <= MAX_REGEX_RULES_PER_TENANT) return rules;
  const key = `${getCurrentTenantId() ?? 'none'}:${kind}`;
  const now = Date.now();
  const last = capWarnedAt.get(key);
  if (last === undefined || now - last >= SLOW_PATTERN_SKIP_MS) {
    capWarnedAt.delete(key);
    if (capWarnedAt.size >= MAX_SLOW_PATTERNS) capWarnedAt.delete(capWarnedAt.keys().next().value as string);
    capWarnedAt.set(key, now);
    logger.warn(
      { kind, regexRules: rules.length, cap: MAX_REGEX_RULES_PER_TENANT },
      `This tenant has more active regex ${kind} rules than the ${MAX_REGEX_RULES_PER_TENANT} it may have; only the first ${MAX_REGEX_RULES_PER_TENANT} are applied`
    );
  }
  return rules.slice(0, MAX_REGEX_RULES_PER_TENANT);
}

/**
 * Stop the worker and forget slow patterns and cap warnings (tests); `maxSlowPatterns`
 * shrinks the skip list, so a test can fill it. `matchTimeBudgetMs` gives each call another
 * budget than MATCH_TIME_BUDGET_MS: a test of what the patterns answer, rather than of the
 * budget, takes a long one, since on a loaded machine starting a worker can use up 500 ms
 * and leave the patterns skipped.
 */
export async function resetUserRegex(options: { maxSlowPatterns?: number; matchTimeBudgetMs?: number } = {}): Promise<void> {
  slowPatterns.clear();
  capWarnedAt.clear();
  slowPatternCapacity = options.maxSlowPatterns ?? MAX_SLOW_PATTERNS;
  matchTimeBudgetMs = options.matchTimeBudgetMs ?? MATCH_TIME_BUDGET_MS;
  const live = current;
  current = null;
  await live?.worker.terminate();
}
