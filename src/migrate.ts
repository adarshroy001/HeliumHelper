import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { appConfig, databaseConfig } from './config/index.js';
import { mongoDriverOptions } from './infrastructure/database/index.js';
import { createProcessLogger } from './infrastructure/logger/process-logger.js';
import {
  loadMigrations,
  MigrationError,
  migrationStatus,
  nextMigrationFile,
  runMigrations,
} from './infrastructure/migrations/index.js';

// Runs migrations against the messaging database (ADR-0005). The pnpm scripts build first.
//
//   node dist/migrate.js up              apply pending migrations: a deploy step, before the new code starts
//   node dist/migrate.js status          list migrations and when each was applied
//   node dist/migrate.js create <name>   add src/migrations/NNNN-<name>.ts from the template

/** Compiled migrations sit next to this file: `dist/migrations`. */
const COMPILED_DIR = path.join(import.meta.dirname, 'migrations');
const SOURCE_DIR = path.resolve('src', 'migrations');

/** A new migration fails until it is written, so a forgotten one stops the deploy instead of passing silently. */
const template = (id: string) => `import type { Migration } from '../infrastructure/migrations/index.js';

/** What this migration changes, and why. */
const migration: Migration = {
  up(db) {
    // Replace this with the change, for example:
    //   await db.collection('campaigns').createIndex({ status: 1, _id: -1 });
    // (make up() async when it awaits).
    return Promise.reject(new Error(\`${id} is not written yet (database \${db.databaseName})\`));
  },
};

export default migration;
`;

const logger = createProcessLogger();

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Env files are optional: deployed environments set real variables.
  }
}

async function create(name: string): Promise<void> {
  const fileName = await nextMigrationFile(SOURCE_DIR, name);
  const file = path.join(SOURCE_DIR, fileName);
  await writeFile(file, template(fileName.replace(/\.ts$/, '')), { flag: 'wx' });
  logger.info({ file: path.relative(process.cwd(), file) }, 'migration created');
}

async function run(command: string): Promise<void> {
  if (command !== 'up' && command !== 'status') {
    throw new MigrationError(`Unknown command "${command}". Use up, status or create <name>.`);
  }
  const app = appConfig();
  const config = databaseConfig();
  logger.setBindings({ service: app.name, env: app.appEnv });

  const migrations = await loadMigrations(COMPILED_DIR);
  const connection = await mongoose
    .createConnection(config.messagingUri, mongoDriverOptions(config))
    .asPromise();
  try {
    const db = connection.db;
    if (db === undefined) throw new MigrationError('The messaging connection has no database');

    if (command === 'status') {
      for (const { id, appliedAt } of await migrationStatus(db, migrations)) {
        logger.info({ migration: id, appliedAt }, appliedAt === null ? 'pending' : 'applied');
      }
      return;
    }
    const applied = await runMigrations(db, migrations, logger);
    logger.info({ applied }, applied.length === 0 ? 'no pending migrations' : 'migrations complete');
  } finally {
    await connection.close();
  }
}

const [command = 'up', name = ''] = process.argv.slice(2);
(command === 'create' ? create(name) : run(command)).catch((err: unknown) => {
  logger.fatal({ err }, 'migration command failed');
  process.exit(1);
});
