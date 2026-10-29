import { Controller } from '@nestjs/common';

/**
 * Routes are grouped by who calls them (ADR-0010), so guards and rate limits can differ per group.
 * Only `internal` is in use; `admin/v1` and `store/v1` are reserved for admin users and storefront customers.
 */
export const INTERNAL_PREFIX = 'internal/v1';

/** A controller for service-to-service calls (HeliumAdmin), served under `/internal/v1/<path>`. */
export function InternalController(path: string): ClassDecorator {
  return Controller(`${INTERNAL_PREFIX}/${path}`);
}
