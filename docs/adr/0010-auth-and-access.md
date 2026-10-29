# ADR-0010 · Authentication and access control

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Today the only caller will be HeliumAdmin's server. Later, admin users and storefront customers may call the backend directly. Each audience needs its own login method, permissions and rate limits.

In CrediTouch, a route without a permission decorator was open by default, and only a test caught it.

## Decision

- **Routes are grouped by audience prefix:**
    - `/internal/v1/…` for service-to-service calls (HeliumAdmin now);
    - `/admin/v1/…` and `/store/v1/…` are reserved for later.

    Guards and rate limits can differ per prefix.
- **Deny by default.**
    - A global `AuthGuard` requires a verified caller on every route, except routes marked `@Public()`, such as health checks.
    - A global `PermissionsGuard` refuses any route that has no access decorator.
    - A route-coverage test fails CI if a route declares neither `@Public()` nor `@RequirePermissions(...)`.
- **Service authentication (now):**
    - Callers send a short-lived JWT (HS256, expiring in 5 minutes or less), signed with that caller's own secret from Secrets Manager.
    - Required claims are `iss` (the caller), `aud = helium-backend` and `exp`.
    - The admin user acting through HeliumAdmin travels in the signed `act` claim (`id`, `email`, `roles`). A header can't forge it.
- **Handlers receive an `Actor`** (`@CurrentActor()`), describing the calling service and the optional user with roles. Services take the actor as an argument for audit and permission decisions.
- **Network:** the API is reachable only through an internal load balancer that admits the HeliumAdmin servers.

## Alternatives considered

- **IAM SigV4 between services:** stronger, but HeliumAdmin runs on EC2 with pm2 today. Revisit when callers move to AWS-managed compute.
- **A shared static API key:** can't carry the acting user, and is hard to rotate safely.

## Consequences

- When customer or admin-user login is needed, it is added as a second strategy in the same `AuthGuard`. No route changes.
- The dev token script (F11) lets developers call the local API.
