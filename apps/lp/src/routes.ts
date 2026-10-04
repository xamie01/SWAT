import type { FastifyInstance } from 'fastify';
import {
  listDiscoverPools,
  listLpPositions,
  queryLpWalletLeaderboard,
  type UserScope
} from '@swat/db';
import { rankPoolsByVolumeToActiveLiquidity } from './scanner/ranking.js';
import { requireUser, registerLpAuth, type LpAuthOptions } from './auth.js';
import { buildPosition, type BuildPositionDeps, type BuildPositionResult } from './builder/build-position.js';
import { listStrategyTemplates } from './builder/templates.js';

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

    try {
      const result = await (deps.build ?? buildPosition)(deps, scope, {
        chain: body.chain,
        poolAddress: body.poolAddress,
        template: body.template as never,
        custom:
          body.custom
            ? {
                rangeLower: Number(body.custom.rangeLower),
                rangeUpper: Number(body.custom.rangeUpper),
                rungCount: Number(body.custom.rungCount),
                distribution: body.custom.distribution as never
              }
            : undefined,
        depositAmount: Number(body.depositAmount),
        depositAsset: body.depositAsset
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
}

export { registerLpAuth, legacyKeyHash, type LpAuthOptions } from './auth.js';

export type { BuildPositionResult, UserScope };
