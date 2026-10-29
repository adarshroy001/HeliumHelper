import { appEnvSchema } from './app.config.js';
import { authEnvSchema } from './auth.config.js';

export { appConfig, type AppConfig } from './app.config.js';
export { authConfig, type AuthConfig } from './auth.config.js';
export { ConfigModule } from './config.module.js';
export { ConfigValidationError } from './config.loader.js';

/** Every area's environment schema. A test checks these against `.env.example`. */
export const CONFIG_SCHEMAS = { app: appEnvSchema, auth: authEnvSchema } as const;
