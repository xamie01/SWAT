import { z } from 'zod';
import { getAdminPortfolioOverview, getAdminPortfolioUsers, getAdminPortfolioUserDetail, getAdminPortfolioMasters, getAdminPortfolioTokens, getAdminPortfolioExportData, } from '@swat/db';
import { requireRole } from '../auth/plugin.js';
const listUsersQuerySchema = z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    search: z.string().trim().max(100).optional(),
    tier: z.enum(['free', 'operator', 'ultra', 'lifetime']).optional(),
});
const exportQuerySchema = z.object({
    type: z.enum(['users', 'positions', 'executions', 'masters']),
    format: z.enum(['csv', 'json']).optional().default('csv'),
});
function toCsv(rows) {
    if (rows.length === 0)
        return '';
    const headers = Object.keys(rows[0]);
    const headerLine = headers.join(',');
    const lines = rows.map((row) => headers
        .map((header) => {
        const val = row[header];
        if (val === null || val === undefined)
            return '';
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    })
        .join(','));
    return [headerLine, ...lines].join('\n');
}
export function registerAdminPortfolioRoutes(app) {
    /**
     * GET /v1/admin/portfolio/overview
     * Fleet-wide KPIs: AUM, Net Realized PnL, 24h PnL, Win Rate %, Gas Burn, Active Copiers.
     */
    app.get('/v1/admin/portfolio/overview', async (request, reply) => {
        if (!requireRole(request, reply, 'admin'))
            return;
        const overview = await getAdminPortfolioOverview();
        return overview;
    });
    /**
     * GET /v1/admin/portfolio/users
     * Multi-tenant user directory matrix: balances, open positions, copied masters, custody.
     */
    app.get('/v1/admin/portfolio/users', async (request, reply) => {
        if (!requireRole(request, reply, 'admin'))
            return;
        const parsed = listUsersQuerySchema.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid query parameters' });
        }
        const result = await getAdminPortfolioUsers(undefined, parsed.data);
        return {
            users: result.users,
            total: result.total,
            page: parsed.data.page,
            limit: parsed.data.limit,
        };
    });
    /**
     * GET /v1/admin/portfolio/users/:userId
     * Single-user portfolio drilldown with balances, positions, subscriptions, and trade ledger.
     */
    app.get('/v1/admin/portfolio/users/:userId', async (request, reply) => {
        if (!requireRole(request, reply, 'admin'))
            return;
        const { userId } = request.params;
        const detail = await getAdminPortfolioUserDetail(undefined, userId);
        if (!detail) {
            return reply.code(404).send({ error: 'User not found' });
        }
        return detail;
    });
    /**
     * GET /v1/admin/portfolio/masters
     * Master alpha and follower profitability board.
     */
    app.get('/v1/admin/portfolio/masters', async (request, reply) => {
        if (!requireRole(request, reply, 'admin'))
            return;
        const masters = await getAdminPortfolioMasters();
        return { masters };
    });
    /**
     * GET /v1/admin/portfolio/tokens
     * Fleet token concentration heatmap across all open user positions.
     */
    app.get('/v1/admin/portfolio/tokens', async (request, reply) => {
        if (!requireRole(request, reply, 'admin'))
            return;
        const tokens = await getAdminPortfolioTokens();
        return { tokens };
    });
    /**
     * GET /v1/admin/portfolio/export
     * Platform data export streaming CSV or JSON for compliance and reporting.
     */
    app.get('/v1/admin/portfolio/export', async (request, reply) => {
        if (!requireRole(request, reply, 'admin'))
            return;
        const parsed = exportQuerySchema.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid export query' });
        }
        const { type, format } = parsed.data;
        const data = await getAdminPortfolioExportData(undefined, type);
        if (format === 'json') {
            reply.header('Content-Type', 'application/json');
            reply.header('Content-Disposition', `attachment; filename="wake-${type}-export.json"`);
            return data;
        }
        const csv = toCsv(data);
        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="wake-${type}-export.csv"`);
        return reply.send(csv);
    });
}
//# sourceMappingURL=admin-portfolio.js.map