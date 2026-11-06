import type { LpChain } from '@swat/shared';
/**
 * LP wallet indexer shapes (Track D).
 *
 * A reader turns one wallet into a set of *observations* — what the wallet's
 * LP positions are worth right now. Valuation happens inside the reader (it
 * has the chain context); the indexer records the series and the PnL
 * calculator closes the books from the series.
 */
export interface ObservedPosition {
    /** Chain-prefixed position identifier (Solana position pubkey; EVM tokenId as address-shaped? no — `position:<tokenId>` is NOT valid here; use the chain-prefixed NFT/position account). */
    readonly positionAddress: string;
    /** Chain-prefixed pool the position sits in. */
    readonly poolAddress: string;
    /** Current inventory value of the position, USD (excludes uncollected fees). */
    readonly positionValueUsd: number;
    /** Uncollected fees sitting in the position, USD. */
    readonly uncollectedFeesUsd: number;
    /** Whether the position's range contains the current price. */
    readonly inRange: boolean;
}
export interface LpPositionReader {
    readonly chain: LpChain;
    /** All LP positions one wallet holds, ready to be recorded as a snapshot row. */
    readPositions(walletAddress: string): Promise<readonly ObservedPosition[]>;
}
//# sourceMappingURL=types.d.ts.map