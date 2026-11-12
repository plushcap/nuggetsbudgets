import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The backend's rules (backend/eslint.config.mjs), for the MCP server and its tests.
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
      // A leading _ marks a parameter kept for a signature or a field left out of a rest.
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
      // Calendar dates: a date is a 'YYYY-MM-DD' string, not a Date's UTC string.
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.property.name=/^(slice|substring|substr|split)$/][callee.object.callee.property.name='toISOString']",
          message: "A Date's UTC string isn't a calendar date: the backend works out the household's today.",
        },
        // The server serves every ledger (backend/eslint.config.mjs's MONEY_DEFAULTS).
        ...["Identifier[name='setFormatMoneyDefaults']", "Literal[value='setFormatMoneyDefaults']", "TemplateElement[value.cooked='setFormatMoneyDefaults']"].map(
          (selector) => ({
            selector,
            message: "The MCP server runs in the backend, which serves every ledger: pass the ledger's format to formatMoney, never setFormatMoneyDefaults.",
          })
        ),
      ],
    },
  },
);
