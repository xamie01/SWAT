/**
 * The single browser -> API client (checklist S6-3).
 *
 * Replaces thirteen copies of a hand-rolled `fetch` that each sent
 * `X-Api-Key: process.env.NEXT_PUBLIC_API_KEY`. check-public-secrets:allow-mention
 * -- naming the deleted variable here is documentation, not usage. It is inlined into
 * the client bundle by Next.js at build time, so the shared operator key was
 * shipped to every visitor and granted full control-plane access. It is deleted,
 * not rotated: a rotated secret in a public bundle is still public.
 *
 * What replaces it is the session cookie the API already issues, plus the
 * double-submit CSRF token it already expects. See `apps/api/src/auth/plugin.ts`
 * -- the backend half has existed since Stage 1; only the frontend was behind.
 *
 * The module is split deliberately. Everything that makes a decision is a pure
 * function over explicit inputs, and only `apiFetch` touches the network or the
 * DOM. That is what lets this file be tested at all: `apps/web` has no jsdom, so
 * a client that read `document.cookie` directly would be untestable here.
 */

/** Name of the CSRF cookie the API sets. Deliberately JS-readable. */
export const CSRF_COOKIE = 'swat_csrf';
/** Header the API compares the cookie against. */
export const CSRF_HEADER = 'x-csrf-token';
/** Session cookie name. httpOnly, so JS can never read it -- only send it. */
export const SESSION_COOKIE = 'swat_session';

/** Methods that change state and therefore need the CSRF header. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the caller should be sent to /login rather than shown an error. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** True when the caller is signed in but lacks the role for this surface. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/**
 * Extracts the CSRF token from a raw cookie string.
 *
 * Pure, and takes the string rather than reading `document.cookie`, so it is
 * testable without a DOM. Returns null rather than an empty string when absent
 * so "no token" cannot be mistaken for "a token that happens to be blank" --
 * the second would produce a request that fails CSRF for a reason the caller
 * cannot distinguish from being logged out.
 */
export function parseCsrfToken(cookieString: string | null | undefined): string | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== CSRF_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? decodeURIComponent(value) : null;
  }
  return null;
}

export interface BuildRequestOptions {
  readonly method?: string;
  /** Already-serialised body, or undefined for a bodyless request. */
  readonly body?: string;
  /** From `parseCsrfToken`. Null when the user has no session. */
  readonly csrfToken?: string | null;
  readonly signal?: AbortSignal;
}

/**
 * Builds the `RequestInit` for an API call.
 *
 * Pure. Three invariants, each of which had a bug behind it:
 *
 *   1. `credentials: 'include'` on every request. The API and the web app are
 *      different origins in every deployment we have (:3000 and :3001), so
 *      without this the browser sends no cookie and every call is anonymous.
 *   2. The CSRF header only on mutating methods, and only when a token exists.
 *      Sending it on a GET is harmless but sending a stale one is misleading,
 *      and the API only checks it where it matters.
 *   3. No API key, ever. There is deliberately no parameter for one -- the way
 *      this stays fixed is that the shape cannot express the old behaviour.
 */
export function buildApiRequestInit(options: BuildRequestOptions = {}): RequestInit {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (MUTATING_METHODS.has(method) && options.csrfToken) {
    headers[CSRF_HEADER] = options.csrfToken;
  }

  const init: RequestInit = {
    method,
    credentials: 'include',
    headers
  };
  if (options.body !== undefined) init.body = options.body;
  if (options.signal) init.signal = options.signal;
  return init;
}

/**
 * Resolves the API origin.
 *
 * `NEXT_PUBLIC_API_URL` is a URL, not a secret, so it stays a `NEXT_PUBLIC_`
 * variable -- the rule being enforced is "no secrets in the bundle", not "no
 * public config". Absent that, derive the host from how the page is being
 * viewed so the dashboard works from another device on the LAN as well as from
 * localhost. Takes the location rather than reading `window` so it is testable.
 */
export function resolveApiBase(
  location?: { protocol: string; hostname: string } | null,
  configured: string | undefined = process.env.NEXT_PUBLIC_API_URL
): string {
  if (configured) return configured.replace(/\/+$/, '');
  if (location) return `${location.protocol}//${location.hostname}:3001`;
  return 'http://localhost:3001';
}

