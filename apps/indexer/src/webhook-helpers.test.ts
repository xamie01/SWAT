import { describe, expect, it } from 'vitest';
import {
  enhancedEventToTransaction,
  getEnhancedWalletCandidates,
  isRawHeliusTransaction,
  verifyStaticAuthorization,
  type EnhancedWebhookEvent
} from './webhook-helpers.js';
import { getWalletTokenDeltas, USDC_MINT } from './parse.js';

const WALLET = 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN = 'Tokenyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';

describe('Helius webhook adapters', () => {
  it('accepts only the exact configured Authorization value', () => {
    expect(verifyStaticAuthorization('shared-secret', 'shared-secret')).toBe(true);
    expect(verifyStaticAuthorization('hmac-of-body', 'shared-secret')).toBe(false);
    expect(verifyStaticAuthorization(undefined, 'shared-secret')).toBe(false);
  });

  it('finds wallets referenced by enhanced account and transfer data', () => {
    const event: EnhancedWebhookEvent = {
      feePayer: WALLET,
      accountData: [{ account: WALLET, tokenBalanceChanges: [] }],
      nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: 'Other', amount: 1 }]
    };
    expect(getEnhancedWalletCandidates(event)).toEqual([WALLET, 'Other']);
  });

  it('converts an enhanced stablecoin-to-token swap to the raw parser shape', () => {
    const event: EnhancedWebhookEvent = {
      signature: 'sig',
      timestamp: 1719397500,
      slot: 42,
      accountData: [{
        account: WALLET,
        tokenBalanceChanges: [
          { userAccount: WALLET, mint: USDC_MINT, rawTokenAmount: { tokenAmount: '-25000000' } },
          { userAccount: WALLET, mint: TOKEN, rawTokenAmount: { tokenAmount: '5000000' } }
        ]
      }]
    };
    const tx = enhancedEventToTransaction(event, WALLET);
    expect(getWalletTokenDeltas(tx, WALLET)).toMatchObject({
      direction: 'buy',
      targetToken: TOKEN
    });
  });

  it('recognizes the raw RPC transaction shape', () => {
    expect(isRawHeliusTransaction({
      transaction: { signatures: ['sig'], message: {} },
      meta: {}
    })).toBe(true);
    expect(isRawHeliusTransaction({ accountData: [] })).toBe(false);
  });
});
