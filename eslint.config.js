// Flat config. Lint only — formatting is Prettier's job (eslint-config-prettier
// turns the stylistic rules off). Run with `npm run lint`.
import js from '@eslint/js';
import globals from 'globals';
import n from 'eslint-plugin-n';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'coverage/**', 'src/web/public/vendor/**'],
  },

  js.configs.recommended,
  n.configs['flat/recommended-module'],

  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Sylo intentionally exits on fatal config / DB errors for a clean restart.
      'n/no-process-exit': 'off',
      // Explicit `.js` extensions on relative imports are correct for ESM; the
      // resolver occasionally trips on subpath exports (discord.js).
      'n/no-missing-import': 'off',
      // Sylo is an application, not a published library — devDeps and the config
      // file are legitimately imported.
      'n/no-unpublished-import': 'off',
      'n/no-unpublished-require': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  // Browser-side progressive-enhancement scripts.
  {
    files: ['src/web/public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, Alpine: 'readonly', htmx: 'readonly' },
    },
    rules: {
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },

  prettier,
];
