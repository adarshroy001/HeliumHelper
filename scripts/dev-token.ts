// Prints a short-lived service token for calling the local API, signed like HeliumAdmin signs its tokens
// (ADR-0010). Local development only.
//
//   pnpm dev:token                                    no user: the caller acts as itself
//   pnpm dev:token --roles analyst --email me@heliumair.in
//   curl -H "Authorization: Bearer $(pnpm -s dev:token --roles analyst)" localhost:3000/internal/v1/...
//
// Reads AUTH_CALLER_SECRETS from the environment, `.env.local` or `.env` (copy `.env.example` to `.env`).
import { parseArgs } from 'node:util';
import { SignJWT } from 'jose';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // The file is optional.
  }
}

const { values } = parseArgs({
  options: {
    issuer: { type: 'string' },
    roles: { type: 'string' },
    email: { type: 'string', default: 'dev@heliumair.in' },
    'user-id': { type: 'string', default: 'dev-user' },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.env['APP_ENV'] !== 'local') fail('Dev tokens are for local development only (APP_ENV=local).');

let secrets: Record<string, string>;
try {
  secrets = JSON.parse(process.env['AUTH_CALLER_SECRETS'] ?? '') as Record<string, string>;
} catch {
  fail('AUTH_CALLER_SECRETS is not set or not JSON. Copy .env.example to .env.');
}

const issuer = values.issuer ?? Object.keys(secrets)[0];
const secret = issuer === undefined ? undefined : secrets[issuer];
if (issuer === undefined || secret === undefined) fail(`No secret for caller "${String(issuer)}".`);

const roles = values.roles
  ?.split(',')
  .map((role) => role.trim())
  .filter(Boolean);
const claims = roles === undefined ? {} : { act: { id: values['user-id'], email: values.email, roles } };

const token = await new SignJWT(claims)
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer(issuer)
  .setAudience('helium-backend')
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(new TextEncoder().encode(secret));

process.stdout.write(`${token}\n`);
