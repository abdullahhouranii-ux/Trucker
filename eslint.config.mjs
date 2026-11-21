import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['tools/dev/design-review.mjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        innerWidth: 'readonly',
        getComputedStyle: 'readonly',
        performance: 'readonly',
      },
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/.expo/**',
      '**/.gradle/**',
      '**/.next-review/**',
      '**/dist-review/**',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      '**/next-env.d.ts',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/mobile/**/*.ts', 'apps/mobile/**/*.tsx'],
    languageOptions: { globals: { __DEV__: 'readonly', process: 'readonly' } },
  },
  {
    // Plain Node.js helper scripts.
    files: [
      'tools/**/*.mjs',
      'apps/web/scripts/**/*.mjs',
      'apps/web/tests/**/*.mjs',
      'apps/web/*.mjs',
      'apps/console/tests/**/*.mjs',
      'apps/console/*.mjs',
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    // Browser checks: functions here are sent to the page and run there.
    files: ['apps/web/tests/**/*.mjs', 'apps/console/tests/**/*.mjs'],
    languageOptions: {
      globals: { document: 'readonly', window: 'readonly', getComputedStyle: 'readonly' },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
