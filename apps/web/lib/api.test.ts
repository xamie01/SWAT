import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseCsrfToken,
  buildApiRequestInit,
  resolveApiBase,
  ApiError,
  CSRF_HEADER
} from './api.js';

describe('parseCsrfToken', () => {
  it('reads the token from a multi-cookie string', () => {
    expect(parseCsrfToken('a=1; swat_csrf=tok-123; swat_session=zzz')).toBe('tok-123');
  });

  it('is not fooled by a cookie whose name merely ends with the target', () => {
    // `not_swat_csrf` shares a suffix. A naive `includes` or a regex without an
    // anchor reads its value and sends a token the API will reject.
    expect(parseCsrfToken('not_swat_csrf=wrong')).toBeNull();
  });

  it('url-decodes the value', () => {
    expect(parseCsrfToken('swat_csrf=a%2Bb')).toBe('a+b');
  });

  it('returns null rather than empty string for a blank cookie', () => {
    // "no token" must not be confusable with "a blank token": the second would
    // build a request that fails CSRF for a reason indistinguishable from being
    // signed out.
    expect(parseCsrfToken('swat_csrf=')).toBeNull();
  });

  it('returns null for absent, empty and undefined cookie strings', () => {
    expect(parseCsrfToken('other=1')).toBeNull();
    expect(parseCsrfToken('')).toBeNull();
    expect(parseCsrfToken(undefined)).toBeNull();
    expect(parseCsrfToken(null)).toBeNull();
  });
});

describe('buildApiRequestInit', () => {
  it('always sends credentials, so the session cookie crosses origins', () => {
    // The web app and API are different origins in every deployment we have.
    // Without this every request is anonymous and cookie auth cannot work.
    expect(buildApiRequestInit().credentials).toBe('include');
    expect(buildApiRequestInit({ method: 'POST', csrfToken: 't' }).credentials).toBe('include');
  });

  it('attaches the CSRF header on mutating methods', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const init = buildApiRequestInit({ method, csrfToken: 'tok' });
      expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe('tok');
    }
  });

  it('omits the CSRF header on GET', () => {
    const init = buildApiRequestInit({ method: 'GET', csrfToken: 'tok' });
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBeUndefined();
  });

  it('omits the CSRF header when no token exists rather than sending empty', () => {
    const init = buildApiRequestInit({ method: 'POST', csrfToken: null });
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBeUndefined();
  });

  it('uppercases the method so a lowercase caller still gets CSRF', () => {
    const init = buildApiRequestInit({ method: 'post', csrfToken: 'tok' });
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe('tok');
  });

  it('never emits an API key header under any option combination', () => {
    // This is the regression guard for S6-3. `NEXT_PUBLIC_API_KEY` shipped the  check-public-secrets:allow-mention
    // operator control-plane key in the browser bundle; the fix is only durable
    // if the client cannot express it.
    const combos = [
      buildApiRequestInit(),
      buildApiRequestInit({ method: 'POST', body: '{}', csrfToken: 'tok' }),
      buildApiRequestInit({ method: 'DELETE', csrfToken: null })
    ];
    for (const init of combos) {
      const names = Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase());
      expect(names).not.toContain('x-api-key');
      expect(names).not.toContain('authorization');
    }
  });

  it('sets Content-Type only when there is a body', () => {
    const withBody = buildApiRequestInit({ method: 'POST', body: '{}' });
    expect((withBody.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const without = buildApiRequestInit({ method: 'POST' });
    expect((without.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(without.body).toBeUndefined();
  });
});

describe('resolveApiBase', () => {
  it('prefers the configured URL and strips trailing slashes', () => {
    expect(resolveApiBase(null, 'https://api.example.com/')).toBe('https://api.example.com');
  });

  it('returns relative origin for browser execution so Next.js rewrites proxy requests', () => {
    expect(resolveApiBase({ protocol: 'http:', hostname: '192.168.1.10' }, undefined)).toBe('');
    expect(resolveApiBase({ protocol: 'https:', hostname: 'wake.vercel.app' }, undefined)).toBe('');
  });

  it('falls back to internal backend URL when there is no window (SSR)', () => {
    expect(resolveApiBase(null, undefined)).toMatch(/http:\/\/(localhost|75\.119\.151\.184):3001/);
  });
});

describe('ApiError', () => {
  it('distinguishes unauthenticated from forbidden', () => {
    // A 401 means sign in; a 403 means you are signed in and may not do this.
    // The old call sites collapsed both into `new Error('Failed to fetch')`.
    expect(new ApiError(401, 'x').isUnauthenticated).toBe(true);
    expect(new ApiError(401, 'x').isForbidden).toBe(false);
    expect(new ApiError(403, 'x').isForbidden).toBe(true);
    expect(new ApiError(403, 'x').isUnauthenticated).toBe(false);
    expect(new ApiError(500, 'x').isUnauthenticated).toBe(false);
  });
});

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function withFetch(response: Response, run: () => Promise<unknown>) {
    const spy = vi.fn(async () => response);
    vi.stubGlobal('fetch', spy);
    const result = await run().catch((error) => error);
    return { spy, result };
  }

  it('parses a JSON body on success', async () => {
    const { api } = await import('./api.js');
    const { result } = await withFetch(
      new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
      () => api.get('/v1/health')
    );
    expect(result).toEqual({ ok: 1 });
  });

  it('throws ApiError carrying the status, not a generic Error', async () => {
    const { api } = await import('./api.js');
    const { result } = await withFetch(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      () => api.get('/v1/wallets')
    );
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).status).toBe(401);
    expect((result as ApiError).message).toBe('Unauthorized');
  });

  it('survives a non-JSON error body and still reports the status', async () => {
    const { api } = await import('./api.js');
    const { result } = await withFetch(
      new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
      () => api.get('/v1/wallets')
    );
    expect((result as ApiError).status).toBe(502);
  });

  it('calls onUnauthenticated on 401 instead of leaving the caller to guess', async () => {
    const { apiFetch } = await import('./api.js');
    const onUnauthenticated = vi.fn();
    await withFetch(
      new Response('{}', { status: 401 }),
      () => apiFetch('/v1/wallets', { onUnauthenticated })
    );
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for 204 rather than failing to parse an empty body', async () => {
    const { api } = await import('./api.js');
    const { result } = await withFetch(new Response(null, { status: 204 }), () =>
      api.delete('/v1/wallets/x')
    );
    expect(result).toBeUndefined();
  });
});
