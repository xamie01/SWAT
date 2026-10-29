import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `S4-P7`'s own acceptance test: **substitute a stub authority and assert the
 * executor is unchanged.**
 *
 * Two halves, and both matter.
 *
 * 1. *Unchanged* — the venue call `handleJob` makes is byte-identical whichever
 *    authority granted it. That is what "the runtime never learns where
 *    authority comes from" means operationally.
 * 2. *Load-bearing* — the grant's settlement and signing addresses are the ones
 *    the executor actually uses, so a stub with different addresses moves them.
 *    Without this half, half one would pass against a port that was never
 *    consulted.
 *
 * Plus the failure that matters most: a job for a user must be **denied with the
 * chain's own code** and must not reach the venue. A user's trade filled with
 * the operator's key is the worst outcome of this refactor and is invisible
 * afterwards, because it fills.
 */

vi.hoisted(() => {
  process.env.TROJAN_WEBHOOK_URL = 'http://mock-trojan.local';
  process.env.TROJAN_WALLET_ADDRESS = 'OperatorTrojanWallet11111111111111111111111';
  process.env.AUTO_EXECUTE = 'false';
  process.env.PAPER_BANKROLL_USD = '10000';
});

const runtimeMocks = vi.hoisted(() => ({
  triggerTrojan: vi.fn(),
  dispatchSolanaTrade: vi.fn(),
  getConfiguredJupiterJitoRuntime: vi.fn(),
  getJupiterJitoSigner: vi.fn()
}));

vi.mock('@swat/db', () => ({
  // `persistTrade` calls the `S4-M35` valuation helpers on every fill. Stubbed
  // rather than imported: `vi.importActual` on a `packages/db/src/*` path puts a
  // file outside this package's `rootDir` into the program and adds a TS6059 to
  // `tsc --noEmit`. Safe to stub here because this suite asserts on venue calls
  // and target accounts, never on a USD figure — the valuation math has its own
  // suite in `packages/db`, and a `null` usdAmount is a value it really returns
  // (an unavailable native price), which `persistTrade` already handles.
  deriveFillPriceUsd: vi.fn().mockReturnValue(null),
  nativeQuoteCurrencyForChain: vi.fn((chain: string) =>
    chain === 'solana' ? 'SOL' : chain === 'robinhood-chain' ? 'ETH' : 'USD'),
  valuateChainNativeQuoteLeg: vi.fn().mockReturnValue({
    code: 'native-price-unknown',
    currency: 'SOL',
    nativeAmount: '0',
    nativeUsdPrice: null,
    usdAmount: null,
    reason: 'stubbed in execution-authority-wiring.test.ts'
  }),
  valuateQuoteLeg: vi.fn().mockReturnValue({
    code: 'no-quote-leg',
    currency: null,
    nativeAmount: null,
    nativeUsdPrice: null,
    usdAmount: null,
    reason: 'stubbed in execution-authority-wiring.test.ts'
  }),
  claimCircuitBreakerProbe: vi.fn(),
  claimSignalForExecution: vi.fn().mockResolvedValue(true),
  claimSourceSignalForCopyExecution: vi.fn(),
  getCanonicalSourceTradeById: vi.fn(),
  getRollingExposureUsd: vi.fn().mockResolvedValue(0),
  getTokenDecimals: vi.fn().mockResolvedValue(6),
  hasRecentBuy: vi.fn().mockResolvedValue(false),
  insertTrade: vi.fn().mockResolvedValue({ id: 'trade-1' }),
  insertTradeAndMarkSignalExecuted: vi.fn().mockResolvedValue({ id: 'trade-1' }),
  insertTradeAndReleaseSignalClaim: vi.fn().mockResolvedValue({ id: 'trade-1' }),
  loadCopyEligibilityFacts: vi.fn().mockImplementation(async ({ signalId }: { signalId: string }) => ({
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
  })),
  query: vi.fn().mockResolvedValue([]),
  readCircuitBreakerState: vi.fn(),
  recordCopyEligibilityRejection: vi.fn().mockResolvedValue(true),
  // S4-M6: persistCanonicalFill accrues the capacity numerator after a
  // confirmed fill. A missing export here THROWS rather than reading as
  // undefined, and the throw replaces the error under test.
  accrueMasterCapacityFillNotional: vi.fn().mockResolvedValue({
    applied: true, code: 'accrue', deltaUsd: '0'
  }),
  // Returns a result rather than undefined: `persistCanonicalFill` reads
  // `fillValuation.currency` and the confirmed total off it (S4-M6). A bare
  // `vi.fn()` resolves to undefined and the read throws several layers from the
  // grant assertion this file is actually about.
  recordCopyExecutionEvidence: vi.fn().mockResolvedValue({
    execution: { confirmedQuoteQuantity: null },
    position: {},
    fillValuation: {
      code: 'no-quote-leg',
      currency: null,
      nativeAmount: null,
      nativeUsdPrice: null,
      usdAmount: null,
      reason: 'stubbed in execution-authority-wiring.test.ts'
    },
    confirmedQuoteTotal: { code: 'no-confirmed-fills', usdAmount: null, unassessedFillCount: 0 }
  }),
  recordCircuitBreakerFailure: vi.fn(),
  recordCircuitBreakerSuccess: vi.fn(),
  releaseSignalClaim: vi.fn(),
  resolveChainMode: vi.fn(),
  resolveRiskPolicy: vi.fn().mockResolvedValue({
    maxPositionPct: 5,
    maxDailyExposurePct: 25,
    stopLossPct: 20,
    maxConsecutiveFailures: 3,
    minLiquidityUsd: 50_000
  }),
  transitionCopyExecution: vi.fn(),
  withEvmNonceLock: vi.fn(),
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }))
}));

