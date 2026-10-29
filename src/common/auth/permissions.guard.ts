import type { IncomingMessage } from 'node:http';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getRequestActor } from './actor.js';
import { AccessNotDeclaredError, PermissionDeniedError } from './auth.errors.js';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators.js';
import { type Permission, permissionsOf, ROLE_PERMISSIONS, type RolePermissions } from './permissions.js';

/**
 * Global guard, after AuthGuard: a route must declare `@Public()` or `@RequirePermissions(...)`, and the actor
 * must hold every required permission. A route that declares neither is refused (deny by default).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ROLE_PERMISSIONS) private readonly rolePermissions: RolePermissions,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) === true) return true;

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSIONS,
      targets,
    );
    if (required === undefined) throw new AccessNotDeclaredError();

    const actor = getRequestActor(context.switchToHttp().getRequest<IncomingMessage>());
    const granted = permissionsOf(actor, this.rolePermissions);
    if (!required.every((permission) => granted.has(permission))) throw new PermissionDeniedError(required);
    return true;
  }
}
