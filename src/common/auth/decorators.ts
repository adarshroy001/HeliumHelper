import type { IncomingMessage } from 'node:http';
import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { type Actor, getRequestActor } from './actor.js';
import type { Permission } from './permissions.js';

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_PERMISSIONS = 'auth:permissions';

/** Anyone may call this route or controller, without a token. Health checks, for example. */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC, true);

/** Callers need a valid token whose user has every listed permission. On a controller, applies to all routes. */
export const RequirePermissions = (
  ...permissions: [Permission, ...Permission[]]
): ClassDecorator & MethodDecorator => SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** The verified caller. Only on routes with `@RequirePermissions()`: public routes have no actor. */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const actor = getRequestActor(ctx.switchToHttp().getRequest<IncomingMessage>());
  if (actor === undefined) {
    throw new Error('@CurrentActor() is used on a route without authentication');
  }
  return actor;
});
