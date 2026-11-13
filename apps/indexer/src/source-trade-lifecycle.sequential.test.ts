import { describe, expect, it, vi } from 'vitest';
import {
  buildPolymarketSourceTradeInput,
  buildRobinhoodSourceTradeInput,
  buildSolanaSourceTradeInput
} from './source-trade-lifecycle.js';
import { USDC_MINT } from './parse.js';
import { parseConfirmedPolymarketTrade } from './polymarket-helpers.js';

vi.mock('@swat/db', () => ({}));

const wallet = '0x1000000000000000000000000000000000000001';
const token = '0x5000000000000000000000000000000000000005';
const transactionHash = `0x${'a'.repeat(64)}`;
const eventAt = new Date('2026-01-01T12:00:00.000Z');

describe('canonical source evidence eligibility', () => {
  it('keeps changed economics and timestamps in one ambiguous wallet/transaction observation group', () => {
    const raw = {
      proxyWallet: wallet, transactionHash, timestamp: 1767268800,
      conditionId: `0x${'b'.repeat(64)}`, asset: '1234567890',
      size: '12.5', price: '0.64', side: 'BUY', outcome: 'Yes', title: 'Fixture'
    };
    const first = buildPolymarketSourceTradeInput({
      trade: parseConfirmedPolymarketTrade(raw), quantity: '12500000', amountUsd: '8'
    });
    const changed = buildPolymarketSourceTradeInput({
      trade: parseConfirmedPolymarketTrade({ ...raw, size: '5', price: '0.7', timestamp: 1767268801 }),
      quantity: '5000000', amountUsd: '3.5'
    });
    expect(first.sourceEventIndex).toBe(`ambiguous-data-api-wallet-v1:${wallet}`);
    expect(changed.sourceEventIndex).toBe(first.sourceEventIndex);
    expect(changed).toMatchObject({ quantity: '5000000', amountUsd: '3.5', priceUsd: '0.7', confirmationState: 'observed' });
    expect(changed.eventAt).toEqual(new Date('2026-01-01T12:00:01.000Z'));
  });

  it('does not promote provider trade fields to confirmed chain evidence', () => {
    const source = buildPolymarketSourceTradeInput({
      trade: {
        proxyWallet: wallet, transactionHash, timestamp: eventAt,
        conditionId: `0x${'b'.repeat(64)}`, asset: '1234567890',
        size: '12.5', price: '0.64', side: 'BUY', outcome: 'Yes', title: 'Fixture'
      },
      quantity: '12500000', amountUsd: '8'
    });
    expect(source.confirmationState).toBe('observed');
    expect(source.confirmationEvidenceId).toMatch(/^polymarket-data-api-observation:/);
  });

  it('does not promote a receipt and height without canonical-block evidence', () => {
    const source = buildRobinhoodSourceTradeInput({
      transactionHash, walletAddress: wallet, tokenMint: token,
      side: 'buy', quantity: '500', eventAt, blockNumber: 1234n
    });
    expect(source.confirmationState).toBe('observed');
    expect(source.confirmationEvidenceId).toMatch(/^robinhood-receipt-observation:/);
  });

  it.each(['solana-backfill', 'solana-webhook'] as const)(
    'does not infer confirmation from the %s source label', (source) => {
      const input = buildSolanaSourceTradeInput({
        source,
        event: {
          chain: 'solana', transactionIdentity: 'fixture-signature', slot: 1234,
          walletAddress: '11111111111111111111111111111111', occurredAt: eventAt,
          direction: 'buy', targetToken: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          tokenIn: USDC_MINT, tokenOut: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          amountIn: '25000000', amountOut: '5000000'
        }
      });
      expect(input.confirmationState).toBe('observed');
      expect(input.confirmationEvidenceId).toMatch(/^solana-observation:/);
    }
  );
});
