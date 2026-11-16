import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../auth/plugin.js';

// Only the DB boundary is replaced. The route, CSV serialization and role guard
// are production code; Fastify injection never opens a listener.
const db = vi.hoisted(() => {
  const unexpectedRead = () => { throw new Error('PACKAGE29_UNEXPECTED_DATABASE_READ'); };
  return {
    getAdminPortfolioOverview: vi.fn(unexpectedRead),
    getAdminPortfolioUsers: vi.fn(unexpectedRead),
    getAdminPortfolioUserDetail: vi.fn(unexpectedRead),
    getAdminPortfolioMasters: vi.fn(unexpectedRead),
    getAdminPortfolioTokens: vi.fn(unexpectedRead),
    getAdminPortfolioExportData: vi.fn<(_pool: unknown, type: string) => Promise<Array<Record<string, unknown>>>>(),
    findUserById: vi.fn(unexpectedRead),
    resolveSession: vi.fn(unexpectedRead),
    forUser: vi.fn(unexpectedRead)
  };
});
vi.mock('@swat/db', () => db);

import { registerAdminPortfolioRoutes } from './admin-portfolio.js';

function userPrincipal(role: 'admin' | 'user'): AuthPrincipal {
  return {
    kind: 'user',
    sessionId: 'package29-injected-session',
    user: {
      id: `package29-${role}`,
      email: `${role}@package29.invalid`,
      displayName: null,
      role,
      tier: 'operator',
      tierExpiresAt: null,
      status: 'active',
      createdAt: new Date('2026-11-13T00:00:00.000Z')
    }
  };
}

const apps: FastifyInstance[] = [];
function appFor(principal?: AuthPrincipal): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest('principal', undefined);
  app.addHook('onRequest', async request => { request.principal = principal; });
  registerAdminPortfolioRoutes(app);
  apps.push(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.getAdminPortfolioExportData.mockReset();
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

// Literal expected wire cells follow the retained OWA-08 policy, not a second
// serializer. Tab and carriage return are supported prefixes; arbitrary leading
// spaces/newline normalization and spreadsheet-engine behavior are not certified.
const formulaCells = [
  ['equals', '=1+1', "'=1+1"],
  ['plus', '+1', "'+1"],
  ['minus', '-1', "'-1"],
  ['at sign', '@SUM(A1:A2)', "'@SUM(A1:A2)"],
  ['tab prefix', '\t=1+1', "'\t=1+1"],
  ['carriage-return prefix', '\r=1+1', "'\r=1+1"]
] as const;

const textCells = [
  ['quotes', 'He said "hello"', '"He said ""hello"""'],
  ['comma', 'alpha,beta', '"alpha,beta"'],
  ['embedded newline', 'alpha\nbeta', '"alpha\nbeta"']
] as const;

describe('Package29 retained admin export acceptance (OWA-08)', () => {
  it.each(formulaCells)('neutralizes the supported %s formula prefix through the actual export route', async (_name, value, wireCell) => {
    db.getAdminPortfolioExportData.mockResolvedValue([{ value }]);
    const response = await appFor(userPrincipal('admin')).inject({
      method: 'GET', url: '/v1/admin/portfolio/export?type=users&format=csv'
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(`value\n${wireCell}`);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe('attachment; filename="wake-users-export.csv"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.getAdminPortfolioExportData).toHaveBeenCalledExactlyOnceWith(undefined, 'users');
  });

  it.each(textCells)('preserves CSV syntax and content for %s', async (_name, value, wireCell) => {
    db.getAdminPortfolioExportData.mockResolvedValue([{ value }]);
    const response = await appFor(userPrincipal('admin')).inject({
      method: 'GET', url: '/v1/admin/portfolio/export?type=positions&format=csv'
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(`value\n${wireCell}`);
    expect(db.getAdminPortfolioExportData).toHaveBeenCalledExactlyOnceWith(undefined, 'positions');
  });

  it('neutralizes a formula cell while escaping its quotes and embedded newline', async () => {
    db.getAdminPortfolioExportData.mockResolvedValue([{ value: '=IF(A1,"yes",\n"no")' }]);
    const response = await appFor(userPrincipal('admin')).inject({
      method: 'GET', url: '/v1/admin/portfolio/export?type=executions&format=csv'
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('value\n"\'=IF(A1,""yes"",\n""no"")"');
  });

  const deniedPrincipals: Array<[string, AuthPrincipal | undefined]> = [
    ['absent principal', undefined],
    ['ordinary user', userPrincipal('user')],
    ['service principal', { kind: 'service' }]
  ];
  for (const format of ['csv', 'json'] as const) {
    it.each(deniedPrincipals)(`rejects %s ${format} export before any database reader`, async (_name, principal) => {
      db.getAdminPortfolioExportData.mockResolvedValue([{ value: 'PACKAGE29_PRIVATE_EXPORT_FIXTURE' }]);
      const response = await appFor(principal).inject({
        method: 'GET', url: `/v1/admin/portfolio/export?type=users&format=${format}`
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden' });
      expect(response.body).not.toContain('PACKAGE29_PRIVATE_EXPORT_FIXTURE');
      for (const reader of Object.values(db)) expect(reader).not.toHaveBeenCalled();
    });
  }

  it('keeps authorized JSON data unchanged rather than applying CSV formula escaping', async () => {
    const rows = [{ value: '=1+1', note: 'alpha\n"beta"' }];
    db.getAdminPortfolioExportData.mockResolvedValue(rows);
    const response = await appFor(userPrincipal('admin')).inject({
      method: 'GET', url: '/v1/admin/portfolio/export?type=masters&format=json'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(rows);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.getAdminPortfolioExportData).toHaveBeenCalledExactlyOnceWith(undefined, 'masters');
  });
});
