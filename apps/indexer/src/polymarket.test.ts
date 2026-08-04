import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPolymarketOutcomeContext,
  insertParsedTransaction,
  recordSourceTradeEvent,
  recordConfirmedPolymarketTrade,
  refreshWalletActivity,
  upsertPolymarketContext,
  upsertToken,
  upsertWallet
} from '@swat/db';
import { REDIS_CHANNELS } from '@swat/shared';
import { backfillPolymarketWallet, fetchConfirmedPolymarketTradePages } from './polymarket.js';

vi.mock('@swat/db', () => ({
  getPolymarketMarket: vi.fn(),
  getPolymarketOutcomeContext: vi.fn(),
  insertParsedTransaction: vi.fn(),
  query: vi.fn(),
  recordSourceTradeEvent: vi.fn(),
  recordConfirmedPolymarketTrade: vi.fn(),
  refreshWalletActivity: vi.fn(),
  upsertPolymarketContext: vi.fn(),
  upsertToken: vi.fn(),
  upsertWallet: vi.fn()
}));

const QUERY_WALLET = `0x${'1'.repeat(40)}`;
const PROXY_WALLET = `0x${'2'.repeat(40)}`;
const CONDITION_ID = `0x${'a'.repeat(64)}`;
const TRANSACTION_HASH = `0x${'b'.repeat(64)}`;
const TOKEN_YES = '1234567890123456789012345678901234567890';
const TOKEN_NO = '9876543210987654321098765432109876543210';

const trade = {
  proxyWallet: PROXY_WALLET,
  timestamp: 1719397500,
  conditionId: CONDITION_ID,
  asset: TOKEN_YES,
  size: 12.5,
  price: 0.64,
  side: 'BUY',
  transactionHash: TRANSACTION_HASH,
  outcome: 'Yes',
  title: 'Will the fixture pass?'
};

const market = {
  conditionId: CONDITION_ID,
  question: 'Will the fixture pass?',
  slug: 'fixture-pass',
  endDate: '2026-08-01T00:00:00Z',
  resolutionSource: 'Fixture oracle',
  outcomes: JSON.stringify(['Yes', 'No']),
  clobTokenIds: JSON.stringify([TOKEN_YES, TOKEN_NO]),
  active: true,
  closed: false,
  acceptingOrders: true,
  negRisk: false,
  orderPriceMinTickSize: 0.01,
  umaResolutionStatus: 'unresolved'
};

