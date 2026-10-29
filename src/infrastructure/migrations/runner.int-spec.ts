import type { Connection, mongo } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase } from '../../../test/helpers/mongo.js';
import { MigrationError, migrationStatus, type NamedMigration, runMigrations } from './index.js';

const silent = { info: () => undefined };

/** A migration that records each run in the `runs` collection. */
function migration(id: string, extra?: () => Promise<void>): NamedMigration {
  return {
    id,
    up: async (db: mongo.Db) => {
      await extra?.();
      await db.collection('runs').insertOne({ id });
    },
  };
}

describe('migration runner (real MongoDB)', () => {
  let connection: Connection & { dropAndClose: () => Promise<void> };
  let db: mongo.Db;

  const runs = async () => (await db.collection('runs').find().toArray()).map((doc) => doc['id'] as string);

  beforeAll(async () => {
    connection = await connectTestDatabase();
    if (connection.db === undefined) throw new Error('no database');
    db = connection.db;
  });

  afterAll(async () => {
    await connection.dropAndClose();
  });

  beforeEach(async () => {
    await db.dropDatabase();
  });

  it('applies pending migrations once, in order, and records them', async () => {
    const all = [migration('0001-a'), migration('0002-b')];

    expect(await runMigrations(db, all, silent)).toEqual(['0001-a', '0002-b']);
    expect(await runMigrations(db, all, silent)).toEqual([]);
    expect(await runs()).toEqual(['0001-a', '0002-b']);

    const status = await migrationStatus(db, [...all, migration('0003-c')]);
    expect(status.map(({ id, appliedAt }) => [id, appliedAt instanceof Date])).toEqual([
      ['0001-a', true],
      ['0002-b', true],
      ['0003-c', false],
    ]);
  });

  it('stops at a failed migration and retries it on the next run', async () => {
    let broken = true;
    const all = [
      migration('0001-a'),
      migration('0002-b', () =>
        broken ? Promise.reject(new Error('index build failed')) : Promise.resolve(),
      ),
      migration('0003-c'),
    ];

    const failed = runMigrations(db, all, silent);
    await expect(failed).rejects.toBeInstanceOf(MigrationError);
    await expect(failed).rejects.toMatchObject({ cause: { message: 'index build failed' } });
    expect(await runs()).toEqual(['0001-a']);

    broken = false;
    expect(await runMigrations(db, all, silent)).toEqual(['0002-b', '0003-c']);
  });

  it('refuses a new migration numbered before one already applied', async () => {
    await runMigrations(db, [migration('0001-a'), migration('0003-c')], silent);

    const late = runMigrations(db, [migration('0001-a'), migration('0002-b'), migration('0003-c')], silent);

    await expect(late).rejects.toThrow(/0002-b sorts before 0003-c/);
    expect(await runs()).toEqual(['0001-a', '0003-c']);
  });

  it('makes a concurrent run fail instead of racing', async () => {
    let finish: () => void = () => undefined;
    const slow = migration('0001-slow', () => new Promise<void>((resolve) => (finish = resolve)));
    const first = runMigrations(db, [slow], silent);
    await expect.poll(() => db.collection('_migrations_lock').countDocuments()).toBe(1);

    await expect(runMigrations(db, [slow], silent)).rejects.toThrow(/holds the lock/);

    finish();
    expect(await first).toEqual(['0001-slow']);
    expect(await db.collection('_migrations_lock').countDocuments()).toBe(0);
  });

  it('releases the lock after a failure, and takes over a lock left by a crashed run', async () => {
    const failing = migration('0001-a', () => Promise.reject(new Error('boom')));
    await expect(runMigrations(db, [failing], silent)).rejects.toThrow();
    expect(await db.collection('_migrations_lock').countDocuments()).toBe(0);

    await db
      .collection<{ _id: string; owner: string; expiresAt: Date }>('_migrations_lock')
      .insertOne({ _id: 'lock', owner: 'crashed-run', expiresAt: new Date(Date.now() - 1000) });
    expect(await runMigrations(db, [migration('0001-a')], silent)).toEqual(['0001-a']);
  });
});
