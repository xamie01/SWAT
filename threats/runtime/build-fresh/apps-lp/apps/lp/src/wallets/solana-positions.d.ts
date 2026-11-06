import type { LpPositionReader } from './types.js';
/**
 * Solana DLMM position reader (Track D1).
 *
 * The DLMM SDK call (`getAllLbPairPositionsByUser`) sits behind a port so the
 * normalization is testable without a chain. The SDK returns per-pair amounts
 * in token units; this reader prices both legs through an injected mint-price
 * source and skips positions it cannot price — an unpriceable position must
 * read as *absent* from the snapshot, not as a zero-value one, or the PnL
 * series would book a phantom total loss.
 */
export interface DlmmPairPosition {
    /** Raw pair pubkey (unprefixed). */
    readonly pairAddress: string;
    /** Raw position pubkey (unprefixed). */
    readonly positionAddress: string;
    /** Raw mints for pricing. */
    readonly baseMint: string;
    readonly quoteMint: string;
    /** Human-scale token amounts in the position's inventory. */
    readonly baseAmount: number;
    readonly quoteAmount: number;
    /** Human-scale uncollected fees per leg. */
    readonly uncollectedBaseFees: number;
    readonly uncollectedQuoteFees: number;
    /** Current quote-per-base price at the pair's active bin. */
    readonly currentPrice: number;
    readonly inRange: boolean;
}
export interface DlmmUserPositionsPort {
    fetchUserPositions(walletAddress: string): Promise<readonly DlmmPairPosition[]>;
}
export interface MintUsdPriceSource {
    /** USD price by chain-prefixed mint; null when unknown. */
    priceUsd(chainPrefixedMint: string): Promise<number | null>;
}
export declare function createSolanaLpPositionReader(options: {
    port: DlmmUserPositionsPort;
    prices: MintUsdPriceSource;
}): LpPositionReader;
//# sourceMappingURL=solana-positions.d.ts.map