const persistedContext = {
  tokenId: `polygon:${TOKEN_YES}`,
  conditionId: CONDITION_ID,
  outcome: 'Yes',
  outcomeIndex: 0,
  question: 'Will the fixture pass?',
  slug: 'fixture-pass',
  endDate: new Date('2026-08-01T00:00:00Z'),
  marketStatus: 'active',
  tickSize: '0.01',
  negRisk: false,
  acceptingOrders: true,
  resolutionStatus: 'unresolved',
  contextComplete: true
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('Polymarket confirmed-trade backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(upsertToken).mockResolvedValue();
    vi.mocked(upsertWallet).mockResolvedValue();
    vi.mocked(upsertPolymarketContext).mockResolvedValue();
    vi.mocked(recordConfirmedPolymarketTrade).mockResolvedValue(true);
    vi.mocked(recordSourceTradeEvent).mockResolvedValue({
      event: { id: 'source-trade-1' }
    } as Awaited<ReturnType<typeof recordSourceTradeEvent>>);
    vi.mocked(insertParsedTransaction).mockResolvedValue(true);
    vi.mocked(refreshWalletActivity).mockResolvedValue();
  });

  it('uses /trades and persists the exact proxy wallet, asset, and market context', async () => {
    vi.mocked(getPolymarketOutcomeContext)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(persistedContext);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('data-api.polymarket.com/trades')) return jsonResponse([trade]);
      if (url.includes('gamma-api.polymarket.com/markets')) return jsonResponse([market]);
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const publish = vi.fn(async () => 1);

    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl, publish });

    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining('/trades?user='),
      expect.stringContaining('/markets?condition_id=')
    ]);
    expect(fetchImpl.mock.calls.every(([input]) => !String(input).includes('/activity'))).toBe(true);
    expect(upsertPolymarketContext).toHaveBeenCalledWith(expect.objectContaining({
      conditionId: CONDITION_ID,
      tickSize: 0.01,
      negRisk: false,
      resolutionStatus: 'unresolved',
      outcomes: [
        { tokenId: TOKEN_YES, outcome: 'Yes', outcomeIndex: 0 },
        { tokenId: TOKEN_NO, outcome: 'No', outcomeIndex: 1 }
      ]
    }));
    expect(upsertWallet).toHaveBeenCalledWith({
      address: PROXY_WALLET,
      chain: 'polygon',
      source: 'discovered',
      discoveryMethod: 'polymarket-proxy'
    });
    expect(recordConfirmedPolymarketTrade).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash: TRANSACTION_HASH,
      proxyWallet: PROXY_WALLET,
      asset: TOKEN_YES,
      conditionId: CONDITION_ID,
      side: 'BUY',
      size: 12.5,
      price: 0.64
    }));
    expect(insertParsedTransaction).toHaveBeenCalledWith(expect.objectContaining({
      chain: 'polygon',
      signature: TRANSACTION_HASH,
      walletAddress: PROXY_WALLET,
      tokenOut: TOKEN_YES,
      targetToken: TOKEN_YES,
      amountIn: '8000000',
      amountOut: '12500000',
      direction: 'buy',
      programId: 'polymarket-data-api'
    }));
    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      chain: 'polygon',
      sourceEventType: 'venue_trade',
      sourceEventId: TRANSACTION_HASH,
      transactionHash: TRANSACTION_HASH,
      walletAddress: PROXY_WALLET,
      tokenMint: TOKEN_YES,
      side: 'buy',
      quantity: '12500000',
      amountUsd: 8,
      priceUsd: 0.64,
      eventAt: new Date('2024-06-26T10:25:00.000Z'),
      confirmationState: 'confirmed'
    }));
    expect(refreshWalletActivity).toHaveBeenCalledWith(
      `polygon:${PROXY_WALLET}`,
      new Date('2024-06-26T10:25:00.000Z'),
      1
    );
    expect(publish).toHaveBeenCalledWith(
      REDIS_CHANNELS.walletSwap,
      expect.stringContaining(`"tokenMint":"polygon:${TOKEN_YES}"`)
    );
    expect(publish).toHaveBeenCalledWith(
      REDIS_CHANNELS.walletSwap,
      expect.stringContaining('source-trade-1')
    );
    expect(result).toMatchObject({ fetched: 1, inserted: 1, skipped: 0, failed: 0 });
  });

  it('rejects an activity-shaped row without an exact asset token ID', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ ...trade, asset: undefined }])) as typeof fetch;

    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl,
      publish: vi.fn()
    });

    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 0, failed: 1 });
    expect(upsertPolymarketContext).not.toHaveBeenCalled();
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
  });

  it('repairs lifecycle persistence when the legacy transaction is already present', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    vi.mocked(insertParsedTransaction).mockResolvedValue(false);
    const fetchImpl = vi.fn(async () => jsonResponse([trade])) as typeof fetch;
    const publish = vi.fn(async () => 1);

    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl, publish });

    expect(recordSourceTradeEvent).toHaveBeenCalledTimes(1);
    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: TRANSACTION_HASH,
      quantity: '12500000'
    }));
    expect(publish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 1, failed: 0 });
  });

  it('persists confirmed SELL quantities and direction in the canonical lifecycle', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = vi.fn(async () => jsonResponse([{ ...trade, side: 'SELL', size: 4, price: 0.7 }])) as typeof fetch;

    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl,
      publish: vi.fn(async () => 1)
    });

    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      chain: 'polygon',
      side: 'sell',
      quantity: '4000000',
      amountUsd: 2.8,
      priceUsd: 0.7
    }));
    expect(insertParsedTransaction).toHaveBeenCalledWith(expect.objectContaining({
      tokenIn: TOKEN_YES,
      tokenOut: expect.stringMatching(/^0x/i),
      amountIn: '4000000',
      amountOut: '2800000',
      direction: 'sell'
    }));
    expect(result).toMatchObject({ fetched: 1, inserted: 1, skipped: 0, failed: 0 });
  });

  it('fails the batch on lifecycle persistence failure without publishing an accepted event', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    vi.mocked(recordSourceTradeEvent).mockRejectedValueOnce(
      new Error('canonical lifecycle unavailable')
    );
    const publish = vi.fn(async () => 1);
    const fetchImpl = vi.fn(async () => jsonResponse([trade])) as typeof fetch;

    await expect(backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl,
      publish
    })).rejects.toMatchObject({
      name: 'IngestionBatchError',
      result: { fetched: 1, inserted: 0, skipped: 0, failed: 1 }
    });

    expect(recordSourceTradeEvent).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(refreshWalletActivity).not.toHaveBeenCalled();
  });

  it('fails closed when Gamma does not map the traded asset', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(null);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('data-api.polymarket.com/trades')) return jsonResponse([trade]);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return jsonResponse([{ ...market, clobTokenIds: JSON.stringify([TOKEN_NO, `${TOKEN_NO}1`]) }]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl,
      publish: vi.fn()
    });

    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 0, failed: 1 });
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
  });
});

