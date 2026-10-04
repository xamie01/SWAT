import type { FastifyInstance } from 'fastify';
import {
  getLpPosition,
  listDiscoverPools,
  listLpPositions,
  queryLpWalletLeaderboard,
  setLpPositionAutoRebalance,
  transitionLpPosition,
  type UserScope
} from '@swat/db';
import type { LpChain } from '@swat/shared';
import { rankPoolsByVolumeToActiveLiquidity } from './scanner/ranking.js';
import { requireUser, registerLpAuth, type LpAuthOptions } from './auth.js';
import { buildPosition, type BuildPositionDeps, type BuildPositionResult } from './builder/build-position.js';
import { listStrategyTemplates, STRATEGY_TEMPLATE_NAMES, type StrategyTemplateName } from './builder/templates.js';
import type { LpStrategyType } from '@swat/db';

const STRATEGY_DISTRIBUTIONS: readonly LpStrategyType[] = ['spot', 'curve', 'bidask'];

/**
 * API / dashboard wiring (Track H) — five routes over the finished tracks:
 *
 *   1. `GET /v1/lp/discover`            — Track B+C output, paginated + sortable.
 *   2. `GET /v1/lp/wallets/leaderboard` — Track D output.
 *   3. `GET /v1/lp/positions`           — Track F output (open positions, live
 *                                         PnL inputs, rebalance flag).
 *   4. `GET /v1/lp/strategy-templates`  — Track E5 presets.
 *   5. `POST /v1/lp/positions/deploy`   — Track E6 behind Track G1.
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
  /** Test seam: override the entrypoint itself. */
  readonly build?: typeof buildPosition;
  /**
   * Track I: computes the read-only ladder preview with live context. Wired in
   * the service entry (it owns the context sources and the cache fallback);
   * tests stub it.
   */
  readonly livePreview: (input: {
    readonly chain: 'solana' | 'robinhood-chain';
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

    if (chain !== undefined && chain !== 'solana' && chain !== 'robinhood-chain') {
      return reply.code(400).send({ error: 'chain must be solana or robinhood-chain' });
    }
    if (!['volume', 'activeTvl', 'feeApr24h', 'ratio'].includes(sort)) {
      return reply.code(400).send({ error: 'sort must be volume, activeTvl, feeApr24h, or ratio' });
    }

    const pools = await listDiscoverPools({
      chain: chain as 'solana' | 'robinhood-chain' | undefined,
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

    if (chain !== undefined && chain !== 'solana' && chain !== 'robinhood-chain') {
      return reply.code(400).send({ error: 'chain must be solana or robinhood-chain' });
    }
    const entries = await queryLpWalletLeaderboard({
      chain: chain as 'solana' | 'robinhood-chain' | undefined,
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
    if (chain !== 'solana' && chain !== 'robinhood-chain') {
      return reply.code(400).send({ error: 'chain must be solana or robinhood-chain' });
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
        chain,
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
        return reply.code(400).send({ error: message });
      }
      throw error;
    }
  });

  // H5: Deploy-ladder action (E6 behind G1) — user-scoped, state-changing.
  app.post('/v1/lp/positions/deploy', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;

    const body = request.body as {
      chain?: string;
      poolAddress?: string;
      template?: string;
      custom?: {
        rangeLower?: number;
        rangeUpper?: number;
        rungCount?: number;
        distribution?: string;
      };
      depositAmount?: number;
      depositAsset?: string;
      /** Track I: opt this position into monitor-driven auto-rebalancing. */
      autoRebalance?: boolean;
    };

    if (!body.chain || !body.poolAddress || !body.depositAsset || !Number.isFinite(Number(body.depositAmount))) {
      return reply.code(400).send({ error: 'chain, poolAddress, depositAsset and depositAmount are required' });
    }
    if (body.chain !== 'solana' && body.chain !== 'robinhood-chain') {
      return reply.code(400).send({ error: 'chain must be solana or robinhood-chain' });
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

    if (body.template !== undefined && !(STRATEGY_TEMPLATE_NAMES as readonly string[]).includes(body.template)) {
      return reply.code(400).send({
        error: `unknown strategy template: ${body.template}`,
        known: STRATEGY_TEMPLATE_NAMES
      });
    }
    if (body.custom !== undefined) {
      const custom = body.custom;
      if (
        !Number.isFinite(Number(custom.rangeLower)) || Number(custom.rangeLower) <= 0
        || !Number.isFinite(Number(custom.rangeUpper)) || Number(custom.rangeUpper) <= Number(custom.rangeLower)
        || !Number.isInteger(Number(custom.rungCount)) || Number(custom.rungCount) < 1 || Number(custom.rungCount) > 64
        || !(STRATEGY_DISTRIBUTIONS as readonly string[]).includes(String(custom.distribution))
      ) {
        return reply.code(400).send({
          error: 'custom ladder needs rangeLower > 0, rangeUpper > rangeLower, integer rungCount in 1..64, and distribution spot|curve|bidask'
        });
      }
    }

    try {
      const result = await (deps.build ?? buildPosition)(deps, scope, {
        chain: body.chain,
        poolAddress: body.poolAddress,
        template: body.template as StrategyTemplateName | undefined,
        custom:
          body.custom
            ? {
                rangeLower: Number(body.custom.rangeLower),
                rangeUpper: Number(body.custom.rangeUpper),
                rungCount: Number(body.custom.rungCount),
                distribution: String(body.custom.distribution) as LpStrategyType
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
    } catch (error) {
      // Known validation failures map to 400; anything else bubbles to the
      // global handler so an internal error never leaks its message.
      if (error instanceof Error && (
        error.message.includes('must be') || error.message.includes('required')
        || error.message.includes('not in the scan cache') || error.message.includes('is off')
        || error.message.includes('not both')
      )) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  // Track I: manual rebalance trigger — the user IS the consent, so the
  // auto-rebalance opt-in does not apply here.
  app.post('/v1/lp/positions/:positionId/rebalance', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { positionId } = request.params as { positionId: string };

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
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : 'transition refused'
      });
    }
    return { queued: true, positionId, state: 'rebalancing' };
  });

  // Track I: auto-rebalance opt-in toggle.
  app.patch('/v1/lp/positions/:positionId/auto-rebalance', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { positionId } = request.params as { positionId: string };
    const body = request.body as { enabled?: boolean };
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
}

export { registerLpAuth, legacyKeyHash, type LpAuthOptions } from './auth.js';

export type { BuildPositionResult, UserScope };
