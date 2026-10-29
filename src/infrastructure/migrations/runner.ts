import { randomUUID } from 'node:crypto';
import type { mongo } from 'mongoose';
import { MigrationError, type NamedMigration } from './migration.js';

const APPLIED = '_migrations';
const LOCK = '_migrations_lock';

/** A crashed run leaves its lock behind; the next run may take it after this long. */
const LOCK_TTL_MS = 30 * 60 * 1000;

interface AppliedDoc {
  _id: string;
  appliedAt: Date;
  durationMs: number;
}

interface LockDoc {
  _id: 'lock';
  owner: string;
  expiresAt: Date;
}

export interface MigrationLog {
  info(fields: object, message: string): void;
}

export interface MigrationStatus {
  id: string;
  appliedAt: Date | null;
}

/** Which migrations are applied, and when. */
export async function migrationStatus(
  db: mongo.Db,
  migrations: readonly NamedMigration[],
): Promise<MigrationStatus[]> {
  const applied = await appliedById(db);
  return migrations.map(({ id }) => ({ id, appliedAt: applied.get(id)?.appliedAt ?? null }));
}

/**
 * Applies every pending migration in order, recording each in `_migrations` once it succeeds. The first failure
 * stops the run: later migrations don't run, and the failed one runs again next time. A lock makes a second,
 * concurrent run fail instead of racing. Returns the ids applied.
 */
export async function runMigrations(
  db: mongo.Db,
  migrations: readonly NamedMigration[],
  log: MigrationLog,
): Promise<string[]> {
  const release = await acquireLock(db);
  try {
    const applied = await appliedById(db);
    const pending = migrations.filter(({ id }) => !applied.has(id));
    const latestApplied = [...applied.keys()].sort().at(-1);
    const early = pending.find(({ id }) => latestApplied !== undefined && id < latestApplied);
    if (early !== undefined) {
      throw new MigrationError(
        `Migration ${early.id} sorts before ${String(latestApplied)}, which is already applied. Renumber it after the latest migration.`,
      );
    }

    for (const migration of pending) {
      log.info({ migration: migration.id }, 'applying migration');
      const started = Date.now();
      try {
        await migration.up(db);
      } catch (err) {
        throw new MigrationError(`Migration ${migration.id} failed; later migrations were not run`, {
          cause: err,
        });
      }
      const durationMs = Date.now() - started;
      await db
        .collection<AppliedDoc>(APPLIED)
        .insertOne({ _id: migration.id, appliedAt: new Date(), durationMs });
      log.info({ migration: migration.id, durationMs }, 'migration applied');
    }
    return pending.map(({ id }) => id);
  } finally {
    await release();
  }
}

async function appliedById(db: mongo.Db): Promise<Map<string, AppliedDoc>> {
  const docs = await db.collection<AppliedDoc>(APPLIED).find().toArray();
  return new Map(docs.map((doc) => [doc._id, doc]));
}

/** Takes the lock, or an expired one. Returns the release function. */
async function acquireLock(db: mongo.Db): Promise<() => Promise<void>> {
  const locks = db.collection<LockDoc>(LOCK);
  const owner = randomUUID();
  const now = new Date();
  const lock: LockDoc = { _id: 'lock', owner, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) };

  try {
    await locks.insertOne(lock);
  } catch (err) {
    if ((err as { code?: unknown }).code !== 11000) throw err;
    const taken = await locks.findOneAndUpdate({ _id: 'lock', expiresAt: { $lt: now } }, { $set: lock });
    if (taken === null) {
      throw new MigrationError('Another migration run holds the lock. Try again when it has finished.');
    }
  }
  return async () => {
    await locks.deleteOne({ _id: 'lock', owner });
  };
}
