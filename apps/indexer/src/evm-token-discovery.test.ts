import { describe, expect, it, vi, beforeEach } from 'vitest';
import { parseAbiItem } from 'viem';
import { discoverFromEvmToken } from './evm.js';

const mocks = vi.hoisted(() => ({
  upsertWallet: vi.fn(),
  logDiscoveryRun: vi.fn(),
  publish: vi.fn(),
  addQueueJob: vi.fn(),
  query: vi.fn()
}));

vi.mock('@swat/db', () => ({
  upsertToken: vi.fn(),
  upsertWallet: mocks.upsertWallet,
  logDiscoveryRun: mocks.logDiscoveryRun,
  insertParsedTransaction: vi.fn(),
  updateTokenLaunchTimestamp: vi.fn(),
  refreshWalletActivity: vi.fn(),
  query: mocks.query
}));

vi.mock('ioredis', () => ({
  Redis: class {
    publish(channel: string, message: string) {
      return mocks.publish(channel, message);
    }
  }
}));

describe('discoverFromEvmToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue([]);
  });

  it('scans logs, aggregates earliest and biggest buyers, and seeds them into the database', async () => {
    const tokenAddress = '0x1111111111111111111111111111111111111111';
    const fakeClient = {
      getBlockNumber: vi.fn().mockResolvedValue(1000n),
      getLogs: vi.fn().mockResolvedValue([
        {
          blockNumber: 100n,
          args: {
            from: '0x0000000000000000000000000000000000000000',
            to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            value: 1000000n
          }
        },
        {
          blockNumber: 105n,
          args: {
            from: '0x0000000000000000000000000000000000000000',
            to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            value: 50000000n
          }
        },
        {
          blockNumber: 110n,
          args: {
            from: '0x0000000000000000000000000000000000000000',
            to: '0xcccccccccccccccccccccccccccccccccccccccc',
            value: 500000n
          }
        }
      ]),
      readContract: vi.fn().mockImplementation(({ functionName }) => {
        if (functionName === 'decimals') return Promise.resolve(18);
        if (functionName === 'symbol') return Promise.resolve('TEST');
        if (functionName === 'name') return Promise.resolve('Test Token');
        return Promise.resolve(null);
      })
    };

    const fakeQueue = {
      add: mocks.addQueueJob
    } as any;

    const result = await discoverFromEvmToken(
      tokenAddress,
      'robinhood-chain',
      { client: fakeClient as any, backfillQueue: fakeQueue }
    );

    expect(result.scanned).toBe(3);
    expect(result.earlyBuyers).toBe(3);
    expect(result.bigBuyers).toBe(0);

    // Verify upsertWallet was called for all 3 buyers
    expect(mocks.upsertWallet).toHaveBeenCalledWith(expect.objectContaining({
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      chain: 'robinhood-chain',
      source: 'discovered',
      discoveryMethod: 'token-early'
    }));
    expect(mocks.upsertWallet).toHaveBeenCalledWith(expect.objectContaining({
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      chain: 'robinhood-chain',
      source: 'discovered',
      discoveryMethod: 'token-early'
    }));

    // Verify backfill jobs were queued
    expect(mocks.addQueueJob).toHaveBeenCalledTimes(3);

    // Verify discovery run was logged
    expect(mocks.logDiscoveryRun).toHaveBeenCalledWith('token', tokenAddress.toLowerCase(), 3);

    // Verify cluster refresh was published to Redis
    expect(mocks.publish).toHaveBeenCalledWith(
      'swat:cluster:refresh',
      expect.stringContaining('token-discovery')
    );
  });
});
