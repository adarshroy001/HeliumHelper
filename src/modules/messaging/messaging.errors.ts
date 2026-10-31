import { HttpStatus } from '@nestjs/common';
import { AppError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../common/errors/index.js';

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

/** 502: Meta's API didn't answer the sync; it is tried again on the next run. */
export class TemplateSyncFailedError extends AppError {
  readonly status = HttpStatus.BAD_GATEWAY;

  constructor(detail: string) {
    super('TEMPLATE_SYNC_FAILED', 'Templates could not be synced from WhatsApp. Try again later.', {
      details: { detail },
      retryable: true,
    });
  }
}

/** 404: no such template in the synced mirror. */
export class TemplateNotFoundError extends NotFoundError {
  constructor(templateId: string) {
    super('TEMPLATE_NOT_FOUND', 'Template not found. Sync templates and try again.', {
      details: { templateId },
    });
  }
}

/** 404: no such media file. */
export class MediaNotFoundError extends NotFoundError {
  constructor(mediaId: string) {
    super('MEDIA_NOT_FOUND', 'Media not found.', { details: { mediaId } });
  }
}

/** 422: a file type or size WhatsApp doesn't accept for template headers. */
export class MediaUnsupportedError extends AppError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(mime: string, accepted: readonly string[], maxBytes?: number) {
    super(
      'MEDIA_UNSUPPORTED',
      maxBytes === undefined
        ? 'This file type is not supported for WhatsApp headers.'
        : 'This file is too large for WhatsApp.',
      {
        details: {
          mime,
          ...(accepted.length > 0 ? { accepted } : {}),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        },
      },
    );
  }
}

/** 502: Meta didn't accept the media upload; it can be tried again. */
export class MediaUploadFailedError extends AppError {
  readonly status = HttpStatus.BAD_GATEWAY;

  constructor(detail: string) {
    super('MEDIA_UPLOAD_FAILED', 'The media file could not be uploaded to WhatsApp. Try again later.', {
      details: { detail },
      retryable: true,
    });
  }
}

/** 422: free text is only allowed within 24 hours of the customer's last message. */
export class ServiceWindowClosedError extends AppError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(phone: string) {
    super(
      'SERVICE_WINDOW_CLOSED',
      'The customer has not written in the last 24 hours: send a template instead.',
      {
        details: { phone },
      },
    );
  }
}

/** 422: only approved templates can be sent. */
export class TemplateNotApprovedError extends AppError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(templateId: string, status: string) {
    super('TEMPLATE_NOT_APPROVED', 'This template is not approved by WhatsApp.', {
      details: { templateId, status },
    });
  }
}
