import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.TROJAN_WEBHOOK_URL = 'http://mock-trojan.local';
process.env.TROJAN_WALLET_ADDRESS = '11111111111111111111111111111111';
process.env.HELIUS_API_KEY = 'test-helius-key';

vi.mock('@swat/db', () => ({
  claimCircuitBreakerProbe: vi.fn(),
  resolveChainMode: vi.fn(),
  hasRecentBuy: vi.fn().mockResolvedValue(false),
  getRollingExposureUsd: vi.fn().mockResolvedValue(0),
  claimSignalForExecution: vi.fn().mockResolvedValue(true),
  releaseSignalClaim: vi.fn().mockResolvedValue(undefined),
  insertTrade: vi.fn().mockResolvedValue({ id: 'shadow-trade-123' }),
  insertTradeAndMarkSignalExecuted: vi.fn().mockResolvedValue({ id: 'live-trade-123' }),
  insertTradeAndReleaseSignalClaim: vi.fn().mockResolvedValue({ id: 'skipped-trade-123' }),
  getTokenDecimals: vi.fn().mockResolvedValue(6),
  pool: { connect: vi.fn() },
  query: vi.fn(),
  readCircuitBreakerState: vi.fn(),
  recordCircuitBreakerFailure: vi.fn(),
  recordCircuitBreakerSuccess: vi.fn(),
}));

vi.mock('@swat/shared', () => ({
  DEFAULT_RISK_CONFIG: { maxConsecutiveFailures: 3, minLiquidityUsd: 50_000 },
  getJupiterSimulatedFill: vi.fn(),
  fetchTokenPriceUsd: vi.fn().mockResolvedValue(0.5),
  isChain: vi.fn().mockReturnValue(true),
  initLogger: vi.fn(),
  REDIS_CHANNELS: { alertQueue: 'alerts' },
  resolveChainAddress: vi.fn((value: string) => ({
    chain: 'solana',
    raw: value.replace(/^solana:/, ''),
    prefixed: value.startsWith('solana:') ? value : `solana:${value}`
  })),
}));

vi.mock('bullmq', () => ({
  DelayedError: class DelayedError extends Error {},
  Worker: class Worker {
    on = vi.fn();
  },
  UnrecoverableError: class UnrecoverableError extends Error {}
}));

vi.mock('ioredis', () => ({
  Redis: class Redis {
    get = vi.fn().mockResolvedValue(null);
    setex = vi.fn().mockResolvedValue('OK');
  }
}));

vi.mock('./policy.js', async (importOriginal) => {
  const actual: any = await importOriginal();
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
    (db.resolveChainMode as any).mockResolvedValue({ effectiveMode: 'live+shadow' });
    
    // Cause the shadow (Jupiter) simulator to throw an error independently
    (shared.getJupiterSimulatedFill as any).mockRejectedValue(new Error('Jupiter API down!'));
    
    // 2. Call handleJob directly
    const { handleJob } = await import('./index.js');
    const result = await handleJob({ data: {
      signalId: 'sig-123',
      tokenMint: 'So11111111111111111111111111111111111111112',
      score: 95,
      manual: true
    }});

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
