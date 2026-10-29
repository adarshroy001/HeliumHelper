---
name: add-config
description: Add an environment variable or a config area to helium-backend, validated with zod at startup and kept in sync with .env.example and AWS. Use whenever code needs a new setting or secret.
---

# Add config

Settings are validated at startup; a wrong value stops the app with a clear message (CONVENTIONS → Configuration).

## Steps

1. **Pick the area**: an existing file in `src/config/` (`app`, `auth`, `database`, `redis`, `queue`, `worker`) or a new `<area>.config.ts` for a new integration (`whatsapp`).
2. **Add the variable to the area's schema**, with a doc comment and a default only if it is safe in production:
   ```ts
   /** Graph API base URL. */
   WHATSAPP_API_URL: z.url().default('https://graph.facebook.com/v23.0'),
   /** Meta app secret, for webhook signatures. From Secrets Manager. */
   WHATSAPP_APP_SECRET: z.string().min(32),
   ```
   Booleans: `z.stringbool({ truthy: ['true'], falsy: ['false'] })`. Numbers: `z.coerce.number().int()`.
3. **Map it** in the area's `parse<Area>Config()` to a camelCase field.
4. **New area only**: copy `src/config/redis.config.ts`, then add the schema to `CONFIG_SCHEMAS` (`src/config/index.ts`), the `registerAs` to `CONFIG_AREAS` (`src/config/config.module.ts`), and export both from `index.ts`.
5. **`.env.example`**: the variable with a comment and a working local value. A test fails if it's missing or extra.
6. **Tests needing a value** that has no default: add it to `env` in `vitest.config.ts`, or to `test/global-setup.ts` if a container provides it.
7. **Unit test** the rules in `<area>.config.spec.ts`: valid, default, and each rejection.
8. **AWS**: plain values in `serviceEnvironment()` in `deploy/lib/app-runtime.ts`; secrets as a Secrets Manager secret (foundation or data stack) referenced there with `EcsSecret.fromSecretsManager`.
9. Use it by injecting the typed area: `@Inject(whatsappConfig.KEY) private readonly whatsapp: WhatsappConfig`.

## Never

- Read `process.env` outside `src/config` (lint fails), or call `ConfigService.get('...')` in feature code.
- Give a secret a default, or put a real secret in `.env.example`.
- Add a development-only default that would also apply in production without a check against `APP_ENV`.
- Log a config value that is a secret.
