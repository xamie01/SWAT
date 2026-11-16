import { describe, expect, it, vi } from 'vitest';
import { createWalletBackfillJob, resolveChainValue } from '@swat/shared';
import {
  createDiscoveryRunner,
  type DiscoveryRunnerDependencies
} from './runner.js';

function createDependencies(
  overrides: Partial<DiscoveryRunnerDependencies> = {}
): DiscoveryRunnerDependencies {
  return {
    findFundedUnknownWallets: vi.fn().mockResolvedValue([]),
    findFrequentCounterparties: vi.fn().mockResolvedValue([]),
    persistBackfill: vi.fn(async (wallet) => {
      const resolved = resolveChainValue(wallet.address);
      return { address: resolved.prefixed, chain: resolved.chain, intentId: 'intent-1' };
    }),
    listPendingBackfills: vi.fn().mockResolvedValue([]),
    acknowledgeBackfill: vi.fn().mockResolvedValue(undefined),
    enqueueBackfill: vi.fn().mockResolvedValue(undefined),
    logDiscoveryRun: vi.fn().mockResolvedValue(undefined),
    logger: {
      info: vi.fn(),
      error: vi.fn()
    },
    ...overrides
  };
}

describe('discovery runner', () => {
  it('preserves chain and discovery method before enqueueing a backfill', async () => {
    const address = 'robinhood-chain:0xabcdef0123456789abcdef0123456789abcdef01';
    const dependencies = createDependencies({
      findFundedUnknownWallets: vi.fn().mockResolvedValue([address])
    });
    const runner = createDiscoveryRunner(dependencies);

    await expect(runner.runFundingGraphExpansion()).resolves.toBe(1);

    expect(dependencies.persistBackfill).toHaveBeenCalledWith({
      address,
      source: 'discovered',
      discoveryMethod: 'funding'
    });
    expect(dependencies.enqueueBackfill).toHaveBeenCalledWith(address, 'robinhood-chain');

    const job = createWalletBackfillJob(address, 'robinhood-chain');
    expect(job.data).toEqual({
      address: '0xabcdef0123456789abcdef0123456789abcdef01',
      chain: 'robinhood-chain'
    });
    expect(dependencies.logDiscoveryRun).toHaveBeenCalledWith(
      'funding',
      'elite_wallets',
      1
    );
  });

  it('isolates one wallet failure and records only successfully queued wallets', async () => {
    const good = 'solana:11111111111111111111111111111111';
    const bad = 'solana:SysvarRent111111111111111111111111111111111';
    const dependencies = createDependencies({
      findFrequentCounterparties: vi.fn().mockResolvedValue([good, bad]),
      persistBackfill: vi.fn(async (wallet) => {
        if (wallet.address === bad) throw new Error('database unavailable');
        const resolved = resolveChainValue(wallet.address);
        return { address: resolved.prefixed, chain: resolved.chain, intentId: 'intent-1' };
      })
    });
    const runner = createDiscoveryRunner(dependencies);

    await expect(runner.runCounterpartyDiscovery()).resolves.toBe(1);

    expect(dependencies.enqueueBackfill).toHaveBeenCalledTimes(1);
    expect(dependencies.logDiscoveryRun).toHaveBeenCalledWith(
      'counterparty',
      'elite_wallets',
      1
    );
    expect(dependencies.logger?.error).toHaveBeenCalledTimes(1);
  });

  it('routes overlapping triggers through one in-flight guard', async () => {
    let releaseFunding!: (addresses: string[]) => void;
    const funding = new Promise<string[]>((resolve) => {
      releaseFunding = resolve;
    });
    const dependencies = createDependencies({
      findFundedUnknownWallets: vi.fn(() => funding)
    });
    const runner = createDiscoveryRunner(dependencies);

    const first = runner.runNightlyDiscoverySafe();
    await Promise.resolve();
    await expect(runner.runNightlyDiscoverySafe()).resolves.toBe('skipped');

    releaseFunding([]);
    await expect(first).resolves.toBe('completed');
    expect(dependencies.findFundedUnknownWallets).toHaveBeenCalledTimes(1);
  });
});
