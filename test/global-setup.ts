import { MongoDBContainer } from '@testcontainers/mongodb';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/** The MongoDB version tests run against (ADR-0005: DocumentDB-compatible features only). */
export const MONGO_IMAGE = 'mongo:7.0';

/** The Valkey version tests run against (ADR-0007: ElastiCache for Valkey). */
export const VALKEY_IMAGE = 'valkey/valkey:8.1';

/** Starts a Valkey container and returns it with its `redis://` URL. */
export async function startValkey(): Promise<{ container: StartedTestContainer; url: string }> {
  const container = await new GenericContainer(VALKEY_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  return { container, url: `redis://${container.getHost()}:${String(container.getMappedPort(6379))}` };
}

/** A connection string for `database` on the server at `base`. */
export function mongoUri(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  // The container's replica set advertises an address only reachable inside Docker.
  url.searchParams.set('directConnection', 'true');
  return url.toString();
}

/**
 * Starts one MongoDB container (a single-node replica set, so transactions work) and one Valkey container for
 * the whole test run, and points the app at them. Test workers inherit these variables. Integration tests take
 * a fresh database each from `MONGO_TEST_URI` (test/helpers/mongo.ts) and unique Redis keys.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const [mongo, valkey] = await Promise.all([new MongoDBContainer(MONGO_IMAGE).start(), startValkey()]);
  const base = mongo.getConnectionString();

  process.env['MONGO_TEST_URI'] = base;
  process.env['MONGO_MAIN_URI'] = mongoUri(base, 'helium');
  process.env['MONGO_MESSAGING_URI'] = mongoUri(base, 'helium_messaging');
  process.env['REDIS_URL'] = valkey.url;

  return async () => {
    await Promise.all([mongo.stop(), valkey.container.stop()]);
  };
}
