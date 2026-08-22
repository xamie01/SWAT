import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Hoisted so the `@swat/db` factory below and the Polygon suite's `afterEach`
// share ONE definition of the default (Solana) eligibility facts. The Polygon
// tests have to swap this implementation — the gate refuses a
// `source-chain-mismatch` long before the venue — and `vi.clearAllMocks()`
// clears calls but NOT implementations, so a swap that is not undone leaks into
// every later Solana copy test. Restoring from the same constant the factory
// used is what keeps the two in step.
const eligibilityFixtures = vi.hoisted(() => ({
  solanaFacts: async ({ signalId }: { signalId: string }) => ({
    signalId,
    signalStatus: 'eligible' as const,
    chain: 'solana' as const,
    walletAddress: 'solana:source-wallet',
    walletKnown: true,
    walletStatus: 'active',
    walletTradeCount: 40,
    clusterSelected: true,
    sourceActivityUsd: 10_000,
    eventAt: new Date()
  })
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
  // Solana-shaped by default; see `eligibilityFixtures` above for why the
  // implementation lives outside this factory.
  loadCopyEligibilityFacts: vi.fn().mockImplementation(eligibilityFixtures.solanaFacts),
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
  transitionCopyExecution: vi.fn(),
  // index.ts binds this into `robinhoodNonceLock` (S4-M12). Never invoked here —
  // no case reaches a live EVM submission — but an absent barrel export is how a
  // mock drifts from the module it stands in for.
  withEvmNonceLock: vi.fn(),
  // Supplies the master's fill price for the S4-M16 mirror bound at the Polymarket
  // call site. Driven by the `Polymarket mirror bound at the handleJob call site`
  // suite at the bottom of this file, which is the only place here that reaches
  // the Polygon branch of `handleJob`.
  getCanonicalSourceTradeById: vi.fn()
}));

vi.mock('@swat/shared', async () => {
  // evaluateCopyPolicy is pure decision math with its own suite in
  // packages/shared; stubbing it would only test the stub.
  const actual = await vi.importActual<typeof import('@swat/shared')>('@swat/shared');
  // Imported from source rather than from `actual`, because `@swat/shared`
  // resolves to its built `dist` here and that artifact lags the source (see the
  // handoff's stale-dist note). Re-implementing the derivation in this mock would
  // let it drift from the one the producers route on, which is the whole point of
  // S3-25 having a single definition.
  const { chainFromTokenMint } = await vi.importActual<
    typeof import('../../../packages/shared/src/constants.js')
  >('../../../packages/shared/src/constants.js');
  return {
    DEFAULT_RISK_CONFIG: { maxConsecutiveFailures: 3 },
    chainFromTokenMint,
    evaluateCopyPolicy: actual.evaluateCopyPolicy,
    // Pure resolution math with its own suite; a stub would test the stub.
    resolveSlippageBps: actual.resolveSlippageBps,
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
  // `index.ts` does `error instanceof NonceContentionError` (S4-M12). Omitting it
  // from this mock makes the right-hand side `undefined`, and the resulting
  // TypeError replaces whatever error the case under test threw — which is how
  // this mock silently broke the breaker-counting case. A stand-in class is
  // enough because only `instanceof` is used; the real class is exercised in
  // `robinhood-nonce.test.ts`.
  NonceContentionError: class NonceContentionError extends Error {},
  WETH_ROBINHOOD: '0x0000000000000000000000000000000000000001'
}));