vi.mock('@swat/shared', async () => {
  const actual = await vi.importActual<typeof import('@swat/shared')>('@swat/shared');
  return {
    DEFAULT_RISK_CONFIG: { maxConsecutiveFailures: 3, minLiquidityUsd: 50_000 },
    chainFromTokenMint: actual.chainFromTokenMint,
    evaluateCopyPolicy: actual.evaluateCopyPolicy,
    resolveSlippageBps: actual.resolveSlippageBps,
    fetchTokenPriceUsd: vi.fn().mockResolvedValue(0.5),
    getJupiterSimulatedFill: vi.fn().mockResolvedValue(null),
    initLogger: vi.fn(),
    isChain: vi.fn().mockReturnValue(true),
    REDIS_CHANNELS: { alertQueue: 'alerts' }
  };
});

vi.mock('bullmq', () => ({
  DelayedError: class DelayedError extends Error {},
  UnrecoverableError: class UnrecoverableError extends Error {},
  Worker: class Worker { on = vi.fn(); }
}));

vi.mock('ioredis', () => ({
  Redis: class Redis {
    get = vi.fn().mockResolvedValue(null);
    publish = vi.fn().mockResolvedValue(1);
    set = vi.fn().mockResolvedValue('OK');
    setex = vi.fn().mockResolvedValue('OK');
  }
}));

vi.mock('./balances.js', () => ({
  fetchSolanaBalanceSol: vi.fn().mockResolvedValue(5)
}));

vi.mock('./robinhood.js', () => ({
  configureRobinhoodRuntime: vi.fn(),
  createViemRobinhoodAdapter: vi.fn(),
  evmAccount: null,
  getRobinhoodLiveReadiness: vi.fn().mockReturnValue({ ready: true, reason: 'verified' }),
  getRobinhoodSpendableEth: vi.fn(),
  getRobinhoodQuote: vi.fn(),
  parseRobinhoodExecutionConfig: vi.fn(),
  reconcileRobinhoodPending: vi.fn(),
  robinhoodPublicClient: {},
  triggerRobinhood: vi.fn(),
  // `index.ts` does `error instanceof NonceContentionError`. Omitting it from a
  // mock of this module makes the right-hand side `undefined`, and the resulting
  // TypeError replaces whatever error the case under test threw.
  NonceContentionError: class NonceContentionError extends Error {},
  WETH_ROBINHOOD: '0x0000000000000000000000000000000000000001'
}));

