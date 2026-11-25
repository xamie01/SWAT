import { Deadline } from './containment.js';
import { assertion, requireCheck, result, type Assertion, type GateResult } from './core.js';
import { assertOwnedFinancialConservation, type OwnedFinancialJournal } from './withdrawal-owned-observer.js';
import {
  claimSourceSignalForCopyExecutionWithClient,
  type PoolClient,
  type SourceSignalCopyClaimInput,
  type SourceSignalCopyClaimResult
} from '@swat/db/dist/copy-trade-lifecycle-owned.js';
import { financialHash, type FinancialRecord } from '@swat/db/dist/withdrawal-contract.js';
import type { SubmitWithdrawal } from '@swat/db/dist/withdrawal-service.js';
import type { ReducingIntent, ReducingRequest } from '@swat/db/dist/reducing-contract.js';
import type { FinancialRunResult } from '../../../apps/trade-executor/src/reducing-orchestration.js';

export interface P6ConcurrencyObserver {
  observedBlocking(holderPid: number, competitorPid: number, deadline: Deadline): Promise<boolean>;
}

export interface P6CompetingClaimsPorts {
  readonly runId: string;
  readonly userId: string;
  /** Two independent transaction runners (direct connections) for pipeline claim race */
  readonly runClaim: (
    runner: 'first' | 'second',
    fn: (
      client: PoolClient,
      barrier: { hold: () => Promise<void>; release: () => void }
    ) => Promise<SourceSignalCopyClaimResult>
  ) => Promise<SourceSignalCopyClaimResult>;
  readonly claimInput: SourceSignalCopyClaimInput;
  /** Two concurrent withdrawal OTP submitters racing on same authorizationId */
  readonly submitWithdrawalRace: (
    userId: string,
    submit: SubmitWithdrawal
  ) => Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]>;
  readonly withdrawalSubmit: SubmitWithdrawal;
  /** Two concurrent reducing requests racing on same requestKey */
  readonly requestReducingRace: (
    userId: string,
    request: ReducingRequest
  ) => Promise<[PromiseSettledResult<FinancialRecord<ReducingIntent>>, PromiseSettledResult<FinancialRecord<ReducingIntent>>]>;
  readonly reducingRequest: ReducingRequest;
  /** Two concurrent runner.run invocations racing on same queued intent */
  readonly runFinancialRace: (
    userId: string,
    intentId: string
  ) => Promise<[PromiseSettledResult<FinancialRunResult<ReducingIntent>>, PromiseSettledResult<FinancialRunResult<ReducingIntent>>]>;
  readonly observeCounts: () => Promise<{
    readonly executions: number;
    readonly deliveries: number;
    readonly otpConsumedCount: number;
    readonly intents: number;
    readonly attempts: number;
    /** Single-intent exposure reservation count (or distinct reserved intents) */
    readonly reservations: number;
  }>;
}

export interface P6TenantInterferencePorts {
  readonly tenantA: string;
  readonly tenantB: string;
  /** Run interleaved/pooled transactions as Tenant A and Tenant B, asserting GUC reset & cross-tenant isolation */
  readonly probeGucAndIsolation: (deadline: Deadline) => Promise<{
    readonly tenantAOnlyVisibleToA: boolean;
    readonly tenantBBlockedFromAExecution: boolean;
    readonly tenantBBlockedFromACustody: boolean;
    readonly tenantBBlockedFromALot: boolean;
    readonly pooledGucResetAfterCommitAndRollback: boolean;
  }>;
  /** Same-account/fee-funding drain race: Intent 1 + Intent 2 exceed available balance */
  readonly raceBudgetDrain: () => Promise<{
    readonly firstCommitted: boolean;
    readonly secondRejectedInsufficient: boolean;
    readonly reservedRaw: string;
    readonly availableRaw: string;
  }>;
  /** Cross-account feeFundingAccountId / lotId attack */
  readonly attackForeignFeeAndLot: () => Promise<{
    readonly foreignFeeAccountRejected: boolean;
    readonly foreignLotRejected: boolean;
  }>;
}

