/**
 * A ref callback that focuses its element once, when it mounts.
 *
 * For a field that takes the place of the control the user just pressed (an inline
 * edit opened by a click): that control unmounts, and without this focus would fall
 * back to the page, leaving a keyboard user to find the field. It is not for focusing
 * a field when a page or dialog opens, which `jsx-a11y/no-autofocus` keeps out (a
 * Radix dialog focuses its first field itself).
 *
 * React calls a ref again whenever the ref it is given changes, and Radix's
 * TextField composes a new one on every render; so each element is focused only the
 * first time it arrives, not on every re-render.
 */
const focused = new WeakSet<HTMLElement>();

export const focusOnMount = (element: HTMLElement | null): void => {
  if (!element || focused.has(element)) return;
  focused.add(element);
  element.focus();
};
