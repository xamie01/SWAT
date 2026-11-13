import { describe, expect, it } from 'vitest';
import { getWalletTokenDeltas, parseCanonicalSolanaSwapEvent, SOL_MINT, USDC_MINT } from '../../apps/indexer/src/parse.js';
import { enhancedEventToTransaction } from '../../apps/indexer/src/webhook-helpers.js';

const wallet = 'FixtureWallet';
const token = 'FixtureToken';
const tx = () => ({
  blockTime: 1700000000,
  transaction: { signatures: ['synthetic-event-only'], message: { accountKeys: [wallet], instructions: [] } },
  meta: {
    preTokenBalances: [{ owner: wallet, mint: USDC_MINT, uiTokenAmount: { amount: '1000000' } }, { owner: wallet, mint: token, uiTokenAmount: { amount: '0' } }],
    postTokenBalances: [{ owner: wallet, mint: USDC_MINT, uiTokenAmount: { amount: '0' } }, { owner: wallet, mint: token, uiTokenAmount: { amount: '100' } }]
  }
});

describe('Source evidence invariants using pure parsers', () => {
  it('IDX-01: unrelated opposite transfers without swap provenance must not create a canonical swap', () => {
    expect(parseCanonicalSolanaSwapEvent(tx(), wallet)).toBeNull();
  });
  it('IDX-01: explicitly failed source transactions must be rejected', () => {
    const failed = tx();
    (failed.meta as any).err = { InstructionError: [0, 'fixture-failure'] };
    expect(parseCanonicalSolanaSwapEvent(failed, wallet)).toBeNull();
  });
  it('IDX-02: ambiguous additional asset legs must not be selected by raw-unit size', () => {
    const multi = tx();
    multi.meta.preTokenBalances.push({ owner: wallet, mint: 'FixtureHighDecimals', uiTokenAmount: { amount: '0' } });
    multi.meta.postTokenBalances.push({ owner: wallet, mint: 'FixtureHighDecimals', uiTokenAmount: { amount: '1000000000000000000' } });
    expect(getWalletTokenDeltas(multi, wallet)).toBeNull();
  });
  it('IDX-03: an enhanced non-payer must not receive the fee refund in its swap quantity', () => {
    const event = {
      signature: 'synthetic-fee-event', timestamp: 1700000000, fee: 5000, feePayer: 'OtherFeePayer',
      accountData: [{ account: wallet, nativeBalanceChange: -1_000_000_000, tokenBalanceChanges: [
        { userAccount: wallet, mint: token, rawTokenAmount: { tokenAmount: '100' } }
      ] }]
    };
    const parsed = getWalletTokenDeltas(enhancedEventToTransaction(event, wallet), wallet);
    expect(parsed?.tokenIn).toBe(SOL_MINT);
    expect(parsed?.amountIn).toBe('1000000000');
  });
  it('control: an event missing a transaction identity is rejected', () => {
    const empty = tx();
    empty.transaction.signatures = [];
    expect(parseCanonicalSolanaSwapEvent(empty, wallet)).toBeNull();
  });
});
