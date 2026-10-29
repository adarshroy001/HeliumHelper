import type { IncomingMessage } from 'node:http';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { setRequestActor } from './actor.js';
import { AuthTokenMissingError } from './auth.errors.js';
import { IS_PUBLIC } from './decorators.js';
import { TokenVerifier } from './token-verifier.js';

/** Global guard: every route needs a valid `Authorization: Bearer <token>`, unless it is `@Public()`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) === true) return true;

    const req = context.switchToHttp().getRequest<IncomingMessage>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || token === undefined || token === '') throw new AuthTokenMissingError();

    setRequestActor(req, await this.verifier.verify(token));
    return true;
  }
}
