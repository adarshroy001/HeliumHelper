import { defineConfig } from 'vitest/config';

/**
 * Three kinds of test (ADR-0012), one project each:
 * - unit:        next to the code, no I/O
 * - integration: next to the code, real MongoDB / Valkey / ElasticMQ in containers (from F12)
 * - e2e:         whole HTTP requests through the real app, in test/
 */
export default defineConfig({
  test: {
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.int-spec.ts', 'src/main.ts'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts', 'eslint/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'int',
          include: ['src/**/*.int-spec.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e-spec.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
