import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWalletBackfillProcessor, getBackfillSource } from './backfill-worker.js';

const SOLANA_ADDRESS = '11111111111111111111111111111111';
const EVM_ADDRESS = '0x1234567890123456789012345678901234567890';
const result = {
  fetched: 1,
  inserted: 1,
  skipped: 0,
  failed: 0,
  lastEventAt: new Date('2026-07-25T12:00:00Z')
};

describe('wallet backfill processor', () => {
  const dependencies = {
    backfillSolana: vi.fn().mockResolvedValue(result),
    backfillPolygon: vi.fn().mockResolvedValue(result),
    backfillRobinhood: vi.fn().mockResolvedValue(result),
    recordBatch: vi.fn().mockResolvedValue(undefined)
  };
  const processor = createWalletBackfillProcessor(dependencies);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['solana', SOLANA_ADDRESS, 'backfillSolana'],
    ['polygon', EVM_ADDRESS, 'backfillPolygon'],
    ['robinhood-chain', EVM_ADDRESS, 'backfillRobinhood']
  ] as const)('routes %s through tracked ingestion', async (chain, address, dependency) => {
    await expect(processor({ data: { chain, address } })).resolves.toMatchObject({
      chain,
      address: chain === 'solana' ? address : address.toLowerCase(),
      inserted: 1
    });

    expect(dependencies[dependency]).toHaveBeenCalledOnce();
    expect(dependencies.recordBatch).toHaveBeenCalledWith(expect.objectContaining({
      chain,
      source: getBackfillSource(chain),
      inserted: 1,
      failed: 0
    }));
  });

  it('rejects malformed jobs before invoking a chain backfill', async () => {
    await expect(processor({
      data: { chain: 'polygon', address: `solana:${SOLANA_ADDRESS}` }
    })).rejects.toThrow(/does not match requested chain/);
    await expect(processor({
      data: { chain: 'unsupported', address: EVM_ADDRESS }
    })).rejects.toThrow(/Unsupported wallet backfill chain/);

    expect(dependencies.backfillSolana).not.toHaveBeenCalled();
    expect(dependencies.backfillPolygon).not.toHaveBeenCalled();
    expect(dependencies.backfillRobinhood).not.toHaveBeenCalled();
  });
});
