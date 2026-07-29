import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from './client.js';
import { insertSignal, insertSignalWithDedupe } from './signals.js';

vi.mock('./client.js', () => ({
  query: vi.fn()
}));

const EVM_ADDRESS = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';

const baseSignal = {
  patternType: 'snipe',
  confidence: 0.9,
  signalScore: 90,
  triggerData: {}
};

describe('signal chain boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('canonicalizes a chain-prefixed target before insert and dedupe', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'signal-1' }]);

    await expect(insertSignalWithDedupe({
      ...baseSignal,
      tokenMint: `polygon:${EVM_ADDRESS}`
    })).resolves.toEqual({ inserted: true, id: 'signal-1' });

    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([
      'snipe',
      `polygon:${EVM_ADDRESS.toLowerCase()}`,
      10
    ]);
    expect(vi.mocked(query).mock.calls[1]?.[1]?.[2]).toBe(
      `polygon:${EVM_ADDRESS.toLowerCase()}`
    );
    expect(vi.mocked(query).mock.calls[1]?.[1]?.[3]).toBe('polygon');
  });

  it('rejects raw EVM targets without a chain and EVM targets labelled Solana', async () => {
    await expect(insertSignal({
      ...baseSignal,
      tokenMint: EVM_ADDRESS
    })).rejects.toThrow(/explicit chain/);
    await expect(insertSignal({
      ...baseSignal,
      tokenMint: EVM_ADDRESS,
      chain: 'solana'
    })).rejects.toThrow(/cannot be classified as Solana/);
    expect(query).not.toHaveBeenCalled();
  });
});
