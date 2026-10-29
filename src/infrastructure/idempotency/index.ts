import { UseInterceptors } from '@nestjs/common';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

export {
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
  IdempotencyUnavailableError,
} from './idempotency.errors.js';
export { IDEMPOTENCY_HEADER, IdempotencyInterceptor } from './idempotency.interceptor.js';

/**
 * Makes a mutating route safe to retry with the `Idempotency-Key` header (R10). See `IdempotencyInterceptor`.
 * `@Post() @Idempotent() create(...)`
 */
export const Idempotent = (): MethodDecorator & ClassDecorator => UseInterceptors(IdempotencyInterceptor);
