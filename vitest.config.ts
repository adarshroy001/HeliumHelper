import { defineConfig } from 'vitest/config';

/**
 * Three kinds of test (ADR-0012), one project each:
 * - unit:        next to the code, no I/O
 * - integration: next to the code, real MongoDB / Valkey / ElasticMQ in containers (test/global-setup.ts)
 * - e2e:         whole HTTP requests through the real app, in test/
 * - smoke:       the built app (dist/) as a real process: signals, startup failures. Needs `pnpm build`.
 */
export default defineConfig({
  test: {
    restoreMocks: true,
    // A minimal valid environment, logs off. Tests never read .env files (src/config/config.module.ts).
    // A test that asserts on logs sets LOG_LEVEL itself and captures LOG_DESTINATION.
    env: {
      NODE_ENV: 'test',
      APP_ENV: 'local',
      LOG_LEVEL: 'silent',
      AUTH_CALLER_SECRETS: JSON.stringify({ 'helium-admin': 'test-secret-0123456789-0123456789-abc' }),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.int-spec.ts',
        'src/main.ts',
        'src/worker.ts',
        'src/migrate.ts',
        'src/export-schedules.ts',
        'src/seed.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts', 'eslint/**/*.spec.ts', 'deploy/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'int',
          include: ['src/**/*.int-spec.ts'],
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e-spec.ts'],
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'smoke',
          include: ['test/smoke/**/*.smoke-spec.ts'],
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
