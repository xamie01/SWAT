import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock('./client.js', () => ({
  query: mocks.query
}));

import {
  RISK_POLICY_CACHE_MAX_ENTRIES,
  RISK_POLICY_CACHE_TTL_MS,
  clearRiskPolicyCache,
  resolveRiskPolicy,
  riskPolicyCacheSize
} from './risk-policy.js';

/**
 * The policy cache is bounded (`S4-P3`).
 *
 * It was a module-level `Map` keyed `${account}:${chain}`, TTL-checked on read but
 * **never swept**. With one operator that is three entries and invisible. Under
 * fan-out the key carries a user id, so it grows one entry per active user per
 * chain and retains every user who has ever traded — including churned ones.
 *
 * That is unbounded growth keyed by user id inside the process that also holds the
 * custody master key, which is the last process in the system that should leak
 * memory. These tests exist because nothing else would notice: a cache that grows
 * forever passes every functional test it has.
 */

describe('risk policy cache bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    clearRiskPolicyCache();
    mocks.query.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearRiskPolicyCache();
  });

  it('caches one entry per (account, chain) pair', async () => {
    await resolveRiskPolicy('user-a', 'solana');
    await resolveRiskPolicy('user-a', 'polygon');
    await resolveRiskPolicy('user-b', 'solana');

    // Distinct keys, because a shared slot would let one chain serve another
    // chain's limits, and one user serve another user's.
    expect(riskPolicyCacheSize()).toBe(3);
  });

  it('serves a repeat lookup from cache without a second query', async () => {
    await resolveRiskPolicy('user-a', 'solana');
    const callsAfterFirst = mocks.query.mock.calls.length;

    await resolveRiskPolicy('user-a', 'solana');

    expect(mocks.query.mock.calls.length).toBe(callsAfterFirst);
    expect(riskPolicyCacheSize()).toBe(1);
  });

  it('sweeps expired entries instead of retaining them forever', async () => {
    vi.useFakeTimers();
    await resolveRiskPolicy('churned-user', 'solana');
    expect(riskPolicyCacheSize()).toBe(1);

    // A user who never returns. Before the fix this entry lived for the life of
    // the process, because expiry was only ever checked on a read that never came.
    vi.advanceTimersByTime(RISK_POLICY_CACHE_TTL_MS + 1);

    // The sweep runs on write, so one unrelated resolve collects the dead entry.
    await resolveRiskPolicy('active-user', 'solana');

    expect(riskPolicyCacheSize()).toBe(1);
  });

  it('never exceeds the hard entry cap, however many users appear', async () => {
    // The backstop: a fan-out burst can outrun TTL expiry entirely, so expiry
    // alone is not a bound.
    const overflow = RISK_POLICY_CACHE_MAX_ENTRIES + 250;
    for (let i = 0; i < overflow; i++) {
      await resolveRiskPolicy(`user-${i}`, 'solana');
    }

    expect(riskPolicyCacheSize()).toBeLessThanOrEqual(RISK_POLICY_CACHE_MAX_ENTRIES);
  });

  it('evicts oldest-first, so the newest entries survive the cap', async () => {
    const overflow = RISK_POLICY_CACHE_MAX_ENTRIES + 10;
    for (let i = 0; i < overflow; i++) {
      await resolveRiskPolicy(`user-${i}`, 'solana');
    }

    const callsBefore = mocks.query.mock.calls.length;
    // The most recent user should still be cached — evicting newest-first would
    // make the cache useless precisely when it is under load.
    await resolveRiskPolicy(`user-${overflow - 1}`, 'solana');

    expect(mocks.query.mock.calls.length).toBe(callsBefore);
  });

  it('clearRiskPolicyCache empties it', async () => {
    await resolveRiskPolicy('user-a', 'solana');
    expect(riskPolicyCacheSize()).toBeGreaterThan(0);

    clearRiskPolicyCache();

    expect(riskPolicyCacheSize()).toBe(0);
  });
});
