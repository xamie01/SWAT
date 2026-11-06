import type { FastifyInstance } from 'fastify';
import { type UserScope } from '@swat/db';
import { type LpChain } from '@swat/shared';
import { buildPosition, type BuildPositionDeps, type BuildPositionResult } from './builder/build-position.js';
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
export type LpRoutesDeps = BuildPositionDeps & {
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
export declare function registerLpRoutes(app: FastifyInstance, deps: LpRoutesDeps): Promise<void>;
export { registerLpAuth, legacyKeyHash, type LpAuthOptions } from './auth.js';
export type { BuildPositionResult, UserScope };
//# sourceMappingURL=routes.d.ts.map