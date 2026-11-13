import { describe, expect, it } from 'vitest';
import { parseCanonicalSolanaSwapEvent, USDC_MINT, type HeliusParsedTransaction } from './parse.js';

const WALLET = 'owner';
const TOKEN = 'target';
const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
// Raydium swap_base_in: opcode 9, amount_in=25_000_000, minimum_out=1.
const DATA = '63UCE4emmE3VCoXST22eKm9';
function receipt(): HeliusParsedTransaction {
  return {
    slot: 42, blockTime: 1752000000,
    transaction: { signatures: ['receipt'], message: {
      accountKeys: [WALLET, 'quote-account', 'target-account'],
      instructions: [{ programId: RAYDIUM, accounts: [WALLET, 'quote-account', 'target-account'], data: DATA }]
    } },
    meta: { err: null, fee: 5000, preBalances: [100000, 0, 0], postBalances: [95000, 0, 0],
      innerInstructions: [{ index: 0, instructions: [
        { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'quote-account', destination: 'pool-quote', amount: '25000000' } } },
        { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'pool-target', destination: 'target-account', amount: '5000000' } } }
      ] }],
      preTokenBalances: [
        { accountIndex: 1, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: '25000000', decimals: 6 } },
        { accountIndex: 2, owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '0', decimals: 9 } }
      ],
      postTokenBalances: [
        { accountIndex: 1, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: '0', decimals: 6 } },
        { accountIndex: 2, owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '5000000', decimals: 9 } }
      ] }
  };
}

