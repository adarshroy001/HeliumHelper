import { Controller } from '@nestjs/common';

/**
 * Routes are grouped by who calls them (ADR-0010), so guards and rate limits can differ per group.
 * `internal` serves other services; `webhooks` serves third parties that sign their requests (Meta).
 * `admin/v1` and `store/v1` are reserved for admin users and storefront customers.
 */
export const INTERNAL_PREFIX = 'internal/v1';
export const WEBHOOKS_PREFIX = 'webhooks';

/** A controller for service-to-service calls (HeliumAdmin), served under `/internal/v1/<path>`. */
export function InternalController(path: string): ClassDecorator {
  return Controller(`${INTERNAL_PREFIX}/${path}`);
}

/**
 * A controller for a provider's webhooks, served under `/webhooks/<provider>`. Its routes are `@Public()`: the
 * provider's signature, checked on the raw body, is their authentication.
 */
export function WebhookController(provider: string): ClassDecorator {
  return Controller(`${WEBHOOKS_PREFIX}/${provider}`);
}