vi.mock('./polymarket.js', () => ({
  getPolymarketAskPrice: vi.fn(),
  getPolymarketAvailableBalance: vi.fn(),
  getPolymarketLiveReadiness: vi.fn().mockReturnValue({ ready: true, reason: 'verified' }),
  pollPolymarketOrders: vi.fn(),
  triggerPolymarket: vi.fn(),
  polymarketSigner: null,
  resolvePolymarketIdentity: vi.fn()
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
  triggerTrojan: runtimeMocks.triggerTrojan
}));

vi.mock('./jupiter-jito-config.js', () => ({
  createJupiterJitoRuntimeFromEnvironment: vi.fn(),
  getConfiguredJupiterJitoRuntime: runtimeMocks.getConfiguredJupiterJitoRuntime,
  getJupiterJitoLiveReadiness: vi.fn().mockReturnValue({ ready: true, reason: '' }),
  getJupiterJitoSigner: runtimeMocks.getJupiterJitoSigner
}));

vi.mock('./solana-dispatch.js', () => ({
  dispatchSolanaTrade: runtimeMocks.dispatchSolanaTrade
}));

import * as db from '@swat/db';
import { handleJob, type ExecutorJobPorts } from './index.js';
import {
  denied,
  type ExecutionAuthorityDenialCode,
  type ExecutionAuthorityRequest,
  type ExecutionAuthorityResolver,
  type GrantedExecutionAuthority
} from './execution-authority.js';

const TROJAN_FILL = {
  status: 'already_resolved' as const,
  clientOrderId: 'sig-1',
  resolution: {
    status: 'filled' as const,
    transactionIdentity: 'tx-abc',
    fillKind: 'entry' as const,
    nativeLamportsDelta: '-190000000',
    tokenBaseUnitsDelta: '1000000',
    confirmedAt: new Date('2026-08-25T00:00:00.000Z')
  }
};

/** A stub authority: no key, no chain library, no environment. */
function stubAuthority(overrides: Partial<GrantedExecutionAuthority> = {}): {
  ports: ExecutorJobPorts;
  requests: ExecutionAuthorityRequest[];
} {
  const requests: ExecutionAuthorityRequest[] = [];
  const authorize: ExecutionAuthorityResolver = async (request) => {
    requests.push(request);
    return {
      kind: 'granted',
      authority: {
        adapterId: 'stub',
        chain: request.chain,
        principal: request.principal,
        settlementAddress: 'StubSettlement1111111111111111111111111111',
        signingAddress: null,
        capabilities: ['venue-managed-submission'],
        expiresAt: null,
        sign: async () => ({
          kind: 'refused',
          code: 'authority-capability-unsupported',
          reason: 'stub'
        }),
        ...overrides
      }
    };
  };
  return { ports: { authorize }, requests };
}

function denyingAuthority(code: ExecutionAuthorityDenialCode, reason: string): {
  ports: ExecutorJobPorts;
  requests: ExecutionAuthorityRequest[];
} {
  const requests: ExecutionAuthorityRequest[] = [];
  return {
    ports: {
      authorize: async (request) => {
        requests.push(request);
        return denied(code, reason);
      }
    },
    requests
  };
}

const liveSolanaJob = {
  signalId: 'sig-1',
  tokenMint: 'solana:So11111111111111111111111111111111111111112',
  score: 95,
  manual: true as const
};

function copyExecution(targetAccount: string) {
  return {
    id: 'exec-1',
    signalId: 'sig-1',
    sourceTradeId: 'source-1',
    chain: 'solana' as const,
    userId: null,
    targetAccount,
    tokenMint: 'solana:So11111111111111111111111111111111111111112',
    direction: 'buy' as const,
    executionMode: 'live' as const,
    clientOrderId: 'copy-1',
    state: 'planned' as const,
    requestedQuoteQuantity: '0.5',
    requestedBaseQuantity: null,
    sourceSellFraction: null
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SOLANA_EXECUTOR;
  vi.mocked(db.resolveChainMode).mockResolvedValue({
    requestedMode: 'live',
    effectiveMode: 'live',
    certified: true
  } as never);
  vi.mocked(db.claimSignalForExecution).mockResolvedValue(true);
  vi.mocked(db.getRollingExposureUsd).mockResolvedValue(0);
  vi.mocked(db.hasRecentBuy).mockResolvedValue(false);
  runtimeMocks.triggerTrojan.mockResolvedValue(TROJAN_FILL);
  runtimeMocks.getConfiguredJupiterJitoRuntime.mockReturnValue(null);
  runtimeMocks.getJupiterJitoSigner.mockReturnValue(null);
});