export interface P6ExpiryCancelFeeOnlyPorts {
  /** Post-lock clock expiry inside claimSourceSignalForCopyExecutionWithClient & financial authorization */
  readonly runPostLockExpiry: () => Promise<{
    readonly pipelineExpiredAfterLockRejected: boolean;
    readonly pipelineInsertedCount: number;
    readonly financialExpiredAuthRejected: boolean;
    readonly financialDispatchedCount: number;
  }>;
  /** Concurrent cancelExpired vs runner.run single-winner conservation */
  readonly raceCancelVsSettlement: (winner: 'cancel' | 'settlement') => Promise<{
    readonly winnerOutcome: 'cancelled' | 'settled';
    readonly loserBlockedOrNoop: boolean;
    readonly conserved: boolean;
    readonly journal: OwnedFinancialJournal<ReducingIntent>;
  }>;
  /** Perps fee-only delta, valuation fee-only correction, and zero-base spot refusal */
  readonly runFeeOnlyAndZeroBaseCases: () => Promise<{
    readonly perpsFeeOnlyConserved: boolean;
    readonly perpsAfterRawZero: boolean;
    readonly valuationFeeOnlyComplete: boolean;
    readonly valuationOriginalFeeStillNull: boolean;
    readonly spotZeroBaseRefusedBeforeSql: boolean;
    readonly spotZeroDeltaRefusedBeforeSql: boolean;
  }>;
}

export interface P6ConcurrencyPorts {
  readonly competingClaims: P6CompetingClaimsPorts;
  readonly tenantInterference: P6TenantInterferencePorts;
  readonly expiryCancelFeeOnly: P6ExpiryCancelFeeOnlyPorts;
}

function isCancelledJournalConserved(journal: OwnedFinancialJournal<ReducingIntent>): boolean {
  const { record, attempts, applications, reservations, outbox } = journal;
  return record.status === 'cancelled'
    && record.terminal === true
    && record.completedRaw === '0'
    && record.userId === record.intent.userId
    && record.intentHash === financialHash(record.intent)
    && outbox.length === 1
    && outbox[0]?.intentHash === record.intentHash
    && attempts.length === 0
    && applications.length === 0
    && reservations.every(row => row.reservedRaw === '0');
}

export async function scheduleCompetingClaims(
  ports: P6CompetingClaimsPorts,
  deadline: Deadline
): Promise<Assertion[]> {
  deadline.check();
  const [firstClaim, secondClaim] = await Promise.all([
    ports.runClaim('first', async (client, barrier) => {
      const claim = await claimSourceSignalForCopyExecutionWithClient(client, ports.claimInput);
      await barrier.hold();
      return claim;
    }),
    ports.runClaim('second', async (client, barrier) => {
      try {
        return await claimSourceSignalForCopyExecutionWithClient(client, ports.claimInput);
      } finally {
        barrier.release();
      }
    })
  ]);
  deadline.check();

  const withdrawalRace = await ports.submitWithdrawalRace(ports.userId, ports.withdrawalSubmit);
  const withdrawalFulfilled = withdrawalRace.filter(r => r.status === 'fulfilled');
  const withdrawalRejected = withdrawalRace.filter(r => r.status === 'rejected');
  deadline.check();

  const reducingRace = await ports.requestReducingRace(ports.userId, ports.reducingRequest);
  const reducingFulfilled = reducingRace.filter(
    (r): r is PromiseFulfilledResult<FinancialRecord<ReducingIntent>> => r.status === 'fulfilled'
  );
  requireCheck(reducingFulfilled.length === 2, 'Competing reducing requests did not converge on one intent');
  const intentId = reducingFulfilled[0]!.value.id;
  deadline.check();

  const runRace = await ports.runFinancialRace(ports.userId, intentId);
  const runFulfilled = runRace.filter(r => r.status === 'fulfilled');
  deadline.check();

  const counts = await ports.observeCounts();

  return [
    assertion(
      'competing canonical pipeline claim inserts once and replays idempotently',
      firstClaim.created === true
        && firstClaim.claimed === true
        && firstClaim.execution !== null
        && secondClaim.created === false
        && secondClaim.claimed === false
        && secondClaim.execution?.id === firstClaim.execution.id
        && counts.executions === 1
        && counts.deliveries === 1
    ),
    assertion(
      'competing withdrawal OTP submit allows exactly one winner and one consumption',
      withdrawalFulfilled.length === 1
        && withdrawalRejected.length === 1
        && counts.otpConsumedCount === 1
    ),
    assertion(
      'competing reducing requests and runner invocations create single intent, attempt, and reservation',
      reducingFulfilled[0]!.value.id === reducingFulfilled[1]!.value.id
        && reducingFulfilled[0]!.value.intentHash === reducingFulfilled[1]!.value.intentHash
        && runFulfilled.length === 2
        && counts.intents === 1
        && counts.attempts === 1
        && counts.reservations === 1
    )
  ];
}

