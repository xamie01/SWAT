import { describe, expect, it } from 'vitest';
import { bitmapPosition, compressedTick, createRobinhoodPoolFetcher, initializedTicksFromBitmap, reconstructTickBands } from './robinhood-pools.js';
const state = (overrides = {}) => ({
    address: '0x00000000000000000000000000000000000000aa',
    token0: '0x0000000000000000000000000000000000000001',
    token1: '0x0000000000000000000000000000000000000002',
    fee: 3000,
    tickSpacing: 60,
    sqrtPriceX96: 2n ** 96n,
    tick: 0,
    inRangeLiquidity: 500n,
    token0Decimals: 18,
    token1Decimals: 18,
    ...overrides
});
const reader = (overrides = {}) => ({
    listConfiguredPools: async () => ['0x00000000000000000000000000000000000000aa'],
    readPoolState: async () => state(),
    liquidityBands: async () => [],
    ...overrides
});
describe('Uniswap v3 tick bitmap helpers', () => {
    it('compresses negative ticks with floor division', () => {
        expect(compressedTick(-1, 10)).toBe(-1);
        expect(compressedTick(-10, 10)).toBe(-1);
        expect(compressedTick(-11, 10)).toBe(-2);
    });
    it('maps negative compressed ticks into the correct bitmap word and bit', () => {
        expect(bitmapPosition(-1)).toEqual({ wordPosition: -1, bitPosition: 255 });
        expect(bitmapPosition(-256)).toEqual({ wordPosition: -1, bitPosition: 0 });
        expect(bitmapPosition(-257)).toEqual({ wordPosition: -2, bitPosition: 255 });
    });
    it('enumerates initialized ticks from a bitmap word', () => {
        expect(initializedTicksFromBitmap(-1, (1n << 255n) | (1n << 253n), 10)).toEqual([-30, -10]);
    });
});
describe('reconstructTickBands', () => {
    it('walks upward using signed liquidityNet', () => {
        const bands = reconstructTickBands({
            currentTick: 0,
            tickSpacing: 10,
            range: 20,
            currentLiquidity: 100,
            liquidityNetByTick: new Map([[10, 25n], [20, -40n]])
        });
        expect(bands).toEqual([
            { tickLower: -20, tickUpper: -10, liquidity: 100 },
            { tickLower: -10, tickUpper: 0, liquidity: 100 },
            { tickLower: 0, tickUpper: 10, liquidity: 100 },
            { tickLower: 10, tickUpper: 20, liquidity: 125 }
        ]);
    });
    it('walks downward by reversing signed liquidityNet', () => {
        const bands = reconstructTickBands({
            currentTick: 0,
            tickSpacing: 10,
            range: 20,
            currentLiquidity: 100,
            liquidityNetByTick: new Map([[-10, 25n], [-20, -40n]])
        });
        expect(bands).toEqual([
            { tickLower: -20, tickUpper: -10, liquidity: 75 },
            { tickLower: -10, tickUpper: 0, liquidity: 100 },
            { tickLower: 0, tickUpper: 10, liquidity: 100 },
            { tickLower: 10, tickUpper: 20, liquidity: 100 }
        ]);
    });
});
describe('createRobinhoodPoolFetcher', () => {
    it('normalizes on-chain state into a chain-prefixed pool with v3 conventions', async () => {
        const pools = await createRobinhoodPoolFetcher({ reader: reader() }).fetch();
        expect(pools).toHaveLength(1);
        const pool = pools[0];
        expect(pool.chain).toBe('robinhood-chain');
        expect(pool.protocol).toBe('uniswap-v3');
        expect(pool.poolAddress).toBe('robinhood-chain:0x00000000000000000000000000000000000000aa');
        expect(pool.feeBps).toBe(30);
        expect(pool.tickSpacing).toBe(60);
        expect(pool.binStep).toBeNull();
        expect(pool.currentPrice).toBeCloseTo(1, 9);
        expect(pool.activeTvlExact).toBe(false);
    });
    it('computes an exact active TVL from reconstructed bands and token prices', async () => {
        const pools = await createRobinhoodPoolFetcher({
            reader: reader({
                liquidityBands: async () => [{ tickLower: -60, tickUpper: 60, liquidity: 1_000 }]
            }),
            priceSource: { priceUsd: async () => 1 }
        }).fetch();
        const pool = pools[0];
        expect(pool.activeTvlExact).toBe(true);
        expect(pool.activeTvlUsd).toBeGreaterThan(0);
        expect(pool.tvl).toBeCloseTo(pool.activeTvlUsd, 9);
    });
    it('derives a stable-quoted base price when no external price source is supplied', async () => {
        const pools = await createRobinhoodPoolFetcher({
            reader: reader({
                readPoolState: async () => state({
                    token1: '0x00000000000000000000000000000000000000bb',
                    sqrtPriceX96: 2n ** 96n
                }),
                liquidityBands: async () => [{ tickLower: -60, tickUpper: 60, liquidity: 1_000 }]
            }),
            stableQuoteToken: '0x00000000000000000000000000000000000000bb'
        }).fetch();
        expect(pools[0]?.activeTvlExact).toBe(true);
        expect(pools[0]?.activeTvlUsd).toBeGreaterThan(0);
    });
    it('keeps explicit token prices authoritative over the stable fallback', async () => {
        const pools = await createRobinhoodPoolFetcher({
            reader: reader({ liquidityBands: async () => [{ tickLower: -60, tickUpper: 60, liquidity: 1_000 }] }),
            stableQuoteToken: '0x0000000000000000000000000000000000000002',
            priceSource: { priceUsd: async (token) => token.endsWith('1') ? 10 : 2 }
        }).fetch();
        expect(pools[0]?.activeTvlExact).toBe(true);
    });
    it('does not invent prices for unknown quote tokens', async () => {
        const pools = await createRobinhoodPoolFetcher({
            reader: reader({ liquidityBands: async () => [{ tickLower: -60, tickUpper: 60, liquidity: 1_000 }] }),
            stableQuoteToken: '0x00000000000000000000000000000000000000ff'
        }).fetch();
        expect(pools[0]?.activeTvlExact).toBe(false);
        expect(pools[0]?.activeTvlUsd).toBe(0);
    });
    it('reports 0 volume when no volume source can price swaps', async () => {
        const pools = await createRobinhoodPoolFetcher({ reader: reader() }).fetch();
        expect(pools[0]?.volume24h).toBe(0);
    });
    it('passes the volume source through when one is configured', async () => {
        const pools = await createRobinhoodPoolFetcher({ reader: reader(), volumeSource: { volume24hUsd: async () => 12_345 } }).fetch();
        expect(pools[0]?.volume24h).toBe(12_345);
    });
    it('carries the v4 protocol tag when configured', async () => {
        const pools = await createRobinhoodPoolFetcher({ reader: reader(), protocol: 'uniswap-v4' }).fetch();
        expect(pools[0]?.protocol).toBe('uniswap-v4');
    });
});
//# sourceMappingURL=robinhood-pools.test.js.map