describe('a stub authority substitutes for the real one (S4-P7 acceptance)', () => {
  it('leaves the venue call identical whichever authority granted it', async () => {
    // Half one: *unchanged*. Two different authorities, two different settlement
    // addresses, and the executor makes the same call to the same venue with the
    // same arguments. That is what it means for the runtime not to learn where
    // authority comes from.
    const first = stubAuthority({ settlementAddress: 'AddressOne111111111111111111111111111111111' });
    const resultOne = await handleJob({ data: liveSolanaJob }, first.ports);
    const callOne = runtimeMocks.triggerTrojan.mock.calls[0]?.[0];

    runtimeMocks.triggerTrojan.mockClear();

    const second = stubAuthority({ settlementAddress: 'AddressTwo222222222222222222222222222222222' });
    const resultTwo = await handleJob({ data: liveSolanaJob }, second.ports);
    const callTwo = runtimeMocks.triggerTrojan.mock.calls[0]?.[0];

    expect(callOne).toBeDefined();
    expect(callTwo).toEqual(callOne);
    expect(resultOne).toEqual(resultTwo);
    expect(resultOne).toMatchObject({ status: 'live-executed', signature: 'tx-abc' });
  });

  it('asks the port before it moves any funds, naming the venue action', async () => {
    const { ports, requests } = stubAuthority();

    await handleJob({ data: liveSolanaJob }, ports);

    expect(requests).toEqual([{
      chain: 'solana',
      principal: { kind: 'operator' },
      action: 'venue-trade',
      direction: 'buy',
      instrument: 'So11111111111111111111111111111111111111112'
    }]);
  });

  it('does not consult the port in paper mode, which has nothing to authorize', async () => {
    vi.mocked(db.resolveChainMode).mockResolvedValue({
      requestedMode: 'paper',
      effectiveMode: 'paper',
      certified: true
    } as never);
    const { ports, requests } = stubAuthority();

    const result = await handleJob({ data: liveSolanaJob }, ports);

    expect(result.status).toBe('paper-filled');
    expect(requests).toEqual([]);
    expect(runtimeMocks.triggerTrojan).not.toHaveBeenCalled();
  });
});

