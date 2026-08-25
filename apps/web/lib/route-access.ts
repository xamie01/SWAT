/**
 * Route protection decisions (checklist S6-2), as pure functions.
 *
 * Kept separate from `middleware.ts` because Next middleware runs in the edge
 * runtime and cannot be imported into a test here -- but the decisions are the
 * part worth testing, and they are just data in, data out.
 *
 * **What this layer is and is not.** It is the reason an unauthenticated visitor
 * is redirected to /login instead of watching a dashboard fail to load. It is
 * *not* the authorization boundary: the API enforces that itself in
 * `apps/api/src/auth/plugin.ts` (`registerAdminOnlyGlobals` restricts every
 * route outside `/v1/auth/` and `/v1/me/` to admins and internal services).
 * Middleware sees only cookies and whatever it chooses to ask the API, so
 * treating it as the gate would put the control in the client's half of the
 * system. Both layers exist; only the API one is load-bearing.
 */

export type RouteClass = 'public' | 'admin' | 'app';

/** Roles the API reports on `GET /v1/auth/me`. */
export type Role = 'admin' | 'user';

/** Reachable without a session. */
const PUBLIC_PREFIXES = ['/login', '/signup', '/forgot-password'] as const;

/**
 * The operator console: today's nine pages.
 *
 * These are admin surfaces because they call global routes -- `/v1/wallets`,
 * `/v1/config`, `/v1/scorer/run` -- which the API admits only for an admin or an
 * internal service. Listing them here is an interim measure: checklist S6-13 and
 * S6-14 move them under an `(admin)` route group, at which point the prefix is
 * structural and this array collapses to one entry. Until then a new operator
 * page must be added here, which is exactly the kind of thing that gets
 * forgotten -- hence `classifyRoute` defaults unknown paths to 'app' (session
 * required) rather than 'public'.
 */
const ADMIN_PREFIXES = [
  '/workspace',
  '/signals',
  '/wallets',
  '/logs',
  '/clusters',
  '/setup',
  '/performance'
] as const;

export function classifyRoute(pathname: string): RouteClass {
  if (pathname === '/') return 'public';
  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return 'public';
  }
  if (ADMIN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return 'admin';
  }
  return 'app';
}

export interface RouteAccessInput {
  readonly pathname: string;
  /** Whether the session cookie is present. Presence, not validity. */
  readonly hasSession: boolean;
  /**
   * The role the API reported, or null when it was not asked or would not say.
   *
   * Null is not 'user'. An unreachable API, an expired session and a genuine
   * non-admin are all null here, and all three must be refused an admin surface
   * -- so this fails closed. That is the right direction, but it means an API
   * outage presents as "you are not an admin", which is why the redirect carries
   * a reason.
   */
  readonly role: Role | null;
}

export type RouteAccess =
  | { readonly decision: 'allow' }
  | { readonly decision: 'redirect'; readonly to: string; readonly reason: RedirectReason };

export type RedirectReason = 'no-session' | 'not-admin';

/**
 * Decides whether a request may proceed.
 *
 * The `next` parameter on the login redirect is what makes a deep link survive
 * signing in; without it every session expiry dumps the operator back on the
 * landing page and they have to navigate again.
 */
export function resolveRouteAccess(input: RouteAccessInput): RouteAccess {
  const classification = classifyRoute(input.pathname);
  if (classification === 'public') return { decision: 'allow' };

  if (!input.hasSession) {
    return {
      decision: 'redirect',
      to: `/login?next=${encodeURIComponent(input.pathname)}`,
      reason: 'no-session'
    };
  }

  if (classification === 'admin' && input.role !== 'admin') {
    // Deliberately not /login: the user is signed in, so sending them to a login
    // form would suggest their credentials are the problem and invite them to
    // retype a password that is already correct.
    return { decision: 'redirect', to: '/?denied=admin', reason: 'not-admin' };
  }

  return { decision: 'allow' };
}

/** True when middleware needs to ask the API for the role at all. */
export function requiresRoleCheck(pathname: string, hasSession: boolean): boolean {
  return hasSession && classifyRoute(pathname) === 'admin';
}
