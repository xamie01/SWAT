import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ record: vi.fn(), verify: vi.fn() }));
vi.mock('@swat/db', () => ({ recordSourceTradeEvent: mocks.record, verifySourceTrade: mocks.verify }));
vi.mock('@swat/shared', () => ({
  isAppliedSourceConfirmation: (state: string) => ['confirmed','finalized'].includes(state),
  resolveChainAddress: (value: string, chain: string) => ({ raw: value, prefixed: `${chain}:${value}` }),
  resolveChainValue: (value: string, chain: string) => ({ raw: value, prefixed: `${chain}:${value}` })
}));
import { persistSolanaSourceTrade } from './source-trade-lifecycle.js';
const event = { chain: 'solana' as const, transactionIdentity: 'inert-observation', slot: 1, walletAddress: 'wallet',
  occurredAt: new Date('2026-11-17T00:00:00.000Z'), direction: 'buy' as const, targetToken: 'mint',
  tokenIn: 'So11111111111111111111111111111111111111112', tokenOut: 'mint', amountIn: '1000000000', amountOut: '1234567' };
const verification = { network: 'inert-local-network', quantityScale: 6,
  evidence: { evidenceId: 'inert' } as import('@swat/db').SourceVerificationEvidence,
  verifier: { validateProvider: vi.fn(), verifyEvidence: vi.fn() } };
beforeEach(() => { vi.resetAllMocks(); mocks.record.mockImplementation(async input => ({ event: { ...input, id: 'source' },
  inserted: true, eligibleForCopy: false })); mocks.verify.mockResolvedValue({ confirmationState: 'confirmed' }); });
describe('invoked indexer exact source verification seam (keyless inert ports)', () => {
  it('existing callers preserve default observation quarantine without verifier call', async () => {
    expect((await persistSolanaSourceTrade({ event, source: 'solana-webhook' })).eligibleForCopy).toBe(false);
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it('explicit network/raw scale binds observation before actual verifier invocation', async () => {
    const result = await persistSolanaSourceTrade({ event, source: 'solana-backfill', verification });
    expect(result.eligibleForCopy).toBe(true);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ quantity: '1.234567', confirmationState: 'observed',
      verificationBinding: expect.objectContaining({ network: verification.network, rawQuantity: '1234567', quantityScale: 6,
        walletAddress: 'solana:wallet', tokenMint: 'solana:mint', sourceEventIndex: 'wallet' }) }));
    expect(mocks.verify).toHaveBeenCalledWith({ sourceTradeId: 'source', evidence: verification.evidence, verifier: verification.verifier });
  });
  it('verifier refusal propagates and never yields admitted source', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('inert wrong-network rejection'));
    await expect(persistSolanaSourceTrade({ event, source: 'solana-webhook', verification })).rejects.toThrow(/wrong-network/);
  });
  it.each([-1, 256, 0.5])('invalid scale %s refuses before source storage', async quantityScale => {
    await expect(persistSolanaSourceTrade({ event, source: 'solana-webhook', verification: { ...verification, quantityScale } })).rejects.toThrow(/decimals/);
    expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
  });
});
