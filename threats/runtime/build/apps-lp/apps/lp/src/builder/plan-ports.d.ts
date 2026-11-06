import type { MeteoraLiquidityPort } from './meteora-ladder.js';
import type { EvmPositionPort } from './evm-ladder.js';
/**
 * Plan-only liquidity ports.
 *
 * The ladder builders call these ports to turn a rung plan into executable
 * steps. The plan-only implementations here pass the rung through unchanged:
 * they produce exactly the step description the executor would act on, without
 * signing or talking to a chain — which is precisely what paper mode requires
 * of a "bundle".
 *
 * The SDK-backed signing ports (DLMM `addLiquidityByStrategy`, NFPM `mint`
 * calldata) land behind these same interfaces when a live-certified runtime is
 * available; the interfaces are the contract, and every consumer above them is
 * already written against it.
 */
export declare function createPlanOnlyMeteoraPort(): MeteoraLiquidityPort;
export declare function createPlanOnlyEvmPort(): EvmPositionPort;
//# sourceMappingURL=plan-ports.d.ts.map