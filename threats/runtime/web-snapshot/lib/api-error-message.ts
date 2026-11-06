/**
 * Turns a thrown value from `lib/api.ts` into something an operator can act on.
 *
 * Exists because the thirteen call sites converted in S6-3 all used to do
 * `if (!res.ok) throw new Error('Failed to fetch X')`, which threw away the
 * status. A 401 (your session lapsed, sign in again), a 403 (you are signed in
 * but this is an admin surface) and a 500 (the API is broken) all rendered as
 * the same red box, so the one failure the operator could fix themselves was
 * indistinguishable from the two they could not.
 *
 * Kept out of `lib/api.ts` on purpose: that module decides what to *send*, this
 * one decides what to *say*. Wording is a UI concern and changes far more often
 * than the transport does.
 */

import { ApiError } from './api.js';

/** Shown on 401. Deliberately actionable -- there is a thing the reader can do. */
export const SESSION_EXPIRED_MESSAGE = 'Your session expired — sign in again.';

/** Shown on 403. Not a login problem, so it must not invite a re-login. */
export const FORBIDDEN_MESSAGE = 'This account is not permitted to use this operator surface.';

/**
 * Shown on a 403 whose cause is the double-submit token, not the user's role.
 *
 * These are the same status, and without this branch a stale `swat_csrf` cookie
 * reads as "you lack permission" -- sending the operator to hunt a role problem
 * that does not exist, on a surface they are in fact allowed to use. Newly
 * load-bearing: since S6-3 every mutating call in the app depends on that cookie.
 *
 * Matched on the API's stable `code`, not on its prose, so rewording the message
 * cannot silently re-break this.
 */
export const CSRF_MESSAGE =
  'Your session token is stale — reload the page and try again.';

/** True when a 403 body carries the API's CSRF marker. */
function isCsrfFailure(error: ApiError): boolean {
  const code = (error.body as { code?: unknown } | null | undefined)?.code;
  return code === 'csrf_invalid';
}

/**
 * @param error   Whatever reached the `catch`. Anything is legal here.
 * @param fallback What the caller was trying to do, e.g. 'Failed to fetch clusters'.
 */
export function describeApiError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.isUnauthenticated) return SESSION_EXPIRED_MESSAGE;
    if (error.isForbidden) return isCsrfFailure(error) ? CSRF_MESSAGE : FORBIDDEN_MESSAGE;
    // `ApiError.message` is already the API's own `error`/`message` field when it
    // sent one, and `"<status> <statusText>"` when it did not. Either way the
    // status is worth repeating: "Bad Request" alone does not say who is at fault.
    return `${fallback} (HTTP ${error.status}: ${error.message})`;
  }
  // A network failure or a CORS rejection lands here as a plain TypeError whose
  // message ('Failed to fetch') is useless on its own.
  if (error instanceof Error && error.message) return `${fallback} (${error.message})`;
  return fallback;
}
