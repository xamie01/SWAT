import type { FastifyInstance } from 'fastify';
import {
  createLpCopySubscription,
  getLpPosition,
  listDiscoverPools,
  listLpCopyExecutions,
  listLpCopySubscriptions,
  listLpPositions,
  queryLpWalletLeaderboard,
  setLpPositionAutoRebalance,
  trackLpWallet,
  transitionLpPosition,
  untrackLpWallet,
  updateLpCopySubscriptionStatus,
  type LpCopySubscriptionStatus,
  type UserScope
} from '@swat/db';
import { isLpChain, type LpChain, type LpProtocol } from '@swat/shared';
import { rankPoolsByVolumeToActiveLiquidity } from './scanner/ranking.js';
import { rankHotNewLaunches } from './scanner/new-launches.js';
import { requireUser, registerLpAuth, type LpAuthOptions } from './auth.js';
import { buildExactPosition, buildPosition, type BuildPositionDeps, type BuildPositionResult } from './builder/build-position.js';
import { lpRaw, lpSnapshot, type LpExactAcquisitionRequest } from '@swat/db/dist/lp-exact.js';
import { listStrategyTemplates } from './builder/templates.js';
import type { LpStrategyType } from '@swat/db';

import { requestLpOperation, type LpOperationDeps } from './operations.js';
const STRATEGY_DISTRIBUTIONS: readonly LpStrategyType[] = ['spot', 'curve', 'bidask'];

/**
 * API / dashboard wiring (Track H + Track I) — the LP service's routes:
 *
 *   1. `GET  /v1/lp/discover`            — Track B+C output, paginated + sortable.
 *   2. `GET  /v1/lp/wallets/leaderboard` — Track D output.
 *   3. `GET  /v1/lp/positions`           — Track F output (open positions, live
 *                                          PnL inputs, rebalance flag).
 *   4. `GET  /v1/lp/strategy-templates`  — Track E5 presets.
 *   5. `POST /v1/lp/positions/deploy`    — Track E6 behind Track G1.
 *   6. `GET  /v1/lp/ladder-preview`      — Track I2 read-only live preview.
 *   7. `POST /v1/lp/positions/:id/rebalance`      — Track I manual trigger.
 *   8. `PATCH /v1/lp/positions/:id/auto-rebalance` — Track I opt-in toggle.
 *   9. `POST /v1/lp/positions/:id/close` — exit from every open state.
 *   10. `POST/DELETE /v1/lp/wallets`     — tracked-wallet on-ramp (service key).
 *
 * Static routes register before any parameterized ones (Fastify's match order),
 * the auth plugin registers before routes so `request.principal` is populated,
 * and every limit is clamped server-side.
 */

