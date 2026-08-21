import { OrderSide, OrderType } from '@polymarket/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `polymarket.ts` constructs an ethers.Wallet at module scope, so this must be a
// well-formed 32-byte key. Deliberately a throwaway constant, never funded.
process.env.EVM_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
process.env.POLYMARKET_SIGNATURE_TYPE = 'EOA';
process.env.POLYMARKET_BUILDER_CODE = `0x${'a'.repeat(64)}`;

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  recordCopyExecutionEvidence: vi.fn(),
  transitionCopyExecution: vi.fn()
}));

const actionMocks = vi.hoisted(() => ({
  fetchBalanceAllowance: vi.fn(),
  fetchBuilderFeeRates: vi.fn()
}));

const marketStateMocks = vi.hoisted(() => ({
  assertPolymarketMarketOpenForSubmission: vi.fn()
}));

vi.mock('@swat/db', () => dbMocks);
vi.mock('@polymarket/client/actions', () => actionMocks);
vi.mock('./polymarket-market-state.js', () => marketStateMocks);

const {
  setPolymarketClientForTesting,
  setPolymarketLiveReadiness,
  triggerPolymarket
} = await import('./polymarket.js');

/**
 * `S4-M16` at the submission boundary.
 *
 * `polymarket-mirror-bound.test.ts` pins the decision; this pins that the
 * decision reaches the signed order — a FAK with the master-derived bound — and
 * that a refusal surfaces as a *skip*, not a failure. Those are different
 * regressions: the planner can be perfectly correct while the order still goes
 * out bounded on our own stale snapshot.
 */

const TOKEN_ID = 'token-mirror';
const CONDITION_ID = `0x${'1'.repeat(64)}`;
const BUILDER_CODE = `0x${'a'.repeat(64)}`;

function paginator(items: unknown[]) {
  const page = { items, hasMore: false };
  return {
    firstPage: vi.fn().mockResolvedValue(page),
    from: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield page;
    }
  };
}

function orderBook(params: {
  asks?: Array<{ price: string; size: string }>;
  bids?: Array<{ price: string; size: string }>;
  tickSize?: string;
  minOrderSize?: string;
}) {
  return {
    conditionId: CONDITION_ID,
    tokenId: TOKEN_ID,
    timestamp: Date.now(),
    asks: params.asks ?? [],
    bids: params.bids ?? [],
    minOrderSize: params.minOrderSize ?? '1',
    tickSize: params.tickSize ?? '0.01',
    negRisk: false,
    hash: 'a'.repeat(40)
  };
}

function clientWithBook(book: ReturnType<typeof orderBook>) {
  const mock = {
    fetchOrderBook: vi.fn().mockResolvedValue(book),
    listOpenOrders: vi.fn().mockReturnValue(paginator([])),
    createMarketOrder: vi.fn().mockResolvedValue({ builder: BUILDER_CODE }),
    postOrder: vi.fn().mockResolvedValue({
      ok: true,
      orderId: 'order-id',
      status: 'live',
      transactionsHashes: [],
      tradeIds: []
    }),
    waitForOrderFillSettlement: vi.fn().mockResolvedValue([]),
    listAccountTrades: vi.fn().mockReturnValue(paginator([]))
  };
  setPolymarketClientForTesting(
    mock as unknown as Parameters<typeof setPolymarketClientForTesting>[0]
  );
  return mock;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.query.mockResolvedValue([]);
  actionMocks.fetchBalanceAllowance.mockResolvedValue({ balance: '1000000000', allowances: {} });
  marketStateMocks.assertPolymarketMarketOpenForSubmission.mockResolvedValue({
    conditionId: CONDITION_ID,
    active: true,
    closed: false,
    acceptingOrders: true,
    resolutionStatus: 'unresolved',
    endDate: new Date(Date.now() + 86_400_000)
  });
  setPolymarketLiveReadiness(true);
  process.env.POLYMARKET_FEE_BUFFER_BPS = '300';
  delete process.env.POLYMARKET_SLIPPAGE_BPS;
  delete process.env.POLYMARKET_MAX_ENTRY_PRICE;
  delete process.env.POLYMARKET_MIN_EXIT_PRICE;
  delete process.env.POLYMARKET_MAX_BOOK_AGE_MS;
  delete process.env.POLYMARKET_MIRROR_TOLERANCE_BPS;
});

