import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { PermissionsGuard } from './permissions.guard.js';
import { DEFAULT_ROLE_PERMISSIONS, ROLE_PERMISSIONS } from './permissions.js';
import { TokenVerifier } from './token-verifier.js';

/** Deny by default (ADR-0010): both guards run on every route, AuthGuard first. */
@Module({
  providers: [
    TokenVerifier,
    { provide: ROLE_PERMISSIONS, useValue: DEFAULT_ROLE_PERMISSIONS },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AuthModule {}
