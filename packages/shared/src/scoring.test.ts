import { describe, it, expect } from 'vitest';
import { calculateCompositeScore, scoreToTier } from './scoring.js';

describe('calculateCompositeScore', () => {
  it('returns 0 for an all-zero wallet', () => {
    expect(
      calculateCompositeScore({ winRate: 0, realizedRoi: 0, earlyEntryScore: 0, consistencyScore: 0 })
    ).toBe(0);
  });

  it('returns 100 for a maxed-out wallet', () => {
    // realizedRoi is normalised by /10, so 10 = max
    expect(
      calculateCompositeScore({ winRate: 1, realizedRoi: 10, earlyEntryScore: 1, consistencyScore: 1 })
    ).toBe(100);
  });

  it('clamps inputs above their ceilings', () => {
    const score = calculateCompositeScore({
      winRate: 5,
      realizedRoi: 1000,
      earlyEntryScore: 9,
      consistencyScore: 4
    });
    expect(score).toBe(100);
  });

  it('clamps negative inputs to zero contribution', () => {
    const score = calculateCompositeScore({
      winRate: -1,
      realizedRoi: -50,
      earlyEntryScore: -2,
      consistencyScore: -3
    });
    expect(score).toBe(0);
  });

  it('weights each component per the documented distribution', () => {
    // Only win rate at 100% → 25% of 100
    expect(
      calculateCompositeScore({ winRate: 1, realizedRoi: 0, earlyEntryScore: 0, consistencyScore: 0 })
    ).toBeCloseTo(25, 5);
    // Only realized ROI at max → 30
    expect(
      calculateCompositeScore({ winRate: 0, realizedRoi: 10, earlyEntryScore: 0, consistencyScore: 0 })
    ).toBeCloseTo(30, 5);
    // Only early entry at max → 25
    expect(
      calculateCompositeScore({ winRate: 0, realizedRoi: 0, earlyEntryScore: 1, consistencyScore: 0 })
    ).toBeCloseTo(25, 5);
    // Only consistency at max → 20
    expect(
      calculateCompositeScore({ winRate: 0, realizedRoi: 0, earlyEntryScore: 0, consistencyScore: 1 })
    ).toBeCloseTo(20, 5);
  });

  it('normalises realized ROI by a factor of 10', () => {
    // ROI of 5 → 0.5 normalised → 0.5 * 0.3 * 100 = 15
    expect(
      calculateCompositeScore({ winRate: 0, realizedRoi: 5, earlyEntryScore: 0, consistencyScore: 0 })
    ).toBeCloseTo(15, 5);
  });
});

describe('scoreToTier', () => {
  it('maps boundary scores to the correct tier', () => {
    expect(scoreToTier(90)).toBe('elite');
    expect(scoreToTier(89.99)).toBe('pro');
    expect(scoreToTier(75)).toBe('pro');
    expect(scoreToTier(74.99)).toBe('promising');
    expect(scoreToTier(60)).toBe('promising');
    expect(scoreToTier(59.99)).toBe('speculative');
    expect(scoreToTier(0)).toBe('speculative');
  });

  it('handles scores above 100 and below 0', () => {
    expect(scoreToTier(150)).toBe('elite');
    expect(scoreToTier(-10)).toBe('speculative');
  });
});
