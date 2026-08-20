import { describe, it, expect } from 'vitest';
import {
  capabilitiesFor,
  effectiveTier,
  quotaExceeded,
  tierAllowsChain,
  tierAtLeast,
  TIER_CAPABILITIES
} from './tiers.js';

const NOW = new Date('2026-08-05T00:00:00.000Z');
const PAST = new Date('2026-08-01T00:00:00.000Z');
const FUTURE = new Date('2026-09-01T00:00:00.000Z');

describe('tier matrix', () => {
  describe('effectiveTier', () => {
    it('keeps a tier whose expiry is in the future', () => {
      expect(effectiveTier('operator', FUTURE, NOW)).toBe('operator');
      expect(effectiveTier('ultra', FUTURE, NOW)).toBe('ultra');
    });

    it('degrades an expired paid tier to free', () => {
      expect(effectiveTier('operator', PAST, NOW)).toBe('free');
      expect(effectiveTier('ultra', PAST, NOW)).toBe('free');
    });

    it('treats a null expiry as LIFETIME, never as expired', () => {
      // This is the USDC lifetime tier. Inverting this check would silently
      // downgrade every lifetime customer to free.
      expect(effectiveTier('ultra', null, NOW)).toBe('ultra');
      expect(effectiveTier('operator', null, NOW)).toBe('operator');
    });

    it('leaves free alone regardless of expiry', () => {
      expect(effectiveTier('free', PAST, NOW)).toBe('free');
      expect(effectiveTier('free', null, NOW)).toBe('free');
    });
  });

  describe('capabilitiesFor', () => {
    it('returns the expired tier’s capabilities, not the nominal one', () => {
      const expired = capabilitiesFor('ultra', PAST, NOW);
      expect(expired.tier).toBe('free');
      expect(expired.trackedWallets).toBe(3);
      expect(expired.liveExecution).toBe(false);
    });

    it('returns full capabilities for a lifetime ultra', () => {
      const lifetime = capabilitiesFor('ultra', null, NOW);
      expect(lifetime.tier).toBe('ultra');
      expect(lifetime.trackedWallets).toBe(null);
      expect(lifetime.liveExecution).toBe(true);
    });
  });

  describe('quotaExceeded', () => {
    it('treats null as unlimited', () => {
      expect(quotaExceeded(null, 0)).toBe(false);
      expect(quotaExceeded(null, 1_000_000)).toBe(false);
    });

    it('blocks at the limit, not past it', () => {
      // A free user with 3 of 3 wallets must be blocked from adding a 4th, so
      // the boundary is `used >= quota`, not `used > quota`.
      expect(quotaExceeded(3, 2)).toBe(false);
      expect(quotaExceeded(3, 3)).toBe(true);
      expect(quotaExceeded(3, 4)).toBe(true);
    });

    it('blocks everything at a zero quota', () => {
      // Free tier gets 0 API keys; this must not read as unlimited.
      expect(quotaExceeded(0, 0)).toBe(true);
      expect(TIER_CAPABILITIES.free.apiKeys).toBe(0);
    });
  });

  describe('tierAtLeast', () => {
    it('orders free < operator < ultra', () => {
      expect(tierAtLeast('ultra', 'operator')).toBe(true);
      expect(tierAtLeast('operator', 'operator')).toBe(true);
      expect(tierAtLeast('free', 'operator')).toBe(false);
      expect(tierAtLeast('operator', 'ultra')).toBe(false);
    });
  });

  describe('tierAllowsChain', () => {
    it('restricts free to solana', () => {
      const free = TIER_CAPABILITIES.free;
      expect(tierAllowsChain(free, 'solana')).toBe(true);
      expect(tierAllowsChain(free, 'polygon')).toBe(false);
      expect(tierAllowsChain(free, 'robinhood-chain')).toBe(false);
    });

    it('allows operator every built-in chain', () => {
      const operator = TIER_CAPABILITIES.operator;
      expect(tierAllowsChain(operator, 'solana')).toBe(true);
      expect(tierAllowsChain(operator, 'polygon')).toBe(true);
      expect(tierAllowsChain(operator, 'robinhood-chain')).toBe(true);
    });

    it('treats ultra’s null chain list as every chain', () => {
      // Ultra adds custom chains in Stage 7, so its list cannot be enumerated.
      const ultra = TIER_CAPABILITIES.ultra;
      expect(ultra.chains).toBe(null);
      expect(tierAllowsChain(ultra, 'solana')).toBe(true);
      expect(tierAllowsChain(ultra, 'polygon')).toBe(true);
    });
  });

  describe('matrix invariants', () => {
    it('never lets a higher tier have a smaller quota', () => {
      const { free, operator, ultra } = TIER_CAPABILITIES;
      const atLeast = (higher: number | null, lower: number | null) =>
        higher === null || (lower !== null && higher >= lower);
      expect(atLeast(operator.trackedWallets, free.trackedWallets)).toBe(true);
      expect(atLeast(ultra.trackedWallets, operator.trackedWallets)).toBe(true);
      expect(atLeast(operator.tokenBackfillsPerDay, free.tokenBackfillsPerDay)).toBe(true);
      expect(atLeast(ultra.tokenBackfillsPerDay, operator.tokenBackfillsPerDay)).toBe(true);
      expect(operator.backfillDepthDays).toBeGreaterThan(free.backfillDepthDays);
      expect(ultra.backfillDepthDays).toBeGreaterThan(operator.backfillDepthDays);
    });

    it('gives higher tiers a lower (sooner) backfill priority number', () => {
      // BullMQ runs LOWER priority numbers first — the inversion is easy to get
      // backwards and would silently starve paying users behind free ones.
      const { free, operator, ultra } = TIER_CAPABILITIES;
      expect(operator.backfillPriority).toBeLessThan(free.backfillPriority);
      expect(ultra.backfillPriority).toBeLessThan(operator.backfillPriority);
    });

    it('delays only the free tier’s signal feed', () => {
      expect(TIER_CAPABILITIES.free.signalDelaySeconds).toBeGreaterThan(0);
      expect(TIER_CAPABILITIES.operator.signalDelaySeconds).toBe(0);
      expect(TIER_CAPABILITIES.ultra.signalDelaySeconds).toBe(0);
    });

    it('gates live execution to paid tiers', () => {
      expect(TIER_CAPABILITIES.free.liveExecution).toBe(false);
      expect(TIER_CAPABILITIES.operator.liveExecution).toBe(true);
      expect(TIER_CAPABILITIES.ultra.liveExecution).toBe(true);
    });
  });
});
