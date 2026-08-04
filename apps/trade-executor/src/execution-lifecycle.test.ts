import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.TROJAN_WEBHOOK_URL = 'http://mock-trojan.local';
  process.env.TROJAN_WALLET_ADDRESS = '11111111111111111111111111111111';
});

const runtimeMocks = vi.hoisted(() => ({
  redisConstructed: vi.fn(),
  workerConstructed: vi.fn(),
  verifyRobinhoodEnvironment: vi.fn(),
  verifyPolymarketEnvironment: vi.fn(),
  triggerTrojan: vi.fn(),
  getTrojanLiveReadiness: vi.fn(),
  getRobinhoodLiveReadiness: vi.fn()
}));

vi.mock('@swat/db', () => ({
  claimCircuitBreakerProbe: vi.fn(),
  claimSourceSignalForCopyExecution: vi.fn(),
  claimSignalForExecution: vi.fn(),
  getRollingExposureUsd: vi.fn(),
  getTokenDecimals: vi.fn(),
  hasRecentBuy: vi.fn(),
    resolveRiskPolicy: vi.fn().mockResolvedValue({
      maxPositionPct: 5,
      maxDailyExposurePct: 25,
      stopLossPct: 20,
      maxConsecutiveFailures: 3,
      minLiquidityUsd: 50000
    }),
  insertTrade: vi.fn().mockResolvedValue({ id: 'inserted-trade' }),
  insertTradeAndMarkSignalExecuted: vi.fn().mockResolvedValue({ id: 'filled-trade' }),
  insertTradeAndReleaseSignalClaim: vi.fn().mockResolvedValue({ id: 'skipped-trade' }),
  // Copy eligibility is exercised on its own in copy-eligibility.test.ts. These
  // tests are about lifecycle routing, so the source is a selected, active
  // wallet — the gate has to pass for the claim under test to be reached.
  loadCopyEligibilityFacts: vi.fn().mockImplementation(async ({ signalId }) => ({
    signalId,
    signalStatus: 'eligible',
    chain: 'solana',
    walletAddress: 'solana:source-wallet',
    walletKnown: true,
    walletStatus: 'active',
    walletTradeCount: 40,
    clusterSelected: true,
    sourceActivityUsd: 10_000,
    eventAt: new Date()
  })),
  recordCopyEligibilityRejection: vi.fn().mockResolvedValue(true),
  // Runs the callback against a stub client. No test here reaches a
  // transaction body; this keeps the barrel's shape honest if one does.
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
  query: vi.fn(),
  readCircuitBreakerState: vi.fn(),
  recordCircuitBreakerFailure: vi.fn(),
  recordCircuitBreakerSuccess: vi.fn(),
  recordCopyExecutionEvidence: vi.fn(),
  releaseSignalClaim: vi.fn(),
  resolveChainMode: vi.fn(),
  transitionCopyExecution: vi.fn()
}));

vi.mock('@swat/shared', async () => {
  // evaluateCopyPolicy is pure decision math with its own suite in
  // packages/shared; stubbing it would only test the stub.
  const actual = await vi.importActual<typeof import('@swat/shared')>('@swat/shared');
  return {
    DEFAULT_RISK_CONFIG: { maxConsecutiveFailures: 3 },
    evaluateCopyPolicy: actual.evaluateCopyPolicy,
    fetchTokenPriceUsd: vi.fn().mockResolvedValue(0.5),
    getJupiterSimulatedFill: vi.fn(),
    initLogger: vi.fn(),
    isChain: vi.fn().mockReturnValue(true),
    REDIS_CHANNELS: { alertQueue: 'alerts' }
  };
});

vi.mock('bullmq', () => ({
  DelayedError: class DelayedError extends Error {},
  UnrecoverableError: class UnrecoverableError extends Error {},
  Worker: class Worker {
    constructor() {
      runtimeMocks.workerConstructed();
    }
    on = vi.fn();
  }
}));

vi.mock('ioredis', () => ({
  Redis: class Redis {
    constructor() {
      runtimeMocks.redisConstructed();
    }
    get = vi.fn().mockResolvedValue(null);
    publish = vi.fn().mockResolvedValue(1);
    set = vi.fn().mockResolvedValue('OK');
    setex = vi.fn().mockResolvedValue('OK');
  }
}));