describe('Polymarket trade paging', () => {
  const USER = `0x${'3'.repeat(40)}`;

  function page(count: number, timestampBase: number): unknown[] {
    return Array.from({ length: count }, (_, index) => ({
      ...trade,
      timestamp: timestampBase - index
    }));
  }

  function urlsOf(fetchImpl: { mock: { calls: unknown[][] } }): URL[] {
    return fetchImpl.mock.calls.map(([input]) => new URL(String(input)));
  }

  it('walks offsets until a short page ends the history', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      return jsonResponse(offset === 0 ? page(2, 1_000) : page(1, 998));
    }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };

    const trades = await fetchConfirmedPolymarketTradePages({
      user: USER,
      fetchImpl,
      pageLimit: 2,
      maxOffset: 100
    });

    expect(trades).toHaveLength(3);
    expect(urlsOf(fetchImpl).map((url) => url.searchParams.get('offset'))).toEqual(['0', '2']);
    // A single window is enough here, so `end` is never pinned.
    expect(urlsOf(fetchImpl).every((url) => url.searchParams.get('end') === null)).toBe(true);
  });

  it('re-anchors on a new end window instead of walking past the offset cap', async () => {
    // The API answers an offset past its cap with a 400 rather than clamping,
    // so a flat walk would abort the whole backfill for a high-volume wallet.
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      const end = url.searchParams.get('end');
      if (offset > 2) return jsonResponse({ error: 'offset out of range' }, 400);
      if (end === null) return jsonResponse(page(2, 1_000 - offset));
      if (end === '997') return jsonResponse(offset === 0 ? page(2, 997) : page(1, 995));
      return jsonResponse([]);
    }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };

    const trades = await fetchConfirmedPolymarketTradePages({
      user: USER,
      fetchImpl,
      pageLimit: 2,
      maxOffset: 4
    });

    const windows = urlsOf(fetchImpl).map((url) => [
      url.searchParams.get('offset'),
      url.searchParams.get('end')
    ]);
    expect(windows).toEqual([
      ['0', null],
      ['2', null],
      // Budget spent: re-anchor on the oldest fill seen and reset the offset.
      ['0', '997'],
      ['2', '997']
    ]);
    expect(trades).toHaveLength(7);
  });

  it('stops instead of looping when a window cannot advance', async () => {
    // Every window returns the same oldest timestamp, so re-anchoring would
    // re-read the same rows forever.
    const fetchImpl = vi.fn(async () => jsonResponse(page(2, 500))) as unknown as
      typeof fetch & { mock: { calls: unknown[][] } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const trades = await fetchConfirmedPolymarketTradePages({
      user: USER,
      fetchImpl,
      pageLimit: 2,
      maxOffset: 4
    });

    expect(trades.length).toBeGreaterThan(0);
    // Truncation is loud: a silent stop here would read as a complete backfill.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not advance the trade window'));
    warn.mockRestore();
  });

  it('propagates a non-OK page as an error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, 500)) as typeof fetch;
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl }))
      .rejects.toThrow('Polymarket Data API returned status 500');
  });
});
