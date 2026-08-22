import { describe, it, expect, vi, beforeEach } from 'vitest';

// `riskPct` is only consulted under dynamic sizing; the static path returns
// BASE_POSITION_SOL regardless of policy, which would make these assertions pass
// for the wrong reason.
process.env.USE_DYNAMIC_BALANCE_SIZING = 'true';
process.env.PAPER_BANKROLL_USD = '10000';
process.env.DAILY_EXPOSURE_CAP_USD = '50000';
// Live sizing reads the real Solana balance and refuses without a configured
// wallet. A throwaway constant — nothing here signs or submits.
process.env.TROJAN_WALLET_ADDRESS = 'So11111111111111111111111111111111111111112';

const dbMocks = vi.hoisted(() => ({
  resolveRiskPolicy: vi.fn(),
  getSolBalance: vi.fn(),
  claimCircuitBreakerProbe: vi.fn(),
  resolveChainMode: vi.fn(),
  hasRecentBuy: vi.fn().mockResolvedValue(false),
  getRollingExposureUsd: vi.fn().mockResolvedValue(0),
  claimSignalForExecution: vi.fn().mockResolvedValue(true),
  releaseSignalClaim: vi.fn(),
  insertTrade: vi.fn(),
  insertTradeAndMarkSignalExecuted: vi.fn(),
  insertTradeAndReleaseSignalClaim: vi.fn(),
  getTokenDecimals: vi.fn().mockResolvedValue(9),
  readCircuitBreakerState: vi.fn(),
  recordCircuitBreakerFailure: vi.fn(),
  recordCircuitBreakerSuccess: vi.fn(),
  claimCopyExecutionsForReconciliation: vi.fn(),
  releaseCopyExecutionReconciliationClaim: vi.fn(),
  query: vi.fn(),
  pool: {}
}));

vi.mock('@swat/db', () => dbMocks);

// Live sizing reads a real on-chain balance. Stubbed so these tests stay hermetic
// and assert policy resolution rather than RPC behaviour, which `balances` owns.
const balanceMocks = vi.hoisted(() => ({
  fetchSolanaBalanceSol: vi.fn(),
  fetchRobinhoodNativeBalanceWei: vi.fn()
}));
vi.mock('./balances.js', () => balanceMocks);

/**
 * `S4-M27`. Without these two mocks this file reached the real network.
 *
 * `index.ts`'s `getCachedSolPrice` asks Redis and then falls through to
 * `fetchTokenPriceUsd`, which calls DexScreener. In isolation the request usually
 * completed, so the file passed 6/6 on its own; under a full-suite run it
 * contended for the network and timed out at vitest's 5 s default, logging
 * `[prices] DexScreener error ... TypeError: fetch failed`. That reads exactly like
 * a real regression, and a suite that flakes for environmental reasons trains
 * everyone to re-run rather than read the failure.
 *
 * `evaluateCopyPolicy` and `resolveSlippageBps` come from `importActual` because
 * both are pure decision math with their own suites in `packages/shared`; stubbing
 * them would only test the stub. Same reasoning, and same shape, as
 * `execution-lifecycle.test.ts`.
 */
vi.mock('@swat/shared', async () => {
  const actual = await vi.importActual<typeof import('@swat/shared')>('@swat/shared');
  return {
    ...actual,
    fetchTokenPriceUsd: vi.fn().mockResolvedValue(150),
    getJupiterSimulatedFill: vi.fn()
  };
});

// `getRedis()` constructs a real client and would try to connect. Nothing here
// asserts cache behaviour: the price above is what the assertions turn on.
vi.mock('ioredis', () => ({
  Redis: class Redis {
    get = vi.fn().mockResolvedValue(null);
    setex = vi.fn().mockResolvedValue('OK');
    set = vi.fn().mockResolvedValue('OK');
    publish = vi.fn().mockResolvedValue(1);
    on = vi.fn();
  }
}));

const { getBalanceAwarePositionSize } = await import('./index.js');

/**
 * Sizing resolves the DB risk policy (`S4-P2`).
 *
 * Written because a live-money defect was invisible to the whole suite: the DB
 * policy override sat inside `if (sizingMode === 'paper')`, so **live sizing
 * ignored it entirely** and used the env constant. Changing that behaviour left
 * all 326 existing tests green, because `getBalanceAwarePositionSize` had no
 * direct coverage — `policy.test.ts` exercises the pure math helper underneath it,
 * not the policy resolution above it.
 *
 * With one operator whose env and DB agree the bug is undetectable. Under fan-out
 * the per-user risk percentage exists *only* in the database, so live sizing would
 * size every user off one env constant — the exact opposite of "exposure
 * proportional to what the user agreed to".
 */

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.resolveRiskPolicy.mockResolvedValue({
    maxPositionPct: 2,
    maxDailyExposurePct: 25,
    stopLossPct: 20,
    maxConsecutiveFailures: 3
  });
  // 10 SOL spendable, so a percentage of it is legible in the assertions.
  balanceMocks.fetchSolanaBalanceSol.mockResolvedValue(10);
  balanceMocks.fetchRobinhoodNativeBalanceWei.mockResolvedValue(10n ** 19n);
});

