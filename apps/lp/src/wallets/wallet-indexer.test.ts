import { beforeEach, describe, expect, it, vi } from 'vitest';

// wallet-indexer.ts defaults its ports to real @swat/db functions; mocking the
// module keeps this a unit test (the real client throws without DATABASE_URL).
const dbMocks = vi.hoisted(() => ({
  recordLpWalletIndexPass: vi.fn(),
  upsertLpWalletPositionResult: vi.fn(),
  trackLpWallet: vi.fn(),
  untrackLpWallet: vi.fn(),
  listTrackedLpWallets: vi.fn()
}));
vi.mock('@swat/db', () => dbMocks);

import { runWalletIndexPass, untrackLpWallet, type TrackedWalletRef } from './wallet-indexer.js';
import type { LpPositionReader, ObservedPosition } from './types.js';

const observed = (positionAddress: string, valueUsd: number): ObservedPosition => ({
  positionAddress,
  poolAddress: `solana:${positionAddress.split(':')[1]}-pool`,
  positionValueUsd: valueUsd,
  uncollectedFeesUsd: 0,
  inRange: true
});

const reader: LpPositionReader = {
  chain: 'solana',
  readPositions: vi.fn(async () => [observed('solana:posA', 1_000)])
};

beforeEach(() => {
  for (const mock of Object.values(dbMocks)) mock.mockReset();
});

describe('runWalletIndexPass', () => {
  it('indexes each tracked wallet through its chain reader and records the pass', async () => {
    dbMocks.recordLpWalletIndexPass.mockResolvedValue(undefined);
    const wallets: readonly TrackedWalletRef[] = [
      { id: 'w1', chain: 'solana', walletAddress: 'solana:wal1' }
    ];

    const summary = await runWalletIndexPass({
      readers: [reader],
      listWallets: async () => wallets
    });

    expect(summary.walletsIndexed).toBe(1);
    expect(summary.positionsObserved).toBe(1);
    expect(summary.failedWallets).toEqual([]);
    expect(dbMocks.recordLpWalletIndexPass).toHaveBeenCalledWith(
      'w1',
      expect.arrayContaining([expect.objectContaining({ positionAddress: 'solana:posA' })])
    );
  });

  it('a wallet on a chain with no reader is reported as failed, not dropped silently', async () => {
    const wallets: readonly TrackedWalletRef[] = [
      { id: 'w2', chain: 'robinhood-chain', walletAddress: 'robinhood-chain:0xwal' }
    ];

    const summary = await runWalletIndexPass({
      readers: [reader],
      listWallets: async () => wallets
    });

    expect(summary.walletsIndexed).toBe(0);
    expect(summary.failedWallets).toEqual(['robinhood-chain:0xwal']);
  });

  it('closes the books for positions with a series and upserts the result', async () => {
    dbMocks.recordLpWalletIndexPass.mockResolvedValue(undefined);
    dbMocks.upsertLpWalletPositionResult.mockResolvedValue(undefined);
    const now = new Date();

    const summary = await runWalletIndexPass({
      readers: [reader],
      listWallets: async () => [{ id: 'w1', chain: 'solana', walletAddress: 'solana:wal1' }],
      snapshotSeries: async () => [
        { capturedAt: new Date(now.getTime() - 3_600_000), positionValueUsd: 900, uncollectedFeesUsd: 0, inRange: true },
        { capturedAt: now, positionValueUsd: 1_000, uncollectedFeesUsd: 10, inRange: true }
      ]
    });

    expect(summary.resultsClosed).toBe(1);
    const [walletId, result] = dbMocks.upsertLpWalletPositionResult.mock.calls[0];
    expect(walletId).toBe('w1');
    expect(result.netResultUsd).toBe(110); // 10 fees + 100 inventory
    expect(result.chain).toBe('solana');
  });

  it('a reader throwing does not take down the sweep', async () => {
    const failingReader: LpPositionReader = {
      chain: 'solana',
      readPositions: vi.fn(async () => {
        throw new Error('SDK exploded');
      })
    };

    const summary = await runWalletIndexPass({
      readers: [failingReader],
      listWallets: async () => [{ id: 'w1', chain: 'solana', walletAddress: 'solana:wal1' }]
    });

    expect(summary.failedWallets).toEqual(['solana:wal1']);
    expect(dbMocks.recordLpWalletIndexPass).not.toHaveBeenCalled();
  });

  it('re-exports untrack for the API layer', async () => {
    dbMocks.untrackLpWallet.mockResolvedValue(true);
    await expect(untrackLpWallet('solana', 'solana:wal')).resolves.toBe(true);
  });
});