describe('the grant is load-bearing, not decorative', () => {
  it('settles a canonical copy on the address the grant named', async () => {
    // Half two. If `handleJob` derived the target account from a key or an env
    // var instead of from the grant, the stub's address would never appear.
    vi.mocked(db.claimSourceSignalForCopyExecution).mockResolvedValue({
      execution: copyExecution('StubSettlement1111111111111111111111111111')
    } as never);
    const { ports } = stubAuthority({
      settlementAddress: 'StubSettlement1111111111111111111111111111'
    });

    await handleJob({ data: { ...liveSolanaJob, sourceTradeId: 'source-1' } }, ports);

    expect(db.claimSourceSignalForCopyExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAccount: 'StubSettlement1111111111111111111111111111',
        executionMode: 'live'
      })
    );

    // S4-M6 wiring: a CONFIRMED fill must accrue the priced capacity numerator.
    // Asserted here rather than in a capacity-specific file because this is the
    // only suite that drives `handleJob` all the way through a real fill, and the
    // wiring is otherwise invisible: the ledger row stays `unpriced`, the cap
    // measures its own projection against zero committed flow, and every test
    // stays green. That is the correct-but-inert shape this repo has been burned
    // by five times.
    expect(db.accrueMasterCapacityFillNotional).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTradeId: expect.anything() })
    );
  });

  it('takes the Jupiter+Jito signing identity from the grant, not from the signer module', async () => {
    // The one place `handleJob` used to name a chain-specific authority type:
    // `getJupiterJitoSigner().publicKey`. The module is mocked to return a
    // signer with a *different* key, so if the executor still read it, the
    // assertion below would see that one instead of the grant's.
    process.env.SOLANA_EXECUTOR = 'jupiter-jito';
    runtimeMocks.getConfiguredJupiterJitoRuntime.mockReturnValue({});
    runtimeMocks.getJupiterJitoSigner.mockReturnValue({ publicKey: 'WrongSignerFromTheModule' });
    runtimeMocks.dispatchSolanaTrade.mockResolvedValue({
      kind: 'submitted',
      bundleId: 'bundle-1',
      venueStatus: 'accepted'
    });
    const { ports } = stubAuthority({ signingAddress: 'GrantedSigner999999999999999999999999999999' });

    await handleJob({ data: liveSolanaJob }, ports);

    expect(runtimeMocks.dispatchSolanaTrade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signerPublicKey: 'GrantedSigner999999999999999999999999999999' })
    );
  });

  it('routes to the venue-managed path when the grant carries no signing address', async () => {
    // A grant with no signing address is the certified Trojan route: authority
    // exists, we just do not hold the key. It must stay a grant, and it must not
    // be promoted onto the uncertified Jito path by a configured runtime alone.
    process.env.SOLANA_EXECUTOR = 'jupiter-jito';
    runtimeMocks.getConfiguredJupiterJitoRuntime.mockReturnValue({});
    const { ports } = stubAuthority({ signingAddress: null });

    await handleJob({ data: liveSolanaJob }, ports);

    expect(runtimeMocks.dispatchSolanaTrade).not.toHaveBeenCalled();
    expect(runtimeMocks.triggerTrojan).toHaveBeenCalledTimes(1);
  });
});

describe('a denial never falls through to another authority', () => {
  it('skips with the code and does not touch the venue', async () => {
    const { ports } = denyingAuthority(
      'authority-operator-not-configured',
      'TROJAN_WALLET_ADDRESS is required for operator execution on solana'
    );

    const result = await handleJob({ data: liveSolanaJob }, ports);

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('authority-operator-not-configured');
    expect(runtimeMocks.triggerTrojan).not.toHaveBeenCalled();
    expect(runtimeMocks.dispatchSolanaTrade).not.toHaveBeenCalled();
    // Denied above the claim, so no signal is left claimed by a job that never ran.
    expect(db.claimSignalForExecution).not.toHaveBeenCalled();
  });

  it('refuses a per-user job with the chain mechanism code, using the real adapters', async () => {
    // No stub here: the default ports, the real six adapters. A job carrying a
    // `userId` must reach the per-user Solana adapter and be refused, because
    // the delegate program of ADR-0003 section 3 does not exist. The failure this
    // guards is the opposite — the operator adapter quietly satisfying it, which
    // would spend the operator's SOL on someone else's signal and *fill*.
    const result = await handleJob({ data: { ...liveSolanaJob, userId: 'alice' } });

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('authority-solana-delegate-unavailable');
    expect(result.reason).toContain('user:alice');
    expect(runtimeMocks.triggerTrojan).not.toHaveBeenCalled();
    expect(runtimeMocks.dispatchSolanaTrade).not.toHaveBeenCalled();
    expect(db.insertTrade).not.toHaveBeenCalled();
    expect(db.insertTradeAndMarkSignalExecuted).not.toHaveBeenCalled();
  });

  it('still grants the operator through the real adapters', async () => {
    // The control for the case above: same default ports, no `userId`, and the
    // operator's certified path runs exactly as before. Without this, "denies
    // everything" would pass the test above.
    const result = await handleJob({ data: liveSolanaJob });

    expect(result).toMatchObject({ status: 'live-executed', signature: 'tx-abc' });
    expect(runtimeMocks.triggerTrojan).toHaveBeenCalledTimes(1);
  });
});
