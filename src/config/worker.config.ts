import { registerAs, type ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { loadConfig, type RawEnv } from './config.loader.js';

/** Variables for the worker process (`src/worker.ts`). The API process ignores them. */
export const workerEnvSchema = z.object({
  /**
   * Which queues this worker consumes, comma-separated (`wa-send,wa-status`), or `*` for every consumer.
   * One image runs as several ECS services, each with its own list, so each scales on its own (ADR-0006).
   */
  WORKER_QUEUES: z.string().default(''),
  /** Port of the worker's health endpoint (`/health/live`, `/health/ready`). */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
});

/** Typed worker config, built from the validated variables. */
export function parseWorkerConfig(env: RawEnv) {
  const vars = loadConfig('worker', workerEnvSchema, env);
  const queues = vars.WORKER_QUEUES.split(',')
    .map((queue) => queue.trim())
    .filter(Boolean);
  return { queues: queues.includes('*') ? ('all' as const) : queues, healthPort: vars.WORKER_HEALTH_PORT };
}

/** Inject with `@Inject(workerConfig.KEY) private readonly worker: WorkerConfig`. */
export const workerConfig = registerAs('worker', () => parseWorkerConfig(process.env));
export type WorkerConfig = ConfigType<typeof workerConfig>;
