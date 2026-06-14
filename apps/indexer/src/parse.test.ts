import { describe, it, expect } from 'vitest';
import {
  extractFundingTransfers,
  getWalletTokenDeltas,
  SOL_MINT,
  SYSTEM_PROGRAM_ID,
  type HeliusParsedTransaction
} from './parse.js';

const WALLET = 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FUNDER = 'Funderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TOKEN = 'Tokenyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';

describe('extractFundingTransfers', () => {
  it('extracts a top-level SystemProgram transfer above the threshold', () => {
    const tx: HeliusParsedTransaction = {
      transaction: {
        message: {
          instructions: [
            {
              programId: SYSTEM_PROGRAM_ID,
              parsed: { type: 'transfer', info: { source: FUNDER, destination: WALLET, lamports: 100_000_000 } }
            }
          ]
        }
      }
    };
    expect(extractFundingTransfers(tx)).toEqual([
      { source: FUNDER, destination: WALLET, lamports: 100_000_000 }
    ]);
  });

  it('extracts transfers nested in inner instructions', () => {
    const tx: HeliusParsedTransaction = {
      meta: {
        innerInstructions: [
          {
            instructions: [
              {
                program: 'system',
                parsed: { type: 'transfer', info: { source: FUNDER, destination: WALLET, lamports: 500_000_000 } }
              }
            ]
          }
        ]
      }
    };
    expect(extractFundingTransfers(tx)).toHaveLength(1);
  });

  it('ignores dust transfers below the threshold', () => {
    const tx: HeliusParsedTransaction = {
      transaction: {
        message: {
          instructions: [
            {
              programId: SYSTEM_PROGRAM_ID,
              parsed: { type: 'transfer', info: { source: FUNDER, destination: WALLET, lamports: 1_000 } }
            }
          ]
        }
      }
    };
    expect(extractFundingTransfers(tx)).toEqual([]);
  });

  it('ignores non-SystemProgram instructions', () => {
    const tx: HeliusParsedTransaction = {
      transaction: {
        message: {
          instructions: [
            {
              programId: 'SomeOtherProgram1111111111111111111111111111',
              parsed: { type: 'transfer', info: { source: FUNDER, destination: WALLET, lamports: 100_000_000 } }
            }
          ]
        }
      }
    };
    expect(extractFundingTransfers(tx)).toEqual([]);
  });

  it('ignores self-transfers and missing parties', () => {
    const tx: HeliusParsedTransaction = {
      transaction: {
        message: {
          instructions: [
            {
              programId: SYSTEM_PROGRAM_ID,
              parsed: { type: 'transfer', info: { source: WALLET, destination: WALLET, lamports: 100_000_000 } }
            },
            {
              programId: SYSTEM_PROGRAM_ID,
              parsed: { type: 'transfer', info: { destination: WALLET, lamports: 100_000_000 } }
            }
          ]
        }
      }
    };
    expect(extractFundingTransfers(tx)).toEqual([]);
  });

  it('respects a custom minimum threshold', () => {
    const tx: HeliusParsedTransaction = {
      transaction: {
        message: {
          instructions: [
            {
              programId: SYSTEM_PROGRAM_ID,
              parsed: { type: 'transfer', info: { source: FUNDER, destination: WALLET, lamports: 10_000 } }
            }
          ]
        }
      }
    };
    expect(extractFundingTransfers(tx, 1_000)).toHaveLength(1);
  });

  it('returns an empty array for a transaction with no instructions', () => {
    expect(extractFundingTransfers({})).toEqual([]);
  });
});

describe('getWalletTokenDeltas', () => {
  it('detects a SOL→token buy', () => {
    const tx: HeliusParsedTransaction = {
      meta: {
        preTokenBalances: [
          { owner: WALLET, mint: SOL_MINT, uiTokenAmount: { amount: '1000000000' } },
          { owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '0' } }
        ],
        postTokenBalances: [
          { owner: WALLET, mint: SOL_MINT, uiTokenAmount: { amount: '0' } },
          { owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '5000000' } }
        ]
      }
    };
    const result = getWalletTokenDeltas(tx, WALLET);
    expect(result).toMatchObject({
      direction: 'buy',
      tokenIn: SOL_MINT,
      tokenOut: TOKEN,
      targetToken: TOKEN,
      amountIn: '1000000000',
      amountOut: '5000000'
    });
  });

  it('detects a token→SOL sell', () => {
    const tx: HeliusParsedTransaction = {
      meta: {
        preTokenBalances: [
          { owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '5000000' } },
          { owner: WALLET, mint: SOL_MINT, uiTokenAmount: { amount: '0' } }
        ],
        postTokenBalances: [
          { owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '0' } },
          { owner: WALLET, mint: SOL_MINT, uiTokenAmount: { amount: '900000000' } }
        ]
      }
    };
    const result = getWalletTokenDeltas(tx, WALLET);
    expect(result).toMatchObject({ direction: 'sell', targetToken: TOKEN });
  });

  it('ignores balances owned by other wallets', () => {
    const tx: HeliusParsedTransaction = {
      meta: {
        preTokenBalances: [{ owner: 'someone-else', mint: TOKEN, uiTokenAmount: { amount: '100' } }],
        postTokenBalances: [{ owner: 'someone-else', mint: TOKEN, uiTokenAmount: { amount: '200' } }]
      }
    };
    expect(getWalletTokenDeltas(tx, WALLET)).toBeNull();
  });

  it('returns null when there is no two-sided swap', () => {
    const tx: HeliusParsedTransaction = {
      meta: {
        preTokenBalances: [{ owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '0' } }],
        postTokenBalances: [{ owner: WALLET, mint: TOKEN, uiTokenAmount: { amount: '100' } }]
      }
    };
    expect(getWalletTokenDeltas(tx, WALLET)).toBeNull();
  });
});
