import { cookies } from 'next/headers';
import { resolveApiBase, ApiError, SESSION_COOKIE } from './api.js';

/**
 * Server-component half of the API client (checklist S6-3).
 *
 * `lib/api.ts` is browser-only by construction: it reads `document.cookie` for
 * the CSRF token and `window.location` for the host. A React Server Component
 * has neither. It runs on the server, where the user's cookies arrive on the
 * *incoming request* and must be forwarded explicitly -- `credentials:
 * 'include'` means nothing there, because there is no browser in the call.
 *
 * Two of the thirteen converted files are server components
 * (`app/signals/page.tsx`, `app/performance/page.tsx`), which is why this exists
 * rather than being folded into `api.ts`. Keeping them separate also keeps
 * `next/headers` -- which throws if imported into a client component -- out of
 * the module every client view imports.
 *
 * **Read-only on purpose.** There is no `post` here. A server component cannot
 * mutate anyway, and the CSRF token is a *double-submit* check: the client must
 * echo a cookie it can read, which is precisely the thing a server component
 * cannot participate in. A mutation belongs in a client component or a Server
 * Action, and offering a `post` here would invite someone to write one that
 * fails CSRF for reasons that look like an auth bug.
 */

/**
 * Fetches from the API on behalf of the signed-in user, forwarding their session.
 *
 * Returns `null` when there is no session rather than throwing, because the
 * common case for a server component is "render the signed-out state", and
 * middleware has already redirected anyone who should not be here.
 */
export async function serverApiGet<T = unknown>(path: string): Promise<T | null> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE);
  if (!session) return null;

  const response = await fetch(`${resolveApiBase(null)}${path}`, {
    // Forwarding only the session cookie, not the whole jar. Nothing else the
    // browser holds is ours to relay to the API, and a narrow forward cannot
    // leak a third-party cookie into our own logs.
    headers: { cookie: `${SESSION_COOKIE}=${session.value}` },
    // Never cache a per-user response. Next would otherwise happily serve one
    // user's data to another on a shared route -- the worst possible bug in a
    // multi-tenant product, and the default is opt-out, not opt-in.
    cache: 'no-store'
  });

  if (response.status === 401) return null;
  if (!response.ok) throw new ApiError(response.status, `${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}
