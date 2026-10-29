import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { redisConfig, type RedisConfig } from '../../config/index.js';

/**
 * Opens the shared client at startup. A Redis that can't be reached fails the start, like MongoDB.
 * While disconnected, commands fail at once instead of queueing, so each caller decides what an outage means
 * for it (ADR-0007: every use documents that). The client reconnects on its own.
 */
async function connectRedis(config: RedisConfig, logger: PinoLogger): Promise<Redis> {
  logger.setContext('Redis');
  const client = new Redis(config.url, {
    password: config.authToken,
    tls: config.tls ? {} : undefined,
    lazyConnect: true,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  // Log changes of state, not every failed reconnect attempt. The listener also stops ioredis printing errors.
  let connected = false;
  client.on('error', () => undefined);
  client.on('ready', () => {
    if (!connected) logger.info('redis connected');
    connected = true;
  });
  client.on('close', () => {
    if (connected) logger.warn('redis connection lost');
    connected = false;
  });

  try {
    await client.connect();
  } catch (err) {
    client.disconnect();
    throw err;
  }
  return client;
}

/** Closes the client on shutdown, after in-flight requests have finished. */
@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(Redis) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

/**
 * The one shared Redis (Valkey) client, for coordination only: locks, rate limits, idempotency keys, counters
 * (ADR-0007). Inject it by class: `constructor(private readonly redis: Redis)`.
 */
@Global()
@Module({
  providers: [
    { provide: Redis, inject: [redisConfig.KEY, PinoLogger], useFactory: connectRedis },
    RedisShutdown,
  ],
  exports: [Redis],
})
export class RedisModule {}
