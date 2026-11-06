import { OrderSide, OrderType } from '@polymarket/client';
import { AssetType } from '@polymarket/bindings/clob';
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
// The live market-state read has its own suite in polymarket-market-state.test.ts.
// Stubbed here so every case below stays about the two axes under test.
const marketStateMocks = vi.hoisted(() => ({
    assertPolymarketMarketOpenForSubmission: vi.fn()
}));
vi.mock('@swat/db', () => dbMocks);
vi.mock('@polymarket/client/actions', () => actionMocks);
vi.mock('./polymarket-market-state.js', () => marketStateMocks);
const { planPolymarketBookOrder, setPolymarketClientForTesting, setPolymarketLiveReadiness, triggerPolymarket } = await import('./polymarket.js');
/**
 * Binary + neg-risk entry/exit matrix (checklist S3-18 remainder).
 *
 * A neg-risk market signs against a different EIP-712 verifying contract than a
 * standard one — `0xE1111800...` versus `0xe2222d27...` per `trading/place-orders`.
 * The SDK makes that choice from the token; `PrepareMarketOrderRequest` has no
 * field through which a caller could override it. Duplicating the mapping on our
 * side would therefore be unreachable at best and silently divergent if
 * Polymarket ever remapped it, which is exactly the failure the redemption sweep
 * already guards against for the collateral adapter. Both exchange addresses are
 * pinned and attested once at startup (`polymarket-startup.ts`), not chosen per
 * order.
 *
 * So the matrix asserts an asymmetry: **neg-risk is a no-op axis** — the plan and
 * the signed request must be byte-identical to the binary case — while **entry
 * versus exit is the real axis**, differing in units, balance source, protective
 * bound, and required inputs.
 */
