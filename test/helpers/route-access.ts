import type { INestApplication, Type } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from '../../src/common/auth/index.js';

/**
 * Every route handler of the app that declares neither `@Public()` nor `@RequirePermissions()`, on itself or its
 * controller, as `Controller.method`. Such a route is refused at runtime; this finds it before it ships.
 */
export function routesWithoutAccessDecision(app: INestApplication): string[] {
  const reflector = app.get(Reflector);
  const undecided: string[] = [];

  for (const module of app.get(ModulesContainer).values()) {
    for (const { metatype } of module.controllers.values()) {
      if (typeof metatype !== 'function') continue;
      const controller = metatype as Type;
      const prototype = controller.prototype as Record<string, unknown>;

      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;

        const targets = [handler, controller];
        const decided =
          reflector.getAllAndOverride<unknown>(IS_PUBLIC, targets) !== undefined ||
          reflector.getAllAndOverride<unknown>(REQUIRED_PERMISSIONS, targets) !== undefined;
        if (!decided) undecided.push(`${controller.name}.${name}`);
      }
    }
  }
  return undecided;
}