describe('polymarket mirrored order submission', () => {
  it('signs a FAK bounded on the master fill, not on the walked book level', async () => {
    // Ask is 0.40; master filled at 0.44. A book-derived bound would sign 0.40 and
    // no-fill on the first adverse tick. The mirror bound is 0.44 × 1.05 → 0.46.
    const client = clientWithBook(orderBook({ asks: [{ price: '0.40', size: '1000' }] }));

    const result = await triggerPolymarket({
      signalId: 'sig-mirror-buy',
      tokenID: TOKEN_ID,
      spendAmountUsd: 20,
      direction: 'buy',
      mirror: { sourceTradeId: 'src-1', masterFillPriceUsd: 0.44, toleranceBps: 500 }
    });

    expect(client.createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      side: OrderSide.BUY,
      orderType: OrderType.FAK,
      maxPrice: 0.46
    }));
    expect(result.mirrorBoundPrice).toBe(0.46);
    expect(Math.round(result.mirrorTrackingBps ?? 0)).toBe(455);
  });

  it('signs a sell bounded below the master fill, never resting', async () => {
    const client = clientWithBook(orderBook({ bids: [{ price: '0.60', size: '1000' }] }));

    await triggerPolymarket({
      signalId: 'sig-mirror-sell',
      tokenID: TOKEN_ID,
      spendAmountUsd: 0,
      direction: 'sell',
      sellShares: 50,
      mirror: { sourceTradeId: 'src-2', masterFillPriceUsd: 0.62, toleranceBps: 500 }
    });

    expect(client.createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      side: OrderSide.SELL,
      orderType: OrderType.FAK,
      minPrice: 0.59
    }));
  });

  it('skips instead of chasing when the book has run past the master fill', async () => {
    const client = clientWithBook(orderBook({ asks: [{ price: '0.71', size: '1000' }] }));

    await expect(triggerPolymarket({
      signalId: 'sig-chase',
      tokenID: TOKEN_ID,
      spendAmountUsd: 20,
      direction: 'buy',
      mirror: { sourceTradeId: 'src-3', masterFillPriceUsd: 0.4 }
    })).rejects.toThrow(/Polymarket Protection.*book-moved-past-master-fill/s);

    // Never signed, so nothing to cancel and no venue round-trip spent.
    expect(client.createMarketOrder).not.toHaveBeenCalled();
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('fails closed when the mirror path carries no master fill price', async () => {
    const client = clientWithBook(orderBook({ asks: [{ price: '0.40', size: '1000' }] }));

    await expect(triggerPolymarket({
      signalId: 'sig-no-price',
      tokenID: TOKEN_ID,
      spendAmountUsd: 20,
      direction: 'buy',
      mirror: { sourceTradeId: 'src-4', masterFillPriceUsd: null }
    })).rejects.toThrow(/Polymarket Protection.*master-fill-price-unavailable/s);
    expect(client.createMarketOrder).not.toHaveBeenCalled();
  });

  it('leaves a manual or stop-loss order on the book-derived bound', async () => {
    // No `mirror` context: there is no master, so the walked level is the only
    // reference such an order has. Making this fail closed would break stop-loss.
    const client = clientWithBook(orderBook({ asks: [{ price: '0.40', size: '1000' }] }));

    await triggerPolymarket({
      signalId: 'sig-manual',
      tokenID: TOKEN_ID,
      spendAmountUsd: 20,
      direction: 'buy'
    });

    expect(client.createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      maxPrice: 0.4,
      orderType: OrderType.FAK
    }));
  });

  it('keeps the operator safe-price ceiling above the mirror tolerance', async () => {
    // A generous mirror tolerance must not widen POLYMARKET_MAX_ENTRY_PRICE. The
    // bound, not the book level, is what gets checked.
    process.env.POLYMARKET_MAX_ENTRY_PRICE = '0.5';
    const client = clientWithBook(orderBook({ asks: [{ price: '0.49', size: '1000' }] }));

    await expect(triggerPolymarket({
      signalId: 'sig-ceiling',
      tokenID: TOKEN_ID,
      spendAmountUsd: 20,
      direction: 'buy',
      mirror: { sourceTradeId: 'src-5', masterFillPriceUsd: 0.49, toleranceBps: 1_000 }
    })).rejects.toThrow(/outside safe bounds/);
    expect(client.createMarketOrder).not.toHaveBeenCalled();
  });

  it('skips a sub-minimum mirrored order rather than rounding it up to the floor', async () => {
    // 1 USD at 0.50 is 2 shares against a 5-share venue minimum. Rounding up would
    // spend more than the user sized; rounding down submits a guaranteed rejection.
    const client = clientWithBook(orderBook({
      asks: [{ price: '0.50', size: '1000' }],
      minOrderSize: '5'
    }));

    await expect(triggerPolymarket({
      signalId: 'sig-dust',
      tokenID: TOKEN_ID,
      spendAmountUsd: 1,
      direction: 'buy',
      mirror: { sourceTradeId: 'src-6', masterFillPriceUsd: 0.5 }
    })).rejects.toThrow(/Polymarket Protection.*5-share minimum/s);
    expect(client.createMarketOrder).not.toHaveBeenCalled();
  });

  it('skips an off-tick book instead of failing the job', async () => {
    // 0.4237 is off the 0.01 grid the market is currently on, so the CLOB would
    // reject any order priced against it. Recorded as a skip with a reason, which
    // is what the job handler matches on — a bare failure would retry forever.
    const client = clientWithBook(orderBook({ asks: [{ price: '0.4237', size: '1000' }] }));

    await expect(triggerPolymarket({
      signalId: 'sig-offtick',
      tokenID: TOKEN_ID,
      spendAmountUsd: 20,
      direction: 'buy',
      mirror: { sourceTradeId: 'src-7', masterFillPriceUsd: 0.42 }
    })).rejects.toThrow(/Polymarket Protection: order-book price is off the current tick-size grid/);
    expect(client.createMarketOrder).not.toHaveBeenCalled();
  });
});

