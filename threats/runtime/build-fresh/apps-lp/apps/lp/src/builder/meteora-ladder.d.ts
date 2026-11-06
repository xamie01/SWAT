import type { LpStrategyType } from '@swat/db';
import type { LadderPlan, LadderRung } from './ladder-plan.js';
/**
 * Meteora ladder builder (Tracks E1/E2).
 *
 * A DLMM "position" holds one contiguous bin range, so a ladder is one
 * position per rung — the SDK's `addLiquidityByStrategy` is called once per
 * rung behind the port. There is no batched multi-position call in the SDK
 * today, so the builder never assumed one.
 *
 * Single-token deposit zap (E1): rungs entirely below the current price take
 * the deposit in base (X), rungs above take it in quote (Y); a straddling
 * rung splits by the share of its bin range on each side of price. The SDK
 * executes the split internally with its strategy math — this builder only
 * decides the totals.
 */
/** One planned on-chain step, executor-agnostic. */
export interface RungTxStep {
    readonly rungIndex: number;
    readonly kind: 'initialize-position-and-add-liquidity';
    /** Human-scale amounts the executor converts to base units. */
    readonly totalXAmount: number;
    readonly totalYAmount: number;
    readonly binLower: number;
    readonly binUpper: number;
    readonly strategy: LpStrategyType;
    readonly description: string;
}
export interface MeteoraLiquidityPort {
    /**
     * Turns one rung's plan into an executable step (the live impl wraps
     * `DLMM.addLiquidityByStrategy`; tests replace it).
     */
    buildRungStep(step: RungTxStep, context: {
        readonly userAddress: string;
        readonly slippageBps: number;
    }): Promise<RungTxStep>;
}
/** Which side(s) of the current price a rung's bin range sits on. */
export declare function splitRungAmounts(rung: LadderRung, currentPrice: number): {
    totalXAmount: number;
    totalYAmount: number;
};
export interface MeteoraLadderBuilder {
    buildLadder(input: {
        readonly plan: LadderPlan;
        readonly pairAddress: string;
        readonly userAddress: string;
        readonly currentPrice: number;
        readonly distribution: LpStrategyType;
        readonly slippageBps?: number;
    }): Promise<readonly RungTxStep[]>;
}
export declare function createMeteoraLadderBuilder(port: MeteoraLiquidityPort): MeteoraLadderBuilder;
//# sourceMappingURL=meteora-ladder.d.ts.map