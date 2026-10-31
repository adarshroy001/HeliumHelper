import { randomUUID } from 'node:crypto';
import mongoose, { type Connection } from 'mongoose';
import { mongoUri } from '../global-setup.js';

/**
 * A connection to a new, empty database on the test run's MongoDB, so integration test files never share data.
 * Uses the same driver settings that matter in production (`retryWrites: false`, as DocumentDB requires).
 * Call `dropAndClose()` in `afterAll`.
 */
export async function connectTestDatabase(): Promise<Connection & { dropAndClose: () => Promise<void> }> {
  const base = process.env['MONGO_TEST_URI'];
  if (base === undefined) {
    throw new Error('MONGO_TEST_URI is not set: run this through the int or e2e project');
  }

  const connection = mongoose.createConnection(mongoUri(base, `test_${randomUUID().slice(0, 8)}`), {
    retryWrites: false,
    serverSelectionTimeoutMS: 5_000,
  });
  await connection.asPromise();

  return Object.assign(connection, {
    dropAndClose: async () => {
      await connection.dropDatabase();
      await connection.close();
    },
  });
}

/**
 * Points the app at databases of its own (`<name>_main`, `<name>_messaging`), so test files running in parallel
 * never see each other's data. Call it before creating the app; restore `process.env` afterwards.
 */
export function isolatedDatabases(name: string): void {
  const base = process.env['MONGO_TEST_URI'];
  if (base === undefined)
    throw new Error('MONGO_TEST_URI is not set: run this through the int or e2e project');
  process.env['MONGO_MAIN_URI'] = mongoUri(base, `${name}_main`);
  process.env['MONGO_MESSAGING_URI'] = mongoUri(base, `${name}_messaging`);
}
