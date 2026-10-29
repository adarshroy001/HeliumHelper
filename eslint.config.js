// ESLint flat config. Every rule is an error: warnings are not allowed (CONVENTIONS, F3).
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import helium from './eslint/helium-plugin.js';

export default defineConfig(
  { ignores: ['dist/**', 'coverage/**', 'cdk.out/**', 'node_modules/**'] },

  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },

  // TypeScript sources: project rules (CONVENTIONS R1–R6, R16).
  {
    files: ['**/*.ts'],
    plugins: { helium },
    rules: {
      'helium/module-boundaries': 'error',
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/common',
              importNames: ['forwardRef'],
              message:
                'forwardRef hides a circular dependency. Break the cycle with an event or a queue (ADR-0004).',
            },
          ],
        },
      ],
      // Nest modules are empty classes carrying a decorator.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      // `import type` for types only. Nest needs real imports for classes used in constructor injection;
      // the rule leaves those alone because decorator metadata is enabled below.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
    languageOptions: {
      parserOptions: { emitDecoratorMetadata: true, experimentalDecorators: true },
    },
  },

  // Lambdas stay small and start fast: no NestJS (ADR-0011).
  {
    files: ['src/lambdas/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*'],
              message: 'Lambdas must not import NestJS (ADR-0011). Use plain helpers.',
            },
          ],
        },
      ],
    },
  },

  // Environment variables are read only in src/config, which validates them (CONVENTIONS R12).
  {
    files: ['**/*.ts'],
    ignores: ['src/config/**', 'test/**', 'vitest.config.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration through a typed config from src/config, never process.env (R12).',
        },
      ],
    },
  },

  // Plain JavaScript config files are not type-checked.
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Must be last: turns off rules that Prettier owns.
  prettier,
);
