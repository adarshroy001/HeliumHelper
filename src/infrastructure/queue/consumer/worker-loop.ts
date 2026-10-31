import { applyDecorators, Injectable, SetMetadata } from '@nestjs/common';

/**
 * Work a worker process runs continuously rather than per message, such as the campaign feeder. Like a consumer,
 * it runs only in workers whose `WORKER_QUEUES` names it (or is `*`), and is stopped before shutdown.
 */
export interface BackgroundLoop {
  start(): void;
  /** Stops and waits for the current pass to finish. */
  stop(): Promise<void>;
}

export const WORKER_LOOP = 'queue:worker-loop';

/** Marks a provider as a worker loop, named for `WORKER_QUEUES`. */
export function WorkerLoop(name: string): ClassDecorator {
  return applyDecorators(Injectable(), SetMetadata(WORKER_LOOP, name));
}
