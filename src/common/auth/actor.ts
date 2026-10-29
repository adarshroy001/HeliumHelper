/** The admin user a calling service acts for, from the token's signed `act` claim. */
export interface ActorUser {
  readonly id: string;
  readonly email: string;
  readonly roles: readonly string[];
}

/**
 * Who is making a request: always a calling service (the token's `iss`), plus the user it acts for, if any.
 * Handlers get it with `@CurrentActor()` and pass it to services for permission and audit decisions.
 */
export interface Actor {
  readonly service: string;
  readonly user?: ActorUser;
}

const actors = new WeakMap<object, Actor>();

/** Stores the verified actor on the request (AuthGuard). */
export function setRequestActor(req: object, actor: Actor): void {
  actors.set(req, actor);
}

/** The verified actor of a request, or `undefined` on a public route. */
export function getRequestActor(req: object): Actor | undefined {
  return actors.get(req);
}
