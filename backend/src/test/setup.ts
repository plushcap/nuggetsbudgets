// Global test setup: runs before every test file, in both projects (vitest.config.ts).

// A test that sends a query on a pg connection still running one fails.
import './pgConcurrentQueryGuard.js';
