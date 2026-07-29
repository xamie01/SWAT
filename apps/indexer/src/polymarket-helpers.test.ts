import { describe, expect, it } from 'vitest';
import {
  assertPolymarketCertificationBatch,
  parseConfirmedPolymarketTrade,
  parsePolymarketMarketContext,
  parsePolymarketTimestamp
} from './polymarket-helpers.js';

const CONDITION_ID = `0x${'a'.repeat(64)}`;
const TRANSACTION_HASH = `0x${'b'.repeat(64)}`;
const PROXY_WALLET = `0x${'c'.repeat(40)}`;
const TOKEN_YES = '1234567890123456789012345678901234567890';
const TOKEN_NO = '9876543210987654321098765432109876543210';

describe('parsePolymarketTimestamp', () => {
  it('converts Unix seconds to milliseconds', () => {
    expect(parsePolymarketTimestamp('1719397500').toISOString()).toBe('2024-06-26T10:25:00.000Z');
  });

  it('preserves Unix milliseconds', () => {
    expect(parsePolymarketTimestamp(1719397500000).toISOString()).toBe('2024-06-26T10:25:00.000Z');
  });

  it.each(['', 'abc', 0, -1])('rejects invalid timestamp %j', (value) => {
    expect(() => parsePolymarketTimestamp(value)).toThrow(/Invalid Polymarket timestamp/);
  });
});

describe('confirmed Polymarket trade parsing', () => {
  it('preserves the exact proxy wallet and full outcome token ID', () => {
    const trade = parseConfirmedPolymarketTrade({
      proxyWallet: PROXY_WALLET.toUpperCase(),
      timestamp: 1719397500,
      conditionId: CONDITION_ID.toUpperCase(),
      asset: TOKEN_YES,
      size: 12.5,
      price: 0.64,
      side: 'BUY',
      transactionHash: TRANSACTION_HASH.toUpperCase(),
      outcome: 'Yes',
      title: 'Will the fixture pass?'
    });

    expect(trade).toMatchObject({
      proxyWallet: PROXY_WALLET,
      conditionId: CONDITION_ID,
      asset: TOKEN_YES,
      transactionHash: TRANSACTION_HASH,
      size: 12.5,
      price: 0.64,
      side: 'BUY'
    });
  });

  it.each([
    { asset: undefined },
    { proxyWallet: '0x1234' },
    { transactionHash: 'pending' },
    { price: 1.01 },
    { side: 'REDEEM' }
  ])('rejects incomplete or non-trade source data %j', (override) => {
    expect(() => parseConfirmedPolymarketTrade({
      proxyWallet: PROXY_WALLET,
      timestamp: 1719397500,
      conditionId: CONDITION_ID,
      asset: TOKEN_YES,
      size: 12.5,
      price: 0.64,
      side: 'BUY',
      transactionHash: TRANSACTION_HASH,
      outcome: 'Yes',
      title: 'Will the fixture pass?',
      ...override
    })).toThrow(/Invalid Polymarket/);
  });
});

describe('Polymarket market context parsing', () => {
  it('maps JSON-encoded outcomes to full token IDs and required market state', () => {
    const context = parsePolymarketMarketContext({
      conditionId: CONDITION_ID,
      question: 'Will the fixture pass?',
      slug: 'fixture-pass',
      endDate: '2026-08-01T00:00:00Z',
      outcomes: JSON.stringify(['Yes', 'No']),
      clobTokenIds: JSON.stringify([TOKEN_YES, TOKEN_NO]),
      active: true,
      closed: false,
      acceptingOrders: true,
      negRisk: false,
      orderPriceMinTickSize: 0.01,
      umaResolutionStatus: 'unresolved'
    }, CONDITION_ID);

    expect(context).toMatchObject({
      tickSize: 0.01,
      negRisk: false,
      acceptingOrders: true,
      resolutionStatus: 'unresolved',
      status: 'active'
    });
    expect(context.outcomes).toEqual([
      { tokenId: TOKEN_YES, outcome: 'Yes', outcomeIndex: 0 },
      { tokenId: TOKEN_NO, outcome: 'No', outcomeIndex: 1 }
    ]);
  });

  it.each([
    { negRisk: undefined },
    { endDate: undefined },
    { clobTokenIds: JSON.stringify([TOKEN_YES]) },
    { orderPriceMinTickSize: undefined }
  ])('fails closed when required context is missing %j', (override) => {
    expect(() => parsePolymarketMarketContext({
      conditionId: CONDITION_ID,
      question: 'Will the fixture pass?',
      endDate: '2026-08-01T00:00:00Z',
      outcomes: JSON.stringify(['Yes', 'No']),
      clobTokenIds: JSON.stringify([TOKEN_YES, TOKEN_NO]),
      active: true,
      closed: false,
      negRisk: false,
      orderPriceMinTickSize: 0.01,
      ...override
    }, CONDITION_ID)).toThrow();
  });
});

describe('Polymarket certification assertions', () => {
  const trade = parseConfirmedPolymarketTrade({
    proxyWallet: PROXY_WALLET,
    timestamp: 1785542340,
    conditionId: CONDITION_ID,
    asset: TOKEN_YES,
    size: 1,
    price: 0.5,
    side: 'BUY',
    transactionHash: TRANSACTION_HASH,
    outcome: 'Yes',
    title: 'Will the fixture pass?'
  });

  it('requires 100% context coverage and bounded lag', () => {
    expect(assertPolymarketCertificationBatch({
      trades: [trade],
      mappedTokenIds: [TOKEN_YES],
      now: new Date('2026-08-01T00:00:00Z'),
      maxLagSeconds: 60
    })).toEqual({ contextCoverage: 1, lagSeconds: 60 });
  });

  it('rejects missing context or stale fixture trades', () => {
    expect(() => assertPolymarketCertificationBatch({
      trades: [trade],
      mappedTokenIds: [],
      now: new Date('2026-08-01T00:00:00Z')
    })).toThrow(/coverage/);
    expect(() => assertPolymarketCertificationBatch({
      trades: [trade],
      mappedTokenIds: [TOKEN_YES],
      now: new Date('2026-08-01T00:10:01Z'),
      maxLagSeconds: 600
    })).toThrow(/lag/);
  });
});
