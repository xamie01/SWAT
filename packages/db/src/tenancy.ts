/**
 * Tenant scoping (D12).
 *
 * The rule this file exists to enforce: **`user_id` comes from the session,
 * never from a request payload.** Every per-user query takes a `UserScope` as
 * its first parameter, and the only way to obtain one is `forUser()`, which the
 * API calls with `request.user.id` set by the auth plugin.
 *
 * This is deliberately a nominal type rather than a bare string. A function
 * signature of `(userId: string, ...)` accepts `request.body.userId` just as
 * happily as the session's id, and that mistake is invisible in review; a
 * signature of `(scope: UserScope, ...)` does not compile against a raw string.
 * The type is the control — not the convention.
 *
 * RLS was considered and rejected for now (D12): a single database role with
 * pooled connections makes `SET LOCAL` fragile, and the cross-tenant background
 * jobs (scorer, discovery, signal-engine) would each need a documented bypass.
 * It may return later as a backstop on custody and balance tables only.
 */

declare const scopeBrand: unique symbol;

export interface UserScope {
  readonly userId: string;
  /** Prevents a bare `{ userId }` object literal from satisfying the type. */
  readonly [scopeBrand]: true;
}

/**
 * The only constructor for a `UserScope`.
 *
 * Call this with a session-derived id and nothing else. It is intentionally the
 * single grep target for "where does tenant scope enter the system?".
 */
export function forUser(userId: string): UserScope {
  if (!userId) {
    // An empty scope would silently widen every query built from it.
    throw new Error('forUser() requires a user id');
    }
  return { userId } as UserScope;
}

/**
 * Escape hatch for routes that legitimately cross tenants (admin listings,
 * platform-wide reports, background jobs).
 *
 * Deliberately verbose and separately named so that crossing tenants is
 * greppable rather than implicit — `grep -rn crossTenant` should return a short,
 * reviewable list. Any new occurrence is a security review item.
 */
export function crossTenantScope(reason: string): UserScope {
  if (!reason) throw new Error('crossTenantScope() requires a stated reason');
  return { userId: '*' } as UserScope;
}

export function isCrossTenant(scope: UserScope): boolean {
  return scope.userId === '*';
}
