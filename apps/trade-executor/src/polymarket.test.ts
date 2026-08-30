import { OrderSide, OrderType, WalletType, production } from '@polymarket/client';
import { AssetType } from '@polymarket/bindings/clob';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const polymarketActionMocks = vi.hoisted(() => ({
  fetchBalanceAllowance: vi.fn(),
  fetchBuilderFeeRates: vi.fn()
}));

// The live market-state gate has its own suite in polymarket-market-state.test.ts;
// here it is stubbed so these tests stay about order flow, with one case below
// proving the gate is actually wired into the submission path.
const marketStateMocks = vi.hoisted(() => ({
  assertPolymarketMarketOpenForSubmission: vi.fn()
}));

process.env.EVM_PRIVATE_KEY = 'test-only-placeholder';
process.env.POLYMARKET_SIGNATURE_TYPE = 'EOA';
process.env.POLYMARKET_BUILDER_CODE = `0x${'a'.repeat(64)}`;

vi.mock('ethers', () => {
  const mockProvider = {
    getNetwork: vi.fn().mockResolvedValue({ chainId: 137 })
  };
  const mockWallet = {
    address: '0x1111111111111111111111111111111111111111',
    connect: vi.fn().mockReturnThis()
  };
  return {
    ethers: {
      providers: {
        JsonRpcProvider: vi.fn().mockReturnValue(mockProvider)
      },
      Wallet: vi.fn().mockReturnValue(mockWallet),
      utils: {
        getAddress: vi.fn((value: string) => value)
      }
    }
  };
});

vi.mock('@swat/db', () => ({
  query: vi.fn().mockResolvedValue([]),
  recordCopyExecutionEvidence: vi.fn().mockResolvedValue(undefined),
  transitionCopyExecution: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@polymarket/client/actions', () => polymarketActionMocks);

vi.mock('./polymarket-market-state.js', () => marketStateMocks);

vi.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {}
}));

type MockClient = ReturnType<typeof createMockClient>;

function paginator(items: any[]) {
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
  tokenId: string;
  asks?: Array<{ price: string; size: string }>;
  bids?: Array<{ price: string; size: string }>;
  minimumShares?: string;
  tickSize?: string;
  timestamp?: number;
}) {
  return {
    conditionId: `0x${'1'.repeat(64)}`,
    tokenId: params.tokenId,
    timestamp: params.timestamp ?? Date.now(),
    asks: params.asks ?? [],
    bids: params.bids ?? [],
    minOrderSize: params.minimumShares ?? '1',
    tickSize: params.tickSize ?? '0.01',
    negRisk: false,
    hash: 'a'.repeat(40)
  };
}

function createMockClient() {
  return {
    credentials: { key: 'key', secret: 'secret', passphrase: 'passphrase' },
    account: {
      signer: '0x1111111111111111111111111111111111111111',
      wallet: '0x1111111111111111111111111111111111111111',
      walletType: WalletType.EOA
    },
    fetchClosedOnlyMode: vi.fn().mockResolvedValue(false),
    fetchOrderBook: vi.fn(),
    fetchOrder: vi.fn(),
    listOpenOrders: vi.fn().mockReturnValue(paginator([])),
    createMarketOrder: vi.fn().mockResolvedValue({
      builder: `0x${'a'.repeat(64)}`
    }),
    postOrder: vi.fn().mockResolvedValue({
      ok: true,
      orderId: 'order-id',
      status: 'live',
      makingAmount: '1',
      takingAmount: '1',
      transactionsHashes: [],
      tradeIds: []
    }),
    waitForOrderFillSettlement: vi.fn().mockResolvedValue([]),
    listAccountTrades: vi.fn().mockReturnValue(paginator([])),
    cancelOrder: vi.fn().mockResolvedValue({ canceled: [], notCanceled: {} })
  };
}

function configureConfirmedFill(params: {
  client: MockClient;
  tokenId: string;
  orderId?: string;
  tradeId?: string;
  price: string;
  size: string;
  feeRateBps?: string;
  transactionHash?: string;
}) {
  const orderId = params.orderId ?? 'order-id';
  const tradeId = params.tradeId ?? 'trade-id';
  const transactionHash = params.transactionHash ?? `0x${'2'.repeat(64)}`;
  params.client.postOrder.mockResolvedValue({
    ok: true,
    orderId,
    status: 'matched',
    makingAmount: params.size,
    takingAmount: params.size,
    transactionsHashes: [],
    tradeIds: [tradeId]
  });
  params.client.waitForOrderFillSettlement.mockResolvedValue([transactionHash]);
  params.client.listAccountTrades.mockReturnValue(paginator([{
    id: tradeId,
    conditionId: `0x${'1'.repeat(64)}`,
    tokenId: params.tokenId,
    owner: 'owner',
    makerAddress: '0x1111111111111111111111111111111111111111',
    takerOrderId: orderId,
    side: 'BUY',
    traderSide: 'TAKER',
    price: params.price,
    size: params.size,
    outcome: 'Yes',
    status: 'CONFIRMED',
    feeRateBps: params.feeRateBps ?? '0',
    bucketIndex: 0,
    transactionHash,
    makerOrders: [],
    matchedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }]));
}

