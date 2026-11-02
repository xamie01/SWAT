import { describe, it, expect } from 'vitest';
import { classifyRoute, resolveRouteAccess, requiresRoleCheck } from './route-access.js';

describe('classifyRoute', () => {
  it('treats the landing page and auth pages as public', () => {
    expect(classifyRoute('/')).toBe('public');
    expect(classifyRoute('/login')).toBe('public');
    expect(classifyRoute('/signup')).toBe('public');
    expect(classifyRoute('/forgot-password')).toBe('public');
    expect(classifyRoute('/learn')).toBe('public');
  });

  it("classifies today's operator pages as admin", () => {
    for (const path of ['/admin', '/admin/portfolio', '/workspace', '/signals', '/wallets', '/logs', '/clusters', '/setup', '/performance']) {
      expect(classifyRoute(path)).toBe('admin');
    }
  });

  it('classifies nested operator paths as admin, not just the exact prefix', () => {
    expect(classifyRoute('/workspace/views/health')).toBe('admin');
  });

  it('does not let a longer path that merely starts with the same letters slip through', () => {
    // `/loginish` is not `/login`. Matching on bare `startsWith` without the
    // segment boundary would make it public.
    expect(classifyRoute('/loginish')).toBe('app');
    expect(classifyRoute('/setupwizard')).toBe('app');
  });

  it('defaults an unknown path to app, so a new page requires a session', () => {
    // Fails closed. A new page added without touching this file is gated rather
    // than public, which is the safe direction to be wrong in.
    expect(classifyRoute('/some/new/page')).toBe('app');
  });
});

describe('resolveRouteAccess', () => {
  it('allows public routes with no session', () => {
    expect(resolveRouteAccess({ pathname: '/', hasSession: false, role: null }))
      .toEqual({ decision: 'allow' });
  });

  it('redirects an anonymous visitor to login and preserves the deep link', () => {
    expect(resolveRouteAccess({ pathname: '/workspace/views/health', hasSession: false, role: null }))
      .toEqual({
        decision: 'redirect',
        to: '/login?next=%2Fworkspace%2Fviews%2Fhealth',
        reason: 'no-session'
      });
  });

  it('allows an admin onto an admin route', () => {
    expect(resolveRouteAccess({ pathname: '/wallets', hasSession: true, role: 'admin' }))
      .toEqual({ decision: 'allow' });
  });

  it('refuses a non-admin an admin route, and does not send them to login', () => {
    // They are signed in. A login form would imply their password is wrong.
    const access = resolveRouteAccess({ pathname: '/wallets', hasSession: true, role: 'user' });
    expect(access).toEqual({ decision: 'redirect', to: '/?denied=admin', reason: 'not-admin' });
  });

  it('fails closed when the role is unknown', () => {
    // An unreachable API, an expired session and a genuine non-admin all arrive
    // here as null. All three must be refused.
    expect(resolveRouteAccess({ pathname: '/setup', hasSession: true, role: null }).decision)
      .toBe('redirect');
  });

  it('lets any signed-in user onto a non-admin app route', () => {
    expect(resolveRouteAccess({ pathname: '/dashboard', hasSession: true, role: 'user' }))
      .toEqual({ decision: 'allow' });
  });
});

describe('requiresRoleCheck', () => {
  it('asks the API only for admin routes with a session', () => {
    expect(requiresRoleCheck('/wallets', true)).toBe(true);
  });

  it('skips the round trip when there is no session or the route is public', () => {
    // No point paying for a role lookup we are going to redirect past anyway.
    expect(requiresRoleCheck('/wallets', false)).toBe(false);
    expect(requiresRoleCheck('/login', true)).toBe(false);
    expect(requiresRoleCheck('/dashboard', true)).toBe(false);
  });
});
