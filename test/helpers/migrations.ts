import path from 'node:path';
import type { Connection } from 'mongoose';
import { loadMigrations, MigrationError, runMigrations } from '../../src/infrastructure/migrations/index.js';

const silent = { info: () => undefined };

/**
 * Applies every migration in `src/migrations` to a test database, as `pnpm migrate` does, so integration tests
 * run against the real collections and indexes. Test files running in parallel on the same database take turns:
 * while another run holds the migration lock, this one waits and tries again.
 */
export async function applyMigrations(connection: Connection): Promise<void> {
  const db = connection.db;
  if (db === undefined) throw new Error('the connection has no database yet: await asPromise() first');
  const migrations = await loadMigrations(path.resolve(import.meta.dirname, '../../src/migrations'));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runMigrations(db, migrations, silent);
      return;
    } catch (error) {
      const locked = error instanceof MigrationError && error.message.includes('holds the lock');
      if (!locked || attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