function pendingPolymarketTrade(params: {
  id?: string;
  signalId?: string;
  copyExecutionId?: string | null;
  tokenId: string;
  orderId: string;
  direction?: 'buy' | 'sell';
  submittedAt?: Date;
}) {
  return {
    id: params.id ?? `db-${params.orderId}`,
    signal_id: params.signalId ?? `sig-${params.orderId}`,
    copy_execution_id: params.copyExecutionId ?? null,
    token_mint: `polygon:${params.tokenId}`,
    direction: params.direction ?? 'buy',
    venue_order_id: params.orderId,
    submitted_at: params.submittedAt ?? new Date()
  };
}

function fetchedOrder(params: {
  tokenId: string;
  orderId: string;
  status: string;
  originalSize: string;
  sizeMatched: string;
  associateTrades?: string[];
  direction?: 'BUY' | 'SELL';
  createdAt?: string;
}) {
  return {
    id: params.orderId,
    conditionId: `0x${'1'.repeat(64)}`,
    tokenId: params.tokenId,
    owner: 'owner',
    makerAddress: '0x1111111111111111111111111111111111111111',
    side: params.direction ?? 'BUY',
    price: '0.50',
    originalSize: params.originalSize,
    sizeMatched: params.sizeMatched,
    outcome: 'Yes',
    orderType: 'FAK',
    status: params.status,
    associateTrades: params.associateTrades ?? [],
    createdAt: params.createdAt ?? new Date().toISOString()
  };
}

