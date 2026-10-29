import { SignJWT } from 'jose';
import { TOKEN_AUDIENCE } from '../../src/common/auth/index.js';

/** The caller and secret Vitest configures in AUTH_CALLER_SECRETS (vitest.config.ts). */
export const TEST_CALLER = 'helium-admin';
const TEST_SECRET = (JSON.parse(process.env['AUTH_CALLER_SECRETS'] ?? '{}') as Record<string, string>)[
  TEST_CALLER
];

export interface TokenOptions {
  issuer?: string;
  audience?: string;
  secret?: string;
  /** Seconds since the epoch. Defaults to now. */
  issuedAt?: number;
  /** Seconds since the epoch. Defaults to 5 minutes after `issuedAt`. */
  expiresAt?: number;
  act?: unknown;
}

/** Signs a service token the way a caller such as HeliumAdmin does. Override any part to make a bad one. */
export async function signToken(options: TokenOptions = {}): Promise<string> {
  const secret = options.secret ?? TEST_SECRET;
  if (secret === undefined) throw new Error('AUTH_CALLER_SECRETS has no test caller');

  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const claims = options.act === undefined ? {} : { act: options.act };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(options.issuer ?? TEST_CALLER)
    .setAudience(options.audience ?? TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(options.expiresAt ?? issuedAt + 300)
    .sign(new TextEncoder().encode(secret));
}