describe('successful attributable Solana ingestion', () => {
  it('preserves an attributable successful USDC entry and its exact units', () => {
    expect(parseCanonicalSolanaSwapEvent(receipt(), WALLET)).toMatchObject({
      tokenIn: USDC_MINT, tokenOut: TOKEN, amountIn: '25000000', amountOut: '5000000', direction: 'buy'
    });
  });
  it('rejects a failed receipt before producing a canonical trade', () => {
    const tx = receipt();
    tx.meta!.err = { InstructionError: [0, 'Custom'] };
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('does not treat a missing execution result as success', () => {
    const tx = receipt();
    delete tx.meta!.err;
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('refuses unrelated wallet transfers attached to a swap touching the same accounts', () => {
    const tx = receipt();
    tx.meta!.innerInstructions = [{ index: 0, instructions: [
      { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'quote-account', destination: 'pool-quote', amount: '25000000' } } },
      { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'pool-target', destination: 'target-account', amount: '1000000' } } }
    ] }];
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('rejects token-program labels that contradict the actual program ID', () => {
    const tx = receipt();
    for (const ix of tx.meta!.innerInstructions![0].instructions!) ix.programId = 'unrelated-program';
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('accounts for SPL native-token spending without double-counting lamports', () => {
    const tx = receipt();
    tx.meta!.preTokenBalances![0] = { accountIndex: 1, owner: WALLET,
      mint: 'So11111111111111111111111111111111111111112', uiTokenAmount: { amount: '1000000000', decimals: 9 } };
    tx.meta!.postTokenBalances![0] = { accountIndex: 1, owner: WALLET,
      mint: 'So11111111111111111111111111111111111111112', uiTokenAmount: { amount: '0', decimals: 9 } };
    tx.meta!.preBalances = [100000, 1002039280, 2039280];
    tx.meta!.postBalances = [95000, 2039280, 2039280];
    tx.meta!.innerInstructions![0].instructions![0].parsed!.info!.amount = '1000000000';
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toMatchObject({ amountIn: '1000000000', amountOut: '5000000' });
  });
  it('does not infer a native leg from missing wallet balance evidence', () => {
    const tx = receipt();
    delete tx.meta!.preBalances;
    delete tx.meta!.postBalances;
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('rejects native spending outside the evidenced swap invocation', () => {
    const tx = receipt();
    tx.meta!.preTokenBalances = [{ accountIndex: 2, owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '0' } }];
    tx.meta!.postTokenBalances = [{ accountIndex: 2, owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '100' } }];
    tx.meta!.preBalances = [1000000, 0, 0];
    tx.meta!.postBalances = [495000, 0, 0];
    tx.meta!.innerInstructions![0].instructions = [
      { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'pool-target', destination: 'target-account', amount: '100' } } }
    ];
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('preserves sub-threshold native swaps instead of treating size as provenance', () => {
    const tx = receipt();
    tx.meta!.preTokenBalances = [{ accountIndex: 2, owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '0' } }];
    tx.meta!.postTokenBalances = [{ accountIndex: 2, owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '100' } }];
    tx.meta!.preBalances = [1000000, 0, 0];
    tx.meta!.postBalances = [495000, 0, 0];
    tx.meta!.innerInstructions![0].instructions = [
      { program: 'system', parsed: { type: 'transfer', info: { source: WALLET, destination: 'pool-sol', lamports: 500000 } } },
      { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'pool-target', destination: 'target-account', amount: '100' } } }
    ];
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toMatchObject({ amountIn: '500000', amountOut: '100' });
  });
  it('rejects invalid native transfer amounts without throwing', () => {
    const tx = receipt();
    tx.meta!.postBalances![2] = 2000000;
    tx.meta!.innerInstructions![0].instructions!.push({ program: 'system', parsed: { type: 'transfer', info: {
      source: WALLET, destination: 'target-account', lamports: 'malformed'
    } } });
    expect(() => parseCanonicalSolanaSwapEvent(tx, WALLET)).not.toThrow();
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('rejects out-of-range event times rather than producing an invalid Date', () => {
    const tx = receipt();
    tx.blockTime = Number.MAX_SAFE_INTEGER;
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('removes attributable token-account rent from native swap spending', () => {
    const tx = receipt();
    tx.meta!.preTokenBalances = [{ accountIndex: 2, owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '0', decimals: 9 } }];
    tx.meta!.postTokenBalances = [{ accountIndex: 2, owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '5000000', decimals: 9 } }];
    tx.meta!.preBalances = [2000000000, 0, 0];
    tx.meta!.postBalances = [997955720, 0, 2039280];
    tx.meta!.innerInstructions = [{ index: 0, instructions: [
      { program: 'system', parsed: { type: 'transfer', info: { source: WALLET, destination: 'pool-sol', lamports: 1000000000 } } },
      { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'pool-target', destination: 'target-account', amount: '5000000' } } },
      { program: 'system', parsed: { type: 'transfer', info: {
        source: WALLET, destination: 'target-account', lamports: 2039280
      } } }
    ] }];
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toMatchObject({ amountIn: '1000000000', tokenOut: TOKEN });
  });
  it('rejects imprecise native balances rather than rounding them', () => {
    const tx = receipt();
    tx.meta!.preBalances![0] = Number.MAX_SAFE_INTEGER + 2;
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('requires both changed token accounts to participate in the same swap', () => {
    const tx = receipt();
    tx.transaction!.message!.instructions![0].accounts = [WALLET, 'target-account'];
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('rejects a third economic asset instead of ranking incomparable raw integers', () => {
    const tx = receipt();
    tx.transaction!.message!.accountKeys!.push('extra-account');
    tx.transaction!.message!.instructions![0].accounts!.push('extra-account');
    tx.meta!.preBalances!.push(0);
    tx.meta!.postBalances!.push(0);
    tx.meta!.postTokenBalances!.push({ accountIndex: 3, owner: WALLET, mint: 'extra', uiTokenAmount: { amount: '999999999999999999', decimals: 18 } });
    tx.meta!.innerInstructions![0].instructions!.push({ program: 'spl-token', parsed: { type: 'transfer', info: {
      source: 'pool-extra', destination: 'extra-account', amount: '999999999999999999'
    } } });
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('rejects malformed balances without throwing or inventing zero', () => {
    const tx = receipt();
    tx.meta!.preTokenBalances![0].uiTokenAmount!.amount = 'not-an-integer';
    expect(() => parseCanonicalSolanaSwapEvent(tx, WALLET)).not.toThrow();
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('rejects inconsistent decimals across accounts of the same mint', () => {
    const tx = receipt();
    tx.meta!.postTokenBalances![0].uiTokenAmount!.decimals = 9;
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('rejects a program invocation unrelated to the changing owned accounts', () => {
    const tx = receipt();
    tx.transaction!.message!.instructions![0].accounts = [WALLET, 'unrelated'];
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('rejects liquidity operations even when they invoke an allowed program', () => {
    const tx = receipt();
    tx.transaction!.message!.instructions![0].data = '11111111111111111';
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
  it('rejects opposite transfers without invoked swap provenance', () => {
    const tx = receipt();
    tx.transaction!.message!.instructions = [];
    expect(parseCanonicalSolanaSwapEvent(tx, WALLET)).toBeNull();
  });
});
