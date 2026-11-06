import { describe, expect, it } from 'vitest';
import { createSolanaLpPositionReader } from './solana-positions.js';
import { createRobinhoodLpPositionReader } from './evm-positions.js';
describe('createSolanaLpPositionReader', () => {
    const port = {
        fetchUserPositions: async () => [
            {
                pairAddress: 'Pair1',
                positionAddress: 'Pos1',
                baseMint: 'So11111111111111111111111111111111111111112',
                quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                baseAmount: 2,
                quoteAmount: 100,
                uncollectedBaseFees: 0.1,
                uncollectedQuoteFees: 5,
                currentPrice: 150,
                inRange: true
            }
        ]
    };
    it('prices both legs and chain-prefixes the identities', async () => {
        const reader = createSolanaLpPositionReader({
            port,
            prices: {
                priceUsd: async (mint) => (mint.endsWith('11112') ? 200 : 1)
            }
        });
        const [observed] = await reader.readPositions('solana:Wallet1');
        expect(observed?.positionAddress).toBe('solana:Pos1');
        expect(observed?.poolAddress).toBe('solana:Pair1');
        // Each leg priced once in USD: base 2 * $200 = 400, quote 100 * $1 = 100.
        // (currentPrice 150 is quote-per-base and must NOT multiply in again.)
        expect(observed?.positionValueUsd).toBeCloseTo(500, 9);
        // fees: 0.1 * $200 + 5 * $1 = 25
        expect(observed?.uncollectedFeesUsd).toBeCloseTo(25, 9);
        expect(observed?.inRange).toBe(true);
    });
    it('skips positions whose legs cannot be priced rather than recording a zero', async () => {
        const reader = createSolanaLpPositionReader({
            port,
            prices: { priceUsd: async () => null }
        });
        expect(await reader.readPositions('solana:Wallet1')).toEqual([]);
    });
});
describe('createRobinhoodLpPositionReader', () => {
    const port = {
        positionManagerAddress: '0x00000000000000000000000000000000000000nf',
        fetchWalletPositions: async () => [
            {
                tokenId: '42',
                token0: '0x0000000000000000000000000000000000000001',
                token1: '0x0000000000000000000000000000000000000002',
                poolAddress: '0x0000000000000000000000000000000000000pool',
                amount0: 3,
                amount1: 250,
                uncollectedFees0: 0.5,
                uncollectedFees1: 12,
                inRange: false
            }
        ]
    };
    it('normalizes a priced v3 position with the composite position id', async () => {
        const reader = createRobinhoodLpPositionReader({
            port,
            prices: { priceUsd: async () => 1 }
        });
        const [observed] = await reader.readPositions('robinhood-chain:0xwallet');
        expect(observed?.positionAddress).toBe('robinhood-chain:0x00000000000000000000000000000000000000nf:42');
        expect(observed?.poolAddress).toBe('robinhood-chain:0x0000000000000000000000000000000000000pool');
        expect(observed?.positionValueUsd).toBeCloseTo(253, 9);
        expect(observed?.uncollectedFeesUsd).toBeCloseTo(12.5, 9);
        expect(observed?.inRange).toBe(false);
    });
    it('skips positions with unknown leg prices', async () => {
        const reader = createRobinhoodLpPositionReader({
            port,
            prices: { priceUsd: async () => null }
        });
        expect(await reader.readPositions('robinhood-chain:0xwallet')).toEqual([]);
    });
});
//# sourceMappingURL=position-readers.test.js.map