export function resolveLpApiBase(
  location?: { protocol: string; hostname: string } | null,
  configured: string | undefined = process.env.NEXT_PUBLIC_LP_API_URL
): string {
  if (configured) return configured.replace(/\/+$/, '');
  if (location) return `${location.protocol}//${location.hostname}:3010`;
  return 'http://localhost:3010';
}

function currentLocation(): { protocol: string; hostname: string } | null {
  if (typeof window === 'undefined') return null;
  return { protocol: window.location.protocol, hostname: window.location.hostname };
}

function currentCookies(): string | null {
  if (typeof document === 'undefined') return null;
  return document.cookie;
}

export interface ApiFetchOptions {
  readonly method?: string;
  /** Serialised for you. Pass the object, not a string. */
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /**
   * Called instead of throwing when the API says 401. Injected so the redirect
   * is the caller's decision -- a background poll should not yank the user out
   * of a form they are filling in.
   */
  readonly onUnauthenticated?: () => void;
}

/**
 * Calls the API with the session cookie and CSRF header attached.
 *
 * Throws `ApiError` on any non-2xx so a caller cannot accidentally treat an
 * error body as data -- the previous call sites all did `if (!res.ok) throw new
 * Error('Failed to fetch X')`, which discarded the status and made a 401 and a
 * 500 indistinguishable in the UI.
 */
export async function apiFetch<T = unknown>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const base = resolveApiBase(currentLocation());
  const init = buildApiRequestInit({
    method: options.method,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    csrfToken: parseCsrfToken(currentCookies()),
    signal: options.signal
  });

  const response = await fetch(`${base}${path}`, init);

  if (response.status === 401 && options.onUnauthenticated) {
    options.onUnauthenticated();
    throw new ApiError(401, 'Not signed in');
  }

  if (!response.ok) {
    let body: unknown;
    let message = `${response.status} ${response.statusText}`;
    try {
      body = await response.json();
      const described = (body as { message?: unknown; error?: unknown } | null)?.message
        ?? (body as { error?: unknown } | null)?.error;
      if (typeof described === 'string' && described.length > 0) message = described;
    } catch {
      // A non-JSON error body is normal (a proxy 502, an HTML error page). The
      // status is the part that matters and we already have it.
    }
    throw new ApiError(response.status, message, body);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Convenience wrappers so call sites read as intent rather than as plumbing. */
export const api = {
  get: <T = unknown>(path: string, options?: Omit<ApiFetchOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T = unknown>(path: string, body?: unknown, options?: Omit<ApiFetchOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  delete: <T = unknown>(path: string, options?: Omit<ApiFetchOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'DELETE' })
};

export async function lpApiFetch<T = unknown>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const base = resolveLpApiBase(currentLocation());
  const init = buildApiRequestInit({
    method: options.method,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    csrfToken: parseCsrfToken(currentCookies()),
    signal: options.signal
  });

  const response = await fetch(`${base}${path}`, init);

  if (response.status === 401 && options.onUnauthenticated) {
    options.onUnauthenticated();
    throw new ApiError(401, 'Not signed in');
  }

  if (!response.ok) {
    let body: unknown;
    let message = `${response.status} ${response.statusText}`;
    try {
      body = await response.json();
      const described = (body as { message?: unknown; error?: unknown } | null)?.message
        ?? (body as { error?: unknown } | null)?.error;
      if (typeof described === 'string' && described.length > 0) message = described;
    } catch {
      // non-json response
    }
    throw new ApiError(response.status, message, body);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const lpApi = {
  get: <T = unknown>(path: string, options?: Omit<ApiFetchOptions, 'method' | 'body'>) =>
    lpApiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T = unknown>(path: string, body?: unknown, options?: Omit<ApiFetchOptions, 'method' | 'body'>) =>
    lpApiFetch<T>(path, { ...options, method: 'POST', body }),
  patch: <T = unknown>(path: string, body?: unknown, options?: Omit<ApiFetchOptions, 'method' | 'body'>) =>
    lpApiFetch<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T = unknown>(path: string, options?: Omit<ApiFetchOptions, 'method' | 'body'>) =>
    lpApiFetch<T>(path, { ...options, method: 'DELETE' })
};