export type DiscoverSort = 'volume' | 'activeTvl' | 'feeApr24h' | 'ratio';

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function clampOffset(raw: unknown): number {
  const parsed = Number(raw ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

export type LpRoutesDeps = BuildPositionDeps & {
  readonly operations?: LpOperationDeps;
  /** Test seam: override the entrypoint itself. */
  readonly build?: typeof buildPosition;
  /**
   * Track I: computes the read-only ladder preview with live context. Wired in
   * the service entry (it owns the context sources and the cache fallback);
   * tests stub it.
   */
  readonly livePreview: (input: {
    readonly chain: LpChain;
    readonly poolAddress: string;
    readonly template?: string;
    readonly custom?: {
      readonly rangeLower: number;
      readonly rangeUpper: number;
      readonly rungCount: number;
      readonly distribution: string;
    };
    readonly depositAmount?: number;
  }) => Promise<unknown>;
  /** Track I: queues a manual rebalance job on the chain's execution queue. */
  readonly queueManualRebalance: (input: {
    readonly positionId: string;
    readonly chain: LpChain;
    readonly poolAddress: string;
  }) => Promise<void>;
};

export async function registerLpRoutes(app: FastifyInstance, deps: LpRoutesDeps): Promise<void> {
  // Health first — it is the only public path.
  app.get('/v1/health', async () => ({ status: 'ok', service: 'lp' }));

  // H1: Discover feed (B+C).
  app.get('/v1/lp/discover', async (request, reply) => {
    if (!request.principal) return reply.code(401).send({ error: 'Unauthorized' });
    const query = request.query as Record<string, unknown>;
    const chain = typeof query.chain === 'string' ? query.chain : undefined;
    const sort = (typeof query.sort === 'string' ? query.sort : 'volume') as DiscoverSort;
    const limit = clampLimit(query.limit, 50, 200);
    const offset = clampOffset(query.offset);

    if (chain !== undefined && !isLpChain(chain)) {
      return reply.code(400).send({ error: 'chain must be a supported LpChain' });
    }
    if (!['volume', 'activeTvl', 'feeApr24h', 'ratio'].includes(sort)) {
      return reply.code(400).send({ error: 'sort must be volume, activeTvl, feeApr24h, or ratio' });
    }

    const pools = await listDiscoverPools({
      chain: chain as LpChain | undefined,
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
    if (!request.principal) return reply.code(401).send({ error: 'Unauthorized' });
    const query = request.query as Record<string, unknown>;
    const chain = typeof query.chain === 'string' ? query.chain : undefined;
    const sort = query.sort === 'winRate' ? 'winRate' : 'pnl';
    const limit = clampLimit(query.limit, 25, 100);

    if (chain !== undefined && !isLpChain(chain)) {
      return reply.code(400).send({ error: 'chain must be a supported LpChain' });
    }
    const entries = await queryLpWalletLeaderboard({
      chain: chain as LpChain | undefined,
      sort,
      limit
    });
    return { entries, sort, limit };
  });

  // H3: Position manager (F) — user-scoped.
  app.get('/v1/lp/positions', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const query = request.query as Record<string, unknown>;
    const includeClosed = query.includeClosed === 'true';
    const positions = await listLpPositions(scope, { includeClosed, limit: 100 });

    // Rebalance-recommendation flag: the monitor already labels state, so the
    // recommendation is a pure read of it — no hidden recomputation here.
    return {
      positions: positions.map((position) => ({
        ...position,
        quantityCapability: 'legacy-numeric-observation-only',
        exactQuantity: null,
        legacyNumericDtoFractionalCapability: false,
        rebalanceRecommended: position.state === 'near_edge' || position.state === 'out_of_range'
      }))
    };
  });

  // H4: Strategy template list (E5).
  app.get('/v1/lp/strategy-templates', async (request, reply) => {
    if (!request.principal) return reply.code(401).send({ error: 'Unauthorized' });
    return { templates: listStrategyTemplates() };
  });

  // Track I2: read-only live preview. Static route — registered before the
  // parameterized /positions/:id routes below.
  app.get('/v1/lp/ladder-preview', async (request, reply) => {
    if (!request.principal) return reply.code(401).send({ error: 'Unauthorized' });
    const query = request.query as Record<string, unknown>;
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
    let custom: Parameters<LpRoutesDeps['livePreview']>[0]['custom'];
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
        chain: chain as LpChain,
        poolAddress,
        template,
        custom,
        depositAmount
      });
      return preview;
    } catch (error) {
      // Validation errors (template unknown, params out of range) are client
      // errors; live-context failures bubble to the global handler as 500.
      const message = error instanceof Error ? error.message : String(error);
      if (/must be|required|unknown strategy template|not both|binStep|tickSpacing/.test(message)) {
        return reply.code(400).send({ error: 'Invalid LP request', requestId: request.id });
      }
      throw error;
    }
  });

  const keysOnly = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
  const exactBody = (value: unknown): value is LpExactAcquisitionRequest => {
    if (!keysOnly(value, ['operationKey', 'chain', 'poolAddress', 'depositAsset', 'deposit', 'strategy', 'autoRebalance'])) return false;
    if (typeof value.operationKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.operationKey)
        || typeof value.chain !== 'string' || !isLpChain(value.chain) || typeof value.poolAddress !== 'string'
        || !value.poolAddress.startsWith(`${value.chain}:`) || typeof value.depositAsset !== 'string'
        || !value.depositAsset.startsWith(`${value.chain}:`) || !keysOnly(value.deposit, ['raw', 'scale'])
        || typeof value.deposit.raw !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value.deposit.raw)
        || !Number.isInteger(value.deposit.scale) || Number(value.deposit.scale) < 0 || Number(value.deposit.scale) > 30
        || !keysOnly(value.strategy, ['rangeLower', 'rangeUpper', 'rungCount', 'distribution'])
        || typeof value.strategy.rangeLower !== 'number' || !Number.isFinite(value.strategy.rangeLower) || value.strategy.rangeLower <= 0
        || typeof value.strategy.rangeUpper !== 'number' || !Number.isFinite(value.strategy.rangeUpper) || value.strategy.rangeUpper <= value.strategy.rangeLower
        || !Number.isInteger(value.strategy.rungCount) || Number(value.strategy.rungCount) < 1 || Number(value.strategy.rungCount) > 64
        || !STRATEGY_DISTRIBUTIONS.includes(value.strategy.distribution as LpStrategyType)
        || value.autoRebalance !== undefined && typeof value.autoRebalance !== 'boolean') return false;
    try { lpRaw({ raw: value.deposit.raw, scale: Number(value.deposit.scale) }, true); } catch { return false; }
    return true;
  };
  app.get('/v1/lp/capabilities', async (request, reply) => {
    if (!request.principal) return reply.code(401).send({ error: 'Unauthorized' });
    return deps.exactPaper?.capabilities() ?? { sourceImplemented: true, injectedPortsConfigured: false, runtimeAccepted: false,
      liveCapabilityAccepted: false, fractionalRawscaleDto: true, legacyNumericDtoFractionalCapability: false,
      reason: 'trusted exact quote/receipt protocol provider unavailable' };
  });
  app.post('/v1/lp/positions/deploy-exact', async (request, reply) => {
    const scope = requireUser(request, reply); if (!scope) return;
    if (!exactBody(request.body)) return reply.code(400).send({ error: 'exact rawscale acquisition DTO required' });
    if (!deps.exactPaper) return reply.code(503).send({ error: 'LP exact quote/receipt capability unavailable' });
    try {
      const position = await buildExactPosition(deps, scope, lpSnapshot(request.body));
      return { positionId: position.id, position, mode: 'paper', broadcast: false, capabilities: deps.exactPaper.capabilities() };
    } catch { return reply.code(409).send({ error: 'LP exact acquisition refused', requestId: request.id }); }
  });
  app.get('/v1/lp/positions/:positionId/exact', async (request, reply) => {
    const scope = requireUser(request, reply); if (!scope) return;
    if (!deps.exactPaper) return reply.code(503).send({ error: 'LP exact read capability unavailable' });
    const { positionId } = request.params as { positionId: string };
    const position = await deps.exactPaper.position(scope, positionId);
    if (!position) return reply.code(404).send({ error: 'position not found' });
    return { position, capabilities: deps.exactPaper.capabilities() };
  });
  app.get('/v1/lp/operations/:operationId', async (request, reply) => {
    const scope = requireUser(request, reply); if (!scope) return;
    if (!deps.operations?.exactPaper) return reply.code(503).send({ error: 'LP exact operation read capability unavailable' });
    const { operationId } = request.params as { operationId: string };
    const operation = await deps.operations.exactPaper.operation(scope, operationId);
    if (!operation) return reply.code(404).send({ error: 'operation not found' });
    return { operation, broadcast: false };
  });
  app.post('/v1/lp/copy/mint-exact', async (request, reply) => {
    const scope = requireUser(request, reply); if (!scope) return;
    const body = request.body;
    if (!keysOnly(body, ['subscriptionId', 'eventId', 'assetScale']) || typeof body.subscriptionId !== 'string'
        || typeof body.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.eventId)
        || !Number.isInteger(body.assetScale) || Number(body.assetScale) < 0 || Number(body.assetScale) > 30) return reply.code(400).send({ error: 'exact canonical copy identity required' });
    if (!deps.exactPaper) return reply.code(503).send({ error: 'LP canonical copy capability unavailable' });
    try {
      const position = await deps.exactPaper.copyMint(scope, { subscriptionId: body.subscriptionId, eventId: body.eventId, assetScale: Number(body.assetScale) });
      return { position, mode: 'paper', broadcast: false, capabilities: deps.exactPaper.capabilities() };
    } catch { return reply.code(409).send({ error: 'LP canonical copy refused', requestId: request.id }); }
  });

  // Legacy numeric admission is explicitly unavailable; it cannot preserve fractional raw quantities.
  app.post('/v1/lp/positions/deploy', async (request, reply) => {
    const scope = requireUser(request, reply); if (!scope) return;
    return reply.code(503).send({ error: 'LP legacy numeric acquisition unavailable; use exact rawscale DTO' });
  });

  // Track I: manual rebalance trigger — the user IS the consent, so the
  // auto-rebalance opt-in does not apply here.
  app.post('/v1/lp/positions/:positionId/rebalance', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { positionId } = request.params as { positionId: string };

    if (!deps.operations?.exactPaper) return reply.code(503).send({ error: 'LP exact durable receipt operations unavailable' });
    const body = request.body;
    if (!keysOnly(body, ['operationKey']) || typeof body.operationKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.operationKey)) return reply.code(400).send({ error: 'operationKey required' });
    const key = body.operationKey;
    try {
      return await requestLpOperation(deps.operations, scope, { positionId, operationKey: key, kind: 'rebalance' });
    } catch {
      return reply.code(409).send({ error: 'LP operation refused', requestId: request.id });
    }
  });

  // Track I: auto-rebalance opt-in toggle.
  app.patch('/v1/lp/positions/:positionId/auto-rebalance', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { positionId } = request.params as { positionId: string };
    const body = request.body;
    if (!keysOnly(body, ['enabled']) || typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled (boolean) is required' });
    }

    const position = await getLpPosition(scope, positionId);
    if (!position) {
      return reply.code(404).send({ error: 'position not found' });
    }
    await setLpPositionAutoRebalance(scope, positionId, body.enabled);
    return { positionId, autoRebalance: body.enabled };
  });

  // Close admission never closes financial state. Only a durable bound paper receipt can settle zero inventory.
  // No reserve sweep is inferred from a client gain or a projection.
  app.post('/v1/lp/positions/:positionId/close', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { positionId } = request.params as { positionId: string };

    if (!deps.operations?.exactPaper) return reply.code(503).send({ error: 'LP exact durable receipt operations unavailable' });
    const body = request.body;
    if (!keysOnly(body, ['operationKey']) || typeof body.operationKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.operationKey)) return reply.code(400).send({ error: 'operationKey required' });
    const key = body.operationKey;
    try {
      return await requestLpOperation(deps.operations, scope, { positionId, operationKey: key, kind: 'close' });
    } catch {
      return reply.code(409).send({ error: 'LP operation refused', requestId: request.id });
    }
  });

  // Tracked-wallet on-ramp (Track D). Tracked wallets are external addresses,
  // not tenants — the leaderboard is platform data — so these are
  // service-key-only routes and never accept a user session.
  app.post('/v1/lp/wallets', async (request, reply) => {
    if (request.principal?.kind !== 'service') {
      return reply.code(403).send({ error: 'service key required' });
    }
    const body = request.body as {
      chain?: string;
      walletAddress?: string;
      label?: string;
      pollingCadenceSeconds?: number;
    };
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
    const query = request.query as Record<string, unknown>;
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
    if (!request.principal) return reply.code(401).send({ error: 'Unauthorized' });
    const query = request.query as Record<string, unknown>;
    const chain = typeof query.chain === 'string' ? query.chain : undefined;
    if (chain !== undefined && !isLpChain(chain)) {
      return reply.code(400).send({ error: 'chain must be a supported LpChain' });
    }
    const pools = await listDiscoverPools({
      chain: chain as LpChain | undefined,
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
    if (!scope) return;
    const body = request.body as {
      masterWalletAddress?: string;
      chain?: string;
      venue?: string;
      allocatedBudgetUsd?: number;
      maxCapitalPerPositionUsd?: number;
    };
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
      // Subscriptions are tenant data; only the service-key routes may manage
      // the platform wallet registry. Discovery onboarding needs its own proof.
      const subscription = await createLpCopySubscription(scope, {
        masterWalletAddress: body.masterWalletAddress,
        chain: body.chain as LpChain,
        venue: body.venue as LpProtocol,
        allocatedBudgetUsd: Number(body.allocatedBudgetUsd),
        maxCapitalPerPositionUsd: Number(body.maxCapitalPerPositionUsd)
      });
      return subscription;
    } catch (error) {
      return reply.code(400).send({ error: 'failed to create subscription', requestId: request.id });
    }
  });

  app.get('/v1/lp/copy/subscriptions', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const query = request.query as Record<string, unknown>;
    const status = typeof query.status === 'string' ? (query.status as LpCopySubscriptionStatus) : undefined;
    const subscriptions = await listLpCopySubscriptions(scope, status);
    return { subscriptions };
  });

  app.patch('/v1/lp/copy/subscriptions/:subscriptionId', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { subscriptionId } = request.params as { subscriptionId: string };
    const body = request.body as { status?: string };
    if (!body.status || !['active', 'paused', 'closed'].includes(body.status)) {
      return reply.code(400).send({ error: 'status must be active, paused, or closed' });
    }
    const updated = await updateLpCopySubscriptionStatus(scope, subscriptionId, body.status as LpCopySubscriptionStatus);
    if (!updated) return reply.code(404).send({ error: 'subscription not found' });
    return updated;
  });

  app.delete('/v1/lp/copy/subscriptions/:subscriptionId', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { subscriptionId } = request.params as { subscriptionId: string };
    const updated = await updateLpCopySubscriptionStatus(scope, subscriptionId, 'closed');
    if (!updated) return reply.code(404).send({ error: 'subscription not found' });
    return { ok: true, subscription: updated };
  });

  app.get('/v1/lp/copy/executions', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const query = request.query as Record<string, unknown>;
    const subscriptionId = typeof query.subscriptionId === 'string' ? query.subscriptionId : undefined;
    const executions = await listLpCopyExecutions(scope, subscriptionId);
    return { executions };
  });
}

export { registerLpAuth, legacyKeyHash, type LpAuthOptions } from './auth.js';

export type { BuildPositionResult, UserScope };