const TOKEN_ID = 'token-matrix';
const BUILDER_CODE = `0x${'a'.repeat(64)}`;
const CONDITION_ID = `0x${'1'.repeat(64)}`;
// 20 USD at 0.40 and 50 shares at 0.60 both come to 50 shares, so an entry and an
// exit can be compared without a quantity difference confounding the direction.
const ENTRY_USD = 20;
const EXIT_SHARES = 50;
const ENTRY_ASKS = [{ price: '0.40', size: '1000' }];
const EXIT_BIDS = [{ price: '0.60', size: '1000' }];
const MARKETS = [
    { label: 'binary', negRisk: false },
    { label: 'neg-risk', negRisk: true }
];
// Keys a caller could plausibly reach for when hand-rolling the neg-risk split.
// None of them exists on `PrepareMarketOrderRequest`; sending one would be a
// silent no-op the venue never sees.
const VENUE_SELECTION_KEYS = [
    'negRisk',
    'neg_risk',
    'exchange',
    'exchangeAddress',
    'adapter',
    'verifyingContract'
];
function paginator(items) {
    const page = { items, hasMore: false };
    return {
        firstPage: vi.fn().mockResolvedValue(page),
        from: vi.fn(),
        async *[Symbol.asyncIterator]() {
            yield page;
        }
    };
}
function orderBook(params) {
    return {
        conditionId: CONDITION_ID,
        tokenId: TOKEN_ID,
        timestamp: params.timestamp ?? Date.now(),
        asks: params.asks ?? [],
        bids: params.bids ?? [],
        minOrderSize: '1',
        tickSize: params.tickSize ?? '0.01',
        negRisk: params.negRisk,
        hash: 'a'.repeat(40)
    };
}
function createMockClient() {
    return {
        fetchOrderBook: vi.fn(),
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
}
function installClient(mock) {
    setPolymarketClientForTesting(mock);
}
function clientWithBook(params) {
    const mock = createMockClient();
    mock.fetchOrderBook.mockResolvedValue(orderBook(params));
    installClient(mock);
    return mock;
}
function configureConfirmedFill(params) {
    const transactionHash = `0x${'2'.repeat(64)}`;
    params.client.postOrder.mockResolvedValue({
        ok: true,
        orderId: 'order-id',
        status: 'matched',
        transactionsHashes: [],
        tradeIds: ['trade-id']
    });
    params.client.waitForOrderFillSettlement.mockResolvedValue([transactionHash]);
    params.client.listAccountTrades.mockReturnValue(paginator([{
            id: 'trade-id',
            conditionId: CONDITION_ID,
            tokenId: TOKEN_ID,
            owner: 'owner',
            takerOrderId: 'order-id',
            side: params.side,
            traderSide: 'TAKER',
            price: params.price,
            size: params.size,
            outcome: 'Yes',
            status: 'CONFIRMED',
            feeRateBps: '0',
            bucketIndex: 0,
            transactionHash,
            makerOrders: [],
            matchedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }]));
}
async function submittedOrderRequest(negRisk, direction) {
    const mock = clientWithBook({ negRisk, asks: ENTRY_ASKS, bids: EXIT_BIDS });
    await triggerPolymarket({
        signalId: `sig-${direction}-${String(negRisk)}`,
        tokenID: TOKEN_ID,
        spendAmountUsd: ENTRY_USD,
        direction,
        ...(direction === 'sell' ? { sellShares: EXIT_SHARES } : {})
    });
    return mock.createMarketOrder.mock.calls[0][0];
}
beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.query.mockResolvedValue([]);
    dbMocks.recordCopyExecutionEvidence.mockResolvedValue(undefined);
    dbMocks.transitionCopyExecution.mockResolvedValue(undefined);
    actionMocks.fetchBalanceAllowance.mockResolvedValue({
        balance: '1000000000',
        allowances: {}
    });
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
    // The price bounds and slippage cap are read from env at submission time. Clear
    // them so the cases below pin the shipped defaults (0.97 / 0.01 / 200 bps)
    // rather than whatever an operator shell happens to export.
    delete process.env.POLYMARKET_SLIPPAGE_BPS;
    delete process.env.POLYMARKET_MAX_ENTRY_PRICE;
    delete process.env.POLYMARKET_MIN_EXIT_PRICE;
    delete process.env.POLYMARKET_MAX_BOOK_AGE_MS;
});
describe('polymarket binary and neg-risk entry-exit matrix', () => {
    describe('neg-risk is not a decision this code makes', () => {
        it.each([
            { direction: 'buy', amount: ENTRY_USD },
            { direction: 'sell', amount: EXIT_SHARES }
        ])('plans a $direction identically on a binary and a neg-risk book', ({ direction, amount }) => {
            // Same levels, same size, one flag apart. If anyone ever branches the depth
            // walk, the slippage cap, or the rounding on `negRisk`, these diverge.
            const now = Date.now();
            const levels = { asks: ENTRY_ASKS, bids: EXIT_BIDS, timestamp: now };
            const binary = planPolymarketBookOrder(orderBook({ negRisk: false, ...levels }), direction, amount, 200, now);
            const negRisk = planPolymarketBookOrder(orderBook({ negRisk: true, ...levels }), direction, amount, 200, now);
            expect(negRisk).toEqual(binary);
        });
        it.each([
            {
                direction: 'buy',
                keys: ['amount', 'builderCode', 'maxPrice', 'maxSpend', 'orderType', 'side', 'tokenId']
            },
            {
                direction: 'sell',
                keys: ['builderCode', 'minPrice', 'orderType', 'shares', 'side', 'tokenId']
            }
        ])('signs an identical $direction request on both market kinds', async ({ direction, keys }) => {
            const binary = await submittedOrderRequest(false, direction);
            const negRisk = await submittedOrderRequest(true, direction);
            // The regression guard. An added `negRisk`/`exchange`/`adapter` key would be
            // dropped on the floor by the SDK while reading as though we had handled the
            // split ourselves.
            expect(Object.keys(negRisk).sort()).toEqual(keys);
            for (const forbidden of VENUE_SELECTION_KEYS) {
                expect(negRisk).not.toHaveProperty(forbidden);
            }
            expect(negRisk).toEqual(binary);
        });
    });
    describe.each(MARKETS)('$label market', ({ negRisk }) => {
        it('enters by spending USD off ask depth, capped by maxPrice', async () => {
            const client = clientWithBook({ negRisk, asks: ENTRY_ASKS });
            configureConfirmedFill({ client, price: '0.40', size: '50', side: 'BUY' });
            const result = await triggerPolymarket({
                signalId: 'sig-entry',
                tokenID: TOKEN_ID,
                spendAmountUsd: ENTRY_USD,
                direction: 'buy'
            });
            // An entry spends collateral, so the balance read is the account's pUSD, not
            // a per-outcome holding.
            expect(actionMocks.fetchBalanceAllowance).toHaveBeenCalledWith(client, {
                assetType: AssetType.COLLATERAL
            });
            expect(client.createMarketOrder).toHaveBeenCalledWith({
                tokenId: TOKEN_ID,
                side: OrderSide.BUY,
                amount: ENTRY_USD,
                maxSpend: ENTRY_USD,
                maxPrice: 0.4,
                orderType: OrderType.FAK,
                builderCode: BUILDER_CODE
            });
            expect(marketStateMocks.assertPolymarketMarketOpenForSubmission)
                .toHaveBeenCalledWith(expect.objectContaining({ conditionId: CONDITION_ID }));
            expect(result.executionStatus).toBe('filled');
            expect(result.shares).toBe(50);
            expect(result.spendAmountUsd).toBe(20);
            // An entry is requested in dollars and discovers its share count; the exit
            // below is the mirror image.
            expect(result.requestedSpendAmountUsd).toBe(ENTRY_USD);
            expect(result.requestedShares).toBe(50);
        });
        it('exits by disposing shares off bid depth, floored by minPrice', async () => {
            const client = clientWithBook({ negRisk, bids: EXIT_BIDS });
            configureConfirmedFill({ client, price: '0.60', size: '50', side: 'SELL' });
            const result = await triggerPolymarket({
                signalId: 'sig-exit',
                tokenID: TOKEN_ID,
                spendAmountUsd: ENTRY_USD,
                direction: 'sell',
                sellShares: EXIT_SHARES
            });
            // An exit disposes of a specific outcome token, so the balance that bounds
            // it is that token's, keyed by id — a neg-risk event has one such holding
            // per outcome and they are not fungible with each other.
            expect(actionMocks.fetchBalanceAllowance).toHaveBeenCalledWith(client, {
                assetType: AssetType.CONDITIONAL,
                tokenId: TOKEN_ID
            });
            expect(client.createMarketOrder).toHaveBeenCalledWith({
                tokenId: TOKEN_ID,
                side: OrderSide.SELL,
                shares: EXIT_SHARES,
                minPrice: 0.6,
                orderType: OrderType.FAK,
                builderCode: BUILDER_CODE
            });
            expect(marketStateMocks.assertPolymarketMarketOpenForSubmission)
                .toHaveBeenCalledWith(expect.objectContaining({ conditionId: CONDITION_ID }));
            expect(result.executionStatus).toBe('filled');
            expect(result.shares).toBe(50);
            expect(result.spendAmountUsd).toBe(30);
            // Requested in shares, with the dollar figure derived — the inverse of the
            // entry.
            expect(result.requestedShares).toBe(EXIT_SHARES);
            expect(result.requestedSpendAmountUsd).toBe(30);
        });
        it('reads the same requested amount as dollars on entry and shares on exit', async () => {
            // Depth is priced in USD (size × price) on the ask side and in shares on the
            // bid side, so the same number means different things by direction. Feeding
            // both sides the same book and the same `10` proves the units are not
            // interchangeable.
            const now = Date.now();
            const book = orderBook({
                negRisk,
                asks: [{ price: '0.50', size: '10' }, { price: '0.52', size: '10' }],
                bids: [{ price: '0.52', size: '10' }, { price: '0.50', size: '10' }],
                timestamp: now
            });
            const entry = planPolymarketBookOrder(book, 'buy', 10, 500, now);
            const exit = planPolymarketBookOrder(book, 'sell', 10, 500, now);
            // $10 clears the 0.50 level ($5) and part of 0.52, so the entry crosses two
            // levels and pays 400 bps of slippage.
            expect(entry.estimatedNotionalUsd).toBeCloseTo(10);
            expect(entry.estimatedShares).toBe(19.61);
            expect(entry.limitPrice).toBe(0.52);
            expect(entry.slippageBps).toBeCloseTo(400);
            // 10 shares clear the top bid alone, so the exit never leaves the best level.
            expect(exit.estimatedShares).toBe(10);
            expect(exit.estimatedNotionalUsd).toBeCloseTo(5.2);
            expect(exit.limitPrice).toBe(0.52);
            expect(exit.slippageBps).toBeCloseTo(0);
        });
        it('refuses 0.98 as an entry while accepting it as an exit', async () => {
            // The bounds are directional, not symmetric: paying 0.98 for a share risks
            // 0.98 to win 0.02, while selling at 0.98 is the good end of that trade.
            clientWithBook({ negRisk, asks: [{ price: '0.98', size: '1000' }] });
            await expect(triggerPolymarket({
                signalId: 'sig-entry-bound',
                tokenID: TOKEN_ID,
                spendAmountUsd: ENTRY_USD,
                direction: 'buy'
            })).rejects.toThrow('outside safe bounds');
            const exitClient = clientWithBook({ negRisk, bids: [{ price: '0.98', size: '1000' }] });
            await triggerPolymarket({
                signalId: 'sig-exit-high',
                tokenID: TOKEN_ID,
                spendAmountUsd: ENTRY_USD,
                direction: 'sell',
                sellShares: 20
            });
            expect(exitClient.createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ side: OrderSide.SELL, minPrice: 0.98 }));
        });
        it('refuses 0.005 as an exit while accepting it as an entry', async () => {
            // Mirror of the case above. A 0.005 bid is close enough to worthless that
            // exiting there is usually a fat-finger or a dead book; entering there is a
            // cheap lottery ticket, which is a position the executor is allowed to take.
            clientWithBook({
                negRisk,
                tickSize: '0.001',
                bids: [{ price: '0.005', size: '10000' }]
            });
            await expect(triggerPolymarket({
                signalId: 'sig-exit-bound',
                tokenID: TOKEN_ID,
                spendAmountUsd: ENTRY_USD,
                direction: 'sell',
                sellShares: 20
            })).rejects.toThrow('outside safe bounds');
            const entryClient = clientWithBook({
                negRisk,
                tickSize: '0.001',
                asks: [{ price: '0.005', size: '10000' }]
            });
            await triggerPolymarket({
                signalId: 'sig-entry-low',
                tokenID: TOKEN_ID,
                spendAmountUsd: ENTRY_USD,
                direction: 'buy'
            });
            expect(entryClient.createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ side: OrderSide.BUY, maxPrice: 0.005 }));
        });
        it('requires an explicit share quantity to exit, and none to enter', async () => {
            // An entry can be sized down to whatever collateral is left, but an exit
            // names a real position. Inferring the quantity would sell something the
            // position may not hold.
            clientWithBook({ negRisk, asks: ENTRY_ASKS, bids: EXIT_BIDS });
            await expect(triggerPolymarket({
                signalId: 'sig-no-shares',
                tokenID: TOKEN_ID,
                spendAmountUsd: ENTRY_USD,
                direction: 'sell'
            })).rejects.toThrow('require an exact requested share quantity');
            await expect(triggerPolymarket({
                signalId: 'sig-entry-no-shares',
                tokenID: TOKEN_ID,
                spendAmountUsd: ENTRY_USD,
                direction: 'buy'
            })).resolves.toBeDefined();
        });
    });
});
//# sourceMappingURL=polymarket-negrisk.test.js.map