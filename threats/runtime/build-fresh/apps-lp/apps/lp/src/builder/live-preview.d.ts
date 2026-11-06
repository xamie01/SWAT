import type { LpChain } from '@swat/shared';
import type { LpStrategyType } from '@swat/db';
import { type LadderRung } from './ladder-plan.js';
import { type StrategyTemplateName } from './templates.js';
import type { MeteoraBin, TickBand } from '../scanner/active-tvl.js';
/**
 * The live ladder preview (Track I2) — a read-only calculator for the manual
 * position builder. Range + distribution + deposit in, per-rung allocation
 * out, anchored on the pool's LIVE context (bins/ticks fetched now, not the
 * scan cache). Nothing is persisted and nothing touches a chain beyond reads;
 * the confirm step is `buildPosition` (E6), which re-plans and persists.
 *
 * E5 flow change: the strategy-template resolver PRE-FILLS the builder — the
 * preview resolves a template into concrete params, the user may edit them,
 * and the confirm handler validates the edited params before E6 runs. The
 * preview output is shaped so the UI can round-trip it: send `params` back
 * (edited or not) as `custom` on POST /v1/lp/positions/deploy.
 */
/** Live pool context, fetched at preview time. */
export interface LivePoolContext {
    readonly chain: LpChain;
    /** Quote-per-base, right now. */
    readonly currentPrice: number;
    /**
     * Meteora: active bin id. Uniswap: current tick. `null` on the scan-cache
     * fallback — the cache carries no anchor observation, and a fabricated one
     * (0) would read as a real bin id / tick to any consumer.
     */
    readonly anchor: {
        readonly kind: 'bin';
        readonly activeBinId: number;
    } | {
        readonly kind: 'tick';
        readonly currentTick: number;
    } | null;
    /** Granularity the ladder will snap to. */
    readonly binStep: number | null;
    readonly tickSpacing: number | null;
    /** Bin liquidity around the anchor, when available. */
    readonly bins: readonly MeteoraBin[] | null;
    /** Tick-band liquidity around the anchor, when available. */
    readonly bands: readonly TickBand[] | null;
    readonly fetchedAt: Date;
    /** What could not be fetched live — surfaced, never swallowed. */
    readonly warnings: readonly string[];
}
export interface LivePreviewInput {
    readonly chain: LpChain;
    readonly protocol: 'meteora-dlmm' | 'uniswap-v3' | 'uniswap-v4';
    /** Chain-prefixed pool address. */
    readonly poolAddress: string;
    /** Template to pre-fill from, or explicit (possibly user-edited) params. */
    readonly template?: StrategyTemplateName;
    readonly custom?: {
        readonly rangeLower: number;
        readonly rangeUpper: number;
        readonly rungCount: number;
        readonly distribution: LpStrategyType;
    };
    readonly currentPrice: number;
    readonly depositAmount?: number;
    /** From the live context. */
    readonly binStep?: number | null;
    readonly tickSpacing?: number | null;
    readonly bins?: readonly MeteoraBin[] | null;
    readonly bands?: readonly TickBand[] | null;
    readonly warnings?: readonly string[];
}
export interface LivePreviewRung extends LadderRung {
    /** Share of the pool's live liquidity already sitting in this rung's range, 0..1. */
    readonly liveLiquidityShare: number | null;
}
export interface LivePreview {
    readonly chain: LpChain;
    readonly poolAddress: string;
    /** The resolved params — round-trip these as `custom` on confirm. */
    readonly params: {
        readonly rangeLower: number;
        readonly rangeUpper: number;
        readonly rungCount: number;
        readonly distribution: LpStrategyType;
    };
    readonly rungs: readonly LivePreviewRung[];
    readonly depositAmount: number | null;
    readonly source: 'template' | 'custom';
    readonly contextWarning: string | null;
}
export declare function buildLivePreview(input: LivePreviewInput): LivePreview;
//# sourceMappingURL=live-preview.d.ts.map