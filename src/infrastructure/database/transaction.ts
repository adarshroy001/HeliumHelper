import type { ClientSession, Connection } from 'mongoose';

/**
 * Runs `work` in a transaction: all its writes commit together or none do. The driver retries `work` on
 * transient errors, so it must be safe to run more than once. Pass `session` to every operation inside.
 *
 * Use it only when a use case needs several documents to change atomically (ADR-0005). Keep it short: no calls
 * to other services inside, and DocumentDB aborts a transaction after one minute.
 */
export function withTransaction<T>(
  connection: Connection,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return connection.transaction(work, {
    readConcern: { level: 'majority' },
    writeConcern: { w: 'majority' },
  });
}
