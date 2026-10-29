import { type BeforeApplicationShutdown, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

/** Marks the start and end of a graceful shutdown, so a stopped task's last log lines explain themselves. */
@Injectable()
export class ShutdownLogger implements BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly logger: PinoLogger) {
    logger.setContext(ShutdownLogger.name);
  }

  /** Runs before the HTTP server stops taking connections. */
  beforeApplicationShutdown(signal?: string): void {
    this.logger.info({ signal }, 'shutting down');
  }

  /** Runs after in-flight requests have finished and connections are closed. */
  onApplicationShutdown(signal?: string): void {
    this.logger.info({ signal }, 'shutdown complete');
  }
}
