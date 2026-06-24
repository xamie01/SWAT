import { describe, it, expect } from 'vitest';
import {
  extractFundingTransfers,
  extractTokenBuyers,
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

describe('extractTokenBuyers', () => {
  const BUYER_A = 'BuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const BUYER_B = 'BuyerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  it('returns owners whose mint balance increased', () => {
    const tx: HeliusParsedTransaction = {
      meta: {
        preTokenBalances: [{ owner: BUYER_A, mint: TOKEN, uiTokenAmount: { amount: '0' } }],
        postTokenBalances: [{ owner: BUYER_A, mint: TOKEN, uiTokenAmount: { amount: '500' } }]
      }
    };
    expect(extractTokenBuyers(tx, TOKEN)).toEqual([{ owner: BUYER_A, amount: 500n }]);
  });

  it('excludes sellers and unchanged owners', () => {
    const tx: HeliusParsedTransaction = {
      meta: {
        preTokenBalances: [
          { owner: BUYER_A, mint: TOKEN, uiTokenAmount: { amount: '1000' } },
          { owner: BUYER_B, mint: TOKEN, uiTokenAmount: { amount: '300' } }
        ],
        postTokenBalances: [
          { owner: BUYER_A, mint: TOKEN, uiTokenAmount: { amount: '400' } }, // sold
          { owner: BUYER_B, mint: TOKEN, uiTokenAmount: { amount: '300' } }  // unchanged
        ]
      }
    };
    expect(extractTokenBuyers(tx, TOKEN)).toEqual([]);
  });

  it('ignores other mints', () => {
    const tx: HeliusParsedTransaction = {
      meta: {
        preTokenBalances: [{ owner: BUYER_A, mint: SOL_MINT, uiTokenAmount: { amount: '0' } }],
        postTokenBalances: [{ owner: BUYER_A, mint: SOL_MINT, uiTokenAmount: { amount: '999' } }]
      }
    };
    expect(extractTokenBuyers(tx, TOKEN)).toEqual([]);
  });

  it('aggregates multiple token accounts for the same owner', () => {
    const tx: HeliusParsedTransaction = {
      meta: {
        preTokenBalances: [
          { owner: BUYER_A, mint: TOKEN, uiTokenAmount: { amount: '100' } },
          { owner: BUYER_A, mint: TOKEN, uiTokenAmount: { amount: '0' } }
        ],
        postTokenBalances: [
          { owner: BUYER_A, mint: TOKEN, uiTokenAmount: { amount: '300' } },
          { owner: BUYER_A, mint: TOKEN, uiTokenAmount: { amount: '200' } }
        ]
      }
    };
    // (300+200) - (100+0) = 400
    expect(extractTokenBuyers(tx, TOKEN)).toEqual([{ owner: BUYER_A, amount: 400n }]);
  });
});
