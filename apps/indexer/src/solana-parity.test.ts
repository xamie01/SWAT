import { describe, expect, it } from 'vitest';
import {
  parseCanonicalSolanaSwapEvent,
  SOL_MINT,
  USDC_MINT,
  type HeliusParsedTransaction
} from './parse.js';
import {
  enhancedEventToTransaction,
  type EnhancedWebhookEvent
} from './webhook-helpers.js';

const WALLET = 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN = 'Tokenyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const TOKEN_TWO = 'Tokenzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const BLOCK_TIME = 1_752_000_000;
const SLOT = 351_000_000;
const FEE_LAMPORTS = 5_000;

type SwapFixture = {
  name: string;
  signature: string;
  nativeBalanceChange?: number;
  tokenDeltas: Record<string, bigint>;
  expected: {
    direction: 'buy' | 'sell';
    targetToken: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
  };
};

function toRawBackfillTransaction(fixture: SwapFixture): HeliusParsedTransaction {
  const nativeBalanceChange = fixture.nativeBalanceChange ?? -FEE_LAMPORTS;
  return {
    slot: SLOT,
    blockTime: BLOCK_TIME,
    transaction: {
      signatures: [fixture.signature],
      message: {
        accountKeys: [WALLET, ...Object.keys(fixture.tokenDeltas).map(mint => `${mint}-account`)],
        instructions: [{
          programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
          accounts: [WALLET, ...Object.keys(fixture.tokenDeltas).map(mint => `${mint}-account`)],
          data: '63UCE4emmE3VCoXST22eKm9'
        }]
      }
    },
    meta: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [...Object.entries(fixture.tokenDeltas).map(([mint, delta]) => ({
        program: 'spl-token', parsed: { type: 'transfer', info: {
          source: delta < 0n ? `${mint}-account` : `pool-${mint}`,
          destination: delta > 0n ? `${mint}-account` : `pool-${mint}`,
          amount: (delta < 0n ? -delta : delta).toString()
        } }
      })), ...(fixture.nativeBalanceChange === undefined ? [] : [{ program: 'system', parsed: { type: 'transfer', info: {
        source: fixture.nativeBalanceChange < 0 ? WALLET : 'pool-sol',
        destination: fixture.nativeBalanceChange > 0 ? WALLET : 'pool-sol',
        lamports: Math.abs(fixture.nativeBalanceChange + FEE_LAMPORTS)
      } } }])] }],
      fee: FEE_LAMPORTS,
      preBalances: [nativeBalanceChange < 0 ? Math.abs(nativeBalanceChange) : 0, ...Object.keys(fixture.tokenDeltas).map(() => 0)],
      postBalances: [nativeBalanceChange > 0 ? nativeBalanceChange : 0, ...Object.keys(fixture.tokenDeltas).map(() => 0)],
      preTokenBalances: Object.entries(fixture.tokenDeltas).map(([mint, delta], index) => ({
        accountIndex: index + 1,
        owner: WALLET,
        mint,
        uiTokenAmount: { amount: delta < 0n ? (-delta).toString() : '0' }
      })),
      postTokenBalances: Object.entries(fixture.tokenDeltas).map(([mint, delta], index) => ({
        accountIndex: index + 1,
        owner: WALLET,
        mint,
        uiTokenAmount: { amount: delta > 0n ? delta.toString() : '0' }
      }))
    }
  };
}

function toEnhancedWebhookEvent(fixture: SwapFixture): EnhancedWebhookEvent {
  return {
    signature: fixture.signature,
    slot: SLOT,
    timestamp: BLOCK_TIME,
    fee: FEE_LAMPORTS,
    feePayer: WALLET,
    transactionError: null,
    instructions: [{
      programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      accounts: [WALLET, ...Object.keys(fixture.tokenDeltas).map(mint => `${mint}-account`)],
      data: '63UCE4emmE3VCoXST22eKm9',
      innerInstructions: [...Object.entries(fixture.tokenDeltas).map(([mint, delta]) => ({
        program: 'spl-token', parsed: { type: 'transfer', info: {
          source: delta < 0n ? `${mint}-account` : `pool-${mint}`,
          destination: delta > 0n ? `${mint}-account` : `pool-${mint}`,
          amount: (delta < 0n ? -delta : delta).toString()
        } }
      })), ...(fixture.nativeBalanceChange === undefined ? [] : [{ program: 'system', parsed: { type: 'transfer', info: {
        source: fixture.nativeBalanceChange < 0 ? WALLET : 'pool-sol',
        destination: fixture.nativeBalanceChange > 0 ? WALLET : 'pool-sol',
        lamports: Math.abs(fixture.nativeBalanceChange + FEE_LAMPORTS)
      } } }])]
    }],
    accountData: [{
      account: WALLET,
      nativeBalanceChange: fixture.nativeBalanceChange ?? -FEE_LAMPORTS,
      tokenBalanceChanges: Object.entries(fixture.tokenDeltas).map(([mint, delta]) => ({
        userAccount: WALLET,
        tokenAccount: `${mint}-account`,
        mint,
        rawTokenAmount: { tokenAmount: delta.toString() }
      }))
    }, ...Object.keys(fixture.tokenDeltas).map(mint => ({ account: `${mint}-account`, nativeBalanceChange: 0 }))]
  };
}

