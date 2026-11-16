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
  it.each([
    { proxy_wallet: `0x${'d'.repeat(40)}` },
    { transaction_hash: `0x${'d'.repeat(64)}` }
  ])('refuses conflicting aliases of source observation identity %j', (override) => {
    expect(() => parseConfirmedPolymarketTrade({
      proxyWallet: PROXY_WALLET, timestamp: 1719397500, conditionId: CONDITION_ID,
      asset: TOKEN_YES, size: '12.5', price: '0.64', side: 'BUY', transactionHash: TRANSACTION_HASH,
      outcome: 'Yes', title: 'Fixture', ...override
    })).toThrow(/Conflicting Polymarket/);
  });

  it('converges equivalent identity aliases while ignoring unreviewed fill/log/confirmation claims', () => {
    const raw = {
      proxyWallet: PROXY_WALLET, timestamp: 1719397500, conditionId: CONDITION_ID,
      asset: TOKEN_YES, size: '12.5', price: '0.64', side: 'BUY', transactionHash: TRANSACTION_HASH,
      outcome: 'Yes', title: 'Fixture'
    };
    const parsed = parseConfirmedPolymarketTrade({
      ...raw, proxy_wallet: PROXY_WALLET.toUpperCase(), transaction_hash: TRANSACTION_HASH.toUpperCase(),
      id: 'claimed-fill', trade_id: 'claimed-trade', logIndex: 17, status: 'CONFIRMED',
      confirmationState: 'finalized', confirmationEvidenceId: 'claimed-certificate'
    });
    expect(parsed).toEqual(parseConfirmedPolymarketTrade(raw));
  });

  it.each([
    { proxy_wallet: null }, { proxy_wallet: '' }, { transaction_hash: null }, { transaction_hash: '' }
  ])('refuses malformed explicit aliases instead of falling back to an alternate identity %j', (override) => {
    expect(() => parseConfirmedPolymarketTrade({
      proxyWallet: PROXY_WALLET, timestamp: 1719397500, conditionId: CONDITION_ID,
      asset: TOKEN_YES, size: '12.5', price: '0.64', side: 'BUY', transactionHash: TRANSACTION_HASH,
      outcome: 'Yes', title: 'Fixture', ...override
    })).toThrow(/Invalid Polymarket/);
  });

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
      size: '12.5',
      price: '0.64',
      side: 'BUY'
    });
  });

  it.each([
    ['0012.5000', '6.400e-1', '12.5', '0.64'],
    ['1e-6', '1.000000000000000000', '0.000001', '1'],
    ['9007199254.740993', '0.640000000000000001', '9007199254.740993', '0.640000000000000001']
  ])('normalizes exact decimal size %s and price %s', (size, price, expectedSize, expectedPrice) => {
    expect(parseConfirmedPolymarketTrade({
      proxyWallet: PROXY_WALLET, timestamp: 1719397500, conditionId: CONDITION_ID,
      asset: TOKEN_YES, size, price, side: 'BUY', transactionHash: TRANSACTION_HASH,
      outcome: 'Yes', title: 'Fixture'
    })).toMatchObject({ size: expectedSize, price: expectedPrice });
  });

  it.each([
    { size: true }, { size: null }, { size: {} }, { size: [] },
    { size: '0' }, { size: '-1' }, { size: '+1' }, { size: ' 1' }, { size: '1 ' },
    { size: '0x10' }, { size: '1e999999999' }, { size: '1e37' }, { size: '1e-37' },
    { size: '1'.repeat(129) }, { size: '1'.repeat(79) },
    { price: '1.000000000000000001' }, { price: '0' }, { price: 'NaN' }, { price: Infinity },
    { price: `0.${'0'.repeat(36)}1` }
  ])('refuses malformed, over-limit or non-positive decimal fields %j', (override) => {
    expect(() => parseConfirmedPolymarketTrade({
      proxyWallet: PROXY_WALLET, timestamp: 1719397500, conditionId: CONDITION_ID,
      asset: TOKEN_YES, size: '12.5', price: '0.64', side: 'BUY', transactionHash: TRANSACTION_HASH,
      outcome: 'Yes', title: 'Fixture', ...override
    })).toThrow(/Invalid Polymarket/);
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
  const requiredContext = {
    conditionId: CONDITION_ID, question: 'Fixture', endDate: '2026-08-01T00:00:00Z',
    outcomes: ['Yes', 'No'], clobTokenIds: [TOKEN_YES, TOKEN_NO],
    active: true, closed: false, acceptingOrders: true, negRisk: false, orderPriceMinTickSize: '0.01'
  };

  it.each([
    { active: undefined }, { active: 'true' }, { closed: undefined }, { closed: 'false' },
    { acceptingOrders: undefined }, { acceptingOrders: null }
  ])('refuses absent or malformed explicit lifecycle evidence %j', override => {
    expect(() => parsePolymarketMarketContext({ ...requiredContext, ...override }, CONDITION_ID)).toThrow();
  });

  it('retains unknown resolution without inventing unresolved and normalizes explicit CLOB order state', () => {
    const context = parsePolymarketMarketContext({ ...requiredContext,
      acceptingOrders: undefined, accepting_orders: false
    }, CONDITION_ID);
    expect(context).toMatchObject({ active: true, closed: false, acceptingOrders: false, resolutionStatus: 'unknown' });
  });

  it.each([
    { condition_id: `0x${'d'.repeat(64)}` }, { condition_id: null },
    { neg_risk: true }, { neg_risk: 'false' },
    { minimumTickSize: '0.02' }, { minimumTickSize: ['0.01'] },
    { minimum_tick_size: null }, { accepting_orders: false }, { accepting_orders: 'true' },
    { end_date: '2027-08-01T00:00:00Z' }, { end_date_iso: null }
  ])('rejects every conflicting or malformed supported metadata alias %j', override => {
    expect(() => parsePolymarketMarketContext({ ...requiredContext, ...override }, CONDITION_ID)).toThrow();
  });

  it('accepts canonical-equivalent supported metadata aliases without losing explicit state', () => {
    expect(parsePolymarketMarketContext({ ...requiredContext,
      condition_id: CONDITION_ID.toUpperCase(), neg_risk: false,
      minimumTickSize: '1e-2', minimum_tick_size: '0.0100', accepting_orders: true,
      end_date: '2026-08-01T00:00:00.000Z', end_date_iso: '2026-08-01T01:00:00+01:00'
    }, CONDITION_ID)).toMatchObject({ conditionId: CONDITION_ID, negRisk: false, tickSize: 0.01, acceptingOrders: true });
  });

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
      acceptingOrders: true,
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
