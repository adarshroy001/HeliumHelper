import { ForbiddenError, UnauthorizedError } from '../errors/index.js';
import type { Permission } from './permissions.js';

export class AuthTokenMissingError extends UnauthorizedError {
  constructor() {
    super('AUTH_TOKEN_MISSING', 'Authentication is required.');
  }
}

/** Bad signature, unknown caller, wrong audience, missing claims: the client learns no more than this. */
export class AuthTokenInvalidError extends UnauthorizedError {
  constructor() {
    super('AUTH_TOKEN_INVALID', 'The access token is invalid.');
  }
}

export class AuthTokenExpiredError extends UnauthorizedError {
  constructor() {
    super('AUTH_TOKEN_EXPIRED', 'The access token has expired.');
  }
}

export class PermissionDeniedError extends ForbiddenError {
  constructor(required: readonly Permission[]) {
    super('PERMISSION_DENIED', 'You are not allowed to do this.', { details: { required } });
  }
}

/** A route that declares neither `@Public()` nor `@RequirePermissions()`. The route-coverage test prevents it. */
export class AccessNotDeclaredError extends ForbiddenError {
  constructor() {
    super('ACCESS_NOT_DECLARED', 'This route is not available.');
  }
}