describe('polymarket staleness at the submission boundary (S4-M18)', () => {
  const NOW = 1_760_000_000_000;
  const MINUTE = 60_000;

  function marketResolvingIn(ms: number) {
    marketStateMocks.assertPolymarketMarketOpenForSubmission.mockResolvedValue({
      conditionId: CONDITION_ID,
      active: true,
      closed: false,
      acceptingOrders: true,
      resolutionStatus: 'unresolved',
      endDate: new Date(NOW + ms),
      secondsDelay: null
    });
  }

  // The item's whole claim, pinned at the wiring rather than in the library:
  // `polymarket-staleness.test.ts` proves the budget curve, this proves a real
  // order is measured against it. The same signal age must survive on a
  // long-dated market and be refused near resolution.
  it('accepts a signal age on a long-dated market that it refuses near resolution', async () => {
    const client = clientWithBook(orderBook({ asks: [{ price: '0.40', size: '1000' }] }));
    const signalAt = new Date(NOW - 5 * MINUTE);

    marketResolvingIn(30 * 24 * 60 * MINUTE);
    await triggerPolymarket({
      signalId: 'sig-fresh-long-dated',
      tokenID: TOKEN_ID,
      spendAmountUsd: 20,
      direction: 'buy',
      mirror: { sourceTradeId: 'src-1', masterFillPriceUsd: 0.44, toleranceBps: 500 },
      sourceEventAt: signalAt,
      now: () => NOW
    });
    expect(client.createMarketOrder).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const nearClient = clientWithBook(orderBook({ asks: [{ price: '0.40', size: '1000' }] }));
    actionMocks.fetchBalanceAllowance.mockResolvedValue({ balance: '1000000000', allowances: {} });
    dbMocks.query.mockResolvedValue([]);
    marketResolvingIn(10 * MINUTE);

    await expect(triggerPolymarket({
      signalId: 'sig-stale-near-resolution',
      tokenID: TOKEN_ID,
      spendAmountUsd: 20,
      direction: 'buy',
      mirror: { sourceTradeId: 'src-2', masterFillPriceUsd: 0.44, toleranceBps: 500 },
      sourceEventAt: signalAt,
      now: () => NOW
    })).rejects.toThrow(/Polymarket Protection/);

    // Nothing may reach the venue once the budget is exceeded.
    expect(nearClient.createMarketOrder).not.toHaveBeenCalled();
    expect(nearClient.postOrder).not.toHaveBeenCalled();
  });

  it('carries the reason code, so the skip is actionable rather than generic', async () => {
    // S4-M24: a skip reason has to name what happened. The marker is what makes
    // the executor record a skipped trade instead of failing the job and retrying
    // into an even older signal.
    clientWithBook(orderBook({ asks: [{ price: '0.40', size: '1000' }] }));
    marketResolvingIn(10 * MINUTE);

    await expect(triggerPolymarket({
      signalId: 'sig-stale-code',
      tokenID: TOKEN_ID,
      spendAmountUsd: 20,
      direction: 'buy',
      mirror: { sourceTradeId: 'src-3', masterFillPriceUsd: 0.44, toleranceBps: 500 },
      sourceEventAt: new Date(NOW - 5 * MINUTE),
      now: () => NOW
    })).rejects.toThrow(/signal-age-exceeds/);
  });

  it('leaves an order with no source event alone', async () => {
    // A manual execute or a stop-loss exit has no master and no source event.
    // Gating those on a timestamp that does not exist would refuse every one of
    // them, which is why `sourceEventAt` is optional rather than defaulted.
    const client = clientWithBook(orderBook({ asks: [{ price: '0.40', size: '1000' }] }));
    marketResolvingIn(10 * MINUTE);

    await triggerPolymarket({
      signalId: 'sig-manual-no-source',
      tokenID: TOKEN_ID,
      spendAmountUsd: 20,
      direction: 'buy',
      now: () => NOW
    });

    expect(client.createMarketOrder).toHaveBeenCalledTimes(1);
  });
});
