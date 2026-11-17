import { beforeEach, describe, expect, it, vi } from 'vitest';
const record = vi.hoisted(() => vi.fn());
vi.mock('@swat/db', async original => ({ ...await original<typeof import('@swat/db')>(), recordSourceTradeEvent: record }));
import { getSourceConfirmationReadiness } from '@swat/db';
import { persistSolanaSourceTrade } from './source-trade-lifecycle.js';
const event = { chain: 'solana' as const, transactionIdentity: 'inert-observation',slot: 1,
  walletAddress: '11111111111111111111111111111111',occurredAt: new Date('2026-11-16T00:00:00Z'),direction: 'buy' as const,
  targetToken: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  tokenIn: 'So11111111111111111111111111111111111111112',tokenOut: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  amountIn: '1000000000',amountOut: '1000' };
beforeEach(() => { vi.clearAllMocks(); record.mockImplementation(async input => ({ event: { ...input,confirmationState: 'observed' } })); });
describe('actual source persistence quarantine without verifier', () => {
  it.each(['solana-webhook','solana-backfill'] as const)('%s persists observations but never admits copy', async source => {
    const result = await persistSolanaSourceTrade({ event,source });
    expect(result.eligibleForCopy).toBe(false); expect(record).toHaveBeenCalledWith(expect.objectContaining({ confirmationState: 'observed',amountUsd: null,priceUsd: null }));
    expect(getSourceConfirmationReadiness()).toEqual({ ready: false,reason: 'source-confirmation-verifier-unavailable' });
  });
  it('provider reply cannot promote the independently observed input', async () => {
    record.mockResolvedValue({ event: { confirmationState: 'finalized' } });
    expect((await persistSolanaSourceTrade({ event,source: 'solana-webhook' })).eligibleForCopy).toBe(false);
  });
  it('storage refusal propagates rather than publishing an accepted source', async () => {
    record.mockRejectedValue(new Error('durable observation unavailable'));
    await expect(persistSolanaSourceTrade({ event,source: 'solana-backfill' })).rejects.toThrow(/persist solana/);
  });
});
