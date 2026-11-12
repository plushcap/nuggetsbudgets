import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Local state that starts from `seed()` and starts over from it whenever one of
 * `deps` changes (compared with Object.is, like an effect's dependencies). In
 * between, the state is the component's to change, as an edit form's is.
 *
 * `deps` are reset keys, chosen by hand: a value the seed reads only for the first
 * seed (a URL param, say) stays out of them, and a key the seed doesn't read (reset
 * the page when the search changes) goes in. react-hooks/exhaustive-deps therefore
 * doesn't check them; list them deliberately.
 *
 * It replaces an effect that copied loaded data into state. The state is adjusted
 * while rendering instead ("Adjusting some state when a prop changes",
 * https://react.dev/learn/you-might-not-need-an-effect), so no render with the old
 * value is committed and there is no second pass. `seed` is handed the current
 * state, so it can keep it, as when the data is still loading.
 *
 * A dependency must not be new on every render of the component itself (an
 * inline object, a `= []` default on query data: use EMPTY_LIST), or the state
 * is seeded again on every render and React stops with "Too many re-renders".
 * Props, query data and primitives are fine.
 */
export function useSeededState<T>(
  seed: (current: T | undefined) => T,
  deps: readonly unknown[],
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => seed(undefined));
  const [seededWith, setSeededWith] = useState<readonly unknown[]>(deps);
  if (deps.length !== seededWith.length || deps.some((dep, at) => !Object.is(dep, seededWith[at]))) {
    setSeededWith(deps);
    setState((current) => seed(current));
  }
  return [state, setState];
}
