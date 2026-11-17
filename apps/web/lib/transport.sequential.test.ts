import { afterEach, expect, it, vi } from 'vitest';
import { resolveApiBase, resolveLpApiBase } from './api.js';
import { validateBackendTarget } from './backend-target.js';
import { resolveLoginDestination } from './route-access.js';

const saved = { ...process.env };
afterEach(() => { vi.unstubAllEnvs(); process.env = { ...saved }; vi.restoreAllMocks(); vi.resetModules(); });

it('refuses remote plaintext SSR destinations, including loopback text outside the hostname', () => {
  vi.stubEnv('NODE_ENV', 'production');
  for (const key of ['INTERNAL_API_URL', 'BACKEND_API_INTERNAL_URL', 'INTERNAL_LP_URL', 'BACKEND_LP_INTERNAL_URL']) delete process.env[key];
  expect(resolveApiBase(null, '')).toBe('http://127.0.0.1:3001');
  expect(resolveLpApiBase(null, '')).toBe('http://127.0.0.1:3010');
  for (const target of ['http://remote.example', 'http://localhost.remote.example', 'http://remote.example/localhost', 'http://remote.example?host=127.0.0.1']) {
    process.env.INTERNAL_API_URL = target;
    process.env.INTERNAL_LP_URL = target;
    expect(() => resolveApiBase(null, '')).toThrow();
    expect(() => resolveLpApiBase(null, '')).toThrow();
  }
});

it('accepts exact loopback or TLS while rejecting malformed and credential-bearing targets', () => {
  for (const url of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001', 'https://backend.example']) {
    expect(validateBackendTarget(url, true)).toBe(url);
  }
  for (const url of ['http://localhost.example', 'https://user:password@example.invalid', 'https://example.invalid?token=fixture', 'https://example.invalid#fixture', 'file:///tmp/backend', '/relative']) {
    expect(() => validateBackendTarget(url, true)).toThrow();
  }
});

it('uses the same validated destination for Next rewrites', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  process.env.INTERNAL_API_URL = 'https://private.example';
  process.env.INTERNAL_LP_URL = 'https://private-lp.example';
  const module = await import('../next.config.js');
  const config = module.default as unknown as import('next').NextConfig;
  const headers = (await config.headers!())[0]!.headers;
  expect(headers).toContainEqual({ key: 'X-Frame-Options', value: 'DENY' });
  expect(headers).toContainEqual({ key: 'Referrer-Policy', value: 'no-referrer' });
  expect(headers).toContainEqual({ key: 'X-Content-Type-Options', value: 'nosniff' });
  const rewrites = await config.rewrites!();
  expect(rewrites).toEqual([
    { source: '/v1/lp/:path*', destination: 'https://private-lp.example/v1/lp/:path*' },
    { source: '/v1/:path*', destination: 'https://private.example/v1/:path*' }
  ]);
});

it('keeps post-login navigation same-origin and classifies decoded paths without query confusion', () => {
  for (const next of ['//outside.invalid', '/\\outside.invalid', '/%2foutside.invalid', '/%5coutside.invalid', '/admin?tab=x', '/%61dmin', '/dashboard/../admin']) {
    expect(resolveLoginDestination(next, 'user')).toBe('/dashboard');
  }
  expect(resolveLoginDestination('/dashboard?tab=positions', 'user')).toBe('/dashboard?tab=positions');
  expect(resolveLoginDestination('/admin?tab=x', 'admin')).toBe('/admin?tab=x');
});

it('does not use browser public configuration for cookie-bearing SSR requests', () => {
  vi.stubEnv('NODE_ENV', 'production');
  process.env.INTERNAL_API_URL = 'https://private.example/';
  process.env.INTERNAL_LP_URL = 'https://private-lp.example/';
  expect(resolveApiBase(null, 'https://public.example')).toBe('https://private.example');
  expect(resolveLpApiBase(null, 'https://public.example')).toBe('https://private-lp.example');
});
