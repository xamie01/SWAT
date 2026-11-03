import { NextResponse, type NextRequest } from 'next/server';
import { resolveRouteAccess, requiresRoleCheck, type Role } from './lib/route-access.js';
import { SESSION_COOKIE } from './lib/api.js';

/**
 * Route protection (checklist S6-2, closes S6-B7).
 *
 * All the decisions live in `lib/route-access.ts` as pure functions with tests;
 * this file is the adapter that feeds them a request and acts on the answer.
 * Middleware runs in the edge runtime and cannot be imported into vitest, so
 * anything decided here rather than there is untestable -- keep it thin.
 *
 * **This is a redirect layer, not the authorization boundary.** The API enforces
 * roles itself (`apps/api/src/auth/plugin.ts`), and it must, because everything
 * middleware knows comes from the client. What this buys is that an operator
 * whose session lapsed lands on a login form instead of a dashboard full of
 * failed requests, and a non-admin never sees an admin shell render before its
 * data 403s.
 */

const API_BASE =
  process.env.INTERNAL_API_URL ??
  process.env.BACKEND_API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'production' ? 'http://75.119.151.184:3001' : 'http://localhost:3001');

/**
 * Asks the API who this session belongs to.
 *
 * Returns null on anything other than a clean 200 with a recognised role --
 * network failure, 401, malformed body. Every one of those means "we do not know
 * this is an admin", and `resolveRouteAccess` refuses admin surfaces on null. So
 * an API outage locks the operator console rather than opening it, which is the
 * correct direction and worth stating because it will look like a bug the first
 * time it happens.
 */
async function fetchRole(request: NextRequest): Promise<Role | null> {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  try {
    const response = await fetch(`${API_BASE}/v1/auth/me`, {
      headers: { cookie },
      // Middleware must never serve a cached identity: a stale 200 would keep a
      // revoked session admitted for as long as the cache lived.
      cache: 'no-store'
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { user?: { role?: unknown } };
    const role = body.user?.role;
    return role === 'admin' || role === 'user' ? role : null;
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/v1/')) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has(SESSION_COOKIE);

  const role = (await (requiresRoleCheck(pathname, hasSession) ? fetchRole(request) : null)) as Role | null;
  const access = resolveRouteAccess({ pathname, hasSession, role });

  if (access.decision === 'redirect') {
    const url = request.nextUrl.clone();
    const [path, query] = access.to.split('?');
    url.pathname = path!;
    url.search = query ? `?${query}` : '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Skip Next internals, static assets and the favicon.
   *
   * Not a security decision -- `classifyRoute` would gate an unmatched path
   * anyway. It is a cost one: without it every image request on an admin page
   * triggers a `/v1/auth/me` round trip.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|v1/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)']
};