vi.mock('./robinhood.js', () => ({
  configureRobinhoodRuntime: vi.fn(),
  createViemRobinhoodAdapter: vi.fn(),
  evmAccount: null,
  getRobinhoodLiveReadiness: runtimeMocks.getRobinhoodLiveReadiness,
  getRobinhoodSpendableEth: vi.fn(),
  getRobinhoodQuote: vi.fn(),
  parseRobinhoodExecutionConfig: vi.fn(),
  reconcileRobinhoodPending: vi.fn(),
  robinhoodPublicClient: {},
  triggerRobinhood: vi.fn(),
  WETH_ROBINHOOD: '0x0000000000000000000000000000000000000001'
}));

vi.mock('./polymarket.js', () => ({
  getPolymarketLiveReadiness: vi.fn().mockReturnValue({ ready: true, reason: 'verified' }),
  getPolymarketAskPrice: vi.fn(),
  getPolymarketAvailableBalance: vi.fn(),
  pollPolymarketOrders: vi.fn(),
  triggerPolymarket: vi.fn()
}));

vi.mock('./robinhood-startup.js', () => ({
  configureRobinhoodOpsAlertEmitter: vi.fn(),
  verifyRobinhoodEnvironment: runtimeMocks.verifyRobinhoodEnvironment
}));

vi.mock('./polymarket-startup.js', () => ({
  verifyPolymarketEnvironment: runtimeMocks.verifyPolymarketEnvironment
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
  getTrojanLiveReadiness: runtimeMocks.getTrojanLiveReadiness,
  setTrojanRuntimeUnavailable: vi.fn(),
  triggerTrojan: runtimeMocks.triggerTrojan
}));

import * as db from '@swat/db';
import * as polymarket from './polymarket.js';
import {
  clampExecutionModeForStartup,
  executeJobWithCircuitBreaker,
  handleJob,
  persistTrade,
  runChainReconciliations,
  runTrojanReconciliation
} from './index.js';

const importSideEffects = {
  redis: runtimeMocks.redisConstructed.mock.calls.length,
  worker: runtimeMocks.workerConstructed.mock.calls.length,
  robinhoodStartup: runtimeMocks.verifyRobinhoodEnvironment.mock.calls.length,
  polymarketStartup: runtimeMocks.verifyPolymarketEnvironment.mock.calls.length
};

const baseTrade = {
  signalId: 'signal-1',
  tokenMint: 'polygon:token-1',
  size: 10,
  amountUsd: 10,
  chain: 'polygon' as const,
  direction: 'buy' as const,
  executor: 'polymarket-clob'
};

function canonicalExecution(
  state: 'requested' | 'simulated' | 'reconciliation_required' = 'requested',
  executionMode: 'live' | 'shadow' = 'live'
) {
  return {
    id: `${executionMode}-execution-id`,
    signalId: 'source-signal',
    sourceTradeId: 'source-trade',
    chain: 'solana' as const,
    targetAccount: 'solana:11111111111111111111111111111111',
    tokenMint: 'solana:token-1',
    direction: 'sell' as const,
    executionMode,
    clientOrderId: `swat-${executionMode}-client-order`,
    state,
    requestedBaseQuantity: '2',
    requestedQuoteQuantity: null,
    confirmedBaseQuantity: '0',
    confirmedQuoteQuantity: '0',
    reservedBaseQuantity: '2',
    submissionAttempts: 0,
    maxSubmissionAttempts: 3,
    simulationId: state === 'simulated' ? 'existing-simulation' : null,
    submissionType: null,
    submissionId: null,
    nextReconciliationAt: null,
    reconciliationClaimId: null,
    reconciliationAttempts: 0,
    maxReconciliationAttempts: 10,
    sourcePositionBeforeQuantity: '8',
    sourceSellFraction: '0.25'
  };
}