const fixtures: SwapFixture[] = [
  {
    name: 'SOL entry BUY',
    signature: 'sol-buy-signature',
    nativeBalanceChange: -1_000_005_000,
    tokenDeltas: { [TOKEN]: 5_000_000n },
    expected: {
      direction: 'buy',
      targetToken: TOKEN,
      tokenIn: SOL_MINT,
      tokenOut: TOKEN,
      amountIn: '1000000000',
      amountOut: '5000000'
    }
  },
  {
    name: 'SOL exit SELL',
    signature: 'sol-sell-signature',
    nativeBalanceChange: 899_995_000,
    tokenDeltas: { [TOKEN]: -5_000_000n },
    expected: {
      direction: 'sell',
      targetToken: TOKEN,
      tokenIn: TOKEN,
      tokenOut: SOL_MINT,
      amountIn: '5000000',
      amountOut: '900000000'
    }
  },
  {
    name: 'USDC SPL token entry BUY',
    signature: 'usdc-buy-signature',
    tokenDeltas: { [USDC_MINT]: -25_000_000n, [TOKEN]: 5_000_000n },
    expected: {
      direction: 'buy',
      targetToken: TOKEN,
      tokenIn: USDC_MINT,
      tokenOut: TOKEN,
      amountIn: '25000000',
      amountOut: '5000000'
    }
  },
  {
    name: 'USDC SPL token exit SELL',
    signature: 'usdc-sell-signature',
    tokenDeltas: { [TOKEN]: -5_000_000n, [USDC_MINT]: 25_000_000n },
    expected: {
      direction: 'sell',
      targetToken: TOKEN,
      tokenIn: TOKEN,
      tokenOut: USDC_MINT,
      amountIn: '5000000',
      amountOut: '25000000'
    }
  },
  {
    name: 'supported non-quote token-to-token exit SELL',
    signature: 'token-sell-signature',
    tokenDeltas: { [TOKEN]: -5_000_000n, [TOKEN_TWO]: 2_000_000n },
    expected: {
      direction: 'sell',
      targetToken: TOKEN,
      tokenIn: TOKEN,
      tokenOut: TOKEN_TWO,
      amountIn: '5000000',
      amountOut: '2000000'
    }
  }
];

describe('canonical Solana ingestion parity', () => {
  it.each(fixtures)('$name is identical through webhook and backfill normalization', (fixture) => {
    const backfillEvent = parseCanonicalSolanaSwapEvent(
      toRawBackfillTransaction(fixture),
      WALLET
    );
    const webhookEvent = parseCanonicalSolanaSwapEvent(
      enhancedEventToTransaction(toEnhancedWebhookEvent(fixture), WALLET),
      WALLET
    );

    expect(webhookEvent).toEqual(backfillEvent);
    expect(backfillEvent).toMatchObject({
      chain: 'solana',
      transactionIdentity: fixture.signature,
      walletAddress: WALLET,
      occurredAt: new Date(BLOCK_TIME * 1000),
      ...fixture.expected
    });
  });

  it('replays a duplicate webhook as the exact same immutable source event', () => {
    const fixture = fixtures[0];
    const transaction = enhancedEventToTransaction(toEnhancedWebhookEvent(fixture), WALLET);

    expect(parseCanonicalSolanaSwapEvent(transaction, WALLET)).toEqual(
      parseCanonicalSolanaSwapEvent(transaction, WALLET)
    );
  });

  it('refuses to fabricate an event without a transaction identity or event time', () => {
    const transaction = toRawBackfillTransaction(fixtures[0]);
    transaction.transaction!.signatures = [];
    expect(parseCanonicalSolanaSwapEvent(transaction, WALLET)).toBeNull();

    transaction.transaction!.signatures = ['restored-signature'];
    delete transaction.blockTime;
    expect(parseCanonicalSolanaSwapEvent(transaction, WALLET)).toBeNull();
  });
});
