import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // json-summary: coverage/coverage-summary.json, which CI uploads with the lcov report.
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      // Keep the reports when a test fails too, so CI's summary and upload have them; Vitest
      // deletes them after a failed run otherwise.
      reportOnFailure: true,
      // Every source file counts, imported by a test or not.
      include: ['src/**/*.ts'],
      exclude: ['**/*.d.ts'],
      // Floors, so coverage can't drop unnoticed: about a point under what the suite
      // measured when they were set (2026-11-02: statements 98.45%, branches 85%, functions
      // 98.82%, lines 100%). `npm run test:coverage` (CI) fails below them. Raise them as
      // coverage grows; lowering one is a decision to make in review.
      thresholds: {
        statements: 97,
        branches: 84,
        functions: 97,
        lines: 99,
      },
    },
  },
});
