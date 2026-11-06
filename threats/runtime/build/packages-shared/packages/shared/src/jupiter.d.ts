/**
 * Jupiter Swap API v1 client for SWAT paper-trade simulation.
 *
 * This module fetches **quotes only** — it never signs or broadcasts a
 * transaction.  A quote tells us the exact output amount, price impact, and
 * routing a real swap would produce, which is far more accurate than the
 * simple `amountUsd / spotPrice` division the paper path used before.
 *
 * Every public function returns `null` on failure so callers can gracefully
 * fall back to the existing spot-price logic without crashing the job.
 *
 * Endpoint:  GET https://api.jup.ag/swap/v1/quote
 * Auth:      x-api-key header (free tier from https://developers.jup.ag/portal)
 * Rate limit: ~60 req/min on free tier (trade-executor runs at concurrency 1,
 *             signals fire every 15 s max — well within this budget).
 */
/** A single hop in the route returned by the Quote API. */
export interface JupiterRouteStep {
    swapInfo: {
        ammKey: string;
        label: string;
        inputMint: string;
        outputMint: string;
        inAmount: string;
        outAmount: string;
        feeAmount: string;
        feeMint: string;
    };
    percent: number;
}
/** Subset of the Quote API response we actually consume. */
export interface JupiterQuote {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: 'ExactIn' | 'ExactOut';
    slippageBps: number;
    priceImpactPct: string;
    routePlan: JupiterRouteStep[];
    contextSlot: number;
}
/** Parameters accepted by {@link getJupiterQuote}. */
export interface JupiterQuoteParams {
    inputMint: string;
    outputMint: string;
    /**
     * Raw amount in the specified side's smallest unit: input for ExactIn,
     * output for ExactOut. The legacy name is retained for caller compatibility.
     */
    amountLamports: number;
    /** Slippage tolerance in basis points.  Defaults to 150 (1.5 %). */
    slippageBps?: number;
    swapMode?: 'ExactIn' | 'ExactOut';
}
/**
 * Pre-processed result returned by {@link getJupiterSimulatedFill}.
 * Contains human-friendly numbers ready to persist into the `trades` table.
 */
export interface JupiterSimulatedFill {
    /** This is quote evidence, not a confirmed or submitted chain fill. */
    status: 'quoted';
    swapMode: 'ExactIn' | 'ExactOut';
    /** Raw input amount returned by Jupiter (smallest input-token unit). */
    inAmountRaw: string;
    /** Raw output amount as returned by Jupiter (smallest token unit). */
    outAmountRaw: string;
    /** Output amount converted to human units using `outputDecimals`. */
    tokenAmount: number;
    /** Minimum output after slippage for ExactIn; null for ExactOut. */
    minTokenAmount: number | null;
    /** Maximum input after slippage for ExactOut; null for ExactIn. */
    maxInputAmount: number | null;
    /** Direction-aware interpretation of Jupiter's otherAmountThreshold. */
    threshold: {
        kind: 'minimum-output';
        rawAmount: string;
        amount: number;
        decimals: number;
    } | {
        kind: 'maximum-input';
        rawAmount: string;
        amount: number;
        decimals: number;
    };
    /** Price impact as a number (e.g. 0.12 means 0.12 %). */
    priceImpactPct: number;
    /** The full route plan for informational logging / storage. */
    routePlan: JupiterRouteStep[];
    /** Solana slot the quote was computed at. */
    contextSlot: number;
}
export type JupiterQuoteDecimals = {
    inputDecimals: number;
    outputDecimals: number;
};
/**
 * Fetch a Jupiter swap quote.  Returns `null` on any error (network, rate
 * limit, missing route, bad response shape) so the caller never has to
 * worry about exceptions.
 *
 * @param params  Quote parameters (mints, amount, slippage).
 * @param apiKey  Optional Jupiter API key.  When omitted the request is
 *                still sent (some endpoints allow unauthenticated access at
 *                a lower rate limit), but authenticated calls are preferred.
 */
export declare function getJupiterQuote(params: JupiterQuoteParams, apiKey?: string): Promise<JupiterQuote | null>;
/**
 * High-level helper that fetches a quote and converts it into values ready
 * for the `trades` table.  Returns `null` when the quote is unavailable so
 * the paper-fill path can fall back to the existing spot-price logic.
 *
 * @param params         Same as {@link getJupiterQuote}.
 * @param decimals       Resolved token decimals. ExactOut requires both input
 *                       and output decimals because its threshold is max-input.
 *                       ExactIn temporarily accepts an output-decimals number
 *                       for existing callers, with no guessed fallback.
 * @param apiKey         Jupiter API key (optional, but recommended).
 */
export declare function getJupiterSimulatedFill(params: JupiterQuoteParams, decimals: number | JupiterQuoteDecimals, apiKey?: string): Promise<JupiterSimulatedFill | null>;
//# sourceMappingURL=jupiter.d.ts.map