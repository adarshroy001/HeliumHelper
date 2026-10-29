import type { mongo } from 'mongoose';

/**
 * One file in `src/migrations/`, named `NNNN-what-it-does.ts`, default-exporting this. It runs once, in number
 * order, against the messaging database (ADR-0005). It gets the plain driver `Db`, not Mongoose models: models
 * change later, but a migration must keep doing exactly what it did.
 */
export interface Migration {
  up(db: mongo.Db): Promise<void>;
}

/** A migration with its id: the file name without extension, such as `0003-add-campaign-indexes`. */
export interface NamedMigration extends Migration {
  readonly id: string;
}

/** Stops a migration run before anything is applied, or after a migration failed. */
export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}
