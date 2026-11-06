import type { JupiterQuote } from './jupiter.js';
export interface JupiterSwapBuildParams {
    readonly quote?: JupiterQuote;
    readonly inputMint?: string;
    readonly outputMint?: string;
    readonly amountLamports?: number | string;
    readonly slippageBps?: number;
    /** The wallet that will sign and pay for the transaction (`taker` in V2). */
    readonly userPublicKey: string;
    /**
     * Wrap/unwrap SOL as needed. Set `true` for safety: a user cannot *spend* an
     * unwrapped SOL balance without this, and a swap that would leave dust in a
     * wrapped token account is wasteful — better to close it and recover the rent.
     * Named `wrapAndUnwrapSol` in V2; `wrapUnwrapSOL` is retained for backwards compatibility.
     */
    readonly wrapAndUnwrapSol?: boolean;
    readonly wrapUnwrapSOL?: boolean;
    /**
     * Exclude DEXes that are incompatible with Jito bundles. Defaults to `true`
     * because SWAT submits transactions exclusively through Jito bundles.
     */
    readonly forJitoBundle?: boolean;
    /**
     * When true, include compute-budget and priority-fee instructions. Should
     * always be false for Jito bundles — the *tip* is what buys inclusion, and a
     * priority fee layered on top is double-paying for the same thing.
     */
    readonly computeUnitPriceMicroLamports?: number;
    readonly apiKey?: string;
    readonly apiBase?: string;
}
export interface JupiterSwapTransaction {
    /** Base64-encoded versioned transaction ready to sign. */
    readonly swapTransaction: string;
    /** The slot the quote was built against; after this expires the tx is stale. */
    readonly lastValidBlockHeight: number;
}
export interface JupiterApiInstruction {
    programId: string;
    accounts: Array<{
        pubkey: string;
        isWritable: boolean;
        isSigner: boolean;
    }>;
    data: string;
}
export interface JupiterSwapBuildResponse {
    computeBudgetInstructions?: JupiterApiInstruction[];
    setupInstructions?: JupiterApiInstruction[];
    swapInstruction?: JupiterApiInstruction;
    cleanupInstruction?: JupiterApiInstruction | null;
    otherInstructions?: JupiterApiInstruction[];
    addressesByLookupTableAddress?: Record<string, string[]>;
    blockhashWithMetadata?: {
        blockhash: string | number[];
        lastValidBlockHeight: number;
    };
    swapTransaction?: string;
    lastValidBlockHeight?: number;
    error?: string;
}
/**
 * Builds the swap transaction from a quote or mint/amount parameters.
 *
 * Uses Jupiter Swap API V2 `GET /build` with `forJitoBundle: true`.
 * Returns `null` on failure so callers can gracefully fall back or skip.
 */
export declare function buildJupiterSwap(params: JupiterSwapBuildParams): Promise<JupiterSwapTransaction | null>;
//# sourceMappingURL=jupiter-swap.d.ts.map