export async function scheduleTenantInterference(
  ports: P6TenantInterferencePorts,
  deadline: Deadline
): Promise<Assertion[]> {
  deadline.check();
  requireCheck(ports.tenantA !== ports.tenantB, 'Distinct tenants required for interference schedule');

  const isolation = await ports.probeGucAndIsolation(deadline);
  deadline.check();

  const drain = await ports.raceBudgetDrain();
  deadline.check();

  const foreign = await ports.attackForeignFeeAndLot();
  deadline.check();

  return [
    assertion(
      'cross-tenant isolation blocks tenant B from tenant A executions, custody grants, and lots',
      isolation.tenantAOnlyVisibleToA
        && isolation.tenantBBlockedFromAExecution
        && isolation.tenantBBlockedFromACustody
        && isolation.tenantBBlockedFromALot
    ),
    assertion(
      'pooled connection resets local app.current_user_id GUC after COMMIT and ROLLBACK',
      isolation.pooledGucResetAfterCommitAndRollback
    ),
    assertion(
      'concurrent same-account budget drain serializes and prevents over-reservation',
      drain.firstCommitted
        && drain.secondRejectedInsufficient
        && BigInt(drain.reservedRaw) <= BigInt(drain.availableRaw)
    ),
    assertion(
      'cross-account feeFundingAccountId and foreign lotId attacks fail closed',
      foreign.foreignFeeAccountRejected && foreign.foreignLotRejected
    )
  ];
}

export async function scheduleExpiryCancelFeeOnly(
  ports: P6ExpiryCancelFeeOnlyPorts,
  deadline: Deadline
): Promise<Assertion[]> {
  deadline.check();
  const expiry = await ports.runPostLockExpiry();
  deadline.check();

  const cancelWins = await ports.raceCancelVsSettlement('cancel');
  const cancelConserved = isCancelledJournalConserved(cancelWins.journal);
  deadline.check();

  const settlementWins = await ports.raceCancelVsSettlement('settlement');
  assertOwnedFinancialConservation(settlementWins.journal);
  deadline.check();

  const feeAndSpot = await ports.runFeeOnlyAndZeroBaseCases();
  deadline.check();

  return [
    assertion(
      'post-lock clock expiry rejects stale pipeline claim and financial authorization before side effects',
      expiry.pipelineExpiredAfterLockRejected
        && expiry.pipelineInsertedCount === 0
        && expiry.financialExpiredAuthRejected
        && expiry.financialDispatchedCount === 0
    ),
    assertion(
      'cancel-wins race releases all reservations with zero attempts or applications',
      cancelWins.winnerOutcome === 'cancelled'
        && cancelWins.loserBlockedOrNoop
        && cancelWins.conserved
        && cancelConserved
    ),
    assertion(
      'settlement-wins race blocks late cancellation and satisfies owned financial conservation',
      settlementWins.winnerOutcome === 'settled'
        && settlementWins.loserBlockedOrNoop
        && settlementWins.conserved
    ),
    assertion(
      'fee-only perps delta and valuation correction conserve totals while zero-base spot refuses before SQL',
      feeAndSpot.perpsFeeOnlyConserved
        && feeAndSpot.perpsAfterRawZero
        && feeAndSpot.valuationFeeOnlyComplete
        && feeAndSpot.valuationOriginalFeeStillNull
        && feeAndSpot.spotZeroBaseRefusedBeforeSql
        && feeAndSpot.spotZeroDeltaRefusedBeforeSql
    )
  ];
}

export async function qualifyP6Concurrency(
  ports: P6ConcurrencyPorts,
  deadline: Deadline,
  evidence: Record<string, unknown> = {}
): Promise<GateResult> {
  deadline.check();
  const competing = await scheduleCompetingClaims(ports.competingClaims, deadline);
  deadline.check();
  const tenant = await scheduleTenantInterference(ports.tenantInterference, deadline);
  deadline.check();
  const expiry = await scheduleExpiryCancelFeeOnly(ports.expiryCancelFeeOnly, deadline);
  deadline.check();

  return result('I5', [...competing, ...tenant, ...expiry], [], {
    ...evidence,
    scheduleCount: 3
  });
}
