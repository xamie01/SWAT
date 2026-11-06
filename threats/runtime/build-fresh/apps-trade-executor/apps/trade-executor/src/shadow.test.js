import { describe, it, expect, vi, beforeEach } from 'vitest';
process.env.TROJAN_WEBHOOK_URL = 'http://mock-trojan.local';
process.env.TROJAN_WALLET_ADDRESS = '11111111111111111111111111111111';
process.env.HELIUS_API_KEY = 'test-helius-key';
vi.mock('@swat/db', () => ({
    // `persistTrade` runs the S4-M35 valuation on every confirmed fill whose USD
    // amount the caller did not supply, which is exactly this test's Solana live
    // fill. All four helpers are declared, not just the one on today's path: an
    // export missing from this factory does not read as `undefined`, it makes
    // vitest THROW at the call site, and that throw replaces the error under test
    // — which is how a shadow-isolation test came to fail inside `persistTrade`
    // with a stack that pointed at production code.
    //
    // Stubbed rather than `importActual`: `@swat/db`'s barrel throws
    // `DATABASE_URL is required` at import (packages/db/src/client.ts:13), and
    // `importActual` on a `packages/db/src/*` path drags a file outside this
    // package's `rootDir` into the program and adds TS6059 to `tsc --noEmit` (see
    // the same note in execution-authority-wiring.test.ts). The valuation math has
    // its own suite in `packages/db`; nothing here asserts a USD figure.
    //
    // `usdAmount: null` is a value the real function genuinely returns when no
    // native price is available, and `persistTrade` already handles it.
    deriveFillPriceUsd: vi.fn().mockReturnValue(null),
    nativeQuoteCurrencyForChain: vi.fn((chain) => chain === 'solana' ? 'SOL' : chain === 'robinhood-chain' ? 'ETH' : 'USD'),
    valuateChainNativeQuoteLeg: vi.fn().mockReturnValue({
        code: 'native-price-unknown',
        currency: 'SOL',
        nativeAmount: '0.19',
        nativeUsdPrice: null,
        usdAmount: null,
        reason: 'stubbed in shadow.test.ts'
    }),
    valuateQuoteLeg: vi.fn().mockReturnValue({
        code: 'no-quote-leg',
        currency: null,
        nativeAmount: null,
        nativeUsdPrice: null,
        usdAmount: null,
        reason: 'stubbed in shadow.test.ts'
    }),
    claimCircuitBreakerProbe: vi.fn(),
    resolveChainMode: vi.fn(),
    hasRecentBuy: vi.fn().mockResolvedValue(false),
    resolveRiskPolicy: vi.fn().mockResolvedValue({
        maxPositionPct: 5,
        maxDailyExposurePct: 25,
        stopLossPct: 20,
        maxConsecutiveFailures: 3,
        minLiquidityUsd: 50000
    }),
    getRollingExposureUsd: vi.fn().mockResolvedValue(0),
    claimSignalForExecution: vi.fn().mockResolvedValue(true),
    releaseSignalClaim: vi.fn().mockResolvedValue(undefined),
    insertTrade: vi.fn().mockResolvedValue({ id: 'shadow-trade-123' }),
    insertTradeAndMarkSignalExecuted: vi.fn().mockResolvedValue({ id: 'live-trade-123' }),
    insertTradeAndReleaseSignalClaim: vi.fn().mockResolvedValue({ id: 'skipped-trade-123' }),
    getTokenDecimals: vi.fn().mockResolvedValue(6),
    // Runs the callback against a stub client. No test here reaches a
    // transaction body; this keeps the barrel's shape honest if one does.
    withTransaction: vi.fn(async (fn) => fn({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
    query: vi.fn(),
    readCircuitBreakerState: vi.fn(),
    recordCircuitBreakerFailure: vi.fn(),
    recordCircuitBreakerSuccess: vi.fn(),
}));
vi.mock('@swat/shared', async () => {
    // `resolveSlippageBps` is pure resolution math with its own suite in
    // packages/shared, so the real implementation is used rather than a stub — a
    // hand-written stub of the chain defaults would silently drift from them.
    const actual = await vi.importActual('@swat/shared');
    return {
        DEFAULT_RISK_CONFIG: { maxConsecutiveFailures: 3, minLiquidityUsd: 50_000 },
        resolveSlippageBps: actual.resolveSlippageBps,
        getJupiterSimulatedFill: vi.fn(),
        fetchTokenPriceUsd: vi.fn().mockResolvedValue(0.5),
        isChain: vi.fn().mockReturnValue(true),
        initLogger: vi.fn(),
        REDIS_CHANNELS: { alertQueue: 'alerts' },
        resolveChainAddress: vi.fn((value) => ({
            chain: 'solana',
            raw: value.replace(/^solana:/, ''),
            prefixed: value.startsWith('solana:') ? value : `solana:${value}`
        })),
    };
});
vi.mock('bullmq', () => ({
    DelayedError: class DelayedError extends Error {
    },
    Worker: class Worker {
        on = vi.fn();
    },
    UnrecoverableError: class UnrecoverableError extends Error {
    }
}));
vi.mock('ioredis', () => ({
    Redis: class Redis {
        get = vi.fn().mockResolvedValue(null);
        setex = vi.fn().mockResolvedValue('OK');
    }
}));
vi.mock('./policy.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        getDynamicPositionSize: vi.fn().mockResolvedValue(1.0),
        parseScore: vi.fn().mockReturnValue(90),
    };
});
vi.mock('./balances.js', () => ({
    fetchSolanaBalanceSol: vi.fn().mockResolvedValue(0.2)
}));
vi.mock('./robinhood.js', () => ({
    configureRobinhoodRuntime: vi.fn(),
    createViemRobinhoodAdapter: vi.fn(),
    evmAccount: null,
    getRobinhoodLiveReadiness: vi.fn().mockReturnValue({ ready: true, reason: 'verified' }),
    getRobinhoodSpendableEth: vi.fn(),
    triggerRobinhood: vi.fn(),
    getRobinhoodQuote: vi.fn(),
    parseRobinhoodExecutionConfig: vi.fn(),
    reconcileRobinhoodPending: vi.fn(),
    robinhoodPublicClient: {},
    WETH_ROBINHOOD: '0x0000000000000000000000000000000000000001'
}));
vi.mock('./polymarket.js', () => ({
    triggerPolymarket: vi.fn(),
    pollPolymarketOrders: vi.fn(),
    getPolymarketAskPrice: vi.fn(),
    getPolymarketAvailableBalance: vi.fn(),
    getPolymarketLiveReadiness: vi.fn().mockReturnValue({ ready: true, reason: 'verified' })
}));
vi.mock('./robinhood-startup.js', () => ({
    configureRobinhoodOpsAlertEmitter: vi.fn(),
    verifyRobinhoodEnvironment: vi.fn().mockResolvedValue(true)
}));
vi.mock('./polymarket-startup.js', () => ({
    verifyPolymarketEnvironment: vi.fn().mockResolvedValue(true)
}));
vi.mock('./robinhood-runtime.js', () => ({
    createRedisRobinhoodPendingStore: vi.fn(),
    createRobinhoodSafetyAssessment: vi.fn()
}));
vi.mock('./ops-alerts.js', () => ({
    createTelegramRobinhoodOpsAlertEmitter: vi.fn()
}));
vi.mock('./trojan-runtime.js', () => ({
    configureTrojanRuntime: vi.fn(),
    createTrojanRuntimeFromEnvironment: vi.fn(),
    getTrojanLiveReadiness: vi.fn().mockReturnValue({ ready: true, reason: 'configured' }),
    setTrojanRuntimeUnavailable: vi.fn(),
    triggerTrojan: vi.fn().mockResolvedValue({
        status: 'already_resolved',
        clientOrderId: 'sig-123',
        resolution: {
            status: 'filled',
            transactionIdentity: 'live-tx-success',
            fillKind: 'entry',
            nativeLamportsDelta: '-190000000',
            tokenBaseUnitsDelta: '1000000',
            confirmedAt: new Date('2026-07-26T20:00:00.000Z')
        }
    })
}));
describe('Shadow Execution Isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it('should not fail the live trade if the shadow simulation throws', { timeout: 15000 }, async () => {
        const db = await import('@swat/db');
        const shared = await import('@swat/shared');
        // Simulate live+shadow on solana
        db.resolveChainMode.mockResolvedValue({ effectiveMode: 'live+shadow' });
        // Cause the shadow (Jupiter) simulator to throw an error independently
        shared.getJupiterSimulatedFill.mockRejectedValue(new Error('Jupiter API down!'));
        // 2. Call handleJob directly
        const { handleJob } = await import('./index.js');
        const result = await handleJob({ data: {
                signalId: 'sig-123',
                tokenMint: 'So11111111111111111111111111111111111111112',
                score: 95,
                manual: true
            } });
        // 3. Assertions
        expect(result.status).toBe('live-executed');
        expect(result.signature).toBe('live-tx-success');
        // insertTradeAndMarkSignalExecuted should have been called EXACTLY ONCE for the live trade
        // (the second persistTrade in the paper block will be skipped due to the throw)
        expect(db.insertTradeAndMarkSignalExecuted).toHaveBeenCalledTimes(1);
        expect(db.insertTradeAndMarkSignalExecuted).toHaveBeenCalledWith(expect.objectContaining({
            executionMode: 'live',
            executor: 'trojan',
            signature: 'live-tx-success',
            amountSol: 0.19
        }));
        expect(shared.getJupiterSimulatedFill).toHaveBeenCalledOnce();
    });
});
//# sourceMappingURL=shadow.test.js.map