describe('DB risk policy in sizing', () => {
  it('applies the DB policy in LIVE mode, not only paper', async () => {
    // The regression. Before the fix this returned the env-derived size in live
    // mode and the assertion below failed.
    dbMocks.resolveRiskPolicy.mockResolvedValue({
      maxPositionPct: 2,
      maxDailyExposurePct: 25,
      stopLossPct: 20,
      maxConsecutiveFailures: 3
    });

    await getBalanceAwarePositionSize(95, 'solana', 'elite', 'live', 'buy', 'token-mint');

    expect(dbMocks.resolveRiskPolicy).toHaveBeenCalledWith('operator', 'solana');
  });

  it('applies the DB policy in PAPER mode as before', async () => {
    await getBalanceAwarePositionSize(95, 'solana', 'elite', 'paper', 'buy', 'token-mint');
    expect(dbMocks.resolveRiskPolicy).toHaveBeenCalledWith('operator', 'solana');
  });

  it('sizes differently when the policy percentage differs', async () => {
    // Proves the resolved value is actually used rather than merely fetched.
    //
    // The balance is deliberately small here. With a large one both sizes clamp
    // to `MAX_POSITION_SOL` and the assertion passes for the wrong reason — the
    // percentage has to be the binding constraint for this to test anything.
    balanceMocks.fetchSolanaBalanceSol.mockResolvedValue(1);

    dbMocks.resolveRiskPolicy.mockResolvedValue({
      maxPositionPct: 1, maxDailyExposurePct: 25, stopLossPct: 20, maxConsecutiveFailures: 3
    });
    const small = await getBalanceAwarePositionSize(95, 'solana', 'elite', 'live', 'buy', 'm');

    dbMocks.resolveRiskPolicy.mockResolvedValue({
      maxPositionPct: 20, maxDailyExposurePct: 25, stopLossPct: 20, maxConsecutiveFailures: 3
    });
    const large = await getBalanceAwarePositionSize(95, 'solana', 'elite', 'live', 'buy', 'm');

    expect(large).toBeGreaterThan(small);
  });

  it('FAILS CLOSED when the policy cannot be resolved', async () => {
    // Previously a `console.warn` and a fall back to env defaults — which
    // substitutes a risk percentage the account never agreed to, and does it on a
    // real trade. Throwing costs one skipped signal; defaulting costs a
    // wrong-sized position.
    dbMocks.resolveRiskPolicy.mockRejectedValue(new Error('db unreachable'));

    await expect(
      getBalanceAwarePositionSize(95, 'solana', 'elite', 'live', 'buy', 'token-mint')
    ).rejects.toThrow(/db unreachable/);
  });

  it('fails closed in paper mode too, so the two modes cannot diverge', async () => {
    dbMocks.resolveRiskPolicy.mockRejectedValue(new Error('db unreachable'));

    await expect(
      getBalanceAwarePositionSize(95, 'solana', 'elite', 'paper', 'buy', 'token-mint')
    ).rejects.toThrow(/db unreachable/);
  });

  it('does not leak one call\'s policy into the next', async () => {
    // `getSizingConfig` returns a fresh object literal per call, so the override
    // is confined to its own call. This pins that property: if the config is ever
    // hoisted to a module constant or a memo cache, the `{...envConfig}` spread
    // stops being sufficient and this turns red instead of silently mispricing.
    dbMocks.resolveRiskPolicy.mockResolvedValue({
      maxPositionPct: 1, maxDailyExposurePct: 25, stopLossPct: 20, maxConsecutiveFailures: 3
    });
    const firstTight = await getBalanceAwarePositionSize(95, 'solana', 'elite', 'live', 'buy', 'm');

    dbMocks.resolveRiskPolicy.mockResolvedValue({
      maxPositionPct: 10, maxDailyExposurePct: 25, stopLossPct: 20, maxConsecutiveFailures: 3
    });
    await getBalanceAwarePositionSize(95, 'solana', 'elite', 'live', 'buy', 'm');

    dbMocks.resolveRiskPolicy.mockResolvedValue({
      maxPositionPct: 1, maxDailyExposurePct: 25, stopLossPct: 20, maxConsecutiveFailures: 3
    });
    const secondTight = await getBalanceAwarePositionSize(95, 'solana', 'elite', 'live', 'buy', 'm');

    expect(secondTight).toBe(firstTight);
  });
});
