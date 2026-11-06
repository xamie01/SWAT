import { Redis } from 'ioredis';
import type { Chain, JupiterSimulatedFill } from '@swat/shared';
import { type EvmNonceLock, type RobinhoodExecutionAdapter, type RobinhoodExecutionConfig, type RobinhoodPendingStore, type RobinhoodReconciliationOutcome } from './robinhood.js';
import { createRobinhoodSafetyAssessment } from './robinhood-runtime.js';
import { type TrojanRuntime, type TrojanTerminalResolution } from './trojan-runtime.js';
import type { TrojanReconciliationResult } from './trojan.js';
import { type VenueReconciler } from './reconciliation-coordinator.js';
import { type ExecutionAuthorityResolver } from './execution-authority.js';
export declare function persistTrade(opts: {
    signalId: string;
    sourceTradeId?: string | null;
    copyExecutionId?: string | null;
    tokenMint: string;
    size: number;
    chain: Chain;
    executionMode: 'paper' | 'live' | 'shadow';
    direction?: 'buy' | 'sell';
    executor: string;
    signature?: string | null;
    jupiterFill?: JupiterSimulatedFill | null;
    slippageBps?: number | null;
    status?: string;
    errorMessage?: string | null;
    amountUsd?: number | null;
    requestedAmountUsd?: number | null;
    tokenAmount?: number | null;
    priceUsd?: number | null;
    feeUsd?: number | null;
    venueOrderId?: string | null;
    venueStatus?: string | null;
    venueTradeIds?: string[];
    settlementTransactionHashes?: string[];
    shadowOf?: string | null;
    submittedAt?: Date | null;
    confirmedAt?: Date | null;
}): Promise<string>;
export declare function clampExecutionModeForStartup(chain: Chain, effectiveMode: 'off' | 'paper' | 'live' | 'live+shadow', reason?: string): {
    effectiveMode: 'off' | 'paper' | 'live' | 'live+shadow';
    reason?: string;
};
type ClusterTier = 'elite' | 'pro' | 'promising' | 'speculative';
export declare function getBalanceAwarePositionSize(score: number, chain: Chain, clusterTier: ClusterTier, sizingMode: 'paper' | 'live', direction: 'buy' | 'sell', tokenMint: string, 
/**
 * Whose money is being sized (`S4-15`/`S4-16`). `null` is the pre-tenancy
 * operator path, which ADR-0001 leaves at `user_id NULL` and never backfills.
 *
 * Optional so the six-argument callers keep compiling, and defaulted to `null`
 * rather than to some ambient current user: a sizing call that forgot to pass a
 * tenant must size the OPERATOR's account, which is loud and wrong, rather than
 * silently size one user off another's risk percentage.
 */
userId?: string | null): Promise<number>;
type RobinhoodRuntime = {
    adapter: RobinhoodExecutionAdapter;
    config: RobinhoodExecutionConfig;
    pendingStore: RobinhoodPendingStore;
    safetyAssessment: ReturnType<typeof createRobinhoodSafetyAssessment>;
    nonceLock: EvmNonceLock;
};
export declare function createRobinhoodRuntime(redisClient: Redis): RobinhoodRuntime;
export declare function runRobinhoodReconciliation(runtime: RobinhoodRuntime): Promise<RobinhoodReconciliationOutcome[]>;
type TrojanReconciliationOutcome = TrojanReconciliationResult | TrojanTerminalResolution;
export type ChainReconciliationTask = {
    chain: Chain;
    run: () => Promise<unknown>;
};
export declare function runChainReconciliations(tasks: ChainReconciliationTask[]): Promise<void>;
/**
 * Build the venue handlers the canonical coordinator routes to.
 *
 * A chain is only included when its live runtime exists. Omitting one is
 * deliberate and safe: the coordinator counts that execution `unsupported` and
 * reschedules it, so the row survives until a process that *can* probe the venue
 * claims it, rather than being resolved by a process with no evidence.
 */
export declare function buildVenueReconcilers(input: {
    robinhoodRuntime: Pick<RobinhoodRuntime, 'adapter'> | null;
    trojanRuntime: Pick<TrojanRuntime, 'readConfirmation'> | null;
    polymarketReady: boolean;
}): Partial<Record<Chain, VenueReconciler>>;
type ExecutorJobResult = {
    status: string;
    reason?: string;
    state?: string;
    signalId?: string;
    tokenMint?: string;
    size?: number;
    signature?: string | null;
    mode?: string;
    simulatedVia?: string;
};
type CircuitBreakerJob = {
    data: unknown;
    token?: string;
    moveToDelayed: (timestamp: number, token?: string) => Promise<unknown>;
};
export declare function executeJobWithCircuitBreaker(job: CircuitBreakerJob, execute?: (job: {
    data: unknown;
}) => Promise<ExecutorJobResult>): Promise<ExecutorJobResult>;
/**
 * Ports `handleJob` is handed. One entry today; the object is the seam.
 *
 * A parameter rather than a module import so a test can substitute a stub
 * authority and assert the executor is unchanged — which is `S4-P7`'s own
 * acceptance test, and the thing that proves the runtime never learns where
 * authority comes from.
 */
export type ExecutorJobPorts = {
    readonly authorize: ExecutionAuthorityResolver;
};
/**
 * Binds the six authority adapters to this process's configuration.
 *
 * Every accessor reads at authorize time, never at construction: `evmAccount`
 * and `polymarketSigner` are module-level in their own files, and
 * `getJupiterJitoSigner()` is only populated part-way through `main()`, so a
 * snapshot taken here would permanently report "nothing configured".
 *
 * This function is the only place in the executor that names a chain-specific
 * authority type. That is the point of it: `handleJob` names none.
 */
export declare function createExecutorJobPorts(): ExecutorJobPorts;
export declare function runTrojanReconciliation(runtime: Pick<TrojanRuntime, 'reconcile'>): Promise<TrojanReconciliationOutcome[]>;
export declare function handleJob(job: {
    data: unknown;
}, ports?: ExecutorJobPorts): Promise<ExecutorJobResult>;
export declare function main(): Promise<void>;
export {};
//# sourceMappingURL=index.d.ts.map