import { afterEach, describe, expect, it } from 'vitest';
import { ConfigValidationError } from '../src/config/index.js';
import { createTestApp } from './helpers/create-test-app.js';

describe('startup configuration', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('boots with the test environment', async () => {
    const { app } = await createTestApp();
    await app.close();
  });

  it('refuses to start with an invalid value, naming the variable', async () => {
    process.env['PORT'] = '99999';

    const start = createTestApp();

    await expect(start).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(start).rejects.toThrow(/PORT:/);
  });

  it('refuses to start when a required variable is missing', async () => {
    delete process.env['APP_ENV'];

    await expect(createTestApp()).rejects.toThrow(/APP_ENV:/);
  });
});