function confirmedAccountTrade(params: {
  tokenId: string;
  orderId: string;
  tradeId: string;
  price: string;
  size: string;
  feeRateBps?: string;
  transactionHash?: string;
}) {
  return {
    id: params.tradeId,
    conditionId: `0x${'1'.repeat(64)}`,
    tokenId: params.tokenId,
    owner: 'owner',
    makerAddress: '0x1111111111111111111111111111111111111111',
    takerOrderId: params.orderId,
    side: 'BUY',
    traderSide: 'TAKER',
    price: params.price,
    size: params.size,
    outcome: 'Yes',
    status: 'TRADE_STATUS_CONFIRMED',
    feeRateBps: params.feeRateBps ?? '0',
    bucketIndex: 0,
    transactionHash: params.transactionHash ?? `0x${'2'.repeat(64)}`,
    makerOrders: [],
    matchedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

let triggerPolymarket: any;
let getPolymarketAskPrice: any;
let pollPolymarketOrders: any;
let setPolymarketLiveReadiness: any;
let setPolymarketClientForTesting: any;
let simulatePolymarketBookFill: any;
let initializePolymarketClient: any;
let loadPolymarketApiCredentials: any;
let loadPolymarketBuilderCredentials: any;
let parsePolymarketBuilderCode: any;
let assertSupportedPolymarketRuntime: any;
let getPolymarketLiveReadiness: any;
let getPolymarketAvailableBalance: any;
let planPolymarketBookOrder: any;
let client: MockClient;

beforeAll(async () => {
  const mod = await import('./polymarket.js');
  triggerPolymarket = mod.triggerPolymarket;
  getPolymarketAskPrice = mod.getPolymarketAskPrice;
  pollPolymarketOrders = mod.pollPolymarketOrders;
  setPolymarketLiveReadiness = mod.setPolymarketLiveReadiness;
  setPolymarketClientForTesting = mod.setPolymarketClientForTesting;
  simulatePolymarketBookFill = mod.simulatePolymarketBookFill;
  initializePolymarketClient = mod.initializePolymarketClient;
  loadPolymarketApiCredentials = mod.loadPolymarketApiCredentials;
  loadPolymarketBuilderCredentials = mod.loadPolymarketBuilderCredentials;
  parsePolymarketBuilderCode = mod.parsePolymarketBuilderCode;
  assertSupportedPolymarketRuntime = mod.assertSupportedPolymarketRuntime;
  getPolymarketLiveReadiness = mod.getPolymarketLiveReadiness;
  getPolymarketAvailableBalance = mod.getPolymarketAvailableBalance;
  planPolymarketBookOrder = mod.planPolymarketBookOrder;
}, 30_000);

describe('Polymarket live executor', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    const db = await import('@swat/db');
    vi.mocked(db.query).mockReset().mockResolvedValue([] as never);
    vi.mocked(db.recordCopyExecutionEvidence).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(db.transitionCopyExecution).mockReset().mockResolvedValue(undefined as never);
    client = createMockClient();
    polymarketActionMocks.fetchBalanceAllowance.mockReset().mockResolvedValue({
      balance: '1000000000',
      allowances: {}
    });
    polymarketActionMocks.fetchBuilderFeeRates.mockReset().mockResolvedValue({
      maker: 0.0025,
      taker: 0.005
    });
    marketStateMocks.assertPolymarketMarketOpenForSubmission.mockReset().mockResolvedValue({
      conditionId: `0x${'1'.repeat(64)}`,
      active: true,
      closed: false,
      acceptingOrders: true,
      resolutionStatus: 'unresolved',
      endDate: new Date(Date.now() + 86_400_000)
    });
    setPolymarketClientForTesting(client);
    setPolymarketLiveReadiness(true);
    process.env.POLYMARKET_FEE_BUFFER_BPS = '300';
  });

  describe('getPolymarketAskPrice', () => {
    it('throws if no asks are available', async () => {
      client.fetchOrderBook.mockResolvedValue({ asks: [], bids: [] });
      await expect(getPolymarketAskPrice('token-123')).rejects.toThrow('No asks available');
    });

    it('returns the lowest ask price', async () => {
      client.fetchOrderBook.mockResolvedValue({
        asks: [{ price: '0.65' }, { price: '0.60' }, { price: '0.70' }],
        bids: []
      });

      await expect(getPolymarketAskPrice('token-123')).resolves.toBe(0.60);
      expect(client.fetchOrderBook).toHaveBeenCalledWith({ tokenId: 'token-123' });
    });
  });

  describe('planPolymarketBookOrder', () => {
    it('walks ask depth and uses the worst consumed level as the protected limit', () => {
      const plan = planPolymarketBookOrder(orderBook({
        tokenId: 'token-depth',
        asks: [
          { price: '0.52', size: '10' },
          { price: '0.50', size: '10' }
        ]
      }), 'buy', 7.6, 500);

      expect(plan.bestPrice).toBe(0.5);
      expect(plan.limitPrice).toBe(0.52);
      expect(plan.estimatedShares).toBe(15);
      expect(plan.slippageBps).toBeCloseTo(400);
    });

    it('rejects thin, stale, and excessive-slippage books', () => {
      expect(() => planPolymarketBookOrder(orderBook({
        tokenId: 'token-thin',
        asks: [{ price: '0.50', size: '1' }]
      }), 'buy', 5, 200)).toThrow('too thin');

      expect(() => planPolymarketBookOrder(orderBook({
        tokenId: 'token-stale',
        asks: [{ price: '0.50', size: '20' }],
        timestamp: Date.now() - 16_000
      }), 'buy', 5, 200)).toThrow('stale');

      expect(() => planPolymarketBookOrder(orderBook({
        tokenId: 'token-slippage',
        asks: [
          { price: '0.50', size: '5' },
          { price: '0.55', size: '20' }
        ]
      }), 'buy', 5, 200)).toThrow('exceeds 200 bps');
    });
  });

  describe('market-state gate', () => {
    it('refuses to submit when the market stopped accepting orders', async () => {
      // A healthy book is not permission to trade: the market can pause,
      // close, or go to resolution between the signal and this submission.
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-paused',
        asks: [{ price: '0.50', size: '100' }]
      }));
      marketStateMocks.assertPolymarketMarketOpenForSubmission.mockRejectedValue(
        new Error('Polymarket Protection: market is paused for orders')
      );

      await expect(triggerPolymarket({
        signalId: 'sig-paused',
        tokenID: 'token-paused',
        spendAmountUsd: 10,
        direction: 'buy'
      })).rejects.toThrow('paused for orders');

      // expect.objectContaining, because `triggerPolymarket` also passes an injected
      // `now` so the tradability gate and the S4-M18 staleness budget read one
      // clock. Pinning the exact argument object made this assertion fail on a
      // change that added a field without altering what it claims to check.
      expect(marketStateMocks.assertPolymarketMarketOpenForSubmission).toHaveBeenCalledWith(
        expect.objectContaining({ conditionId: `0x${'1'.repeat(64)}` })
      );
      // Nothing may reach the venue once the gate refuses.
      expect(client.createMarketOrder).not.toHaveBeenCalled();
      expect(client.postOrder).not.toHaveBeenCalled();
    });

    it('checks market state only after the book passes its own bounds', async () => {
      // No point asking Gamma about a market whose book already failed.
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-thin-gate',
        asks: [{ price: '0.50', size: '0.1' }]
      }));

      await expect(triggerPolymarket({
        signalId: 'sig-thin-gate',
        tokenID: 'token-thin-gate',
        spendAmountUsd: 500,
        direction: 'buy'
      })).rejects.toThrow();

      expect(marketStateMocks.assertPolymarketMarketOpenForSubmission).not.toHaveBeenCalled();
    });
  });

  describe('simulatePolymarketBookFill', () => {
    // The simulator reads the same slippage bound the live path reads, so the
    // fixtures below have to stay inside it — that coupling is the point.
    beforeEach(() => {
      process.env.POLYMARKET_SLIPPAGE_BPS = '500';
    });

    // Scoped, not global: leaving it set would silently widen the bound for
    // every later describe in this file.
    afterEach(() => {
      delete process.env.POLYMARKET_SLIPPAGE_BPS;
    });

    it('prices a paper buy off walked depth, not the best level', async () => {
      // 10 shares at 0.50 then 10 at 0.52. $7.60 cannot clear at the best
      // level; taking 0.50 for the whole order would invent liquidity that is
      // not on the book and make paper look better than live ever could.
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-paper-depth',
        asks: [
          { price: '0.52', size: '10' },
          { price: '0.50', size: '10' }
        ]
      }));

      const plan = await simulatePolymarketBookFill({
        tokenID: 'token-paper-depth',
        direction: 'buy',
        requestedAmount: 7.6
      });

      expect(plan.bestPrice).toBe(0.5);
      expect(plan.estimatedShares).toBe(15);
      expect(plan.estimatedNotionalUsd).toBeCloseTo(7.6);
      // 7.6 / 15 shares — strictly worse than the 0.50 best price.
      expect(plan.averagePrice).toBeCloseTo(0.50667, 5);
      expect(plan.averagePrice).toBeGreaterThan(plan.bestPrice);
    });

    it('agrees exactly with the live path for the same book and size', async () => {
      // Paper and live must not drift: both go through planPolymarketBookOrder.
      const book = orderBook({
        tokenId: 'token-parity',
        asks: [
          { price: '0.50', size: '4' },
          { price: '0.51', size: '30' }
        ]
      });
      client.fetchOrderBook.mockResolvedValue(book);

      const simulated = await simulatePolymarketBookFill({
        tokenID: 'token-parity',
        direction: 'buy',
        requestedAmount: 10
      });
      const live = planPolymarketBookOrder(book, 'buy', 10, 500);

      expect(simulated).toEqual(live);
    });

    it('refuses a book too thin for the requested paper size', async () => {
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-paper-thin',
        asks: [{ price: '0.50', size: '1' }]
      }));

      await expect(simulatePolymarketBookFill({
        tokenID: 'token-paper-thin',
        direction: 'buy',
        requestedAmount: 50
      })).rejects.toThrow('too thin');
    });

    it('prices a paper sell from bid depth for the requested shares', async () => {
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-paper-sell',
        bids: [
          { price: '0.40', size: '5' },
          { price: '0.38', size: '20' }
        ]
      }));

      const plan = await simulatePolymarketBookFill({
        tokenID: 'token-paper-sell',
        direction: 'sell',
        requestedAmount: 10
      });

      expect(plan.bestPrice).toBe(0.4);
      // 5 @ 0.40 + 5 @ 0.38 = 3.90 over 10 shares.
      expect(plan.estimatedNotionalUsd).toBeCloseTo(3.9);
      expect(plan.averagePrice).toBeCloseTo(0.39);
      expect(plan.averagePrice).toBeLessThan(plan.bestPrice);
    });
  });

  describe('triggerPolymarket', () => {
    it('throws on honeypot bounds', async () => {
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-999',
        asks: [{ price: '0.98', size: '1000' }]
      }));
      await expect(triggerPolymarket({
        signalId: 'sig-1',
        tokenID: 'token-999',
        spendAmountUsd: 100,
        direction: 'buy'
      })).rejects.toThrow('outside safe bounds');
    });

    it('reserves the fee buffer when sizing to available collateral', async () => {
      polymarketActionMocks.fetchBalanceAllowance.mockResolvedValue({
        balance: '5000000',
        allowances: {}
      });
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-888',
        asks: [{ price: '0.50', size: '100' }]
      }));
      configureConfirmedFill({
        client,
        tokenId: 'token-888',
        price: '0.50',
        size: '9.70'
      });

      const result = await triggerPolymarket({
        signalId: 'sig-3',
        tokenID: 'token-888',
        spendAmountUsd: 100,
        direction: 'buy'
      });

      expect(client.createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
        amount: 4.854368,
        maxSpend: 4.854368,
        maxPrice: 0.5
      }));
      expect(result.requestedSpendAmountUsd).toBe(4.854368);
      expect(result.spendAmountUsd).toBe(4.85);
      expect(result.shares).toBe(9.7);
      expect(result.executionStatus).toBe('filled');
    });

    it('blocks a duplicate order for the same token', async () => {
      client.listOpenOrders.mockReturnValue(paginator([{ id: 'existing-order' }]));
      await expect(triggerPolymarket({
        signalId: 'sig-4',
        tokenID: 'token-777',
        spendAmountUsd: 50,
        direction: 'buy'
      })).rejects.toThrow('Open orders already exist');
    });

    it('uses the stable signal ID to block a previously persisted execution', async () => {
      const db = await import('@swat/db');
      vi.mocked(db.query).mockResolvedValueOnce([{
        venue_order_id: 'persisted-order',
        status: 'pending_confirmation'
      }] as never);

      await expect(triggerPolymarket({
        signalId: 'sig-retry',
        tokenID: 'token-retry',
        spendAmountUsd: 50,
        direction: 'buy'
      })).rejects.toThrow('already has an active execution');
      expect(client.listOpenOrders).not.toHaveBeenCalled();
      expect(client.postOrder).not.toHaveBeenCalled();
    });

    it('attaches the builder code to the protected FAK order', async () => {
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-555',
        asks: [{ price: '0.33', size: '1000' }]
      }));
      configureConfirmedFill({
        client,
        tokenId: 'token-555',
        orderId: 'poly-order-123',
        price: '0.33',
        size: '151.51'
      });

      const result = await triggerPolymarket({
        signalId: 'sig-2',
        tokenID: 'token-555',
        spendAmountUsd: 50,
        direction: 'buy'
      });

      expect(client.createMarketOrder).toHaveBeenCalledWith({
        tokenId: 'token-555',
        side: OrderSide.BUY,
        amount: 50,
        maxSpend: 50,
        maxPrice: 0.33,
        orderType: OrderType.FAK,
        builderCode: `0x${'a'.repeat(64)}`
      });
      expect(client.postOrder).toHaveBeenCalledOnce();
      expect(result.orderId).toBe('poly-order-123');
      expect(result.settlementTransactionHashes).toEqual([`0x${'2'.repeat(64)}`]);
      expect(result.executionStatus).toBe('filled');
    });

    it('fails closed if the SDK omits the builder code from the signed order', async () => {
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-builder',
        asks: [{ price: '0.50', size: '100' }]
      }));
      client.createMarketOrder.mockResolvedValue({ builder: `0x${'0'.repeat(64)}` });

      await expect(triggerPolymarket({
        signalId: 'sig-builder',
        tokenID: 'token-builder',
        spendAmountUsd: 10,
        direction: 'buy'
      })).rejects.toThrow('omitted the configured builder code');
      expect(client.postOrder).not.toHaveBeenCalled();
    });

    it('caps sells to available outcome shares', async () => {
      polymarketActionMocks.fetchBalanceAllowance.mockResolvedValue({
        balance: '3250000',
        allowances: {}
      });
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-sell',
        bids: [{ price: '0.50', size: '100' }]
      }));
      configureConfirmedFill({
        client,
        tokenId: 'token-sell',
        price: '0.50',
        size: '3.25'
      });

      const result = await triggerPolymarket({
        signalId: 'sig-sell',
        tokenID: 'token-sell',
        spendAmountUsd: 10,
        direction: 'sell',
        sellShares: 8
      });

      expect(polymarketActionMocks.fetchBalanceAllowance).toHaveBeenCalledWith(client, {
        assetType: AssetType.CONDITIONAL,
        tokenId: 'token-sell'
      });
      expect(client.createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
        shares: 3.25,
        minPrice: 0.5
      }));
      expect(result.shares).toBe(3.25);
    });

    it('returns pending confirmation without fabricating a fill for delayed orders', async () => {
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-delayed',
        asks: [{ price: '0.50', size: '100' }]
      }));
      client.postOrder.mockResolvedValue({
        ok: true,
        orderId: 'delayed-order',
        status: 'delayed',
        makingAmount: '0',
        takingAmount: '0',
        transactionsHashes: [],
        tradeIds: []
      });

      const result = await triggerPolymarket({
        signalId: 'sig-delayed',
        tokenID: 'token-delayed',
        spendAmountUsd: 10,
        direction: 'buy'
      });

      expect(result.executionStatus).toBe('pending_confirmation');
      expect(result.spendAmountUsd).toBe(0);
      expect(result.shares).toBe(0);
    });

    it('persists confirmed partial quantities and fill-derived fees honestly', async () => {
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-partial',
        asks: [{ price: '0.50', size: '100' }]
      }));
      configureConfirmedFill({
        client,
        tokenId: 'token-partial',
        price: '0.50',
        size: '10',
        feeRateBps: '1000'
      });

      const result = await triggerPolymarket({
        signalId: 'sig-partial',
        tokenID: 'token-partial',
        spendAmountUsd: 10,
        direction: 'buy'
      });

      expect(result.executionStatus).toBe('partial');
      expect(result.shares).toBe(10);
      expect(result.spendAmountUsd).toBe(5);
      expect(result.averagePrice).toBe(0.5);
      expect(result.feesUsd).toBeCloseTo(0.25);
    });

    it('keeps an accepted order pending when settlement lookup times out', async () => {
      client.fetchOrderBook.mockResolvedValue(orderBook({
        tokenId: 'token-timeout',
        asks: [{ price: '0.50', size: '100' }]
      }));
      client.postOrder.mockResolvedValue({
        ok: true,
        orderId: 'timeout-order',
        status: 'matched',
        makingAmount: '5',
        takingAmount: '10',
        transactionsHashes: [],
        tradeIds: ['timeout-trade']
      });
      client.waitForOrderFillSettlement.mockRejectedValue(new Error('timed out'));

      const result = await triggerPolymarket({
        signalId: 'sig-timeout',
        tokenID: 'token-timeout',
        spendAmountUsd: 5,
        direction: 'buy'
      });

      expect(result.executionStatus).toBe('pending_confirmation');
      expect(result.orderId).toBe('timeout-order');
      expect(result.shares).toBe(0);
    });
  });

  describe('delayed FAK reconciliation', () => {
    it('persists only confirmed partial fill evidence and terminalizes the FAK remainder', async () => {
      const db = await import('@swat/db');
      const row = pendingPolymarketTrade({
        tokenId: 'token-delayed-partial',
        orderId: 'delayed-partial',
        copyExecutionId: 'copy-delayed-partial'
      });
      vi.mocked(db.query)
        .mockResolvedValueOnce([row] as never)
        .mockResolvedValueOnce([{ id: row.id }] as never);
      client.fetchOrder.mockResolvedValue(fetchedOrder({
        tokenId: 'token-delayed-partial',
        orderId: 'delayed-partial',
        status: 'MATCHED',
        originalSize: '20',
        sizeMatched: '10',
        associateTrades: ['venue-trade-partial']
      }));
      client.listAccountTrades.mockReturnValue(paginator([confirmedAccountTrade({
        tokenId: 'token-delayed-partial',
        orderId: 'delayed-partial',
        tradeId: 'venue-trade-partial',
        price: '0.45',
        size: '10',
        feeRateBps: '100'
      })]));

      const outcomes = await pollPolymarketOrders();

      expect(client.fetchOrder).toHaveBeenCalledWith({ orderId: 'delayed-partial' });
      expect(client.listAccountTrades).toHaveBeenCalledWith({ id: 'venue-trade-partial' });
      expect(client.listOpenOrders).not.toHaveBeenCalled();
      expect(outcomes).toEqual([expect.objectContaining({
        status: 'partial',
        shares: 10,
        amountUsd: 4.5,
        averagePrice: 0.45,
        venueTradeIds: ['venue-trade-partial'],
        settlementTransactionHashes: [`0x${'2'.repeat(64)}`]
      })]);
      expect(outcomes[0].feesUsd).toBeCloseTo(0.02475);
      expect(db.recordCopyExecutionEvidence).toHaveBeenCalledWith(expect.objectContaining({
        executionId: 'copy-delayed-partial',
        evidenceType: 'venue_fill',
        evidenceId: 'order:delayed-partial',
        baseQuantity: '10',
        // S4-M35: the amount now carries its unit. Polymarket settles in USDC, so
        // the currency is asserted here rather than left for a chain lookup.
        quoteLeg: { amount: '4.5', currency: 'USD' },
        priceUsd: '0.45',
        confirmationState: 'confirmed',
        completesExecution: true
      }));
      const fillUpdate = vi.mocked(db.query).mock.calls.find(([sql]) =>
        String(sql).includes('amount_usd = $3')
      );
      expect(fillUpdate?.[1]).toEqual([
        row.id,
        'partial',
        4.5,
        10,
        0.45,
        expect.closeTo(0.02475),
        `0x${'2'.repeat(64)}`,
        'MATCHED',
        JSON.stringify(['venue-trade-partial']),
        JSON.stringify([`0x${'2'.repeat(64)}`])
      ]);
    });

    it('persists a delayed full fill once and makes a repeated poll idempotent', async () => {
      const db = await import('@swat/db');
      const row = pendingPolymarketTrade({
        tokenId: 'token-delayed-full',
        orderId: 'delayed-full'
      });
      let pendingReads = 0;
      vi.mocked(db.query).mockImplementation(async (sql) => {
        const statement = String(sql);
        if (statement.includes("executor = 'polymarket-clob'")) {
          pendingReads += 1;
          return (pendingReads === 1 ? [row] : []) as never;
        }
        if (statement.includes('WITH reconciled AS')) return [{ id: row.id }] as never;
        return [] as never;
      });
      client.fetchOrder.mockResolvedValue(fetchedOrder({
        tokenId: 'token-delayed-full',
        orderId: 'delayed-full',
        status: 'MATCHED',
        originalSize: '8',
        sizeMatched: '8',
        associateTrades: ['venue-trade-full']
      }));
      client.listAccountTrades.mockReturnValue(paginator([confirmedAccountTrade({
        tokenId: 'token-delayed-full',
        orderId: 'delayed-full',
        tradeId: 'venue-trade-full',
        price: '0.625',
        size: '8',
        transactionHash: `0x${'3'.repeat(64)}`
      })]));

      await expect(pollPolymarketOrders()).resolves.toEqual([
        expect.objectContaining({ status: 'filled', shares: 8, amountUsd: 5 })
      ]);
      await expect(pollPolymarketOrders()).resolves.toEqual([]);

      expect(client.fetchOrder).toHaveBeenCalledTimes(1);
      expect(client.listAccountTrades).toHaveBeenCalledTimes(1);
      expect(vi.mocked(db.query).mock.calls.filter(([sql]) =>
        String(sql).includes('WITH reconciled AS')
      )).toHaveLength(1);
      expect(client.postOrder).not.toHaveBeenCalled();
    });

    it('terminalizes a venue-cancelled delayed order without fabricating quantities', async () => {
      const db = await import('@swat/db');
      const row = pendingPolymarketTrade({
        tokenId: 'token-delayed-cancelled',
        orderId: 'delayed-cancelled',
        copyExecutionId: 'copy-delayed-cancelled'
      });
      vi.mocked(db.query)
        .mockResolvedValueOnce([row] as never)
        .mockResolvedValueOnce([{ id: row.id }] as never);
      client.fetchOrder.mockResolvedValue(fetchedOrder({
        tokenId: 'token-delayed-cancelled',
        orderId: 'delayed-cancelled',
        status: 'CANCELLED',
        originalSize: '12',
        sizeMatched: '0'
      }));

      const outcomes = await pollPolymarketOrders();

      expect(outcomes).toEqual([expect.objectContaining({
        status: 'cancelled',
        reason: expect.stringContaining('without a confirmed fill')
      })]);
      expect(client.listAccountTrades).not.toHaveBeenCalled();
      expect(db.transitionCopyExecution).toHaveBeenCalledWith({
        executionId: 'copy-delayed-cancelled',
        nextState: 'cancelled',
        reason: 'Polymarket order delayed-cancelled was cancelled without a confirmed fill'
      });
      const terminalUpdate = vi.mocked(db.query).mock.calls.find(([sql]) =>
        String(sql).includes("venue_trade_ids = '[]'::jsonb")
      );
      expect(terminalUpdate?.[1]).toEqual([
        row.id,
        'cancelled',
        'CANCELLED',
        'Polymarket order delayed-cancelled was cancelled without a confirmed fill'
      ]);
    });

    it('distinguishes failed and ambiguous terminal evidence without creating fills', async () => {
      const db = await import('@swat/db');
      const failedRow = pendingPolymarketTrade({
        tokenId: 'token-delayed-failed',
        orderId: 'delayed-failed'
      });
      const ambiguousRow = pendingPolymarketTrade({
        tokenId: 'token-delayed-ambiguous',
        orderId: 'delayed-ambiguous'
      });
      vi.mocked(db.query)
        .mockResolvedValueOnce([failedRow, ambiguousRow] as never)
        .mockResolvedValueOnce([{ id: failedRow.id }] as never)
        .mockResolvedValueOnce([] as never);
      client.fetchOrder
        .mockResolvedValueOnce(fetchedOrder({
          tokenId: 'token-delayed-failed',
          orderId: 'delayed-failed',
          status: 'FAILED',
          originalSize: '5',
          sizeMatched: '0'
        }))
        .mockResolvedValueOnce(fetchedOrder({
          tokenId: 'token-delayed-ambiguous',
          orderId: 'delayed-ambiguous',
          status: 'MYSTERY',
          originalSize: '5',
          sizeMatched: '0'
        }));

      const outcomes = await pollPolymarketOrders();

      expect(outcomes.map((outcome: { status: string }) => outcome.status)).toEqual([
        'failed',
        'ambiguous'
      ]);
      expect(vi.mocked(db.query).mock.calls.some(([sql]) =>
        String(sql).includes('amount_usd = $3')
      )).toBe(false);
      const ambiguousUpdate = vi.mocked(db.query).mock.calls.find(([, params]) =>
        Array.isArray(params) && params[0] === ambiguousRow.id
      );
      expect(ambiguousUpdate?.[1]).toEqual([
        ambiguousRow.id,
        'ambiguous',
        'Polymarket order delayed-ambiguous returned unknown status MYSTERY',
        // An ambiguous ORDER status carries no settlement state: the order never
        // got far enough for its trades to have one.
        null
      ]);
    });

    it('cancels a stale persisted order only after the venue confirms cancellation', async () => {
      const db = await import('@swat/db');
      const row = pendingPolymarketTrade({
        tokenId: 'token-stale',
        orderId: 'stale-order',
        submittedAt: new Date(Date.now() - 601_000)
      });
      vi.mocked(db.query)
        .mockResolvedValueOnce([row] as never)
        .mockResolvedValueOnce([{ id: row.id }] as never);
      client.fetchOrder.mockResolvedValue(fetchedOrder({
        tokenId: 'token-stale',
        orderId: 'stale-order',
        status: 'LIVE',
        originalSize: '10',
        sizeMatched: '0',
        createdAt: new Date(Date.now() - 601_000).toISOString()
      }));
      client.cancelOrder.mockResolvedValue({
        canceled: ['stale-order'],
        notCanceled: {}
      });

      await expect(pollPolymarketOrders()).resolves.toEqual([
        expect.objectContaining({ status: 'cancelled' })
      ]);

      expect(client.cancelOrder).toHaveBeenCalledWith({ orderId: 'stale-order' });
      expect(client.listOpenOrders).not.toHaveBeenCalled();
    });
  });

  it('fails closed on malformed balance-allowance payloads', async () => {
    polymarketActionMocks.fetchBalanceAllowance.mockResolvedValue({
      balance: '1.5',
      allowances: {}
    });

    await expect(getPolymarketAvailableBalance('token-invalid', 'buy')).rejects.toThrow(
      'invalid buy balance'
    );
  });

  describe('authenticated client initialization', () => {
    it('rejects partial credentials, malformed builder codes, and unsupported runtimes', () => {
      expect(() => loadPolymarketApiCredentials({
        POLYMARKET_API_KEY: 'key-only'
      })).toThrow('must be configured together');
      expect(() => loadPolymarketBuilderCredentials({
        POLYMARKET_BUILDER_API_KEY: 'key-only'
      })).toThrow('must be configured together');
      expect(() => parsePolymarketBuilderCode('builder-name')).toThrow('bytes32');
      expect(() => assertSupportedPolymarketRuntime('22.22.2')).toThrow('requires Node.js 24');
      expect(() => assertSupportedPolymarketRuntime('24.0.0')).not.toThrow();
    });

    it('derives credentials and validates wallet, account, and builder fees', async () => {
      const factory = vi.fn().mockResolvedValue(client);
      const initialized = await initializePolymarketClient({
        POLYMARKET_SIGNATURE_TYPE: 'EOA',
        POLYMARKET_BUILDER_CODE: `0x${'b'.repeat(64)}`
      }, factory, '24.0.0');

      expect(initialized.credentialSource).toBe('derived');
      expect(initialized.builderCode).toBe(`0x${'b'.repeat(64)}`);
      expect(initialized.builderMakerFeeBps).toBe(25);
      expect(initialized.builderTakerFeeBps).toBe(50);
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({
        environment: production
      }));
      expect(client.fetchClosedOnlyMode).toHaveBeenCalledOnce();
      expect(client.listOpenOrders).toHaveBeenCalledWith();
      expect(polymarketActionMocks.fetchBuilderFeeRates).toHaveBeenCalledWith(client, {
        builderCode: `0x${'b'.repeat(64)}`
      });
    });

    it('validates and reuses configured user and builder credentials', async () => {
      const factory = vi.fn().mockResolvedValue(client);
      const initialized = await initializePolymarketClient({
        POLYMARKET_SIGNATURE_TYPE: 'EOA',
        POLYMARKET_BUILDER_CODE: `0x${'c'.repeat(64)}`,
        POLYMARKET_API_KEY: 'user-api-key',
        POLYMARKET_API_SECRET: 'user-secret',
        POLYMARKET_API_PASSPHRASE: 'user-passphrase',
        POLYMARKET_BUILDER_API_KEY: 'builder-api-key',
        POLYMARKET_BUILDER_API_SECRET: 'builder-secret',
        POLYMARKET_BUILDER_API_PASSPHRASE: 'builder-passphrase'
      }, factory, '24.0.0');

      expect(initialized.credentialSource).toBe('environment');
      expect(initialized.builderAuthentication).toBe('local');
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({
        credentials: {
          key: 'user-api-key',
          secret: 'user-secret',
          passphrase: 'user-passphrase'
        },
        apiKey: expect.anything()
      }));
    });

    it('fails closed when builder fee rates exceed the configured limits', async () => {
      polymarketActionMocks.fetchBuilderFeeRates.mockResolvedValue({ maker: 0.0051, taker: 0.005 });

      await expect(initializePolymarketClient({
        POLYMARKET_SIGNATURE_TYPE: 'EOA',
        POLYMARKET_BUILDER_CODE: `0x${'b'.repeat(64)}`
      }, vi.fn().mockResolvedValue(client), '24.0.0')).rejects.toThrow(
        'maker builder fees outside the supported limits'
      );
    });

    it('revokes readiness and clears the client before reinitialization', async () => {
      const factory = vi.fn().mockRejectedValue(new Error('authentication unavailable'));

      await expect(initializePolymarketClient({
        POLYMARKET_SIGNATURE_TYPE: 'EOA',
        POLYMARKET_BUILDER_CODE: `0x${'b'.repeat(64)}`
      }, factory, '24.0.0')).rejects.toThrow('authentication unavailable');

      expect(getPolymarketLiveReadiness()).toEqual({
        ready: false,
        reason: 'Polymarket authenticated client initialization is in progress'
      });
      setPolymarketLiveReadiness(true);
      await expect(triggerPolymarket({
        signalId: 'sig-stale-client',
        tokenID: 'token-stale-client',
        spendAmountUsd: 10,
        direction: 'buy'
      })).rejects.toThrow('authenticated client is not initialized');
    });

    it('rejects incomplete credentials returned by the authenticated client', async () => {
      client.credentials.passphrase = '';

      await expect(initializePolymarketClient({
        POLYMARKET_SIGNATURE_TYPE: 'EOA',
        POLYMARKET_BUILDER_CODE: `0x${'b'.repeat(64)}`
      }, vi.fn().mockResolvedValue(client), '24.0.0')).rejects.toThrow(
        'incomplete L2 API credentials'
      );
      expect(getPolymarketLiveReadiness().ready).toBe(false);
    });
  });

  describe('settlement state persistence', () => {
    // The venue advances a trade MATCHED -> MINED -> CONFIRMED independently of
    // the order status, with RETRYING when an onchain attempt failed. Collapsing
    // those into one "pending" bucket hides which of three very different
    // positions is actually being held.
    function settlingTrade(params: {
      tokenId: string;
      orderId: string;
      tradeId: string;
      status: string;
    }) {
      return {
        ...confirmedAccountTrade({
          tokenId: params.tokenId,
          orderId: params.orderId,
          tradeId: params.tradeId,
          price: '0.40',
          size: '5'
        }),
        status: params.status
      };
    }

    async function reconcileWith(orderId: string, tradeStatuses: string[]) {
      const db = await import('@swat/db');
      const tokenId = `token-${orderId}`;
      const tradeIds = tradeStatuses.map((_, index) => `${orderId}-trade-${index}`);
      const row = pendingPolymarketTrade({ tokenId, orderId });
      vi.mocked(db.query)
        .mockResolvedValueOnce([row] as never)
        .mockResolvedValue([] as never);
      client.fetchOrder.mockResolvedValue(fetchedOrder({
        tokenId,
        orderId,
        status: 'MATCHED',
        originalSize: '5',
        sizeMatched: '5',
        associateTrades: tradeIds
      }));
      client.listAccountTrades.mockImplementation(({ id }: { id: string }) => {
        const index = tradeIds.indexOf(id);
        return paginator([settlingTrade({
          tokenId,
          orderId,
          tradeId: id,
          status: tradeStatuses[index]!
        })]);
      });

      const outcomes = await pollPolymarketOrders();
      const update = vi.mocked(db.query).mock.calls.find(([sql]) =>
        String(sql).includes('venue_settlement_status = $4')
      );
      return { outcomes, update, rowId: row.id };
    }

    it.each([
      ['TRADE_STATUS_MATCHED', 'matched'],
      ['TRADE_STATUS_MATCHED_NOT_BROADCASTED', 'matched'],
      ['TRADE_STATUS_MINED', 'mined'],
      ['TRADE_STATUS_RETRYING', 'retrying']
    ])('persists %s distinctly as %s without creating a fill', async (venueStatus, expected) => {
      const { outcomes, update, rowId } = await reconcileWith(`settle-${expected}-${venueStatus}`, [venueStatus]);

      expect(outcomes).toEqual([expect.objectContaining({ status: 'pending_confirmation' })]);
      expect(outcomes[0].shares).toBeUndefined();
      expect(update?.[1]).toEqual([rowId, 'MATCHED', expect.stringContaining(`settlement ${expected}`), expected]);
    });

    it('reports the weakest settlement state across several trades', async () => {
      // One leg mined and another retrying is a RETRYING position: the order is
      // only as settled as its least-settled trade.
      const { outcomes, update } = await reconcileWith('settle-mixed', [
        'TRADE_STATUS_MINED',
        'TRADE_STATUS_RETRYING'
      ]);

      expect(outcomes[0].status).toBe('pending_confirmation');
      expect(update?.[1]?.[3]).toBe('retrying');
    });

    it('fails closed on a settlement status outside the documented set', async () => {
      // Parking an unrecognised state as "pending" is how a position ends up
      // sitting forever in a state nobody is watching.
      const { outcomes } = await reconcileWith('settle-unknown', ['TRADE_STATUS_TELEPORTED']);

      expect(outcomes).toEqual([expect.objectContaining({
        status: 'ambiguous',
        reason: expect.stringContaining('unrecognised settlement status')
      })]);
    });
  });
});
