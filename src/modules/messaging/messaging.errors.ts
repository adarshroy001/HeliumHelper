import { HttpStatus } from '@nestjs/common';
import { AppError, ForbiddenError, UnauthorizedError } from '../../common/errors/index.js';

/** 401: a webhook's `X-Hub-Signature-256` doesn't match the body. Nothing was queued. */
export class WebhookSignatureInvalidError extends UnauthorizedError {
  constructor() {
    super('WEBHOOK_SIGNATURE_INVALID', 'The webhook signature is invalid.');
  }
}

/** 403: Meta's verification request had the wrong mode or token. */
export class WebhookVerificationFailedError extends ForbiddenError {
  constructor() {
    super('WEBHOOK_VERIFICATION_FAILED', 'Webhook verification failed.');
  }
}

/** 503: a verified webhook couldn't be queued. Meta retries it, so nothing is lost. */
export class WebhookNotQueuedError extends AppError {
  readonly status = HttpStatus.SERVICE_UNAVAILABLE;

  constructor(cause: unknown) {
    super('WEBHOOK_NOT_QUEUED', 'The webhook could not be accepted. Try again later.', {
      cause,
      retryable: true,
    });
  }
}
