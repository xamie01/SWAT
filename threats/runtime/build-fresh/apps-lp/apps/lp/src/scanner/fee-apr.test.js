import { describe, expect, it } from 'vitest';
import { realizedFeeApr } from './fee-apr.js';
import { rankPoolsByVolumeToActiveLiquidity, volumeToActiveLiquidityRatio } from './ranking.js';
describe('realizedFeeApr', () => {
    it('divides trailing fees by TVL without annualizing', () => {
        const apr = realizedFeeApr({ fees24h: 400, fees7d: 2_400, tvl: 100_000 });
        expect(apr.feeApr24h).toBeCloseTo(0.004, 12);
        expect(apr.feeApr7d).toBeCloseTo(0.024, 12);
    });
    it('zero TVL reads as unknown, not as infinite or zero', () => {
        const apr = realizedFeeApr({ fees24h: 400, fees7d: null, tvl: 0 });
        expect(apr.feeApr24h).toBeNull();
        expect(apr.feeApr7d).toBeNull();
    });
    it('a pool younger than 7d keeps a 24h APR and a null 7d APR', () => {
        const apr = realizedFeeApr({ fees24h: 25, fees7d: null, tvl: 50_000 });
        expect(apr.feeApr24h).toBeCloseTo(0.0005, 12);
        expect(apr.feeApr7d).toBeNull();
    });
});
describe('rankPoolsByVolumeToActiveLiquidity', () => {
    it('sorts by the volume-to-active-TVL ratio, highest first, without mutating input', () => {
        const pools = [
            { poolAddress: 'a', volume24h: 100, activeTvl: 100 }, // ratio 1
            { poolAddress: 'b', volume24h: 900, activeTvl: 300 }, // ratio 3
            { poolAddress: 'c', volume24h: 10, activeTvl: 1_000 } // ratio 0.01
        ];
        const ranked = rankPoolsByVolumeToActiveLiquidity(pools);
        expect(ranked.map((pool) => pool.poolAddress)).toEqual(['b', 'a', 'c']);
        expect(pools.map((pool) => pool.poolAddress)).toEqual(['a', 'b', 'c']);
    });
    it('unmeasurable pools sink below every rankable pool', () => {
        const pools = [
            { poolAddress: 'unknown-volume', volume24h: null, activeTvl: 500 },
            { poolAddress: 'worst-ratio', volume24h: 1, activeTvl: 1_000_000 },
            { poolAddress: 'unknown-tvl', volume24h: 5_000, activeTvl: null }
        ];
        const ranked = rankPoolsByVolumeToActiveLiquidity(pools);
        expect(ranked[0]?.poolAddress).toBe('worst-ratio');
        expect(ranked.slice(1).map((pool) => pool.poolAddress).sort()).toEqual(['unknown-tvl', 'unknown-volume']);
    });
    it('volume against zero active TVL is unmeasurable, not an infinite ratio', () => {
        // Trades need liquidity — volume > 0 with activeTvl = 0 is a failed
        // active-TVL observation, and Infinity would top the feed with it.
        expect(volumeToActiveLiquidityRatio({ poolAddress: 'x', volume24h: 50, activeTvl: 0 })).toBeNull();
    });
});
//# sourceMappingURL=fee-apr.test.js.map