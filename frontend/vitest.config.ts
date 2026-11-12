import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // The pages' tests click through them with userEvent, a few seconds each on a busy
    // machine: Vitest's default 5 s timed some out under load. One limit
    // for every test, instead of one per slow test or describe.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      // json-summary: coverage/coverage-summary.json, which CI uploads with the lcov report.
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      // Keep the reports when a test fails too, so CI's summary and upload have them; Vitest
      // deletes them after a failed run otherwise.
      reportOnFailure: true,
      // Every source file counts, imported by a test or not: without `include`,
      // Vitest measures only the files the tests load, which overstated coverage.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        '**/*.{test,spec}.{ts,tsx}',
        '**/__tests__/**',
        '**/__mocks__/**',
        '**/mockData/**',
        // Test helpers, not the app.
        'src/test/**',
      ],
      // Floors, so coverage can't drop unnoticed: about a point under what the
      // suite measured over every source file when they were set (2026-11-03, on main:
      // statements 50.28%, branches 47.38%, functions 42%, lines 51.63%). `npm run
      // test:coverage` (CI) fails below them. Raise them as coverage grows; lowering one is a decision to
      // make in review, not a way to get a change through.
      thresholds: {
        statements: 49,
        branches: 46,
        functions: 41,
        lines: 50,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
