import { describe, expect, it } from 'vitest';
import { decimalQuantityToBaseUnits, executionModesForChainMode, resolvePaperCopyTargetAccount, sourceSellFractionToBps } from './canonical-copy.js';
describe('canonical copy execution helpers', () => {
    it('maps chain modes to independent canonical execution rows', () => {
        expect(executionModesForChainMode('paper')).toEqual(['paper']);
        expect(executionModesForChainMode('live')).toEqual(['live']);
        expect(executionModesForChainMode('live+shadow')).toEqual(['live', 'shadow']);
    });
    it('uses stable paper accounts and permits explicit overrides', () => {
        expect(resolvePaperCopyTargetAccount('solana', {})).toBe('11111111111111111111111111111111');
        expect(resolvePaperCopyTargetAccount('polygon', {
            PAPER_COPY_ACCOUNT_POLYGON: '0x1111111111111111111111111111111111111111'
        })).toBe('0x1111111111111111111111111111111111111111');
    });
    it('converts source fractions and tracked quantities without rounding up', () => {
        expect(sourceSellFractionToBps('0.25')).toBe(2_500);
        expect(sourceSellFractionToBps('0.33339')).toBe(3_333);
        expect(sourceSellFractionToBps('1')).toBe(10_000);
        expect(decimalQuantityToBaseUnits('1.234567', 6)).toBe(1234567n);
    });
    it('fails closed for unusable fractional exits', () => {
        expect(() => sourceSellFractionToBps('0.00001')).toThrow('rounds outside');
        expect(() => sourceSellFractionToBps('1.01')).toThrow('between 0 and 1');
        expect(() => decimalQuantityToBaseUnits('0.0000001', 6)).toThrow('rounds to zero');
    });
});
//# sourceMappingURL=canonical-copy.test.js.map