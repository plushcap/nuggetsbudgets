import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Started by e2e/run.sh, which prepares the database and the environment. The three
 * servers below are the built app as a deployment runs it; Playwright starts them, waits
 * for each to answer, and stops them afterwards.
 */
const root = path.resolve(import.meta.dirname, '..');
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run the tests through e2e/run.sh`);
  return value;
};
const baseURL = required('E2E_BASE_URL');
const backendPort = required('E2E_BACKEND_PORT');
const staticPort = required('E2E_STATIC_PORT');
const appPort = required('E2E_PORT');
const channel = process.env.E2E_BROWSER_CHANNEL || undefined;

export default defineConfig({
  testDir: './tests',
  // The journeys build on each other (sign-in, then a ledger, then its data) in one
  // deployment, so one worker, in order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel } }],
  webServer: [
    {
      name: 'backend',
      // Its JSON log goes to a file (e2e/.run/backend.log), not into the test output.
      command: 'exec node dist/index.js >> ../e2e/.run/backend.log 2>&1',
      cwd: path.join(root, 'backend'),
      // Ready: started, database answering, migrations applied.
      url: `http://127.0.0.1:${backendPort}/api/ready`,
      timeout: 60_000,
      reuseExistingServer: false,
      // Its environment is the one run.sh exported (database, secrets, NODE_ENV=production).
      env: { PORT: backendPort },
    },
    {
      name: 'static',
      // The production image's static server, on the build, with its serve.json.
      command: `node_modules/.bin/serve -s ${path.join(root, 'frontend/build')} -l tcp://127.0.0.1:${staticPort} --no-port-switching`,
      cwd: path.join(root, 'frontend/static-server'),
      url: `http://127.0.0.1:${staticPort}/`,
      reuseExistingServer: false,
    },
    {
      name: 'proxy',
      command: 'node proxy.mjs',
      env: {
        E2E_PORT: appPort,
        BACKEND_URL: `http://127.0.0.1:${backendPort}`,
        STATIC_URL: `http://127.0.0.1:${staticPort}`,
      },
      // Where it listens: the browser's localhost may try ::1 first, Node's check only one.
      url: `http://127.0.0.1:${appPort}/api/ready`,
      reuseExistingServer: false,
    },
  ],
});
