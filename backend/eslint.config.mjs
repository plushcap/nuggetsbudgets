import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Calendar dates: "today" is the household's day and a date column is already
// 'YYYY-MM-DD', so neither goes through a Date's UTC string, or SQL's session-zone day.
const CALENDAR_DATES = [
  {
    selector: "CallExpression[callee.property.name=/^(slice|substring|substr|split)$/][callee.object.callee.property.name='toISOString']",
    message: "A Date's UTC string isn't a calendar date. Today is appToday() (utils/appDate.ts); day math is in utils/calendarDate.ts.",
  },
  {
    selector: 'TemplateElement[value.raw=/\\bCURRENT_DATE\\b|now\\(\\)\\s*::\\s*date/i]',
    message: "CURRENT_DATE and now()::date follow the session's zone. The household's today in SQL is app_today().",
  },
];

// Settings come from config() (config.ts) and secrets from utils/docker-secrets.ts:
// no reading or writing a variable on process.env elsewhere. Passing the environment whole
// to the functions that take one (getOwnerCredentials(process.env, true),
// validateStartupConfig(process.env, …)), defaulting a function's parameter to it
// (`env = process.env`, not a destructured one), or comparing it (`env === process.env`)
// reads no variable, and stays
// allowed. Anything else doesn't: logger.info(process.env), JSON.stringify(process.env),
// inspect(process.env) and structuredClone(process.env) would spill every secret in it, and
// `'X' in process.env` reads one (any plain call, and `in`, were once let through).
const ENV_MESSAGE =
  'Read a setting with config() (config.ts) and a secret with readDockerSecret or envSecret (utils/docker-secrets.ts), not process.env.';
const PROCESS_ENV = [
  {
    selector:
      "MemberExpression[property.name='env']:matches([object.name='process'], [object.property.name='process'])" +
      ":not(:function > AssignmentPattern[left.type='Identifier'] > .right, BinaryExpression[operator=/^[!=]==?$/] > *," +
      " CallExpression[callee.name=/^(getOwnerCredentials|validateStartupConfig)$/] > .arguments)",
    message: ENV_MESSAGE,
  },
  { selector: "MemberExpression[object.name='process'][computed=true][property.value='env']", message: ENV_MESSAGE },
  { selector: "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']", message: ENV_MESSAGE },
  { selector: 'ImportDeclaration[source.value=/^(node:)?process$/]', message: ENV_MESSAGE },
];

// formatMoney's defaults are one client's ledger's (the SPA's, setFormatMoneyDefaults): the
// server shows every ledger's money, so it passes each ledger's own format to each call
// (services/tenantMoneyFormat.ts), and never sets the defaults, which would show one ledger's
// currency in another's texts.
const MONEY_DEFAULTS_MESSAGE =
  "The server serves every ledger: pass the ledger's format to formatMoney (moneyText / tenantMoneyText, services/tenantMoneyFormat.ts), never setFormatMoneyDefaults.";
// By its name, and by a string naming it (shared['setFormatMoneyDefaults'](…), a template one too).
const MONEY_DEFAULTS = [
  { selector: "Identifier[name='setFormatMoneyDefaults']", message: MONEY_DEFAULTS_MESSAGE },
  { selector: "Literal[value='setFormatMoneyDefaults']", message: MONEY_DEFAULTS_MESSAGE },
  { selector: "TemplateElement[value.cooked='setFormatMoneyDefaults']", message: MONEY_DEFAULTS_MESSAGE },
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      // An error, so dead code doesn't pile up again. A leading _ marks a parameter kept for a
      // signature (Express's four-argument error handler) or a field left out of a rest.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      'no-undef': 'off', // TypeScript handles this better
      'no-useless-escape': 'warn',
      'no-restricted-syntax': ['error', ...CALENDAR_DATES, ...MONEY_DEFAULTS],
      // The data-isolation unit is a tenant in code; "Ledger" is only the UI's word for it
      // (CLAUDE.md), so no name here says ledger.
      'id-match': ['error', '^(?!.*(?:ledger|Ledger|LEDGER)).*$', {
        properties: true,
        classFields: true,
        onlyDeclarations: false,
        ignoreDestructuring: false,
      }],
    },
  },
  {
    // The app's code. Not where the environment is read by design: config.ts is the settings
    // registry and docker-secrets.ts the secrets' (readDockerSecret's fallback, envSecret);
    // tests and their helpers set variables to drive the code under test. A single line here
    // that must (a child process's environment, LOG_LEVEL set before the logger loads, the
    // Docker secrets copied in at startup) says why in an eslint-disable comment.
    files: ['src/**/*.ts'],
    ignores: ['src/config.ts', 'src/utils/docker-secrets.ts', 'src/**/__tests__/**', 'src/**/*.test.ts', 'src/test/**'],
    rules: {
      'no-restricted-syntax': ['error', ...CALENDAR_DATES, ...PROCESS_ENV, ...MONEY_DEFAULTS],
    },
  },
);
