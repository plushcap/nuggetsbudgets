import { useEffect, useMemo, useRef } from 'react';

export interface KeyedDebounce {
  /**
   * Run `run` once `delayMs` have passed without another `schedule` for the same
   * key; scheduling again first drops the earlier run.
   */
  schedule: (key: string, run: () => void | Promise<void>) => void;
  /** Drop the run waiting for `key`, if any. */
  cancel: (key: string) => void;
  /** Drop every waiting run: the edit was cancelled, or saved another way. */
  cancelAll: () => void;
  /**
   * Take every waiting run off its timer and hand it over: a save that covers them is about
   * to run. Drop what this returns once that save succeeds; `putBack` it if it fails.
   */
  takeAll: () => HeldRuns;
  /**
   * Put runs `takeAll` took back on their timers, each unless its key was scheduled or
   * cancelled again meanwhile: the newer edit stands, even once it has run. Nothing goes back
   * after a `cancelAll` (the edit was cancelled while the save ran). After unmount they run at
   * once, as waiting runs do then.
   */
  putBack: (held: HeldRuns) => void;
}

/** Runs taken off their timers by `takeAll`; hand them to `putBack`. */
export interface HeldRuns {
  /** The keys whose runs are held. */
  keys: () => IterableIterator<string>;
}

interface Held extends HeldRuns {
  /** `cancelAll`'s count when they were taken. */
  readonly epoch: number;
  /** Each key's run, and its version when it was taken. */
  readonly runs: ReadonlyMap<string, { run: () => void | Promise<void>; version: number }>;
}

/**
 * Debounce per key, for autosaves. Runs still waiting when the component unmounts run
 * then, at once: an amount typed just before clicking a link is saved, not dropped.
 * `cancel` / `cancelAll` drop them: call `cancelAll` before leaving on Cancel. A save
 * that covers them holds them with `takeAll` and, if it fails, `putBack`s them, so they're
 * not lost with it. The functions keep their identity across renders.
 *
 * The timers live in a ref that only these functions and the unmount cleanup
 * touch, so callers never read a ref while rendering.
 */
export function useKeyedDebounce(delayMs: number): KeyedDebounce {
  const timers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void | Promise<void> }>());
  const unmounted = useRef(false);
  // Each key's version: `schedule` and `cancel` raise it, so `putBack` can tell a held run
  // from a newer edit, waiting or already run. `cancelAll` raises the epoch.
  const versions = useRef(new Map<string, number>());
  const epoch = useRef(0);

  useEffect(() => {
    const pending = timers.current;
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      const waiting = [...pending.values()];
      pending.clear();
      for (const { timer, run } of waiting) {
        clearTimeout(timer);
        void run();
      }
    };
  }, []);

  return useMemo(() => {
    const clearTimers = () => {
      const pending = timers.current;
      pending.forEach(({ timer }) => clearTimeout(timer));
      pending.clear();
    };
    const cancel = (key: string) => {
      const pending = timers.current;
      const waiting = pending.get(key);
      if (waiting) clearTimeout(waiting.timer);
      pending.delete(key);
      versions.current.set(key, (versions.current.get(key) ?? 0) + 1);
    };
    const schedule = (key: string, run: () => void | Promise<void>) => {
      cancel(key);
      const pending = timers.current;
      pending.set(key, {
        run,
        timer: setTimeout(() => {
          pending.delete(key);
          void run();
        }, delayMs),
      });
    };
    const cancelAll = () => {
      epoch.current += 1;
      clearTimers();
    };
    const takeAll = (): HeldRuns => {
      const runs = new Map<string, { run: () => void | Promise<void>; version: number }>();
      timers.current.forEach(({ run }, key) => runs.set(key, { run, version: versions.current.get(key) ?? 0 }));
      clearTimers();
      const held: Held = { epoch: epoch.current, runs, keys: () => runs.keys() };
      return held;
    };
    const putBack = (taken: HeldRuns) => {
      const held = taken as Held;
      if (held.epoch !== epoch.current) return;
      held.runs.forEach(({ run, version }, key) => {
        if ((versions.current.get(key) ?? 0) !== version) return;
        if (unmounted.current) {
          // Run once: the same held runs put back again find the key's version moved.
          versions.current.set(key, version + 1);
          void run();
        } else schedule(key, run);
      });
    };
    return { schedule, cancel, cancelAll, takeAll, putBack };
  }, [delayMs]);
}
