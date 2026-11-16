import { describe, expect, it, vi } from 'vitest';
import { createDiscoveryRunner } from './runner.js';

const address = 'solana:11111111111111111111111111111111';
const intent = { address, chain: 'solana' as const, intentId: 'intent-a' };

function harness() {
  const pending = new Map<string, typeof intent>();
  const dependencies = {
    findFundedUnknownWallets: vi.fn().mockResolvedValue([address]),
    findFrequentCounterparties: vi.fn().mockResolvedValue([]),
    upsertWallet: vi.fn().mockResolvedValue(intent),
    persistBackfill: vi.fn(async () => { pending.set(intent.intentId, intent); return intent; }),
    listPendingBackfills: vi.fn(async () => [...pending.values()]),
    acknowledgeBackfill: vi.fn(async (id: string) => { pending.delete(id); }),
    enqueueBackfill: vi.fn().mockResolvedValue(undefined),
    logDiscoveryRun: vi.fn().mockResolvedValue(undefined),
    logger: { info: vi.fn(), error: vi.fn() }
  };
  return { dependencies, pending };
}

describe('package24 durable discovery public runner seam', () => {
  it('commits a recoverable intent before the queue dependency', async () => {
    const { dependencies: d } = harness();
    await createDiscoveryRunner(d).runFundingGraphExpansion();
    expect(d.persistBackfill).toHaveBeenCalledWith({ address, source: 'discovered', discoveryMethod: 'funding' });
    expect(d.upsertWallet).not.toHaveBeenCalled();
    expect(d.persistBackfill.mock.invocationCallOrder[0]).toBeLessThan(d.enqueueBackfill.mock.invocationCallOrder[0]);
    expect(d.acknowledgeBackfill).toHaveBeenCalledWith('intent-a');
  });

  it('queue outage leaves pending intent; a new runner recovers without rediscovering', async () => {
    const { dependencies: d, pending } = harness();
    d.enqueueBackfill.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(createDiscoveryRunner(d).runFundingGraphExpansion()).resolves.toBe(0);
    expect(pending.has('intent-a')).toBe(true);
    d.findFundedUnknownWallets.mockResolvedValue([]);
    await createDiscoveryRunner(d).runNightlyDiscoverySafe();
    expect(d.enqueueBackfill).toHaveBeenCalledTimes(2);
    expect(pending.size).toBe(0);
    expect(d.persistBackfill).toHaveBeenCalledTimes(1);
  });

  it('queue acceptance followed by ack failure remains retryable with the same logical identity', async () => {
    const { dependencies: d, pending } = harness();
    d.acknowledgeBackfill.mockRejectedValueOnce(new Error('commit failed'));
    await createDiscoveryRunner(d).runFundingGraphExpansion();
    expect(pending.size).toBe(1);
    d.findFundedUnknownWallets.mockResolvedValue([]);
    await createDiscoveryRunner(d).runNightlyDiscoverySafe();
    expect(d.enqueueBackfill.mock.calls).toEqual([[address, 'solana'], [address, 'solana']]);
    expect(pending.size).toBe(0);
  });

  it('durable-store failure refuses queue and does not use standalone wallet upsert', async () => {
    const { dependencies: d } = harness();
    d.persistBackfill.mockRejectedValue(new Error('intent schema unavailable'));
    await expect(createDiscoveryRunner(d).runFundingGraphExpansion()).resolves.toBe(0);
    expect(d.enqueueBackfill).not.toHaveBeenCalled();
    expect(d.upsertWallet).not.toHaveBeenCalled();
  });
});
