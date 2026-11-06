export type HeliusTokenBalance = {
    owner?: string;
    mint: string;
    uiTokenAmount?: {
        amount?: string;
    };
};
export type HeliusParsedInstruction = {
    programId?: string;
    program?: string;
    parsed?: {
        type?: string;
        info?: {
            source?: string;
            destination?: string;
            lamports?: number | string;
        };
    };
};
export type HeliusAccountKey = string | {
    pubkey?: string;
};
export type HeliusParsedTransaction = {
    slot?: number;
    blockTime?: number;
    transaction?: {
        signatures?: string[];
        message?: {
            instructions?: HeliusParsedInstruction[];
            accountKeys?: HeliusAccountKey[];
        };
    };
    meta?: {
        fee?: number;
        preBalances?: number[];
        postBalances?: number[];
        preTokenBalances?: HeliusTokenBalance[];
        postTokenBalances?: HeliusTokenBalance[];
        innerInstructions?: Array<{
            instructions?: HeliusParsedInstruction[];
        }>;
    };
};
export declare function accountKeyPubkey(key: HeliusAccountKey | undefined): string | undefined;
/**
 * Convert a base-unit integer amount (as a string) to a human-unit float
 * WITHOUT precision loss for large values. `Number("50000000000000000")`
 * silently rounds past 2^53 (~9e15); a 9-decimal memecoin trade routinely
 * exceeds that. We split the integer and fractional parts in BigInt space first
 * so only the (small) scaled quotient is handed to Number.
 */
export declare function baseUnitsToFloat(amountStr: string, decimals: number): number;
export declare const MIN_SOL_LEG_LAMPORTS = 1000000;
export declare const SOL_MINT = "So11111111111111111111111111111111111111112";
export declare const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export declare const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export declare const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export declare const MIN_FUNDING_LAMPORTS = 50000000;
export type FundingTransfer = {
    source: string;
    destination: string;
    lamports: number;
};
/**
 * Extract SystemProgram SOL transfers from a parsed transaction.
 * Looks at both top-level and inner instructions. Filters to `transfer` /
 * `transferChecked` instructions above the dust threshold.
 */
export declare function extractFundingTransfers(tx: HeliusParsedTransaction, minLamports?: number): FundingTransfer[];
/**
 * Compute the buy/sell direction and target token for a swap from the wallet's
 * pre/post token balance deltas. Returns null if the tx isn't a clean 2-sided
 * swap for this wallet.
 */
export declare function getWalletTokenDeltas(tx: HeliusParsedTransaction, walletAddress: string): {
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
    direction: "buy" | "sell";
    targetToken: string;
} | null;
export type CanonicalSolanaSwapEvent = {
    chain: 'solana';
    transactionIdentity: string;
    slot: number | null;
    walletAddress: string;
    occurredAt: Date;
    direction: 'buy' | 'sell';
    targetToken: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
};
/**
 * Produce the source-independent swap event consumed by Solana ingestion.
 *
 * Helius enhanced webhooks are first converted to a
 * {@link HeliusParsedTransaction}; JSON-RPC backfills already have that shape.
 * Keeping source labels out of this value makes parity directly testable and
 * prevents the two ingestion paths from drifting on direction or quantities.
 */
export declare function parseCanonicalSolanaSwapEvent(tx: HeliusParsedTransaction, walletAddress: string): CanonicalSolanaSwapEvent | null;
export type TokenBuyer = {
    owner: string;
    /** Base units of `mint` the owner gained in this tx (post - pre, > 0). */
    amount: bigint;
};
/**
 * Find every account that NET-GAINED a balance of `mint` in this transaction —
 * i.e. the buyers/receivers of the token in this tx. Used by token-discovery to
 * enumerate candidate early/big buyers from each on-chain swap.
 *
 * Aggregates per owner across all of that owner's token accounts for `mint`
 * (an owner can hold the mint in several ATAs). Owners whose net delta is <= 0
 * (sellers, unchanged) are excluded.
 */
export declare function extractTokenBuyers(tx: HeliusParsedTransaction, mint: string): TokenBuyer[];
//# sourceMappingURL=parse.d.ts.map