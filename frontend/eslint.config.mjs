import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'build', 'node_modules'] },
  {
    // jsx-a11y declares an ESLint peer range that stops at 9; package.json's
    // `overrides` lets it install beside ESLint 10. Its rules use only
    // context.report/options/settings, which ESLint 10 still provides, so it
    // needs no @eslint/compat wrapper. The same override keeps its minimatch on
    // 3.x (3.1.5 or later): it calls minimatch's default export, which 9.x and
    // later, the 11.x the other packages here use included, don't have.
    extends: [js.configs.recommended, ...tseslint.configs.recommended, jsxA11y.flatConfigs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    settings: {
      'jsx-a11y': {
        // Radix Themes' <Text as="label"> renders a <label>: check it as one.
        polymorphicPropName: 'as',
        polymorphicAllowList: ['Text'],
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'jsx-a11y/label-has-associated-control': [
        'error',
        {
          // Components that render a labelable element (an <input>, or the <button>
          // of a Select trigger, Checkbox, Switch, radio or date picker), so a label
          // wrapped around one names it.
          controlComponents: [
            'TextField.Root',
            'TextArea',
            'Select.Root',
            'FormSelectRoot',
            'Select.Trigger',
            'Checkbox',
            'Switch',
            'RadioGroup.Item',
            'CurrencyInput',
            'RadixDatePicker',
          ],
          // Radix layout (Flex/Box) nests a label's text and control a few levels down.
          depth: 5,
        },
      ],
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'warn',
      '@typescript-eslint/no-unused-expressions': 'error',
      'prefer-const': 'error',
    },
  }
);
