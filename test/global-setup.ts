import { MongoDBContainer } from '@testcontainers/mongodb';

/** The MongoDB version tests run against (ADR-0005: DocumentDB-compatible features only). */
export const MONGO_IMAGE = 'mongo:7.0';

/** A connection string for `database` on the server at `base`. */
export function mongoUri(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  // The container's replica set advertises an address only reachable inside Docker.
  url.searchParams.set('directConnection', 'true');
  return url.toString();
}

/**
 * Starts one MongoDB container (a single-node replica set, so transactions work) for the whole test run, and
 * points the app's connections at it. Test workers inherit these variables. Integration tests take a fresh
 * database each from `MONGO_TEST_URI` (test/helpers/mongo.ts).
 */
export default async function setup(): Promise<() => Promise<void>> {
  const mongo = await new MongoDBContainer(MONGO_IMAGE).start();
  const base = mongo.getConnectionString();

  process.env['MONGO_TEST_URI'] = base;
  process.env['MONGO_MAIN_URI'] = mongoUri(base, 'helium');
  process.env['MONGO_MESSAGING_URI'] = mongoUri(base, 'helium_messaging');

  return async () => {
    await mongo.stop();
  };
}
