import { Inject, Injectable } from '@nestjs/common';
import { decodeJwt, errors, jwtVerify } from 'jose';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { authConfig, type AuthConfig } from '../../config/index.js';
import type { Actor } from './actor.js';
import { AuthTokenExpiredError, AuthTokenInvalidError } from './auth.errors.js';

/** The `aud` every token must carry. */
export const TOKEN_AUDIENCE = 'helium-backend';

/** Tokens live at most this long after `iat`, whatever their `exp` says. */
const MAX_TOKEN_AGE = '5m';

/** Allowed clock difference between the caller and us, in seconds. */
const CLOCK_TOLERANCE = 30;

const actClaim = z.looseObject({
  id: z.string().min(1),
  email: z.email(),
  roles: z.array(z.string()),
});

/**
 * Verifies a caller's service token (ADR-0010): HS256, signed with the secret of the caller named in `iss`,
 * `aud` = `helium-backend`, `exp` and `iat` present, and at most 5 minutes old. The optional `act` claim carries
 * the admin user the service acts for.
 */
@Injectable()
export class TokenVerifier {
  private readonly keys: ReadonlyMap<string, Uint8Array>;

  constructor(
    @Inject(authConfig.KEY) auth: AuthConfig,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(TokenVerifier.name);
    const encoder = new TextEncoder();
    this.keys = new Map(
      Object.entries(auth.callerSecrets).map(([iss, secret]) => [iss, encoder.encode(secret)]),
    );
  }

  async verify(token: string): Promise<Actor> {
    const issuer = issuerOf(token);
    const key = issuer === undefined ? undefined : this.keys.get(issuer);
    if (issuer === undefined || key === undefined) return this.reject('unknown caller', issuer);

    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        issuer,
        audience: TOKEN_AUDIENCE,
        maxTokenAge: MAX_TOKEN_AGE,
        clockTolerance: CLOCK_TOLERANCE,
        requiredClaims: ['exp', 'iat'],
      });
      if (payload['act'] === undefined) return { service: issuer };

      const act = actClaim.safeParse(payload['act']);
      if (!act.success) return this.reject('invalid act claim', issuer);
      return { service: issuer, user: { id: act.data.id, email: act.data.email, roles: act.data.roles } };
    } catch (err) {
      if (err instanceof errors.JWTExpired) throw new AuthTokenExpiredError();
      return this.reject(err instanceof errors.JOSEError ? err.code : 'unreadable token', issuer);
    }
  }

  /** The client only learns "invalid"; the reason is logged for whoever runs the calling service. */
  private reject(reason: string, issuer: string | undefined): never {
    this.logger.warn({ reason, issuer }, 'token rejected');
    throw new AuthTokenInvalidError();
  }
}

/** The unverified `iss`, used only to pick which secret to verify the token with. */
function issuerOf(token: string): string | undefined {
  try {
    return decodeJwt(token).iss;
  } catch {
    return undefined;
  }
}
