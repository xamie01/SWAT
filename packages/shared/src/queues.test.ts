import { describe, expect, it } from 'vitest';
import { createWalletBackfillJob } from './queues.js';

const EVM_MIXED = '0xAbCdEf0123456789aBCdeF0123456789ABcDef01';
const EVM_LOWER = EVM_MIXED.toLowerCase();

describe('createWalletBackfillJob', () => {
  it('strips a stored prefix and preserves the represented chain', () => {
    expect(createWalletBackfillJob(`robinhood-chain:${EVM_MIXED}`)).toEqual({
      name: 'backfill-wallet',
      data: {
        address: EVM_LOWER,
        chain: 'robinhood-chain'
      },
      options: {
        jobId: `backfill-robinhood-chain-${EVM_LOWER}`,
        removeOnComplete: true,
        removeOnFail: 1000
      }
    });
  });

  it('normalizes a raw EVM address when the chain is explicit', () => {
    expect(createWalletBackfillJob(EVM_MIXED, 'polygon').data).toEqual({
      address: EVM_LOWER,
      chain: 'polygon'
    });
  });

  it('rejects a chain that conflicts with the stored prefix', () => {
    expect(() => createWalletBackfillJob(`polygon:${EVM_LOWER}`, 'solana')).toThrow(
      /does not match/
    );
  });

  it('rejects ambiguous or misclassified raw EVM addresses', () => {
    expect(() => createWalletBackfillJob(EVM_MIXED)).toThrow(/explicit chain/);
    expect(() => createWalletBackfillJob(EVM_MIXED, 'solana')).toThrow(
      /cannot be classified as Solana/
    );
  });
});
