import { appEnvSchema } from './app.config.js';
import { blobEnvSchema } from './blob.config.js';
import { authEnvSchema } from './auth.config.js';
import { databaseEnvSchema } from './database.config.js';
import { queueEnvSchema } from './queue.config.js';
import { redisEnvSchema } from './redis.config.js';
import { whatsappEnvSchema } from './whatsapp.config.js';
import { workerEnvSchema } from './worker.config.js';

export { appConfig, type AppConfig } from './app.config.js';
export { authConfig, type AuthConfig } from './auth.config.js';
export { blobConfig, type BlobConfig } from './blob.config.js';
export { databaseConfig, type DatabaseConfig } from './database.config.js';
export { queueConfig, type QueueConfig } from './queue.config.js';
export { redisConfig, type RedisConfig } from './redis.config.js';
export { whatsappConfig, type WhatsappConfig } from './whatsapp.config.js';
export { workerConfig, type WorkerConfig } from './worker.config.js';
export { ConfigModule } from './config.module.js';
export { ConfigValidationError } from './config.loader.js';

/** Every area's environment schema. A test checks these against `.env.example`. */
export const CONFIG_SCHEMAS = {
  app: appEnvSchema,
  auth: authEnvSchema,
  database: databaseEnvSchema,
  redis: redisEnvSchema,
  queue: queueEnvSchema,
  worker: workerEnvSchema,
  whatsapp: whatsappEnvSchema,
  blob: blobEnvSchema,
} as const;
