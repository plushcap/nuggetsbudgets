import { useEffect, useRef, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';

const APP_NAME = 'Nuggets';
const POLL_MS = 50;
/** How long to wait for a page's heading (a lazy page, then its data) before settling for `main`. */
export const ROUTE_FOCUS_TIMEOUT_MS = 5000;

/** A page's document title: its heading, then the app's name. */
export const pageTitle = (heading: string | null | undefined): string => {
  const text = heading?.replace(/\s+/g, ' ').trim();
  return text ? `${text} – ${APP_NAME}` : APP_NAME;
};

/**
 * Names each page and, after a navigation inside the app, takes the keyboard there.
 *
 * A single-page app doesn't load a new document when a link is followed, so neither
 * the title nor the focus changes by itself: a screen reader says nothing, and the
 * next Tab starts again in the menu. Once the new page's `<h1>` is in `main`, this sets
 * `document.title` from it and focuses it, so a screen reader reads the page's name and
 * Tab continues into the page. A page without one gets `fallbackHeading` as its title
 * and `main` is focused instead.
 *
 * It waits while a modal dialog (the menu drawer, closing) hides the page, and it
 * leaves the focus alone on the first page shown and when someone has already moved it
 * into the new page. Only the path counts: a changed query string (a filter) moves
 * nothing.
 */
export function useRouteFocus(mainRef: RefObject<HTMLElement | null>, fallbackHeading?: string): void {
  const { pathname } = useLocation();
  const shownPath = useRef<string | null>(null);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const moveFocus = shownPath.current !== null && shownPath.current !== pathname;
    shownPath.current = pathname;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const focusIsInPage = () => {
      const active = document.activeElement;
      return !!active && active !== document.body && active !== main && main.contains(active);
    };
    const hiddenByModal = () => !!main.closest('[aria-hidden="true"]');

    const tick = () => {
      const heading = main.querySelector('h1');
      const timedOut = Date.now() - started >= ROUTE_FOCUS_TIMEOUT_MS;
      if ((heading || timedOut) && !hiddenByModal()) {
        document.title = pageTitle(heading?.textContent ?? fallbackHeading);
        if (moveFocus && !focusIsInPage()) {
          const target: HTMLElement = heading ?? main;
          if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
          target.focus();
        }
        return;
      }
      if (timedOut) return; // A dialog still covers the page: it keeps the focus.
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => clearTimeout(timer);
  }, [pathname, mainRef, fallbackHeading]);
}
