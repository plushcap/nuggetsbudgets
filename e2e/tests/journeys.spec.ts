import { test, expect, type Page, type ConsoleMessage, type Locator, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * The core journeys, in a real browser against the built app: first-run setup, signing
 * out and in, a new ledger, an account with an opening balance, a budget (an income, an expense
 * and a goal, its figures under their column headings on a wide screen), a transaction that
 * shows in the account, the transaction list and the budget, that transaction edited and saved,
 * a transfer to a second account, the deployment admin's users and organizations pages (their
 * /api/admin routes), a passkey that signs in without an email, an older passkey
 * replaced as the profile page says, and a deleted one taken off the device. One
 * deployment, one user, in order: each step
 * starts where the one before it left off.
 *
 * Throughout, the page may not log an error or break its Content-Security-Policy: the app
 * runs under the policy its static server sends (frontend/public/serve.json).
 */

const ADMIN = {
  firstName: 'Avery',
  lastName: 'Example',
  email: 'avery@example.com',
  password: 'correct horse battery staple',
};
const LEDGER = 'Household';
const ACCOUNT = 'Everyday Checking';
const SAVINGS = 'Rainy Day Savings';
const BUDGET_ITEM = 'Groceries';
const INCOME_ITEM = 'Paycheck';
const GOAL = 'Emergency Fund';
const MERCHANT = 'Corner Grocer';

// One page for the whole file: the session (its cookies) carries from step to step.
test.describe.configure({ mode: 'serial' });
let page: Page;
const problems: string[] = [];
/** The run's day, YYYY-MM-DD (beforeAll): every step, and the browser's clock, use it. */
let today: string;

/**
 * The household's time zone for the run: a fixed-offset zone where it is midday now, so the
 * household's day can't change while the run takes its minutes. In UTC, a run that crossed
 * midnight failed step 7: the account's opening balance, dated by the backend when it
 * is made (step 5), fell on the next day, after the transaction the browser dated the day
 * before, so the running balance beside that transaction was -$82.50. `Etc/GMT-5` is UTC+5
 * (POSIX signs); offsets run from -11 to +12, and at the zone's noon UTC is the same day.
 */
function middayZone(now = new Date()): { name: string; offsetHours: number } {
  const offsetHours = 12 - now.getUTCHours();
  const name = offsetHours === 0 ? 'Etc/GMT' : `Etc/GMT${offsetHours > 0 ? '-' : '+'}${Math.abs(offsetHours)}`;
  return { name, offsetHours };
}
const zone = middayZone();

/** The run's database, as its owner (e2e/run.sh sets it). */
function databaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error('E2E_DATABASE_URL is not set: run the tests through e2e/run.sh');
  return url;
}

/**
 * Set the deployment's time zone (application_timezone, which a ledger that sets none, as
 * the run's, takes), as the deployment-settings page would. The backend reads it per request.
 */
function setHouseholdZone(name: string): void {
  execFileSync('psql', [databaseUrl(), '-XAq', '-v', 'ON_ERROR_STOP=1', '-v', `zone=${name}`], {
    input:
      "INSERT INTO system_settings (setting_key, setting_value, category) VALUES ('application_timezone', :'zone', 'general')\n" +
      '  ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value;\n',
    encoding: 'utf8',
  });
}

/**
 * The household's day as the backend has it (app_today() in the run's database). Read once,
 * so the browser's steps keep one day: steps 6 and 7 both use "this month", and the
 * zone (middayZone) keeps the backend's own day the same until the run ends.
 */
function backendToday(): string {
  const [household, day] = execFileSync('psql', [databaseUrl(), '-XAtc', 'SELECT app_timezone(), app_today()'], { encoding: 'utf8' })
    .trim()
    .split('|');
  if (household !== zone.name) throw new Error(`app_timezone() answered "${household}", not the run's ${zone.name}`);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`app_today() answered "${day}"`);
  return day;
}

/** A new one-time setup token, from the backend's own command (backend/dist/scripts). */
function setupToken(): string {
  const out = execFileSync('node', ['dist/scripts/setup-token.js'], {
    cwd: path.resolve(import.meta.dirname, '../../backend'),
    encoding: 'utf8',
  });
  const token = out.match(/\b[0-9a-f]{64}\b/)?.[0];
  if (!token) throw new Error(`no setup token in: ${out}`);
  return token;
}

/** An amount as the app shows it, e.g. 1000 -> "$1,000.00". */
const usd = (amount: number) =>
  amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** The run's day as the app formats a date in a table, e.g. "11/04/2026". */
const todayMDY = () => {
  const [year, month, day] = today.split('-');
  return `${month}/${day}/${year}`;
};

