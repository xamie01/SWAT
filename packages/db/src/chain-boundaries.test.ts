import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from './client.js';
import { insertTrade } from './trades.js';
import { insertParsedTransaction } from './transactions.js';
import { upsertWallet } from './wallets.js';

vi.mock('./client.js', () => ({
  pool: { connect: vi.fn() },
  query: vi.fn()
}));

const EVM_ADDRESS = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';
const EVM_LOWER = EVM_ADDRESS.toLowerCase();

describe('database chain write boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects EVM-shaped writes that would otherwise default to Solana', async () => {
    await expect(insertTrade({
      tokenMint: EVM_ADDRESS,
      direction: 'buy'
    })).rejects.toThrow(/explicit chain/);
    await expect(insertParsedTransaction({
      signature: 'tx-1',
      walletAddress: EVM_ADDRESS,
      tokenIn: EVM_ADDRESS,
      tokenOut: EVM_ADDRESS,
      amountIn: '1',
      amountOut: '1',
      direction: 'buy',
      targetToken: EVM_ADDRESS,
      timestamp: new Date()
    })).rejects.toThrow(/explicit chain/);
    await expect(upsertWallet({
      address: EVM_ADDRESS,
      chain: 'solana',
      source: 'manual'
    })).rejects.toThrow(/cannot be classified as Solana/);
    expect(query).not.toHaveBeenCalled();
  });

  it('infers a prefixed wallet chain and canonicalizes every transaction asset', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 1 }]);

    await expect(insertParsedTransaction({
      signature: 'tx-2',
      walletAddress: `polygon:${EVM_ADDRESS}`,
      tokenIn: EVM_ADDRESS,
      tokenOut: '12345',
      amountIn: '1000000',
      amountOut: '2000000',
      direction: 'buy',
      targetToken: '12345',
      timestamp: new Date('2026-07-24T12:00:00Z')
    })).resolves.toBe(true);

    const params = vi.mocked(query).mock.calls[0]?.[1] as unknown[];
    expect(params[1]).toBe('polygon');
    expect(params[2]).toBe(`polygon:${EVM_LOWER}`);
    expect(params[3]).toBe(`polygon:${EVM_LOWER}`);
    expect(params[4]).toBe('polygon:12345');
    expect(params[10]).toBe('polygon:12345');
  });
});
