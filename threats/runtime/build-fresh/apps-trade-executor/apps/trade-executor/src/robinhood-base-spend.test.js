import { describe, expect, it } from 'vitest';
import { describeRobinhoodBaseSpend } from './robinhood.js';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
/**
 * S4-M41 — the base-asset spend must carry its unit.
 *
 * The defect these pin: `amountEth` is a `number` whose name hardcodes a currency
 * only one of the two base-asset modes uses. In `erc20` mode it was `0`, and the
 * ledger wrote that zero as a real ETH cost — a fabricated value on a trade that
 * spent a stablecoin. A zero cost basis makes an ordinary position look like an
 * infinite-return winner, and one that can never trip a stop-loss.
 *
 * Every case here exercises `erc20` mode explicitly. A suite that only covered
 * `native-weth` would pass with the bug fully intact, which is why it survived.
 */
describe('describeRobinhoodBaseSpend (S4-M41)', () => {
    describe('native-weth mode', () => {
        it('reports the ETH amount that went in on a buy', () => {
            const spend = describeRobinhoodBaseSpend({
                baseAssetMode: 'native-weth',
                baseAsset: WETH,
                direction: 'buy',
                actualAmountIn: 100000000000000000n, // 0.1 ETH
                actualAmountOut: 4900n
            });
            expect(spend).toEqual({ kind: 'native', currency: 'ETH', amount: 0.1 });
        });
        it('reports the ETH amount that came out on a sell', () => {
            // The base asset is what we spend on a buy and what we receive on a sell,
            // so the leg flips with direction. Reading the wrong one silently reports a
            // token quantity as an ETH amount.
            const spend = describeRobinhoodBaseSpend({
                baseAssetMode: 'native-weth',
                baseAsset: WETH,
                direction: 'sell',
                actualAmountIn: 4900n,
                actualAmountOut: 250000000000000000n // 0.25 ETH
            });
            expect(spend).toEqual({ kind: 'native', currency: 'ETH', amount: 0.25 });
        });
    });
    describe('erc20 mode — where the fabricated zero used to be', () => {
        it('never reports ETH, and never reports zero, for a USDG spend', () => {
            const spend = describeRobinhoodBaseSpend({
                baseAssetMode: 'erc20',
                baseAsset: USDG,
                direction: 'buy',
                actualAmountIn: 250000000n, // 250 USDG at 6 decimals
                actualAmountOut: 4900n
            });
            expect(spend).toEqual({ kind: 'erc20', token: USDG, baseUnits: 250000000n });
            // The two assertions that are the whole point of the item.
            expect(spend).not.toMatchObject({ currency: 'ETH' });
            expect(spend).not.toMatchObject({ amount: 0 });
        });
        it('carries base units rather than a decimal, because USDG has 6 decimals not 18', () => {
            // 250 USDG is 250_000_000 base units. Formatting it with the ether helpers
            // would yield 2.5e-10 — understated by 10^12, which presents as "no funds"
            // rather than as a scaling bug. Keeping the integer makes the amount exact
            // and forces the caller that knows the decimals to do the conversion.
            const spend = describeRobinhoodBaseSpend({
                baseAssetMode: 'erc20',
                baseAsset: USDG,
                direction: 'buy',
                actualAmountIn: 250000000n,
                actualAmountOut: 1n
            });
            expect(spend.kind).toBe('erc20');
            if (spend.kind !== 'erc20')
                throw new Error('unreachable');
            expect(spend.baseUnits).toBe(250000000n);
            expect(typeof spend.baseUnits).toBe('bigint');
        });
        it('flips to the output leg on a sell, same as native mode', () => {
            const spend = describeRobinhoodBaseSpend({
                baseAssetMode: 'erc20',
                baseAsset: USDG,
                direction: 'sell',
                actualAmountIn: 4900n,
                actualAmountOut: 310500000n
            });
            expect(spend).toEqual({ kind: 'erc20', token: USDG, baseUnits: 310500000n });
        });
        it('reports the configured base asset, not a hardcoded one', () => {
            // A caller could reasonably assume erc20 mode means USDG. It means whatever
            // ROBINHOOD_BASE_ASSET is set to, and the ledger needs to know which token
            // the number is denominated in to ever convert it.
            const other = '0x1111111111111111111111111111111111111111';
            const spend = describeRobinhoodBaseSpend({
                baseAssetMode: 'erc20',
                baseAsset: other,
                direction: 'buy',
                actualAmountIn: 1n,
                actualAmountOut: 1n
            });
            expect(spend).toMatchObject({ kind: 'erc20', token: other });
        });
        it('reports a genuinely zero spend as zero base units, not as unassessed', () => {
            // Distinguishing the two directions of the unknown-vs-zero rule: a real zero
            // is representable and must not be laundered into "unknown" either.
            const spend = describeRobinhoodBaseSpend({
                baseAssetMode: 'erc20',
                baseAsset: USDG,
                direction: 'buy',
                actualAmountIn: 0n,
                actualAmountOut: 0n
            });
            expect(spend).toEqual({ kind: 'erc20', token: USDG, baseUnits: 0n });
        });
    });
    it('the two modes never produce the same shape, so a consumer must branch', () => {
        // Structural point: `kind` is what forces the ledger call site to decide what
        // to record. The old `number` let it skip that decision and write a zero.
        const native = describeRobinhoodBaseSpend({
            baseAssetMode: 'native-weth', baseAsset: WETH, direction: 'buy',
            actualAmountIn: 1n, actualAmountOut: 1n
        });
        const erc20 = describeRobinhoodBaseSpend({
            baseAssetMode: 'erc20', baseAsset: USDG, direction: 'buy',
            actualAmountIn: 1n, actualAmountOut: 1n
        });
        expect(native.kind).not.toBe(erc20.kind);
    });
});
//# sourceMappingURL=robinhood-base-spend.test.js.map