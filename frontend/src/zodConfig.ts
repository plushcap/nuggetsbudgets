/**
 * Zod settings for the app. index.tsx imports this module first, so they apply before
 * any schema is built (the @nuggets/shared ones are built when their module loads).
 *
 * jitless: Zod compiles object parsers with `new Function` where it may, and probes for
 * that the first time it builds an object schema. The app's Content-Security-Policy
 * (public/serve.json) has no 'unsafe-eval', so the compiler can never run in the browser
 * anyway, and the probe would be reported as a CSP violation on every page load.
 */
import { z } from 'zod';

z.config({ jitless: true });
