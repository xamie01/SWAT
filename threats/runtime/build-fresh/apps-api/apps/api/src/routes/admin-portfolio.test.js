import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
    process.env.DATABASE_URL ??= 'postgres://swat:swat@127.0.0.1:5432/swat_route_tests';
});
const mockDb = vi.hoisted(() => ({
    getAdminPortfolioOverview: vi.fn(async () => ({
        totalFleetAumUsd: 25000,
        netRealizedPnlUsd: 3500,
        netRealizedPnl24hUsd: 450,
        unrealizedPnlUsd: 0,
        fleetWinRatePct: 72.5,
        cumulativeGasTipBurnUsd: 85.5,
        totalCopiersActive: 15,
        openPositionsCount: 42,
    })),
    getAdminPortfolioUsers: vi.fn(async () => ({
        users: [
            {
                id: 'u-1',
                email: 'trader@wake.trade',
                role: 'user',
                tier: 'operator',
                createdAt: '2026-08-01T00:00:00.000Z',
                tierExpiresAt: '2026-09-01T00:00:00.000Z',
                gracePeriodEndsAt: null,
                custodyStatus: { solana: 'solana_vault' },
                totalCashFloatUsd: 1500,
                copiedMasters: [
                    {
                        masterAddress: 'solana:Master1',
                        label: 'Alpha Whale',
                        chain: 'solana',
                        state: 'active',
                        membershipSlot: 1,
                    },
                ],
                openPositionsCount: 2,
                openPositionsValueUsd: 3000,
                unrealizedPnlUsd: 0,
                realizedPnlUsd: 250,
                trades24hCount: 4,
                killSwitchActive: false,
            },
        ],
        total: 1,
    })),
    getAdminPortfolioUserDetail: vi.fn(async (_pool, userId) => {
        if (userId === 'not-found')
            return null;
        return {
            user: {
                id: userId,
                email: 'trader@wake.trade',
                role: 'user',
                tier: 'operator',
                createdAt: '2026-08-01T00:00:00.000Z',
                tierExpiresAt: null,
                gracePeriodEndsAt: null,
                killSwitchActive: false,
                maxSlippageBps: 100,
            },
            balances: [],
            openPositions: [],
            subscriptions: [],
            executionLedger: [],
        };
    }),
    getAdminPortfolioMasters: vi.fn(async () => [
        {
            masterWalletAddress: 'solana:Master1',
            chain: 'solana',
            label: 'Alpha Whale',
            followerCount: 15,
            followerCap: 50,
            totalFollowerCapitalUsd: 45000,
            copierRealizedPnlUsd: 3200,
            avgCopierSlippageBps: 8,
            copierWinRatePct: 75.0,
        },
    ]),
    getAdminPortfolioTokens: vi.fn(async () => [
        {
            tokenMint: 'solana:Mint1',
            tokenSymbol: 'SOL1',
            chain: 'solana',
            totalHolders: 5,
            totalQuantity: 1000,
            totalExposureUsd: 5000,
            concentrationPct: 5.0,
        },
    ]),
    getAdminPortfolioExportData: vi.fn(async (_pool, type) => [
        { recordType: type, value: 123 },
    ]),
}));
vi.mock('@swat/db', () => mockDb);
import { registerAdminPortfolioRoutes } from './admin-portfolio.js';
async function createTestApp() {
    const app = Fastify();
    app.decorateRequest('principal', undefined);
    app.addHook('onRequest', async (request) => {
        const userHeader = request.headers['x-test-user'];
        const userId = Array.isArray(userHeader) ? userHeader[0] : userHeader;
        const roleHeader = request.headers['x-test-role'];
        const role = (Array.isArray(roleHeader) ? roleHeader[0] : roleHeader) ?? 'admin';
        if (userId) {
            request.principal = {
                kind: 'user',
                sessionId: 'session-test',
                user: {
                    id: userId,
                    role,
                    tier: 'operator',
                    tierExpiresAt: null,
                    status: 'active',
                },
            };
        }
    });
    registerAdminPortfolioRoutes(app);
    return app;
}
describe('Admin Portfolio Routes', () => {
    let app;
    beforeEach(async () => {
        app = await createTestApp();
    });
    describe('RBAC Guards', () => {
        it('refuses unauthenticated caller (403)', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/overview',
            });
            expect(res.statusCode).toBe(403);
        });
        it('refuses non-admin user (403)', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/overview',
                headers: {
                    'x-test-user': 'user-123',
                    'x-test-role': 'user',
                },
            });
            expect(res.statusCode).toBe(403);
        });
        it('admits admin user (200)', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/overview',
                headers: {
                    'x-test-user': 'admin-123',
                    'x-test-role': 'admin',
                },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.totalFleetAumUsd).toBe(25000);
            expect(body.fleetWinRatePct).toBe(72.5);
        });
    });
    describe('GET /v1/admin/portfolio/users', () => {
        it('returns paginated users with custody and subscriptions', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/users?page=1&limit=25',
                headers: {
                    'x-test-user': 'admin-123',
                    'x-test-role': 'admin',
                },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.users.length).toBe(1);
            expect(body.users[0].email).toBe('trader@wake.trade');
            expect(body.total).toBe(1);
        });
        it('validates invalid query parameters', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/users?tier=invalid_tier',
                headers: {
                    'x-test-user': 'admin-123',
                    'x-test-role': 'admin',
                },
            });
            expect(res.statusCode).toBe(400);
        });
    });
    describe('GET /v1/admin/portfolio/users/:userId', () => {
        it('returns 404 for non-existent user', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/users/not-found',
                headers: {
                    'x-test-user': 'admin-123',
                    'x-test-role': 'admin',
                },
            });
            expect(res.statusCode).toBe(404);
        });
        it('returns user drill-down data for valid user', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/users/valid-user-id',
                headers: {
                    'x-test-user': 'admin-123',
                    'x-test-role': 'admin',
                },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.user.id).toBe('valid-user-id');
        });
    });
    describe('GET /v1/admin/portfolio/masters', () => {
        it('returns master alpha leaderboard', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/masters',
                headers: {
                    'x-test-user': 'admin-123',
                    'x-test-role': 'admin',
                },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.masters.length).toBe(1);
            expect(body.masters[0].followerCap).toBe(50);
        });
    });
    describe('GET /v1/admin/portfolio/tokens', () => {
        it('returns token concentration list', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/tokens',
                headers: {
                    'x-test-user': 'admin-123',
                    'x-test-role': 'admin',
                },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.tokens.length).toBe(1);
            expect(body.tokens[0].tokenSymbol).toBe('SOL1');
        });
    });
    describe('GET /v1/admin/portfolio/export', () => {
        it('exports CSV with correct content headers', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/export?type=positions&format=csv',
                headers: {
                    'x-test-user': 'admin-123',
                    'x-test-role': 'admin',
                },
            });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.headers['content-disposition']).toContain('wake-positions-export.csv');
            expect(res.body).toContain('recordType,value');
        });
        it('exports JSON when format=json', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/admin/portfolio/export?type=users&format=json',
                headers: {
                    'x-test-user': 'admin-123',
                    'x-test-role': 'admin',
                },
            });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('application/json');
            expect(res.headers['content-disposition']).toContain('wake-users-export.json');
        });
    });
});
//# sourceMappingURL=admin-portfolio.test.js.map