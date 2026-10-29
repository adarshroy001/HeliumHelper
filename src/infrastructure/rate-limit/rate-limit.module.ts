import type { IncomingMessage } from 'node:http';
import { type ExecutionContext, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

/** Default limit for each caller on `/internal/v1`. A route can change it with `@Throttle({ internal: ... })`. */
export const INTERNAL_LIMIT = { limit: 600, ttl: 60_000 } as const;

const outside = (prefix: string) => (context: ExecutionContext) =>
  !(context.switchToHttp().getRequest<IncomingMessage>().url ?? '').startsWith(prefix);

/**
 * Rate limits shared across every API instance (Redis). One named limit per audience prefix (ADR-0010):
 * `internal` now; `admin` and `store` get their own when those audiences arrive. Routes outside every prefix
 * (health checks) are never limited.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [Redis, PinoLogger],
      useFactory: (redis: Redis, logger: PinoLogger) => {
        logger.setContext('RateLimit');
        return {
          throttlers: [{ name: 'internal', ...INTERNAL_LIMIT, skipIf: outside('/internal/') }],
          storage: new RedisThrottlerStorage(redis, logger),
          // The library's headers are named after the limit (`Retry-After-internal`); the guard sets the
          // standard `Retry-After` itself.
          setHeaders: false,
        };
      },
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class RateLimitModule {}
