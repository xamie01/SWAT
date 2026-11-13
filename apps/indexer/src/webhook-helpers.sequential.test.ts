import { describe, expect, it } from 'vitest';
import { enhancedEventToTransaction, type EnhancedWebhookEvent } from './webhook-helpers.js';
import { accountKeyPubkey, getWalletTokenDeltas, parseCanonicalSolanaSwapEvent, SOL_MINT } from './parse.js';

const OWNER = 'owner';
const PAYER = 'payer';
const TOKEN = 'target';
function observation(): EnhancedWebhookEvent {
  return {
    type: 'SWAP', signature: 'receipt', timestamp: 1752000000, slot: 42,
    feePayer: PAYER, fee: 5000, transactionError: null,
    instructions: [{
      programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      accounts: [OWNER, 'target-account'], data: '63UCE4emmE3VCoXST22eKm9',
      innerInstructions: [{ program: 'system', parsed: { type: 'transfer', info: {
        source: OWNER, destination: 'pool-sol', lamports: 1000000000
      } } }, { program: 'spl-token', parsed: { type: 'transfer', info: {
        source: 'pool-target', destination: 'target-account', amount: '5000000'
      } } }]
    }],
    accountData: [{ account: OWNER, nativeBalanceChange: -1000000000,
      tokenBalanceChanges: [{ userAccount: OWNER, tokenAccount: 'target-account', mint: TOKEN,
        rawTokenAmount: { tokenAmount: '5000000', decimals: 9 } }] },
      { account: 'target-account', nativeBalanceChange: 0 }]
  };
}
describe('enhanced Solana receipt attribution', () => {
  it('does not credit a tracked nonpayer with another wallet\'s fee', () => {
    const tx = enhancedEventToTransaction(observation(), OWNER);
    expect(getWalletTokenDeltas(tx, OWNER)).toMatchObject({ amountIn: '1000000000', tokenIn: SOL_MINT });
    expect(accountKeyPubkey(tx.transaction?.message?.accountKeys?.[0])).toBe(PAYER);
  });
  it('preserves actual invoked swap and success evidence for canonical ingestion', () => {
    const event = observation();
    expect(parseCanonicalSolanaSwapEvent(enhancedEventToTransaction(event, OWNER), OWNER))
      .toMatchObject({ amountIn: '1000000000', amountOut: '5000000' });
  });
  it('decodes raw System and SPL CPI data without synthetic parsed fields', () => {
    const event = observation();
    event.instructions![0].innerInstructions = [
      { programId: '11111111111111111111111111111111', accounts: [OWNER, 'pool-sol'], data: '3Bxs3zzLZLuLQEYX' },
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', accounts: ['pool-target', 'target-account', 'pool-authority'], data: '3QDJ9TwUE2Dm' }
    ];
    expect(parseCanonicalSolanaSwapEvent(enhancedEventToTransaction(event, OWNER), OWNER))
      .toMatchObject({ amountIn: '1000000000', amountOut: '5000000' });
  });
  it('decodes raw checked transfers with the destination after the mint account', () => {
    const event = observation();
    event.instructions![0].innerInstructions = [
      { programId: '11111111111111111111111111111111', accounts: [OWNER, 'pool-sol'], data: '3Bxs3zzLZLuLQEYX' },
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', accounts: ['pool-target', TOKEN, 'target-account', 'pool-authority'], data: 'gvQzKgr3xhN2k' }
    ];
    expect(parseCanonicalSolanaSwapEvent(enhancedEventToTransaction(event, OWNER), OWNER))
      .toMatchObject({ amountIn: '1000000000', amountOut: '5000000' });
  });
  it('rejects truncated raw transfer data instead of inventing its amount', () => {
    const event = observation();
    event.instructions![0].innerInstructions = [
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', accounts: ['pool-target', 'target-account', 'pool-authority'], data: '3' }
    ];
    expect(parseCanonicalSolanaSwapEvent(enhancedEventToTransaction(event, OWNER), OWNER)).toBeNull();
  });
  it('does not infer a native balance of zero when the observation omits it', () => {
    const event = observation();
    delete event.accountData![0].nativeBalanceChange;
    event.accountData![0].tokenBalanceChanges!.push({ userAccount: OWNER, tokenAccount: 'quote-account',
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', rawTokenAmount: { tokenAmount: '-25000000', decimals: 6 } });
    event.instructions![0].accounts!.push('quote-account');
    expect(parseCanonicalSolanaSwapEvent(enhancedEventToTransaction(event, OWNER), OWNER)).toBeNull();
  });
  it('does not manufacture successful execution from a SWAP label', () => {
    const event = observation();
    delete event.transactionError;
    expect(parseCanonicalSolanaSwapEvent(enhancedEventToTransaction(event, OWNER), OWNER)).toBeNull();
  });
  it('does not manufacture an invoked program from an enhanced SWAP label', () => {
    const event = observation();
    delete event.instructions;
    expect(parseCanonicalSolanaSwapEvent(enhancedEventToTransaction(event, OWNER), OWNER)).toBeNull();
  });
});
