import { describe, expect, it } from 'vitest';
import { netLpResult } from './net-lp-result.js';
describe('netLpResult', () => {
    it('sums gains and subtracts stated-positive costs', () => {
        expect(netLpResult({
            feesEarned: 120,
            impermanentLoss: 30,
            gasCost: 5,
            rebalanceCost: 8,
            inventoryChange: -40
        })).toBe(37);
    });
    it('credits inventory appreciation as a gain', () => {
        expect(netLpResult({
            feesEarned: 0,
            impermanentLoss: 0,
            gasCost: 0,
            rebalanceCost: 0,
            inventoryChange: 250
        })).toBe(250);
    });
    it('a window where costs out-earn fees is negative, and that is normal', () => {
        expect(netLpResult({
            feesEarned: 10,
            impermanentLoss: 60,
            gasCost: 12,
            rebalanceCost: 20,
            inventoryChange: 0
        })).toBe(-82);
    });
    it('the all-zero position reads as exactly 0, not null', () => {
        expect(netLpResult({
            feesEarned: 0,
            impermanentLoss: 0,
            gasCost: 0,
            rebalanceCost: 0,
            inventoryChange: 0
        })).toBe(0);
    });
    it('refuses a negative cost — passing IL as a negative loss would double-count it as a gain', () => {
        expect(() => netLpResult({
            feesEarned: 100,
            impermanentLoss: -30,
            gasCost: 0,
            rebalanceCost: 0,
            inventoryChange: 0
        })).toThrow('impermanentLoss must be a finite non-negative cost');
    });
    it('refuses non-finite inputs', () => {
        const base = { feesEarned: 1, impermanentLoss: 0, gasCost: 0, rebalanceCost: 0, inventoryChange: 0 };
        expect(() => netLpResult({ ...base, feesEarned: Number.NaN })).toThrow('finite non-negative cost');
        expect(() => netLpResult({ ...base, gasCost: Number.POSITIVE_INFINITY })).toThrow('finite non-negative cost');
        expect(() => netLpResult({ ...base, inventoryChange: Number.NaN })).toThrow('inventoryChange must be finite');
    });
});
//# sourceMappingURL=net-lp-result.test.js.map