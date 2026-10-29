---
name: add-module
description: Create a new business module in helium-backend (src/modules/<name>) with the right files, wiring and README. Use when adding a new feature area such as messaging or campaigns.
---

# Add a module

A module is one business feature in `src/modules/<name>/` (ADR-0004). Other code uses it only through its `index.ts`.

## Steps

1. Pick a name: one lower-case word or kebab-case (`campaigns`). Check PLAN.md for the task that owns it.
2. Create the folder and these files (add the others only when needed):

   | File | Holds |
   | --- | --- |
   | `<name>.module.ts` | `@Module({ imports, controllers, providers, exports })` |
   | `index.ts` | The public API: the module class, message types, schedules, types other modules may use |
   | `README.md` | What it owns: collections, queues, routes, events, error codes, schedules |
   | `<name>.errors.ts` | `AppError` subclasses (extend `NotFoundError`, `ConflictError`, ...) |
   | `<name>.schemas.ts` | zod schemas for requests and Mongoose schemas, or one file per entity |
   | `<name>.messages.ts` | `defineMessage()` types and queue names |
   | `<feature>.controller.ts` / `.service.ts` / `.repository.ts` | Layers: controller → service → repository |

3. Database models: `MongooseModule.forFeature([{ name: X.name, schema: XSchema }], DB.messaging)` in the module's `imports`. `DB.main` is read-only.
4. Wire it in:
   - routes or services the API needs → add the module to `imports` in `src/app.module.ts`;
   - consumers → add it to `src/worker.module.ts`;
   - schedules → add them to `src/schedules.ts`, then `pnpm schedules:export`.
5. Permissions for its routes go in `DEFAULT_ROLE_PERMISSIONS` (`src/common/auth/permissions.ts`), as `<area>:<action>`.
6. Collections and indexes: a migration (skill `add-migration`).
7. Write the README's "Owns" table: copy the layout of `src/modules/audit/README.md`.
8. Run `pnpm lint && pnpm typecheck && pnpm test`.

## Never

- Import another module's files except its `index.ts` (lint fails).
- Use `forwardRef` to break a cycle: use an event or a queue.
- Write to a collection another module owns, or to `DB.main` without an ADR.
- Put business rules in `src/common` or `src/infrastructure`.
- Use plain `@Controller`, `HttpException`, `throw new Error` or `z.object` in a module (lint fails).