/** The run's month as the budget names its period, e.g. "November 2026". */
const thisMonth = () =>
  new Date(`${today}T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * The text of a budget item's row under each of the budget's column headers (Planned,
 * Actual, Remaining), by where each value sits under its header: the budget grid is laid
 * out, not a table, and its headers sit over the values. Read so, a new or moved column
 * doesn't break the assertions, as the row's text run together did.
 */
async function budgetRow(name: string): Promise<Record<'Planned' | 'Actual' | 'Remaining' | 'Status', string>> {
  const main = page.getByRole('main');
  const line = await main.getByRole('link', { name, exact: true }).filter({ visible: true }).boundingBox();
  if (!line) throw new Error(`no budget row for ${name}`);
  // Everything on the row's line: the amounts, and the status badge.
  const texts = await main.locator('p, span, button').filter({ visible: true }).evaluateAll((elements, [top, bottom]) =>
    elements
      .filter((el) => el.children.length === 0 || el.tagName === 'BUTTON')
      .map((el) => ({ text: el.textContent?.trim() ?? '', box: el.getBoundingClientRect() }))
      .filter(({ text, box }) => text !== '' && box.bottom > top && box.top < bottom)
      .map(({ text, box }) => ({ text, left: box.left, right: box.right })),
  [line.y, line.y + line.height]);
  const row = { Planned: '', Actual: '', Remaining: '', Status: '' };
  // The column headers: the row of them that holds "Planned" (the summary above has an
  // "Actual" of its own).
  const headers = main.getByText('Planned', { exact: true }).filter({ visible: true }).locator('xpath=..');
  for (const header of ['Planned', 'Actual', 'Remaining'] as const) {
    const column = await headers.getByText(header, { exact: true }).boundingBox();
    if (!column) throw new Error(`no ${header} column`);
    row[header] = texts
      .filter(({ text, left, right }) => /\$/.test(text) && (left + right) / 2 >= column.x && (left + right) / 2 <= column.x + column.width)
      .map(({ text }) => text)
      .join(' ');
  }
  row.Status = texts.find(({ text }) => /^(On Track|Near Limit|Warning|Critical|Over Budget|Spent|Expected|Partly received|Received|Above plan|Funded)$/.test(text))?.text ?? '';
  return row;
}

type Column = 'Planned' | 'Actual' | 'Remaining';

/**
 * How far, in px, each figure on a line of the desktop budget grid (an item's row, or a section's
 * totals) ends from the end of its column's heading. Each is the right edge
 * of the text itself, from a Range over its text nodes: a figure's box isn't where its text ends
 * (the budget button's padding hangs outside its column, and a heading's cell is wider than its
 * word). A figure is in the column whose heading's cell holds its centre; null if none is.
 */
async function columnOffsets(anchor: Locator): Promise<Record<Column, number | null>> {
  return anchor.filter({ visible: true }).evaluate((line) => {
    const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const textRight = (el: Element) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let right = -Infinity;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) if (rect.width > 0) right = Math.max(right, rect.right);
      }
      return right;
    };
    const main = line.closest('main') as HTMLElement;
    // The headings: the row of them that holds "Planned" (the summary has an "Actual" of its own).
    const planned = Array.from(main.querySelectorAll('div')).find((el) => el.textContent === 'Planned' && visible(el));
    const headings = planned?.parentElement;
    if (!headings) throw new Error('no column headings');
    const box = line.getBoundingClientRect();
    // The figures on the anchor's line: the leaf texts (and buttons) with an amount in them.
    const figures = Array.from(main.querySelectorAll('p, span, button'))
      .filter((el) => visible(el) && (el.children.length === 0 || el.tagName === 'BUTTON') && /\$/.test(el.textContent ?? ''))
      .map((el) => ({ rect: el.getBoundingClientRect(), right: textRight(el) }))
      .filter(({ rect }) => rect.bottom > box.top && rect.top < box.bottom);
    const offsets: Record<string, number | null> = {};
    for (const name of ['Planned', 'Actual', 'Remaining']) {
      const heading = Array.from(headings.children).find((el) => el.textContent === name);
      if (!heading) throw new Error(`no ${name} heading`);
      const cell = heading.getBoundingClientRect();
      const figure = figures.find(({ rect }) => (rect.left + rect.right) / 2 >= cell.left && (rect.left + rect.right) / 2 <= cell.right);
      offsets[name] = figure ? Math.round((figure.right - textRight(heading)) * 10) / 10 : null;
    }
    return offsets as Record<'Planned' | 'Actual' | 'Remaining', number | null>;
  });
}

/** An account's card on the accounts page. */
const accountCard = (name: string) =>
  page.getByRole('main').locator('.rt-Card').filter({ visible: true }).filter({ has: page.getByRole('link', { name, exact: true }) });

test.beforeAll(async ({ browser }) => {
  setHouseholdZone(zone.name);
  today = backendToday();
  page = await browser.newPage({ timezoneId: zone.name });
  // The browser's clock starts at noon of the run's day in the household's zone and runs on
  // from there: the app's own "today" (the budget month it offers, a new transaction's date)
  // stays that day.
  await page.clock.setSystemTime(new Date(Date.parse(`${today}T12:00:00Z`) - zone.offsetHours * 3_600_000));
  // Chromium logs a blocked script or resource, but not a `new Function` the page caught
  // (Zod's eval probe): the page reports every violation to the console itself.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`Content-Security-Policy: ${e.violatedDirective} blocked ${e.blockedURI} (${e.sourceFile}:${e.lineNumber})`);
    });
  });
  page.on('console', (message: ConsoleMessage) => {
    const text = message.text();
    // The app asks who is signed in before anyone is: those answers are 401 by design.
    if (message.type() === 'error' && !/status of 401/.test(text)) problems.push(`console: ${text}`);
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
});

test.afterAll(async () => {
  await page?.close();
});

test.afterEach(() => {
  // Read per step, so a failure names the step that caused it.
  const found = problems.splice(0);
  expect(found, 'the page logged errors or broke its Content-Security-Policy').toEqual([]);
});

test('the app is served with its Content-Security-Policy, and a fresh deployment asks for setup', async () => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toMatch(/default-src 'self';.*script-src 'self'/);
  await expect(page).toHaveURL(/\/admin-setup$/);
  await expect(page.getByRole('button', { name: 'Create Admin Account' })).toBeVisible();
});

test('first-run setup creates the admin and signs them in', async () => {
  await page.getByLabel('Setup Token').fill(setupToken());
  await page.getByLabel('First Name').fill(ADMIN.firstName);
  await page.getByLabel('Last Name').fill(ADMIN.lastName);
  await page.getByLabel('Email Address').fill(ADMIN.email);
  await page.getByLabel('Password *', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('Confirm Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create Admin Account' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'User menu' })).toContainText(ADMIN.firstName);
});

test('signing out ends the session, and signing in starts a new one', async () => {
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  // Signed out, the app's pages send the browser back to sign in.
  await page.goto('/accounts');
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel(/Email/).fill(ADMIN.email);
  await page.getByLabel(/^Password/).fill(ADMIN.password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await expect(page.getByRole('button', { name: 'User menu' })).toContainText(ADMIN.firstName);
  await expect(page).not.toHaveURL(/\/login/);
});

test('a new ledger, switched to, starts empty', async () => {
  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'New ledger' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create ledger' });
  await dialog.getByLabel('Name').fill(LEDGER);
  await dialog.getByRole('button', { name: 'Create ledger' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: new RegExp(`^${LEDGER}\\b`) })).toBeVisible();

  await page.getByRole('button', { name: /^Switch ledger/ }).click();
  await page.getByRole('menuitemradio', { name: LEDGER }).click();
  await expect(page.getByRole('button', { name: `Switch ledger (current: ${LEDGER})` })).toBeVisible();

  await page.goto('/accounts');
  await expect(page.getByRole('heading', { name: 'No accounts yet' })).toBeVisible();
});

test('an account opens with its starting balance', async () => {
  await page.getByRole('link', { name: 'Add Account' }).click();
  await page.getByLabel('Account Name').fill(ACCOUNT);
  await page.getByLabel('Initial Balance').fill('1,000.00');
  await page.getByRole('button', { name: 'Create Account' }).click();

  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByRole('link', { name: ACCOUNT })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(/Net Worth\s*\$1,000\.00/);
});

test('a budget: an income, an expense item and a goal, then this month\'s period', async () => {
  await page.goto('/budget-items/add');
  await page.getByRole('radio', { name: 'Income' }).click();
  await page.getByLabel('Income Name').fill(INCOME_ITEM);
  await page.getByLabel('Monthly Income Amount').fill('5,000.00');
  await page.getByRole('button', { name: 'Create Income' }).click();
  await expect(page).toHaveURL(/\/budgets$/);

  await page.goto('/budget-items/add');
  await page.getByLabel('Expense Name').fill(BUDGET_ITEM);
  await page.getByLabel('Monthly Budget Amount').fill('400.00');
  await page.getByRole('button', { name: 'Create Expense' }).click();
  await expect(page).not.toHaveURL(/\/budget-items\/add$/);

  await page.goto('/goals/add');
  await page.getByLabel('Goal Name').fill(GOAL);
  await page.getByLabel('Target Amount').fill('1,000.00');
  await page.getByRole('button', { name: /^Target Date/ }).click();
  await page.getByRole('button', { name: /^Today, / }).click();
  await page.getByLabel('Estimated Monthly Contribution').fill('50.00');
  await page.getByRole('button', { name: 'Create Goal' }).click();
  await expect(page).toHaveURL(/\/goals$/);

  await page.goto('/settings/budget-periods/add');
  // The month the page offers is the current one.
  await page.getByRole('button', { name: 'Create Budget Period' }).click();
  await expect(page).not.toHaveURL(/\/budget-periods\/add$/);

  await page.goto('/budgets');
  const main = page.getByRole('main');
  await expect(main).toContainText(thisMonth());
  await expect.poll(() => budgetRow(BUDGET_ITEM)).toEqual({ Planned: '$400.00', Actual: '$0.00', Remaining: '$400.00', Status: 'On Track' });
  // Pay not in yet is Expected, not Over Budget.
  await expect.poll(() => budgetRow(INCOME_ITEM)).toMatchObject({ Planned: '$5,000.00', Actual: '$0.00', Status: 'Expected' });
  await expect.poll(() => budgetRow(GOAL)).toMatchObject({ Planned: '$50.00', Actual: '$0.00', Remaining: '$50.00' });
});

// On a wide screen nothing sat under its heading. The section totals ended
// 20px right of the headings, the income rows' figures 8px right, the goal rows' 32px (they had
// no actions column), the expense rows' 4px left, and each Planned figure was centred in its
// button. Every line now ends in the same columns.
test("the budget's figures and totals sit under their column headings on a wide screen", async () => {
  const before = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    await page.goto('/budgets');
    const main = page.getByRole('main');
    const lines: Array<[string, Locator]> = [
      [INCOME_ITEM, main.getByRole('link', { name: INCOME_ITEM, exact: true })],
      [GOAL, main.getByRole('link', { name: GOAL, exact: true })],
      [BUDGET_ITEM, main.getByRole('link', { name: BUDGET_ITEM, exact: true })],
      ...['Income', 'Goals', 'Expenses', 'Monthly', 'Flexible'].map(
        (section): [string, Locator] => [`${section} totals`, main.getByRole('button', { name: section, exact: true })],
      ),
    ];
    // Within a pixel, each figure's text ends where its heading's does: the lines that don't,
    // with how far each figure ends from its heading's end.
    await expect
      .poll(async () => {
        const off: Record<string, Record<Column, number | null>> = {};
        for (const [name, anchor] of lines) {
          const offsets = await columnOffsets(anchor);
          if (!Object.values(offsets).every((offset) => offset !== null && Math.abs(offset) <= 1)) off[name] = offsets;
        }
        return off;
      }, { message: "lines whose figures end off their column headings' ends (px)" })
      .toEqual({});
  } finally {
    if (before) await page.setViewportSize(before);
  }
});

test('a transaction shows in the account, the transaction list and the budget', async () => {
  await page.goto('/accounts');
  await page.getByRole('link', { name: ACCOUNT }).click();
  await expect(page.getByRole('heading', { level: 1, name: ACCOUNT })).toBeVisible();
  await page.getByRole('button', { name: 'Add transaction' }).click();

  await page.getByLabel('Amount').fill('82.50');
  await page.getByRole('button', { name: /^Merchant Name/ }).click();
  await page.getByLabel('Search merchants', { exact: true }).fill(MERCHANT);
  await page.getByRole('option', { name: `Add "${MERCHANT}"` }).click();
  await page.getByRole('combobox', { name: 'Budget Period' }).click();
  await page.getByRole('option', { name: new RegExp(thisMonth()) }).click();
  await page.getByRole('combobox', { name: 'Budget Item' }).click();
  await page.getByRole('option', { name: new RegExp(BUDGET_ITEM) }).click();
  await page.getByRole('button', { name: 'Create Transaction' }).click();

  // The account: the expense (shown in accounting style), dated today, and the running
  // balance after it: 1,000.00 - 82.50.
  await expect(page.getByRole('heading', { level: 1, name: ACCOUNT })).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(MERCHANT) });
  await expect(row).toContainText(todayMDY());
  await expect(row).toContainText(`(${usd(82.5)})`);
  await expect(row).toContainText(usd(917.5));

  // The ledger's transaction list.
  await page.goto('/transactions');
  await expect(page.getByRole('row', { name: new RegExp(MERCHANT) })).toBeVisible();

  // The budget: the item's planned, actual and remaining (400.00 - 82.50).
  await page.goto('/budgets');
  await expect.poll(() => budgetRow(BUDGET_ITEM)).toEqual({ Planned: '$400.00', Actual: '($82.50)', Remaining: '$317.50', Status: 'On Track' });
});

// Save Changes on the edit page sent the status as its label ('Cleared'), which the
// server refuses, so every whole-form save failed.
test('a transaction edited and saved keeps the edit: its status and a note', async () => {
  const NOTE = 'Paid at the register';
  await page.goto('/transactions');
  await page
    .getByRole('row', { name: new RegExp(MERCHANT) })
    .getByRole('button', { name: `Edit ${MERCHANT}, ${todayMDY()}` })
    .click();
  await expect(page).toHaveURL(/\/transactions\/[0-9a-f-]+\?edit=true/);
  const transactionPath = new URL(page.url()).pathname;

  const status = page.getByRole('combobox', { name: /^Status/ });
  await expect(status).toHaveText('Pending');
  await status.click();
  await page.getByRole('option', { name: 'Cleared', exact: true }).click();
  await expect(status).toHaveText('Cleared');
  await page.getByRole('textbox', { name: /^Notes/ }).fill(NOTE);
  await page.getByRole('button', { name: 'Save Changes' }).click();

  // Saved, the page goes back to the list it came from.
  await expect(page).toHaveURL(/\/transactions$/);

  // Opened again, it has both, and the amount it had.
  await page.goto(transactionPath);
  const main = page.getByRole('main');
  await expect(main).toContainText(NOTE);
  await expect(main.getByText('Cleared', { exact: true }).first()).toBeVisible();
  await expect(main).toContainText(usd(-82.5));
});

test('a transfer to a second account moves the money: both balances, and both sides listed', async () => {
  // A second account, with 500.00 to start.
  await page.goto('/accounts');
  await page.getByRole('link', { name: 'Add Account' }).click();
  await page.getByLabel('Account Name').fill(SAVINGS);
  await page.getByLabel('Initial Balance').fill('500.00');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(accountCard(SAVINGS)).toContainText(usd(500));

  // 200.00 from checking to savings, on the transfer page.
  await page.goto('/transfertransaction');
  await page.getByRole('combobox', { name: /^From Account/ }).click();
  await page.getByRole('option', { name: ACCOUNT, exact: true }).click();
  await page.getByRole('combobox', { name: /^To Account/ }).click();
  await page.getByRole('option', { name: SAVINGS, exact: true }).click();
  await page.getByRole('textbox', { name: /^Amount/ }).fill('200.00');
  await page.getByRole('button', { name: 'Create Transfer' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText(`from ${ACCOUNT} to ${SAVINGS}`);
  await confirm.getByRole('button', { name: 'Transfer', exact: true }).click();

  // Both sides, in the ledger's transaction list (where the page goes back to): the
  // payee is the transfer, each in its own account, out of checking and into savings.
  await expect(page).toHaveURL(/\/transactions$/);
  const sides = page.getByRole('row', { name: new RegExp(`Transfer: ${SAVINGS}`) });
  await expect(sides).toHaveCount(2);
  const out = sides.filter({ hasText: ACCOUNT });
  await expect(out).toContainText(`(${usd(200)})`);
  await expect(out).toContainText(todayMDY());
  const into = sides.filter({ hasNotText: ACCOUNT });
  await expect(into).toContainText(usd(200));
  await expect(into).not.toContainText(`(${usd(200)})`);

  // The balances: 1,000.00 - 82.50 - 200.00 in checking, 500.00 + 200.00 in savings; the
  // net worth is as it was.
  await page.goto('/accounts');
  await expect(accountCard(ACCOUNT)).toContainText(usd(717.5));
  await expect(accountCard(SAVINGS)).toContainText(usd(700));
  await expect(page.getByRole('main')).toContainText(/Net Worth\s*\$1,417\.50/);
});

// The deployment-admin routes moved under /api/admin, and no journey opened a
// page that calls them; only the API tests did.
test("a deployment admin's pages answer from /api/admin: the users, and the organizations", async () => {
  const answered = (path: string) =>
    page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === 'GET');

  const users = answered('/api/admin/users');
  await page.goto('/settings/users');
  expect((await users).status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'User Management' })).toBeVisible();
  // The admin, from first-run setup, is the one user.
  await expect(page.getByRole('row', { name: new RegExp(ADMIN.email) })).toContainText(`${ADMIN.firstName} ${ADMIN.lastName}`);

  const organizations = answered('/api/admin/organizations');
  await page.goto('/settings/organizations');
  expect((await organizations).status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
});

/** One row's columns from the run's database, as psql prints them unaligned (|-separated). */
function databaseRow(query: string, ...args: string[]): string[] {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error('E2E_DATABASE_URL is not set: run the tests through e2e/run.sh');
  const vars = args.flatMap((value, i) => ['-v', `a${i + 1}=${value}`]);
  return execFileSync('psql', [url, '-XAt', ...vars], { input: query, encoding: 'utf8' }).trim().split('|');
}

/**
 * Records, in the page, each WebAuthn request it makes (navigator.credentials.get), as
 * `conditional:` (one that waits in the email box's autofill) or `modal:` (one asked for now),
 * then `started`, `resolved` or `rejected`, in sessionStorage, so the record outlives the reload
 * after a sign-in. Installed in every document the page opens from now on.
 */
async function recordWebAuthnRequests(): Promise<void> {
  await page.addInitScript(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (options?: CredentialRequestOptions) => {
      const kind = options?.mediation === 'conditional' ? 'conditional' : 'modal';
      const note = (what: string) => {
        const calls = JSON.parse(sessionStorage.getItem('webauthnCalls') ?? '[]') as string[];
        sessionStorage.setItem('webauthnCalls', JSON.stringify([...calls, `${kind}:${what}`]));
      };
      note('started');
      return get(options).then(
        (credential) => {
          note('resolved');
          return credential;
        },
        (error: unknown) => {
          note('rejected');
          throw error;
        }
      );
    };
  });
}
const webauthnCalls = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('webauthnCalls') ?? '[]') as string[]);
/** How the requests the page made ended, in order. */
const webauthnOutcomes = async () => (await webauthnCalls()).filter((call) => !call.endsWith(':started'));
const forgetWebauthnCalls = () => page.evaluate(() => sessionStorage.removeItem('webauthnCalls'));
/**
 * For a poll across a navigation: the outcomes, or null (not yet) while the page is between
 * documents, when an evaluate throws "Execution context was destroyed" instead of answering.
 * The record itself is in sessionStorage, so the next try reads it. Any other error is thrown.
 */
const webauthnOutcomesOnceLoaded = async (): Promise<string[] | null> => {
  try {
    return await webauthnOutcomes();
  } catch (error) {
    if (error instanceof Error && /Execution context was destroyed|navigat/i.test(error.message)) return null;
    throw error;
  }
};

/** Adds a passkey on the profile page, confirming the password if the page asks. */
async function addPasskeyOnProfile(name: string) {
  await page.getByRole('button', { name: 'Add Passkey' }).click();
  const add = page.getByRole('dialog', { name: 'Add New Passkey' });
  await add.getByLabel('Device Name').fill(name);
  await add.getByRole('button', { name: 'Add Passkey' }).click();
  const added = page.getByText('Passkey added successfully!');
  const confirm = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(added.or(confirm)).toBeVisible();
  if (await confirm.isVisible()) {
    await confirm.getByLabel('Password').fill(ADMIN.password);
    await confirm.getByRole('button', { name: 'Confirm' }).click();
  }
  await expect(added).toBeVisible();
  // The toast shows before the dialog closes. While the dialog is open the page behind it is
  // hidden from the accessibility tree, so the next "Add Passkey" click would land on this
  // dialog's own button and register a second passkey under this name.
  await expect(add).toBeHidden();
}

// Passkey sign-in asks for no email. The browser offers the passkeys it holds for the
// site (discoverable ones), in the email box's autofill or when asked with the button, and
// the passkey says whose account it is. Here a virtual authenticator (Chrome's, over CDP)
// holds the passkey: it makes discoverable passkeys and verifies its user.
test('a passkey added on the profile page signs in without an email: with the button, and from the autofill', async () => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await recordWebAuthnRequests();
  try {
    // Added on the profile page. Adding one needs a recent sign-in or confirmation.
    await page.goto('/profile');
    await addPasskeyOnProfile('Test laptop');
    await expect(page.getByText('Test laptop')).toBeVisible();
    // Discoverable, so no note about passkeys that may need an email.
    await expect(page.getByText(/no longer asks for your email/)).toHaveCount(0);

    // The authenticator holds it as a discoverable passkey, under the account's own user
    // handle, which the server stored with it, and the browser said it was discoverable.
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ isResidentCredential: true, rpId: 'localhost' });
    const handle = Buffer.from(credentials[0].userHandle ?? '', 'base64').toString('base64url');
    const [accountHandle, storedHandle, discoverable] = databaseRow(
      `SELECT u.webauthn_user_id, p.user_handle, p.discoverable FROM users u JOIN passkey_credentials p ON p.user_id = u.id WHERE u.email = :'a1'`,
      ADMIN.email
    );
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([accountHandle, storedHandle, discoverable]).toEqual([handle, handle, 't']);

    // The button. While the sign-in page waits for a passkey chosen in its autofill, the
    // virtual authenticator would answer that request by itself; it doesn't answer one that
    // started while it couldn't, so it can't until the button asks again.
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
    await forgetWebauthnCalls();
    await page.getByRole('button', { name: 'User menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    const email = page.getByLabel(/Email/);
    await expect(email).toHaveAttribute('autocomplete', 'username webauthn');
    // The autofill request is waiting: the tip says so.
    await expect(page.getByText(/your saved passkeys are also offered when you select the email box/i)).toBeVisible();
    await expect.poll(webauthnCalls).toEqual(['conditional:started']);
    // Let the browser hand it to the authenticator, which can't answer it now, and see it wait.
    await page.waitForTimeout(1000);
    await expect(page).toHaveURL(/\/login/);
    expect(await webauthnCalls()).toEqual(['conditional:started']);
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
    await expect(email).toHaveValue('');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByRole('button', { name: 'User menu' })).toContainText(ADMIN.firstName);
    await expect(page).not.toHaveURL(/\/login/);
    // The button signed in: it ended the waiting autofill request, and its own request was
    // answered. (Had the button failed, the autofill offered again would have signed in.)
    expect(await webauthnOutcomes()).toEqual(['conditional:rejected', 'modal:resolved']);

    // The autofill: signed out, the sign-in page's waiting request is answered with the
    // passkey (the virtual authenticator chooses it), and nothing is typed or clicked.
    await forgetWebauthnCalls();
    await page.getByRole('button', { name: 'User menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    // Wait for the autofill's own answer first: right after the click the old page is still
    // signed in, so a check that it is passes before the sign-out has happened (it did on a
    // loaded machine, and the outcome was read before the sign-in page had asked).
    await expect.poll(webauthnOutcomesOnceLoaded, { timeout: 15_000 }).toEqual(['conditional:resolved']);
    await expect(page.getByRole('button', { name: 'User menu' })).toContainText(ADMIN.firstName);
    await expect(page).not.toHaveURL(/\/login/);
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
});

// The profile page tells someone with a passkey that isn't known to sign in
// without an email to add a new one on that device or key, then delete the old. The device
// holding the old one must let the new one be added beside it.
test('a passkey from before is replaced as the profile page says: a new one added beside it, then the old one deleted', async () => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  try {
    // A passkey this device holds from before email-free passkey sign-in: registered under a user handle the
    // server never kept, and stored with no handle and no word on whether it is discoverable.
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from([0x22, 0x58, 0x20]),
      Buffer.from(jwk.y, 'base64url'),
    ]);
    const oldId = randomBytes(16);
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId,
      credential: {
        credentialId: oldId.toString('base64'),
        isResidentCredential: true,
        rpId: 'localhost',
        privateKey: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
        userHandle: randomBytes(32).toString('base64'),
        signCount: 0,
      },
    });
    databaseRow(
      `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports, device_name)
       SELECT id, :'a2', :'a3', 0, ARRAY['internal'], 'Old key' FROM users WHERE email = :'a1'`,
      ADMIN.email,
      oldId.toString('base64url'),
      cose.toString('base64url')
    );

    await page.goto('/profile');
    const note = page.getByText(/Signing in with a passkey no longer asks for your email/);
    await expect(note).toContainText("One of your passkeys isn't known to work that way");
    await expect(note).toContainText('add a new one on that device or key, then delete the old one');
    const oldCard = page.locator('.rt-Card').filter({ hasText: 'Old key' }).filter({ hasNotText: 'Test laptop' });
    await expect(oldCard).toContainText('Not yet known to sign in without your email');

    // Added beside it: the device holds both.
    await addPasskeyOnProfile('New key');
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    expect(credentials.map((c) => c.isResidentCredential)).toEqual([true, true]);

    // Then the old one deleted: the note goes.
    await oldCard.getByRole('button', { name: 'Delete passkey' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Passkey' }).click();
    await expect(page.getByText('Passkey deleted successfully')).toBeVisible();
    await expect(page.getByText(/no longer asks for your email/)).toHaveCount(0);
    const stored = execFileSync(
      'psql',
      [process.env.E2E_DATABASE_URL!, '-XAtc', "SELECT string_agg(device_name || ':' || discoverable, ',' ORDER BY device_name) FROM passkey_credentials"],
      { encoding: 'utf8' }
    ).trim();
    expect(stored).toBe('New key:true,Test laptop:true');
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
});

// Deleting a passkey on the profile page tells the browser that passkey is gone (WebAuthn's
// Signal API, signalUnknownCredential), so it stops offering it. The browser drops it and nothing
// else: not another account's passkey for the site, nor this account's own, one of them being added
// in another tab at that very moment (a list of the passkeys that remain, read then, would leave it
// out, and the browser would drop it with the deleted one). A device holds one passkey per account
// (a new one replaces it), so the one being added is on another of the browser's authenticators.
test('a passkey deleted on the profile page is taken off the device; the others stay, one being added meanwhile', async ({ browser }) => {
  await page.goto('/profile');
  const hasSignals = await page.evaluate(
    () => typeof (PublicKeyCredential as unknown as { signalUnknownCredential?: unknown }).signalUnknownCredential === 'function'
  );
  test.skip(!hasSignals, 'This browser has no WebAuthn Signal API');
  const authenticator = {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  } as const;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  // A second tab of the same browser: its own page, signed in with the same session.
  const secondContext = await browser.newContext();
  await secondContext.addCookies(await page.context().cookies());
  const second = await secondContext.newPage();
  const cdp2 = await secondContext.newCDPSession(second);
  const held: Route[] = [];
  const devices: string[] = [];
  const addDevice = async (session: typeof cdp, transport: 'internal' | 'usb' = 'internal') => {
    const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', { options: { ...authenticator, transport } });
    if (session === cdp) devices.push(authenticatorId);
    return authenticatorId;
  };
  const onDevice = async (session: typeof cdp, authenticatorId: string) =>
    (await session.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  try {
    // "Spare key", added on the profile page.
    const spareDevice = await addDevice(cdp);
    await addPasskeyOnProfile('Spare key');
    const [spare] = await onDevice(cdp, spareDevice);
    expect(spare).toBeDefined();

    // Another passkey being added in this tab, on another device: the device has made it, the
    // server hasn't stored it yet (its verify request is held, as on a slow network).
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: spareDevice });
    const raceDevice = await addDevice(cdp);
    await page.route('**/api/passkeys/register/verify', (route) => {
      held.push(route);
    });
    await page.getByRole('button', { name: 'Add Passkey' }).click();
    const add = page.getByRole('dialog', { name: 'Add New Passkey' });
    await add.getByLabel('Device Name').fill('Race key');
    await add.getByRole('button', { name: 'Add Passkey' }).click();
    const confirm = page.getByRole('dialog', { name: 'Confirm it’s you' });
    await expect.poll(async () => held.length > 0 || (await confirm.isVisible())).toBe(true);
    if (held.length === 0) {
      await confirm.getByLabel('Password').fill(ADMIN.password);
      await confirm.getByRole('button', { name: 'Confirm' }).click();
      await expect.poll(() => held.length).toBe(1);
    }
    const [race] = await onDevice(cdp, raceDevice);
    expect(race).toBeDefined();

    // The second tab's browser holds them: "Spare key" with someone else's passkey for this site
    // (another user handle) on one authenticator, and "Race key" on another.
    await cdp2.send('WebAuthn.enable');
    const phone = await addDevice(cdp2);
    const securityKey = await addDevice(cdp2, 'usb');
    const otherId = randomBytes(16).toString('base64');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await cdp2.send('WebAuthn.addCredential', {
      authenticatorId: phone,
      credential: {
        credentialId: otherId,
        isResidentCredential: true,
        rpId: 'localhost',
        privateKey: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
        userHandle: randomBytes(32).toString('base64'),
        signCount: 0,
      },
    });
    await cdp2.send('WebAuthn.addCredential', { authenticatorId: phone, credential: spare! });
    await cdp2.send('WebAuthn.addCredential', { authenticatorId: securityKey, credential: race! });
    const heldNow = async () => [
      (await onDevice(cdp2, phone)).map((c) => c.credentialId).sort(),
      (await onDevice(cdp2, securityKey)).map((c) => c.credentialId),
    ];
    expect(await heldNow()).toEqual([[otherId, spare!.credentialId].sort(), [race!.credentialId]]);

    // "Spare key" deleted in the second tab: the browser drops it alone.
    await second.goto('/profile');
    const spareCard = second.locator('.rt-Card').filter({ hasText: 'Spare key' }).filter({ hasNotText: 'Test laptop' });
    await spareCard.getByRole('button', { name: 'Delete passkey' }).click();
    await second.getByRole('alertdialog').getByRole('button', { name: 'Delete Passkey' }).click();
    await expect(spareCard).toHaveCount(0);
    const kept = [[otherId], [race!.credentialId]];
    await expect.poll(heldNow).toEqual(kept);
    await second.waitForTimeout(1000);
    expect(await heldNow()).toEqual(kept);

    // The held registration goes through: the server keeps "Race key", which its device still holds.
    await held[0]!.continue();
    const stored = () =>
      execFileSync(
        'psql',
        [process.env.E2E_DATABASE_URL!, '-XAtc', "SELECT string_agg(device_name, ',' ORDER BY device_name) FROM passkey_credentials"],
        { encoding: 'utf8' }
      ).trim();
    await expect.poll(stored).toBe('New key,Race key,Test laptop');
  } finally {
    await page.unroute('**/api/passkeys/register/verify').catch(() => undefined);
    await secondContext.close().catch(() => undefined);
    for (const authenticatorId of devices) await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
});
