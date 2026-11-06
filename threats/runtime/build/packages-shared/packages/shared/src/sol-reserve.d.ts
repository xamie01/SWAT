/**
 * Per-user SOL minimum for tips and transaction fees (S4-P20).
 *
 * A user funding only tokens/USDC has zero SOL and cannot execute.
 * The threshold is strictly denominated in USD ($10 equivalent) and converted
 * live via the current SOL price, never fixed at a static SOL floor that drifts
 * with price movement.
 *
 * Fail-closed: an unreadable SOL price must not silently admit an underfunded
 * user or guess a fabricated fallback (e.g. 150). It returns an actionable
 * skip verdict with a specific reason.
 */
export declare const DEFAULT_SOL_MINIMUM_RESERVE_USD = 10;
export type SolReserveVerdict = {
    readonly status: 'funded';
    readonly currentSol: number;
    readonly requiredSol: number;
    readonly solPriceUsd: number;
} | {
    readonly status: 'underfunded';
    readonly code: 'sol-reserve-underfunded';
    readonly reason: string;
    readonly currentSol: number;
    readonly requiredSol: number;
    readonly neededSol: number;
    readonly solPriceUsd: number;
} | {
    readonly status: 'price-unavailable';
    readonly code: 'sol-price-unavailable';
    readonly reason: string;
    readonly currentSol: number;
};
export interface EvaluateSolReserveOptions {
    readonly currentSolBalance: number;
    readonly solPriceUsd: number | null | undefined;
    readonly targetUsd?: number;
}
export declare function evaluateSolReserve(opts: EvaluateSolReserveOptions): SolReserveVerdict;
//# sourceMappingURL=sol-reserve.d.ts.map