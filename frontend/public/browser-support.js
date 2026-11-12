/*
 * Nuggets: the notice for a browser older than the ones the app is built for.
 *
 * The app is built for Chrome and Edge 111, Firefox 128 and Safari 16.4 (`build.target` in
 * vite.config.ts). An older browser gets the app unstyled (Tailwind 4 needs color-mix()
 * and @property), or broken (Intl.NumberFormat v3 for money, newer JavaScript).
 *
 * This is a classic script, not a module, written in ES5, and not built: Vite copies public/
 * as it is, so any browser that runs JavaScript can run it. It loads from the app's own origin,
 * deferred, ahead of the app's module, as the Content-Security-Policy allows (script-src
 * 'self', no inline script: public/serve.json).
 *
 * Its lines are the build target's:
 *  - color-mix():                Chrome and Edge 111, Firefox 113, Safari 16.2;
 *  - CSS.registerProperty():     Chrome and Edge 78, Firefox 128, Safari 16.4.
 * A browser with both is at least Chrome or Edge 111, Firefox 128 or Safari 16.4.
 *
 * When one is missing it puts `nuggets-unsupported` on <html>: index.html's styles then show
 * its notice in place of the app. "Continue anyway" shows the app instead, for this tab.
 */
(function () {
  var UNSUPPORTED = 'nuggets-unsupported';
  var CONTINUED_KEY = 'nuggets-unsupported-browser-continued';
  var root = document.documentElement;

  function isSupported() {
    try {
      var css = window.CSS;
      return (
        !!css &&
        typeof css.supports === 'function' &&
        css.supports('color', 'color-mix(in srgb, red, blue)') &&
        typeof css.registerProperty === 'function'
      );
    } catch (e) {
      return false;
    }
  }

  function continued() {
    try {
      return window.sessionStorage.getItem(CONTINUED_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function showApp() {
    root.className = (' ' + root.className + ' ').replace(' ' + UNSUPPORTED + ' ', ' ').replace(/^\s+|\s+$/g, '');
    try {
      window.sessionStorage.setItem(CONTINUED_KEY, '1');
    } catch (e) {
      // Storage blocked or full: the app shows for this page only.
    }
    // The button that had focus is hidden now: take focus to the page's heading, so the
    // keyboard and a screen reader carry on from the top of the app rather than from <body>.
    // The app may still be loading behind the notice: then wait for its heading, for at
    // most 10 seconds, unless the person has put the focus somewhere themselves by then.
    if (focusHeading()) return;
    var appRoot = document.getElementById('root');
    var stopAt = new Date().getTime() + 10000;
    var observer = null;
    var done = false;
    function settle() {
      if (done) return true;
      var active = document.activeElement;
      var moved = active && active !== document.body && active !== root && active.id !== 'unsupported-browser-continue';
      if (moved || focusHeading() || new Date().getTime() > stopAt) {
        done = true;
        if (observer) observer.disconnect();
      }
      return done;
    }
    if (window.MutationObserver && appRoot) {
      observer = new window.MutationObserver(settle);
      observer.observe(appRoot, { childList: true, subtree: true });
      setTimeout(function () {
        done = true;
        observer.disconnect();
      }, 10000);
    } else {
      (function poll() {
        if (!settle()) setTimeout(poll, 100);
      })();
    }
  }

  /** Focus the app's heading, if it has rendered; whether it had. */
  function focusHeading() {
    var heading = document.querySelector('#root h1');
    if (!heading) return false;
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus();
    return true;
  }

  if (isSupported() || continued()) return;
  root.className = root.className ? root.className + ' ' + UNSUPPORTED : UNSUPPORTED;

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (target && target.id === 'unsupported-browser-continue') showApp();
  });
})();
