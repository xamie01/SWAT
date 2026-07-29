import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordSourceTradeEvent } from '@swat/db';
import {
  buildPolymarketSourceTradeInput,
  buildRobinhoodSourceTradeInput,
  buildSolanaSourceTradeInput,
  persistPolymarketSourceTrade,
  persistRobinhoodSourceTrade,
  persistSolanaSourceTrade
} from './source-trade-lifecycle.js';
import { USDC_MINT, type CanonicalSolanaSwapEvent } from './parse.js';
import type { ConfirmedPolymarketTrade } from './polymarket-helpers.js';

vi.mock('@swat/db', () => ({
  recordSourceTradeEvent: vi.fn()
}));

const SOLANA_WALLET = '11111111111111111111111111111111';
const SOLANA_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const EVM_WALLET = '0x1000000000000000000000000000000000000001';
const EVM_TOKEN = '0x5000000000000000000000000000000000000005';
const TRANSACTION_HASH = `0x${'a'.repeat(64)}`;

const solanaBuy: CanonicalSolanaSwapEvent = {
  chain: 'solana',
  transactionIdentity: 'solana-buy-signature',
  slot: 351_000_000,
  walletAddress: SOLANA_WALLET,
  occurredAt: new Date('2026-01-01T12:00:00.000Z'),
  direction: 'buy',
  targetToken: SOLANA_TOKEN,
  tokenIn: USDC_MINT,
  tokenOut: SOLANA_TOKEN,
  amountIn: '25000000',
  amountOut: '5000000'
};

const solanaSell: CanonicalSolanaSwapEvent = {
  ...solanaBuy,
  transactionIdentity: 'solana-sell-signature',
  direction: 'sell',
  tokenIn: SOLANA_TOKEN,
  tokenOut: USDC_MINT,
  amountIn: '3000000',
  amountOut: '18000000'
};

const polymarketBuy: ConfirmedPolymarketTrade = {
  proxyWallet: EVM_WALLET,
  timestamp: new Date('2026-01-01T12:01:00.000Z'),
  conditionId: `0x${'b'.repeat(64)}`,
  asset: '1234567890123456789012345678901234567890',
  size: 12.5,
  price: 0.64,
  side: 'BUY',
  transactionHash: TRANSACTION_HASH,
  outcome: 'Yes',
  title: 'Will the lifecycle fixture pass?'
};

const polymarketSell: ConfirmedPolymarketTrade = {
  ...polymarketBuy,
  side: 'SELL',
  size: 4,
  price: 0.7
};

