import path from 'node:path';
import type { Connection } from 'mongoose';
import { loadMigrations, runMigrations } from '../../src/infrastructure/migrations/index.js';

const silent = { info: () => undefined };

/**
 * Applies every migration in `src/migrations` to a test database, as `pnpm migrate` does, so integration tests
 * run against the real collections and indexes.
 */
export async function applyMigrations(connection: Connection): Promise<void> {
  const db = connection.db;
  if (db === undefined) throw new Error('the connection has no database yet: await asPromise() first');
  const migrations = await loadMigrations(path.resolve(import.meta.dirname, '../../src/migrations'));
  await runMigrations(db, migrations, silent);
}
