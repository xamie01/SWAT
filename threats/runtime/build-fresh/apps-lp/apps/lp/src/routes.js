import { createLpCopySubscription, getLpPosition, listDiscoverPools, listLpCopyExecutions, listLpCopySubscriptions, listLpPositions, queryLpWalletLeaderboard, setLpPositionAutoRebalance, trackLpWallet, transitionLpPosition, untrackLpWallet, updateLpCopySubscriptionStatus } from '@swat/db';
import { isLpChain } from '@swat/shared';
import { rankPoolsByVolumeToActiveLiquidity } from './scanner/ranking.js';
import { rankHotNewLaunches } from './scanner/new-launches.js';
import { requireUser } from './auth.js';
import { buildPosition } from './builder/build-position.js';
import { listStrategyTemplates, STRATEGY_TEMPLATE_NAMES } from './builder/templates.js';
const STRATEGY_DISTRIBUTIONS = ['spot', 'curve', 'bidask'];
function clampLimit(raw, fallback, max) {
    const parsed = Number(raw ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 1)
        return fallback;
    return Math.min(parsed, max);
}
function clampOffset(raw) {
    const parsed = Number(raw ?? 0);
    if (!Number.isInteger(parsed) || parsed < 0)
        return 0;
    return parsed;
}
export async function registerLpRoutes(app, deps) {
    // Health first — it is the only public path.
    app.get('/v1/health', async () => ({ status: 'ok', service: 'lp' }));
    // H1: Discover feed (B+C).
    app.get('/v1/lp/discover', async (request, reply) => {
        if (!request.principal)
            return reply.code(401).send({ error: 'Unauthorized' });
        const query = request.query;
        const chain = typeof query.chain === 'string' ? query.chain : undefined;
        const sort = (typeof query.sort === 'string' ? query.sort : 'volume');
        const limit = clampLimit(query.limit, 50, 200);
        const offset = clampOffset(query.offset);
        if (chain !== undefined && !isLpChain(chain)) {
            return reply.code(400).send({ error: 'chain must be a supported LpChain' });
        }
        if (!['volume', 'activeTvl', 'feeApr24h', 'ratio'].includes(sort)) {
            return reply.code(400).send({ error: 'sort must be volume, activeTvl, feeApr24h, or ratio' });
        }
        const pools = await listDiscoverPools({
            chain: chain,
            // ratio is a pure post-query sort over the same stored columns.
            sort: sort === 'ratio' ? 'volume' : sort,
            limit,
            offset
        });
        const ranked = sort === 'ratio' ? rankPoolsByVolumeToActiveLiquidity(pools) : pools;
        return { pools: ranked, sort, limit, offset };
    });
    // H2: LP Wallets leaderboard (D).
    app.get('/v1/lp/wallets/leaderboard', async (request, reply) => {
        if (!request.principal)
            return reply.code(401).send({ error: 'Unauthorized' });
        const query = request.query;
        const chain = typeof query.chain === 'string' ? query.chain : undefined;
        const sort = query.sort === 'winRate' ? 'winRate' : 'pnl';
        const limit = clampLimit(query.limit, 25, 100);
        if (chain !== undefined && !isLpChain(chain)) {
            return reply.code(400).send({ error: 'chain must be a supported LpChain' });
        }
        const entries = await queryLpWalletLeaderboard({
            chain: chain,
            sort,
            limit
        });
        return { entries, sort, limit };
    });
    // H3: Position manager (F) — user-scoped.
    app.get('/v1/lp/positions', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const query = request.query;
        const includeClosed = query.includeClosed === 'true';
        const positions = await listLpPositions(scope, { includeClosed, limit: 100 });
        // Rebalance-recommendation flag: the monitor already labels state, so the
        // recommendation is a pure read of it — no hidden recomputation here.
        return {
            positions: positions.map((position) => ({
                ...position,
                rebalanceRecommended: position.state === 'near_edge' || position.state === 'out_of_range'
            }))
        };
    });
    // H4: Strategy template list (E5).
    app.get('/v1/lp/strategy-templates', async (request, reply) => {
        if (!request.principal)
            return reply.code(401).send({ error: 'Unauthorized' });
        return { templates: listStrategyTemplates() };
    });
    // Track I2: read-only live preview. Static route — registered before the
    // parameterized /positions/:id routes below.
    app.get('/v1/lp/ladder-preview', async (request, reply) => {
        if (!request.principal)
            return reply.code(401).send({ error: 'Unauthorized' });
        const query = request.query;
        const chain = typeof query.chain === 'string' ? query.chain : undefined;
        const poolAddress = typeof query.poolAddress === 'string' ? query.poolAddress : undefined;
        if (!chain || !poolAddress) {
            return reply.code(400).send({ error: 'chain and poolAddress are required' });
        }
        if (!isLpChain(chain)) {
            return reply.code(400).send({ error: 'chain must be a supported LpChain' });
        }
        if (!poolAddress.startsWith(`${chain}:`)) {
            return reply.code(400).send({ error: 'poolAddress must be chain-prefixed' });
        }
        const template = typeof query.template === 'string' ? query.template : undefined;
        const hasCustom = query.rangeLower !== undefined || query.distribution !== undefined;
        if (!template && !hasCustom) {
            return reply.code(400).send({ error: 'a strategy template or custom ladder params is required' });
        }
        let custom;
        if (hasCustom) {
            custom = {
                rangeLower: Number(query.rangeLower),
                rangeUpper: Number(query.rangeUpper),
                rungCount: Number(query.rungCount),
                distribution: String(query.distribution ?? '')
            };
        }
        const depositAmount = query.depositAmount === undefined ? undefined : Number(query.depositAmount);
        try {
            const preview = await deps.livePreview({
                chain: chain,
                poolAddress,
                template,
                custom,
                depositAmount
            });
            return preview;
        }
        catch (error) {
            // Validation errors (template unknown, params out of range) are client
            // errors; live-context failures bubble to the global handler as 500.
            const message = error instanceof Error ? error.message : String(error);
            if (/must be|required|unknown strategy template|not both|binStep|tickSpacing/.test(message)) {
                return reply.code(400).send({ error: message });
            }
            throw error;
        }
    });
    // H5: Deploy-ladder action (E6 behind G1) — user-scoped, state-changing.
    app.post('/v1/lp/positions/deploy', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const body = request.body;
        if (!body.chain || !body.poolAddress || !body.depositAsset || !Number.isFinite(Number(body.depositAmount))) {
            return reply.code(400).send({ error: 'chain, poolAddress, depositAsset and depositAmount are required' });
        }
        if (!isLpChain(body.chain)) {
            return reply.code(400).send({ error: 'chain must be a supported LpChain' });
        }
        if (!body.poolAddress.startsWith(`${body.chain}:`)) {
            return reply.code(400).send({ error: 'poolAddress and depositAsset must be chain-prefixed' });
        }
        if (!body.depositAsset.startsWith(`${body.chain}:`)) {
            return reply.code(400).send({ error: 'poolAddress and depositAsset must be chain-prefixed' });
        }
        if (!body.template && !body.custom) {
            return reply.code(400).send({ error: 'a strategy template or custom ladder params is required' });
        }
        if (body.template !== undefined && !STRATEGY_TEMPLATE_NAMES.includes(body.template)) {
            return reply.code(400).send({
                error: `unknown strategy template: ${body.template}`,
                known: STRATEGY_TEMPLATE_NAMES
            });
        }
        if (body.custom !== undefined) {
            const custom = body.custom;
            if (!Number.isFinite(Number(custom.rangeLower)) || Number(custom.rangeLower) <= 0
                || !Number.isFinite(Number(custom.rangeUpper)) || Number(custom.rangeUpper) <= Number(custom.rangeLower)
                || !Number.isInteger(Number(custom.rungCount)) || Number(custom.rungCount) < 1 || Number(custom.rungCount) > 64
                || !STRATEGY_DISTRIBUTIONS.includes(String(custom.distribution))) {
                return reply.code(400).send({
                    error: 'custom ladder needs rangeLower > 0, rangeUpper > rangeLower, integer rungCount in 1..64, and distribution spot|curve|bidask'
                });
            }
        }
        try {
            const result = await (deps.build ?? buildPosition)(deps, scope, {
                chain: body.chain,
                poolAddress: body.poolAddress,
                template: body.template,
                custom: body.custom
                    ? {
                        rangeLower: Number(body.custom.rangeLower),
                        rangeUpper: Number(body.custom.rangeUpper),
                        rungCount: Number(body.custom.rungCount),
                        distribution: String(body.custom.distribution)
                    }
                    : undefined,
                depositAmount: Number(body.depositAmount),
                depositAsset: body.depositAsset,
                autoRebalance: body.autoRebalance === true
            });
            if (result.rejectionReasons.length > 0) {
                // A guard refusal is 403 with reasons — the client shows the caps, not
                // a generic error.
                return reply.code(403).send({ error: 'Deploy blocked by guardrails', reasons: result.rejectionReasons });
            }
            return result;
        }
        catch (error) {
            // Known validation failures map to 400; anything else bubbles to the
            // global handler so an internal error never leaks its message.
            if (error instanceof Error && (error.message.includes('must be') || error.message.includes('required')
                || error.message.includes('not in the scan cache') || error.message.includes('is off')
                || error.message.includes('not both') || error.message.includes('no current price')
                || error.message.includes('chain-prefixed'))) {
                return reply.code(400).send({ error: error.message });
            }
            throw error;
        }
    });
    // Track I: manual rebalance trigger — the user IS the consent, so the
    // auto-rebalance opt-in does not apply here.
    app.post('/v1/lp/positions/:positionId/rebalance', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const { positionId } = request.params;
        const position = await getLpPosition(scope, positionId);
        if (!position) {
            return reply.code(404).send({ error: 'position not found' });
        }
        if (position.state === 'building') {
            return reply.code(409).send({ error: 'position is still building; nothing to rebalance yet' });
        }
        if (position.state === 'closed') {
            return reply.code(409).send({ error: 'position is closed' });
        }
        await deps.queueManualRebalance({
            positionId: position.id,
            chain: position.chain,
            poolAddress: position.poolAddress
        });
        // Transition after the job is queued: a refusal here (racing a close)
        // leaves a queued job that no-ops on a closed position, never a position
        // stuck in `rebalancing` with no work behind it.
        try {
            await transitionLpPosition(scope, positionId, {
                toState: 'rebalancing',
                reason: 'manual rebalance trigger (Track I)'
            });
        }
        catch (error) {
            return reply.code(409).send({
                error: error instanceof Error ? error.message : 'transition refused'
            });
        }
        return { queued: true, positionId, state: 'rebalancing' };
    });
    // Track I: auto-rebalance opt-in toggle.
    app.patch('/v1/lp/positions/:positionId/auto-rebalance', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const { positionId } = request.params;
        const body = request.body;
        if (typeof body.enabled !== 'boolean') {
            return reply.code(400).send({ error: 'enabled (boolean) is required' });
        }
        const position = await getLpPosition(scope, positionId);
        if (!position) {
            return reply.code(404).send({ error: 'position not found' });
        }
        await setLpPositionAutoRebalance(scope, positionId, body.enabled);
        return { positionId, autoRebalance: body.enabled };
    });
    // Close a position. The state machine allows every open state -> closed
    // (including `building`, so a stuck or unwanted build has an exit). The
    // profit-bank sweep (G2) is deliberately NOT invoked here: it needs a
    // realized-gain valuation from live position reads, which paper mode does
    // not have — wiring it to a client-supplied gain would trust the caller to
    // price its own sweep.
    app.post('/v1/lp/positions/:positionId/close', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const { positionId } = request.params;
        const position = await getLpPosition(scope, positionId);
        if (!position) {
            return reply.code(404).send({ error: 'position not found' });
        }
        if (position.state === 'closed') {
            return reply.code(409).send({ error: 'position is already closed' });
        }
        try {
            await transitionLpPosition(scope, positionId, {
                toState: 'closed',
                reason: 'user close (dashboard)'
            });
        }
        catch (error) {
            return reply.code(409).send({
                error: error instanceof Error ? error.message : 'transition refused'
            });
        }
        return { positionId, state: 'closed' };
    });
    // Tracked-wallet on-ramp (Track D). Tracked wallets are external addresses,
    // not tenants — the leaderboard is platform data — so these are
    // service-key-only routes and never accept a user session.
    app.post('/v1/lp/wallets', async (request, reply) => {
        if (request.principal?.kind !== 'service') {
            return reply.code(403).send({ error: 'service key required' });
        }
        const body = request.body;
        if (!body.chain || !isLpChain(body.chain)) {
            return reply.code(400).send({ error: 'chain must be a supported LpChain' });
        }
        if (!body.walletAddress || !body.walletAddress.startsWith(`${body.chain}:`)) {
            return reply.code(400).send({ error: 'walletAddress must be chain-prefixed' });
        }
        const wallet = await trackLpWallet({
            chain: body.chain,
            walletAddress: body.walletAddress,
            label: body.label ?? null,
            pollingCadenceSeconds: body.pollingCadenceSeconds
        });
        return wallet;
    });
    app.delete('/v1/lp/wallets', async (request, reply) => {
        if (request.principal?.kind !== 'service') {
            return reply.code(403).send({ error: 'service key required' });
        }
        const query = request.query;
        const chain = typeof query.chain === 'string' ? query.chain : undefined;
        const walletAddress = typeof query.walletAddress === 'string' ? query.walletAddress : undefined;
        if (!chain || !isLpChain(chain)) {
            return reply.code(400).send({ error: 'chain must be a supported LpChain' });
        }
        if (!walletAddress || !walletAddress.startsWith(`${chain}:`)) {
            return reply.code(400).send({ error: 'walletAddress must be chain-prefixed' });
        }
        const removed = await untrackLpWallet(chain, walletAddress);
        return { removed };
    });
    // Track 3: Hot New Launches Feed (Rug Shield Audited)
    app.get('/v1/lp/new-launches', async (request, reply) => {
        if (!request.principal)
            return reply.code(401).send({ error: 'Unauthorized' });
        const query = request.query;
        const chain = typeof query.chain === 'string' ? query.chain : undefined;
        if (chain !== undefined && !isLpChain(chain)) {
            return reply.code(400).send({ error: 'chain must be a supported LpChain' });
        }
        const pools = await listDiscoverPools({
            chain: chain,
            sort: 'volume',
            limit: 100,
            offset: 0
        });
        const newLaunches = rankHotNewLaunches(pools);
        return { newLaunches, count: newLaunches.length };
    });
    // Track 2: LP Copy-Trading Subscriptions
    app.post('/v1/lp/copy/subscribe', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const body = request.body;
        if (!body.masterWalletAddress || !body.chain || !body.venue || !body.allocatedBudgetUsd || !body.maxCapitalPerPositionUsd) {
            return reply.code(400).send({ error: 'masterWalletAddress, chain, venue, allocatedBudgetUsd, and maxCapitalPerPositionUsd are required' });
        }
        if (!isLpChain(body.chain)) {
            return reply.code(400).send({ error: `unsupported chain: ${body.chain}` });
        }
        if (!body.masterWalletAddress.startsWith(`${body.chain}:`)) {
            return reply.code(400).send({ error: 'masterWalletAddress must be chain-prefixed' });
        }
        if (Number(body.allocatedBudgetUsd) <= 0 || Number(body.maxCapitalPerPositionUsd) <= 0) {
            return reply.code(400).send({ error: 'budget and max capital must be strictly positive' });
        }
        try {
            try {
                await trackLpWallet({
                    chain: body.chain,
                    walletAddress: body.masterWalletAddress,
                    label: 'Copied LP Master'
                });
            }
            catch {
                // Best-effort if already tracked or duplicate
            }
            const subscription = await createLpCopySubscription(scope, {
                masterWalletAddress: body.masterWalletAddress,
                chain: body.chain,
                venue: body.venue,
                allocatedBudgetUsd: Number(body.allocatedBudgetUsd),
                maxCapitalPerPositionUsd: Number(body.maxCapitalPerPositionUsd)
            });
            return subscription;
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : 'failed to create subscription' });
        }
    });
    app.get('/v1/lp/copy/subscriptions', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const query = request.query;
        const status = typeof query.status === 'string' ? query.status : undefined;
        const subscriptions = await listLpCopySubscriptions(scope, status);
        return { subscriptions };
    });
    app.patch('/v1/lp/copy/subscriptions/:subscriptionId', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const { subscriptionId } = request.params;
        const body = request.body;
        if (!body.status || !['active', 'paused', 'closed'].includes(body.status)) {
            return reply.code(400).send({ error: 'status must be active, paused, or closed' });
        }
        const updated = await updateLpCopySubscriptionStatus(scope, subscriptionId, body.status);
        if (!updated)
            return reply.code(404).send({ error: 'subscription not found' });
        return updated;
    });
    app.delete('/v1/lp/copy/subscriptions/:subscriptionId', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const { subscriptionId } = request.params;
        const updated = await updateLpCopySubscriptionStatus(scope, subscriptionId, 'closed');
        if (!updated)
            return reply.code(404).send({ error: 'subscription not found' });
        return { ok: true, subscription: updated };
    });
    app.get('/v1/lp/copy/executions', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const query = request.query;
        const subscriptionId = typeof query.subscriptionId === 'string' ? query.subscriptionId : undefined;
        const executions = await listLpCopyExecutions(scope, subscriptionId);
        return { executions };
    });
}
export { registerLpAuth, legacyKeyHash } from './auth.js';
//# sourceMappingURL=routes.js.map