describe('production source-trade lifecycle adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recordSourceTradeEvent).mockResolvedValue(
      {} as Awaited<ReturnType<typeof recordSourceTradeEvent>>
    );
  });

  it('maps a Solana stablecoin BUY to exact atomic quantity and deterministic USD notional', () => {
    expect(buildSolanaSourceTradeInput({
      event: solanaBuy,
      source: 'solana-backfill'
    })).toEqual({
      chain: 'solana',
      sourceEventType: 'transaction',
      sourceEventId: 'solana-buy-signature',
      sourceEventIndex: SOLANA_WALLET,
      transactionHash: 'solana-buy-signature',
      walletAddress: SOLANA_WALLET,
      tokenMint: SOLANA_TOKEN,
      side: 'buy',
      quantity: '5000000',
      amountUsd: '25',
      priceUsd: null,
      eventAt: new Date('2026-01-01T12:00:00.000Z'),
      confirmationState: 'confirmed',
      confirmationEvidenceId: 'solana-backfill:solana-buy-signature:351000000'
    });
  });

  it('keeps non-stable Solana pricing unknown instead of using replay-dependent spot data', () => {
    const input = buildSolanaSourceTradeInput({
      event: { ...solanaBuy, tokenIn: 'AnotherQuoteToken', amountIn: '9000000' },
      source: 'solana-webhook'
    });

    expect(input).toMatchObject({
      quantity: '5000000',
      amountUsd: null,
      priceUsd: null,
      confirmationEvidenceId: 'solana-webhook:solana-buy-signature:351000000'
    });
  });

  it('maps a Solana stablecoin SELL to the exact target-token atomic quantity', () => {
    expect(buildSolanaSourceTradeInput({
      event: solanaSell,
      source: 'solana-webhook'
    })).toMatchObject({
      sourceEventId: 'solana-sell-signature',
      side: 'sell',
      quantity: '3000000',
      amountUsd: '18',
      priceUsd: null
    });
  });

  it('converges prefixed and raw Solana wallet identities', () => {
    const raw = buildSolanaSourceTradeInput({
      event: solanaBuy,
      source: 'solana-backfill'
    });
    const prefixed = buildSolanaSourceTradeInput({
      event: { ...solanaBuy, walletAddress: `solana:${SOLANA_WALLET}` },
      source: 'solana-webhook'
    });

    expect(prefixed.sourceEventIndex).toBe(raw.sourceEventIndex);
    expect(prefixed.walletAddress).toBe(raw.walletAddress);
  });

  it('content-addresses a Polymarket venue fill while retaining its native transaction identity', () => {
    const first = buildPolymarketSourceTradeInput({
      trade: polymarketBuy,
      quantity: '12500000',
      amountUsd: 8
    });
    const replay = buildPolymarketSourceTradeInput({
      trade: polymarketBuy,
      quantity: '12500000',
      amountUsd: 8
    });
    const mixedCaseReplay = buildPolymarketSourceTradeInput({
      trade: {
        ...polymarketBuy,
        proxyWallet: `0x${polymarketBuy.proxyWallet.slice(2).toUpperCase()}`,
        conditionId: `0x${polymarketBuy.conditionId.slice(2).toUpperCase()}`,
        transactionHash: `0x${polymarketBuy.transactionHash.slice(2).toUpperCase()}`
      },
      quantity: '012500000',
      amountUsd: 8
    });

    expect(replay).toEqual(first);
    expect(mixedCaseReplay).toEqual(first);
    expect(first).toMatchObject({
      chain: 'polygon',
      sourceEventType: 'venue_trade',
      sourceEventId: TRANSACTION_HASH,
      transactionHash: TRANSACTION_HASH,
      walletAddress: EVM_WALLET,
      tokenMint: polymarketBuy.asset,
      side: 'buy',
      quantity: '12500000',
      amountUsd: 8,
      priceUsd: 0.64,
      confirmationState: 'confirmed'
    });
    expect(first.sourceEventIndex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps a Polymarket SELL and distinguishes separate fills in one transaction', () => {
    const sell = buildPolymarketSourceTradeInput({
      trade: polymarketSell,
      quantity: '4000000',
      amountUsd: 2.8
    });
    const separateFill = buildPolymarketSourceTradeInput({
      trade: { ...polymarketSell, size: 5 },
      quantity: '5000000',
      amountUsd: 3.5
    });

    expect(sell).toMatchObject({
      sourceEventId: TRANSACTION_HASH,
      side: 'sell',
      quantity: '4000000',
      amountUsd: 2.8,
      priceUsd: 0.7
    });
    expect(separateFill.sourceEventIndex).not.toBe(sell.sourceEventIndex);
  });

  it('maps a reviewed Robinhood receipt to exact target-token quantity', () => {
    expect(buildRobinhoodSourceTradeInput({
      transactionHash: TRANSACTION_HASH,
      walletAddress: EVM_WALLET,
      tokenMint: EVM_TOKEN,
      side: 'sell',
      quantity: '4000',
      eventAt: new Date('2026-01-01T12:02:00.000Z'),
      blockNumber: 1234n
    })).toEqual({
      chain: 'robinhood-chain',
      sourceEventType: 'transaction',
      sourceEventId: TRANSACTION_HASH,
      sourceEventIndex: EVM_WALLET,
      transactionHash: TRANSACTION_HASH,
      walletAddress: EVM_WALLET,
      tokenMint: EVM_TOKEN,
      side: 'sell',
      quantity: '4000',
      amountUsd: null,
      priceUsd: null,
      eventAt: new Date('2026-01-01T12:02:00.000Z'),
      confirmationState: 'confirmed',
      confirmationEvidenceId: `robinhood-receipt:${TRANSACTION_HASH}:1234`
    });
  });

  it('normalizes Robinhood checksum casing into one transaction identity', () => {
    const mixedCaseHash = `0x${'Aa'.repeat(32)}`;
    const mixedCaseWallet = '0xAbCd000000000000000000000000000000000001';
    const mixedCaseToken = '0xAbCd000000000000000000000000000000000005';
    const source = buildRobinhoodSourceTradeInput({
      transactionHash: mixedCaseHash,
      walletAddress: mixedCaseWallet,
      tokenMint: mixedCaseToken,
      side: 'buy',
      quantity: '0005000',
      eventAt: new Date('2026-01-01T12:02:00.000Z'),
      blockNumber: 1234n
    });

    expect(source).toMatchObject({
      sourceEventId: mixedCaseHash.toLowerCase(),
      sourceEventIndex: mixedCaseWallet.toLowerCase(),
      transactionHash: mixedCaseHash.toLowerCase(),
      walletAddress: mixedCaseWallet.toLowerCase(),
      tokenMint: mixedCaseToken.toLowerCase(),
      side: 'buy',
      quantity: '5000'
    });
  });

  it('passes accepted events from all three chains to the DB lifecycle', async () => {
    await persistSolanaSourceTrade({
      event: solanaBuy,
      source: 'solana-webhook'
    });
    await persistPolymarketSourceTrade({
      trade: polymarketSell,
      quantity: '4000000',
      amountUsd: 2.8
    });
    await persistRobinhoodSourceTrade({
      transactionHash: TRANSACTION_HASH,
      walletAddress: EVM_WALLET,
      tokenMint: EVM_TOKEN,
      side: 'buy',
      quantity: '5000',
      eventAt: new Date('2026-01-01T12:02:00.000Z'),
      blockNumber: 1234n
    });

    expect(recordSourceTradeEvent).toHaveBeenCalledTimes(3);
    expect(vi.mocked(recordSourceTradeEvent).mock.calls.map(([input]) => input.chain))
      .toEqual(['solana', 'polygon', 'robinhood-chain']);
  });

  it.each([
    ['solana', () => persistSolanaSourceTrade({
      event: solanaBuy,
      source: 'solana-webhook'
    })],
    ['polygon', () => persistPolymarketSourceTrade({
      trade: polymarketBuy,
      quantity: '12500000',
      amountUsd: 8
    })],
    ['robinhood-chain', () => persistRobinhoodSourceTrade({
      transactionHash: TRANSACTION_HASH,
      walletAddress: EVM_WALLET,
      tokenMint: EVM_TOKEN,
      side: 'buy',
      quantity: '5000',
      eventAt: new Date('2026-01-01T12:02:00.000Z'),
      blockNumber: 1234n
    })]
  ] as const)('propagates %s lifecycle persistence failures', async (_chain, persist) => {
    vi.mocked(recordSourceTradeEvent).mockRejectedValueOnce(
      new Error('Source event identity collision with a different immutable payload')
    );

    await expect(persist()).rejects.toThrow('identity collision');
  });
});