describe('executor trade-state routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.readCircuitBreakerState).mockResolvedValue({
      consecutiveFailures: 0,
      trippedAt: null
    });
    vi.mocked(db.claimCircuitBreakerProbe).mockResolvedValue(false);
    vi.mocked(db.recordCircuitBreakerFailure).mockResolvedValue({
      consecutiveFailures: 1,
      trippedAt: null
    });
    vi.mocked(db.recordCircuitBreakerSuccess).mockResolvedValue({
      consecutiveFailures: 0,
      trippedAt: null
    });
    runtimeMocks.getTrojanLiveReadiness.mockReturnValue({ ready: true, reason: 'configured' });
    runtimeMocks.getRobinhoodLiveReadiness.mockReturnValue({ ready: true, reason: 'verified' });
    vi.mocked(polymarket.getPolymarketLiveReadiness).mockReturnValue({
      ready: true,
      reason: 'verified'
    });
  });

  it('does not construct Redis, a worker, or run startup verification when imported', () => {
    expect(importSideEffects).toEqual({
      redis: 0,
      worker: 0,
      robinhoodStartup: 0,
      polymarketStartup: 0
    });
  });

  it('clamps Polygon live mode to paper when startup attestation is not ready', () => {
    vi.mocked(polymarket.getPolymarketLiveReadiness).mockReturnValue({
      ready: false,
      reason: 'contract mismatch'
    });

    expect(clampExecutionModeForStartup('polygon', 'live')).toEqual({
      effectiveMode: 'paper',
      reason: 'Polygon startup attestation failed: contract mismatch'
    });
    expect(clampExecutionModeForStartup('solana', 'live')).toEqual({
      effectiveMode: 'live',
      reason: undefined
    });

    runtimeMocks.getRobinhoodLiveReadiness.mockReturnValue({
      ready: false,
      reason: 'router attestation failed'
    });
    expect(clampExecutionModeForStartup('robinhood-chain', 'live+shadow')).toEqual({
      effectiveMode: 'paper',
      reason: 'Robinhood startup attestation failed: router attestation failed'
    });
  });

  it('persists submitted orders without executing or releasing the signal', async () => {
    await expect(persistTrade({
      ...baseTrade,
      executionMode: 'live',
      status: 'pending_confirmation',
      signature: null,
      venueOrderId: 'order-1',
      submittedAt: new Date('2026-07-24T12:00:00Z')
    })).resolves.toBe('inserted-trade');

    expect(db.insertTrade).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending_confirmation',
      amountUsd: null,
      tokenAmount: null,
      priceUsd: null,
      signature: null,
      venueOrderId: 'order-1',
      confirmedAt: null
    }));
    expect(db.insertTradeAndMarkSignalExecuted).not.toHaveBeenCalled();
    expect(db.insertTradeAndReleaseSignalClaim).not.toHaveBeenCalled();
  });

  it('persists confirmed partial venue values and retains requested notional separately', async () => {
    await persistTrade({
      ...baseTrade,
      size: 10,
      requestedAmountUsd: 10,
      amountUsd: 4.5,
      tokenAmount: 9,
      priceUsd: 0.5,
      feeUsd: 0.025,
      executionMode: 'live',
      status: 'partial'
    });

    expect(db.insertTradeAndMarkSignalExecuted).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        amountSol: 10,
        targetAmountUsd: 10,
        amountUsd: 4.5,
        tokenAmount: 9,
        priceUsd: 0.5,
        feeUsd: 0.025
      })
    );
  });

  it('routes confirmed fills, terminal skips, and shadow rows separately', async () => {
    await persistTrade({ ...baseTrade, executionMode: 'live', status: 'filled' });
    expect(db.insertTradeAndMarkSignalExecuted).toHaveBeenCalledOnce();

    await persistTrade({
      ...baseTrade,
      executionMode: 'live',
      status: 'skipped',
      errorMessage: 'no route'
    });
    expect(db.insertTradeAndReleaseSignalClaim).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped', errorMessage: 'no route' })
    );

    await persistTrade({ ...baseTrade, executionMode: 'shadow', status: 'filled' });
    expect(db.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: 'shadow', status: 'filled' })
    );
    expect(db.insertTradeAndMarkSignalExecuted).toHaveBeenCalledTimes(1);
  });

  it('persists breaker state per chain and does not reset it for policy skips', async () => {
    const job = {
      data: { tokenMint: 'polygon:token-1' },
      token: 'lock-token',
      moveToDelayed: vi.fn()
    };
    const skip = vi.fn().mockResolvedValue({ status: 'skipped', reason: 'policy' });

    await expect(executeJobWithCircuitBreaker(job, skip)).resolves.toEqual({
      status: 'skipped',
      reason: 'policy'
    });
    expect(db.readCircuitBreakerState).toHaveBeenCalledWith('operator', 'polygon');
    expect(db.recordCircuitBreakerSuccess).not.toHaveBeenCalled();
    expect(db.recordCircuitBreakerFailure).not.toHaveBeenCalled();

    const success = vi.fn().mockResolvedValue({ status: 'live-executed' });
    await executeJobWithCircuitBreaker(job, success);
    expect(db.recordCircuitBreakerSuccess).toHaveBeenCalledWith('operator', 'polygon');
  });

  it('counts returned execution failures and thrown transient failures', async () => {
    const job = {
      data: { tokenMint: 'robinhood-chain:0x0000000000000000000000000000000000000001' },
      token: 'lock-token',
      moveToDelayed: vi.fn()
    };

    await executeJobWithCircuitBreaker(
      job,
      vi.fn().mockResolvedValue({ status: 'rejected', reason: 'venue rejected' })
    );
    await expect(executeJobWithCircuitBreaker(
      job,
      vi.fn().mockRejectedValue(new Error('rpc unavailable'))
    )).rejects.toThrow('rpc unavailable');

    expect(db.recordCircuitBreakerFailure).toHaveBeenCalledTimes(2);
    expect(db.recordCircuitBreakerFailure).toHaveBeenCalledWith(
      'operator',
      'robinhood-chain',
      3
    );
  });

  it('delays a tripped chain unless it owns the half-open probe lease', async () => {
    const trippedAt = new Date(Date.now() - 1_000).toISOString();
    vi.mocked(db.readCircuitBreakerState).mockResolvedValue({
      consecutiveFailures: 3,
      trippedAt
    });
    vi.mocked(db.claimCircuitBreakerProbe).mockResolvedValue(false);
    const job = {
      data: { tokenMint: 'solana:token-1' },
      token: 'lock-token',
      moveToDelayed: vi.fn().mockResolvedValue(undefined)
    };
    const execute = vi.fn();

    await expect(executeJobWithCircuitBreaker(job, execute)).rejects.toBeInstanceOf(Error);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock-token');
    expect(execute).not.toHaveBeenCalled();

    vi.mocked(db.claimCircuitBreakerProbe).mockResolvedValue(true);
    const probe = vi.fn().mockResolvedValue({ status: 'submitted' });
    await expect(executeJobWithCircuitBreaker(job, probe)).resolves.toEqual({
      status: 'submitted'
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(db.recordCircuitBreakerSuccess).toHaveBeenCalledWith('operator', 'solana');
  });

  it('routes a Solana SELL through the stable Trojan runtime without BUY sizing', async () => {
    vi.mocked(db.resolveChainMode).mockResolvedValue({
      requestedMode: 'live',
      effectiveMode: 'live',
      certified: true
    });
    vi.mocked(db.claimSignalForExecution).mockResolvedValue(true);
    runtimeMocks.triggerTrojan.mockResolvedValue({
      status: 'pending_confirmation',
      clientOrderId: 'sell-signal',
      transactionIdentity: 'solana-sell-signature',
      order: {},
      firstAttemptAt: new Date(),
      lastAttemptAt: new Date(),
      acknowledgedAt: new Date(),
      attempts: 1
    });

    await expect(handleJob({
      data: {
        signalId: 'sell-signal',
        tokenMint: 'solana:token-1',
        score: 90,
        manual: true,
        direction: 'sell'
      }
    })).resolves.toMatchObject({
      status: 'submitted',
      state: 'pending_confirmation',
      signature: 'solana-sell-signature'
    });

    expect(runtimeMocks.triggerTrojan).toHaveBeenCalledWith(expect.objectContaining({
      signalId: 'sell-signal',
      direction: 'sell',
      sellProportionBps: 10_000,
      amountSol: 0
    }));
    expect(db.insertTrade).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'sell',
      status: 'pending_confirmation',
      signature: 'solana-sell-signature'
    }));
    expect(db.insertTradeAndMarkSignalExecuted).not.toHaveBeenCalled();
  });

  it('keeps live execution moving when proportional shadow preparation has no position', async () => {
    vi.mocked(db.resolveChainMode).mockResolvedValue({
      requestedMode: 'live+shadow',
      effectiveMode: 'live+shadow',
      certified: true
    });
    vi.mocked(db.getTokenDecimals).mockResolvedValue(6);
    vi.mocked(db.claimSourceSignalForCopyExecution)
      .mockResolvedValueOnce({
        execution: canonicalExecution('requested', 'live'),
        created: true,
        claimed: true
      })
      .mockResolvedValueOnce({
        execution: null,
        created: false,
        claimed: false,
        reason: 'No unreserved confirmed copied position is available to sell'
      });
    runtimeMocks.triggerTrojan.mockResolvedValue({
      status: 'pending_confirmation',
      clientOrderId: 'swat-live-client-order',
      transactionIdentity: 'canonical-solana-signature',
      order: {},
      firstAttemptAt: new Date(),
      lastAttemptAt: new Date(),
      acknowledgedAt: new Date(),
      attempts: 1
    });

    await expect(handleJob({
      data: {
        signalId: 'source-signal',
        sourceTradeId: 'source-trade',
        tokenMint: 'solana:token-1',
        score: 90,
        manual: true,
        direction: 'sell'
      }
    })).resolves.toMatchObject({ status: 'submitted', signature: 'canonical-solana-signature' });

    expect(runtimeMocks.triggerTrojan).toHaveBeenCalledWith(expect.objectContaining({
      signalId: 'swat-live-client-order',
      sellProportionBps: 2_500,
      maximumTokenAmountBaseUnits: '2000000'
    }));
    expect(db.transitionCopyExecution).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'live-execution-id',
      nextState: 'submitted',
      submissionId: 'canonical-solana-signature'
    }));
    expect(db.releaseSignalClaim).not.toHaveBeenCalled();
  });

  it.each(['requested', 'simulated'] as const)(
    'retries a canonical %s execution with the same client order identity',
    async (state) => {
      vi.mocked(db.resolveChainMode).mockResolvedValue({
        requestedMode: 'live',
        effectiveMode: 'live',
        certified: true
      });
      vi.mocked(db.getTokenDecimals).mockResolvedValue(6);
      vi.mocked(db.claimSourceSignalForCopyExecution).mockResolvedValue({
        execution: canonicalExecution(state),
        created: false,
        claimed: false
      });
      runtimeMocks.triggerTrojan.mockResolvedValue({
        status: 'pending_confirmation',
        clientOrderId: 'swat-live-client-order',
        transactionIdentity: 'same-submission',
        order: {},
        firstAttemptAt: new Date(),
        lastAttemptAt: new Date(),
        acknowledgedAt: new Date(),
        attempts: 1
      });

      await handleJob({
        data: {
          signalId: 'source-signal',
          sourceTradeId: 'source-trade',
          tokenMint: 'solana:token-1',
          score: 90,
          manual: true,
          direction: 'sell'
        }
      });

      expect(runtimeMocks.triggerTrojan).toHaveBeenCalledWith(expect.objectContaining({
        signalId: 'swat-live-client-order'
      }));
    }
  );

  it('does not resubmit a canonical reconciliation-required execution', async () => {
    vi.mocked(db.resolveChainMode).mockResolvedValue({
      requestedMode: 'live',
      effectiveMode: 'live',
      certified: true
    });
    vi.mocked(db.claimSourceSignalForCopyExecution).mockResolvedValue({
      execution: canonicalExecution('reconciliation_required'),
      created: false,
      claimed: false
    });

    await expect(handleJob({
      data: {
        signalId: 'source-signal',
        sourceTradeId: 'source-trade',
        tokenMint: 'solana:token-1',
        score: 90,
        manual: true,
        direction: 'sell'
      }
    })).resolves.toMatchObject({ status: 'submitted', state: 'reconciliation_required' });
    expect(runtimeMocks.triggerTrojan).not.toHaveBeenCalled();
  });

  it('persists explicit Solana reconciliation-required and submission-unknown states', async () => {
    const reconcile = vi.fn().mockResolvedValue([
      {
        status: 'pending_reconciliation',
        transactionIdentity: 'solana-pending-signature'
      },
      {
        status: 'submission_unknown',
        clientOrderId: '00000000-0000-4000-8000-000000000001'
      }
    ]);

    await runTrojanReconciliation({ reconcile });

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('venue_status = $2'),
      ['solana-pending-signature', 'pending_reconciliation']
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("venue_status = 'submission_unknown'"),
      ['00000000-0000-4000-8000-000000000001']
    );
  });

  it('isolates reconciliation failures between chains', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const robinhoodRun = vi.fn().mockRejectedValue(new Error('Robinhood RPC offline'));
    const solanaRun = vi.fn().mockResolvedValue([{ status: 'filled' }]);

    await expect(runChainReconciliations([
      { chain: 'robinhood-chain', run: robinhoodRun },
      { chain: 'solana', run: solanaRun }
    ])).resolves.toBeUndefined();

    expect(robinhoodRun).toHaveBeenCalledOnce();
    expect(solanaRun).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      '[trade-executor] robinhood-chain reconciliation failed',
      expect.any(Error)
    );
    error.mockRestore();
  });
});
