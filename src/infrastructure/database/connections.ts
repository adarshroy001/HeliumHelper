/**
 * The named MongoDB connections (ADR-0005). A module's models declare which one they use:
 * `MongooseModule.forFeature([...], DB.messaging)` and `@InjectModel(Campaign.name, DB.messaging)`.
 *
 * - `main`: today's Helium database. Read-only: the database user can't write to it.
 * - `messaging`: the messaging database, owned by this backend.
 */
export const DB = { main: 'main', messaging: 'messaging' } as const;

export type ConnectionName = (typeof DB)[keyof typeof DB];