vi.mock('./polymarket.js', () => ({
  getPolymarketLiveReadiness: vi.fn().mockReturnValue({ ready: true, reason: 'verified' }),
  getPolymarketAskPrice: vi.fn(),
  getPolymarketAvailableBalance: vi.fn(),
  pollPolymarketOrders: vi.fn(),
  triggerPolymarket: vi.fn(),
  // `resolveLiveCopyTargetAccount('polygon')` reads both of these before the
  // canonical claim: it throws `EVM_PRIVATE_KEY is required for canonical
  // Polymarket execution` on a falsy signer, so a Polygon copy cannot reach the
  // venue without them. A plain object is enough — only `.address` is read, and
  // the real derivation is covered in `polymarket-representation.test.ts`.
  polymarketSigner: { address: '0x00000000000000000000000000000000000000aa' },
  resolvePolymarketIdentity: vi.fn().mockReturnValue({
    signerAddress: '0x00000000000000000000000000000000000000aa',
    funderAddress: '0x00000000000000000000000000000000000000bb'
  })
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
import { NonceContentionError } from './robinhood.js';
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
    // The S4-10 tenancy key. `null` rather than a placeholder id because these
    // fixtures are operator-mode executions and there is no user behind them —
    // inventing one would make a single-tenant path look multi-tenant.
    //
    // This was missing, and invisible: `@swat/db` resolves to a stale `dist` that
    // predates `userId`, so the omission only surfaces when typechecking against
    // source. It would have appeared as three unexplained TS2741 errors the moment
    // the operator rebuilt the package. See docs/stale-dist-hazards.md item 2.
    userId: null,
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

  it('does NOT count nonce contention against the breaker (S4-M12)', async () => {
    // Contention means another process holds the account's nonce lock — nothing
    // is wrong with the venue. Counting it would let three unlucky millisecond
    // overlaps trip the breaker and halt every trade on the chain for five
    // minutes, converting a retryable collision into an outage.
    const job = {
      data: { tokenMint: 'robinhood-chain:0x0000000000000000000000000000000000000001' },
      token: 'lock-token',
      moveToDelayed: vi.fn()
    };

    await expect(executeJobWithCircuitBreaker(
      job,
      vi.fn().mockRejectedValue(new NonceContentionError('contended'))
    )).rejects.toBeInstanceOf(NonceContentionError);

    expect(db.recordCircuitBreakerFailure).not.toHaveBeenCalled();
    expect(db.recordCircuitBreakerSuccess).not.toHaveBeenCalled();
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
      amountSol: 0,
      // Pins the `S4-P4` threading. The 1500 that used to be a literal at this
      // call site now comes from `resolveSlippageBps('solana', null)`, and
      // nothing else in the suite asserts a slippage value — verified by
      // changing the Solana default and watching all 332 tests stay green.
      // Without this, migration `049` could wire the user's value to the wrong
      // place and no test would notice.
      slippageBps: 1500
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

/**
 * A Polygon-shaped canonical execution.
 *
 * Deliberately NOT a parameterisation of `canonicalExecution` above: that fixture
 * is Solana-shaped down to its addresses, and `prepareCanonicalExecutions` throws
 * `Canonical execution identity does not match the queued source event` unless
 * `chain`, `direction`, and `sourceTradeId` all agree with the queued job. A
 * mismatch is refused long before the venue, so the two fixtures stay separate
 * rather than growing a chain switch that would let a wrong-chain row through.
 */
function polygonCanonicalExecution(direction: 'buy' | 'sell' = 'buy') {
  return {
    id: 'polygon-execution-id',
    signalId: 'polygon-source-signal',
    sourceTradeId: 'polygon-source-trade',
    chain: 'polygon' as const,
    // Operator-mode execution: no user behind it (S4-10), same reasoning as the
    // Solana fixture above.
    userId: null,
    targetAccount: 'polygon:0x00000000000000000000000000000000000000bb',
    tokenMint: 'polygon:token-1',
    direction,
    executionMode: 'live' as const,
    clientOrderId: 'swat-polygon-client-order',
    state: 'requested' as const,
    requestedBaseQuantity: direction === 'sell' ? '25' : null,
    requestedQuoteQuantity: direction === 'buy' ? '50' : null,
    confirmedBaseQuantity: '0',
    confirmedQuoteQuantity: '0',
    reservedBaseQuantity: direction === 'sell' ? '25' : '0',
    submissionAttempts: 0,
    maxSubmissionAttempts: 3,
    simulationId: null,
    submissionType: null,
    submissionId: null,
    nextReconciliationAt: null,
    reconciliationClaimId: null,
    reconciliationAttempts: 0,
    maxReconciliationAttempts: 10,
    sourcePositionBeforeQuantity: direction === 'sell' ? '100' : null,
    sourceSellFraction: direction === 'sell' ? '0.25' : null
  };
}

/** A `source_trades` row as `getCanonicalSourceTradeById` returns it. */
function polygonSourceTrade(priceUsd: string | null) {
  return {
    id: 'polygon-source-trade',
    chain: 'polygon' as const,
    sourceEventType: 'evm_log' as const,
    sourceEventId: '0xmastertx',
    sourceEventIndex: '0',
    transactionHash: '0xmastertx',
    walletAddress: 'polygon:0x00000000000000000000000000000000000000cc',
    tokenMint: 'polygon:token-1',
    side: 'buy' as const,
    quantity: '80',
    amountUsd: '50',
    priceUsd,
    eventAt: new Date('2026-08-22T11:59:00Z'),
    observedAt: new Date('2026-08-22T11:59:05Z'),
    confirmationState: 'confirmed' as const
  };
}

/**
 * What `triggerPolymarket` resolves to on a clean fill.
 *
 * Typed off the venue function's own return type rather than as a loose literal,
 * so a field added to the real result (`mirrorBoundPrice` and `mirrorTrackingBps`
 * arrived with S4-M16) fails the typecheck here instead of leaving this fixture
 * describing a response shape the executor no longer receives.
 */
type PolymarketTriggerResult = Awaited<ReturnType<typeof polymarket.triggerPolymarket>>;

function polymarketFill(): PolymarketTriggerResult {
  return {
    orderId: 'polymarket-order-1',
    // The venue reports `OrderPostStatus`, an enum, so a bare string literal is
    // not assignable. Cast rather than import, to keep `@polymarket/client` out
    // of this file for one constant.
    status: 'matched' as PolymarketTriggerResult['status'],
    executionStatus: 'filled',
    requestedSpendAmountUsd: 50,
    spendAmountUsd: 50,
    requestedShares: 80,
    shares: 80,
    averagePrice: 0.625,
    feesUsd: 0.05,
    latencyMs: 120,
    slippageBps: 300,
    // Whatever bound the planner settled on. Not asserted here — the bound math
    // is `polymarket-mirror-bound.test.ts`; this suite is about the input the
    // call site hands it.
    mirrorBoundPrice: 0.63,
    mirrorTrackingBps: 300,
    tradeIds: ['polymarket-trade-1'],
    settlementTransactionHashes: ['0xsettlement']
  };
}

describe('Polymarket mirror bound at the handleJob call site (S4-M16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reaching the Polygon branch at all requires the whole pre-venue gauntlet to
    // pass. Each of these is a place an earlier attempt stopped short of the venue.
    vi.mocked(db.resolveChainMode).mockResolvedValue({
      requestedMode: 'live',
      effectiveMode: 'live',
      certified: true
    });
    vi.mocked(polymarket.getPolymarketLiveReadiness).mockReturnValue({
      ready: true,
      reason: 'verified'
    });
    // Balance-aware sizing runs BEFORE the venue call and throws
    // `Balance-aware sizing inputs must be finite, non-negative numbers` when the
    // Polygon balance read resolves `undefined`. This is the single mock whose
    // absence hides the branch entirely.
    vi.mocked(polymarket.getPolymarketAvailableBalance).mockResolvedValue(1_000);
    vi.mocked(polymarket.getPolymarketAskPrice).mockResolvedValue(0.5);
    vi.mocked(db.getRollingExposureUsd).mockResolvedValue(0);
    vi.mocked(db.hasRecentBuy).mockResolvedValue(false);
    // Polygon-shaped facts: `enforceCopyEligibility` rejects
    // `source-chain-mismatch` against the Solana default.
    vi.mocked(db.loadCopyEligibilityFacts).mockImplementation(async ({ signalId }) => ({
      signalId,
      signalStatus: 'eligible',
      chain: 'polygon',
      walletAddress: 'polygon:0x00000000000000000000000000000000000000cc',
      walletKnown: true,
      walletStatus: 'active',
      walletTradeCount: 40,
      clusterSelected: true,
      sourceActivityUsd: 10_000,
      eventAt: new Date()
    }));
    vi.mocked(polymarket.triggerPolymarket).mockResolvedValue(polymarketFill());
  });

  afterEach(() => {
    // `vi.clearAllMocks()` in the sibling suites' `beforeEach` clears CALLS but
    // leaves every implementation set above in place, so a Solana copy test that
    // ran after this suite would read Polygon eligibility facts and be refused for
    // `source-chain-mismatch`. Undo the swap explicitly, restoring the default from
    // the same hoisted constant the module factory used.
    vi.mocked(db.loadCopyEligibilityFacts).mockImplementation(eligibilityFixtures.solanaFacts);
    // These five have no implementation in the module factory, so resetting them
    // returns them to exactly their declared state. `mockReset` (not `mockClear`)
    // because only reset drops a queued implementation.
    vi.mocked(db.getCanonicalSourceTradeById).mockReset();
    vi.mocked(db.getRollingExposureUsd).mockReset();
    vi.mocked(db.hasRecentBuy).mockReset();
    vi.mocked(polymarket.getPolymarketAvailableBalance).mockReset();
    vi.mocked(polymarket.getPolymarketAskPrice).mockReset();
    vi.mocked(polymarket.triggerPolymarket).mockReset();
  });

  it('passes the master fill price to the venue as the mirror reference for a copy', async () => {
    vi.mocked(db.claimSourceSignalForCopyExecution).mockResolvedValue({
      execution: polygonCanonicalExecution('buy'),
      created: true,
      claimed: true
    });
    vi.mocked(db.getCanonicalSourceTradeById).mockResolvedValue(polygonSourceTrade('0.61'));

    await expect(handleJob({
      data: {
        signalId: 'polygon-source-signal',
        sourceTradeId: 'polygon-source-trade',
        tokenMint: 'polygon:token-1',
        score: 90,
        manual: true,
        direction: 'buy'
      }
    })).resolves.toMatchObject({ status: 'live-executed', signature: 'polymarket-order-1' });

    // The proof the branch is genuinely reached: the read happened against the
    // queued source id, and its price arrived at the venue as a number.
    expect(db.getCanonicalSourceTradeById).toHaveBeenCalledWith('polygon-source-trade');
    expect(polymarket.triggerPolymarket).toHaveBeenCalledWith(expect.objectContaining({
      signalId: 'swat-polygon-client-order',
      tokenID: 'token-1',
      direction: 'buy',
      mirror: {
        sourceTradeId: 'polygon-source-trade',
        masterFillPriceUsd: 0.61
      }
    }));
  });

  it('passes a null master price through as null rather than omitting the mirror', async () => {
    // Dropping `mirror` on an absent master price would silently downgrade a copy
    // to the book-derived bound — the exact failure S4-M16 forbids. The planner
    // fails closed on `null`, so `null` has to arrive.
    vi.mocked(db.claimSourceSignalForCopyExecution).mockResolvedValue({
      execution: polygonCanonicalExecution('buy'),
      created: true,
      claimed: true
    });
    vi.mocked(db.getCanonicalSourceTradeById).mockResolvedValue(polygonSourceTrade(null));

    await handleJob({
      data: {
        signalId: 'polygon-source-signal',
        sourceTradeId: 'polygon-source-trade',
        tokenMint: 'polygon:token-1',
        score: 90,
        manual: true,
        direction: 'buy'
      }
    });

    const call = vi.mocked(polymarket.triggerPolymarket).mock.calls[0]?.[0];
    expect(call?.mirror).toEqual({
      sourceTradeId: 'polygon-source-trade',
      masterFillPriceUsd: null
    });
    // `toEqual` treats an absent key and an explicit `undefined` alike, so assert
    // the key exists independently — that is the whole distinction under test.
    expect(call && 'mirror' in call).toBe(true);
    expect(call?.mirror?.masterFillPriceUsd).toBeNull();
  });

  it('passes a missing source row through as a null master price, not as no mirror', async () => {
    vi.mocked(db.claimSourceSignalForCopyExecution).mockResolvedValue({
      execution: polygonCanonicalExecution('buy'),
      created: true,
      claimed: true
    });
    vi.mocked(db.getCanonicalSourceTradeById).mockResolvedValue(null);

    await handleJob({
      data: {
        signalId: 'polygon-source-signal',
        sourceTradeId: 'polygon-source-trade',
        tokenMint: 'polygon:token-1',
        score: 90,
        manual: true,
        direction: 'buy'
      }
    });

    expect(vi.mocked(polymarket.triggerPolymarket).mock.calls[0]?.[0].mirror).toEqual({
      sourceTradeId: 'polygon-source-trade',
      masterFillPriceUsd: null
    });
  });

  it('mirrors a SELL copy too, where sizing reads the bid as well as the balance', async () => {
    // A Polygon SELL is the only direction that reaches `getPolymarketAskPrice`:
    // `liveTokenSell` excludes polygon, so balance-aware sizing runs for the sell
    // and converts share balance to USD through the bid. Without that second read
    // mocked, sizing throws before the venue exactly as the buy path does without
    // the balance read.
    vi.mocked(db.claimSourceSignalForCopyExecution).mockResolvedValue({
      execution: polygonCanonicalExecution('sell'),
      created: true,
      claimed: true
    });
    vi.mocked(db.getCanonicalSourceTradeById).mockResolvedValue(polygonSourceTrade('0.44'));

    await handleJob({
      data: {
        signalId: 'polygon-source-signal',
        sourceTradeId: 'polygon-source-trade',
        tokenMint: 'polygon:token-1',
        score: 90,
        manual: true,
        direction: 'sell'
      }
    });

    expect(polymarket.getPolymarketAskPrice).toHaveBeenCalled();
    expect(polymarket.triggerPolymarket).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'sell',
      // The proportional quantity from the canonical row, not a bankroll figure.
      sellShares: 25,
      mirror: {
        sourceTradeId: 'polygon-source-trade',
        masterFillPriceUsd: 0.44
      }
    }));
  });

  it('gives a manual order with no source trade no mirror at all', async () => {
    vi.mocked(db.claimSignalForExecution).mockResolvedValue(true);

    await expect(handleJob({
      data: {
        signalId: 'manual-polygon-signal',
        tokenMint: 'polygon:token-1',
        score: 90,
        manual: true,
        direction: 'buy'
      }
    })).resolves.toMatchObject({ status: 'live-executed' });

    // No master exists, so there is nothing to mirror and the book-derived bound
    // is the correct one. Reading the source table here would be a bug.
    expect(db.getCanonicalSourceTradeById).not.toHaveBeenCalled();
    const call = vi.mocked(polymarket.triggerPolymarket).mock.calls[0]?.[0];
    expect(call?.mirror).toBeUndefined();
    expect(call).toMatchObject({ signalId: 'manual-polygon-signal', tokenID: 'token-1' });
    expect(db.insertTradeAndMarkSignalExecuted).toHaveBeenCalledWith(expect.objectContaining({
      executor: 'polymarket-clob',
      status: 'filled'
    }));
  });
});
