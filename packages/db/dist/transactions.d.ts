export type ParsedTransactionInsert = {
    signature: string;
    walletAddress: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
    amountInUsd?: number | null;
    amountOutUsd?: number | null;
    direction: 'buy' | 'sell';
    targetToken: string;
    programId?: string | null;
    slot?: number | null;
    timestamp: Date;
    blockTime?: number | null;
};
export type TokenMintInfo = {
    decimals?: number | null;
    mintAuthorityDisabled?: boolean | null;
    freezeAuthorityDisabled?: boolean | null;
    symbol?: string | null;
    name?: string | null;
};
/**
 * Upsert a token record. On first insert, optionally populate metadata.
 * On subsequent calls, only updates fields that are provided.
 */
export declare function upsertToken(mint: string, info?: TokenMintInfo): Promise<void>;
export declare function getTokenDecimals(mint: string): Promise<number | null>;
/**
 * Record the earliest observed transaction time for a token as its
 * launch_timestamp. Only moves the value earlier, never later, so the
 * estimate converges on the true launch as more history is ingested.
 *
 * This powers the early-entry component of the wallet composite score.
 */
export declare function updateTokenLaunchTimestamp(mint: string, observedAt: Date): Promise<void>;
export declare function insertParsedTransaction(input: ParsedTransactionInsert): Promise<boolean>;
//# sourceMappingURL=transactions.d.ts.map