import { Deadline } from './containment.js';
import { assertion, hash, result, type Assertion, type GateResult } from './core.js';
import { assertOwnedFinancialConservation, type OwnedFinancialJournal } from './withdrawal-owned-observer.js';
import {
  requireCompletedJournal,
  requireRedelivery,
  type QueueIdentity,
  type QueueJournal
} from './queue-contract.js';
import type { WithdrawalIntent } from '@swat/db/dist/withdrawal-contract.js';
import type { ReducingIntent } from '@swat/db/dist/reducing-contract.js';

export interface P6RedisDropPorts {
  /** Drop Redis at pre-enqueue (after DB pending commit), mid-wait, and post-settlement-commit */
  readonly simulatePreEnqueueRedisDrop: (deadline: Deadline) => Promise<{
    readonly enqueueRejected: boolean;
    readonly durablePendingPreserved: boolean;
    readonly recoveredOnce: boolean;
    readonly finalReceipts: number;
  }>;
  readonly simulateMidWaitRedisDrop: (deadline: Deadline) => Promise<{
    readonly waitRejectedBounded: boolean;
    readonly connectionsDisconnected: boolean;
  }>;
  readonly simulatePostCommitRedisDrop: (deadline: Deadline) => Promise<{
    readonly committedHashBefore: string;
    readonly committedHashAfter: string;
    readonly receipts: number;
  }>;
}

export interface P6PreCommitCrashPorts {
  /** Canonical pipeline crash before COMMIT + ambiguous COMMIT fence, followed by clean retry */
  readonly simulatePipelinePreCommitCrash: (deadline: Deadline) => Promise<{
    readonly preCommitRolledBack: boolean;
    readonly zeroPartialRowsAfterCrash: boolean;
    readonly retrySingleExecution: boolean;
    readonly retrySingleReceipt: boolean;
  }>;
  readonly simulatePipelineAmbiguousCommit: (deadline: Deadline) => Promise<{
    readonly threwCommitUncertain: boolean;
    readonly didNotEmitRollback: boolean;
    readonly leaseQuarantined: boolean;
  }>;
  /** Withdrawal/reducing crash before prepare COMMIT and crash after dispatchFence (reconcile-only retry) */
  readonly simulateFinancialPreCommitAndFenceCrash: (deadline: Deadline) => Promise<{
    readonly prePrepareRolledBack: boolean;
    readonly postFenceRetryDidNotResubmit: boolean;
    readonly submitCallCount: number;
    readonly applicationCount: number;
    readonly conserved: boolean;
    readonly journal: OwnedFinancialJournal<WithdrawalIntent | ReducingIntent>;
  }>;
}

export interface P6BullMqUnackPorts {
  readonly input: QueueIdentity;
  /** Simulate Worker 1 commit + crash before BullMQ ack, then Worker 2 stall redelivery */
  readonly simulateUnackRedelivery: (deadline: Deadline) => Promise<{
    readonly beforeJournal: QueueJournal;
    readonly afterJournal: QueueJournal;
    readonly retainedJob: {
      id: string;
      name: string;
      data: unknown;
      attemptsStarted: number;
      stalledCounter: number;
    };
    readonly finalState: string;
    readonly stream: readonly { event: string; jobId: string }[];
  }>;
}

export interface P6FaultPorts {
  readonly redisDrop: P6RedisDropPorts;
  readonly preCommitCrash: P6PreCommitCrashPorts;
  readonly bullMqUnack: P6BullMqUnackPorts;
}

export async function scheduleRedisDrop(
  ports: P6RedisDropPorts,
  deadline: Deadline
): Promise<Assertion[]> {
  deadline.check();
  const preEnqueue = await ports.simulatePreEnqueueRedisDrop(deadline);
  deadline.check();

  const midWait = await ports.simulateMidWaitRedisDrop(deadline);
  deadline.check();

  const postCommit = await ports.simulatePostCommitRedisDrop(deadline);
  deadline.check();

  return [
    assertion(
      'pre-enqueue Redis drop preserves durable pending operation and recovers once',
      preEnqueue.enqueueRejected
        && preEnqueue.durablePendingPreserved
        && preEnqueue.recoveredOnce
        && preEnqueue.finalReceipts === 1
    ),
    assertion(
      'mid-wait Redis drop aborts boundedly and disconnects all adopted Redis clients',
      midWait.waitRejectedBounded && midWait.connectionsDisconnected
    ),
    assertion(
      'post-commit Redis drop preserves committed SQL hash and single receipt',
      postCommit.committedHashBefore === postCommit.committedHashAfter
        && postCommit.receipts === 1
    )
  ];
}

export async function schedulePreCommitCrash(
  ports: P6PreCommitCrashPorts,
  deadline: Deadline
): Promise<Assertion[]> {
  deadline.check();
  const pipelineCrash = await ports.simulatePipelinePreCommitCrash(deadline);
  deadline.check();

  const ambiguous = await ports.simulatePipelineAmbiguousCommit(deadline);
  deadline.check();

  const financial = await ports.simulateFinancialPreCommitAndFenceCrash(deadline);
  assertOwnedFinancialConservation(financial.journal);
  deadline.check();

  return [
    assertion(
      'pipeline pre-commit crash rolls back partial rows and clean retry produces single execution and receipt',
      pipelineCrash.preCommitRolledBack
        && pipelineCrash.zeroPartialRowsAfterCrash
        && pipelineCrash.retrySingleExecution
        && pipelineCrash.retrySingleReceipt
    ),
    assertion(
      'ambiguous pipeline COMMIT throws ExecutedPipelineCommitUncertainError without ROLLBACK and quarantines lease',
      ambiguous.threwCommitUncertain
        && ambiguous.didNotEmitRollback
        && ambiguous.leaseQuarantined
    ),
    assertion(
      'financial pre-prepare crash rolls back and post-fence crash reconciles without double-submit',
      financial.prePrepareRolledBack
        && financial.postFenceRetryDidNotResubmit
        && financial.submitCallCount === 1
        && financial.applicationCount === 1
        && financial.conserved
    )
  ];
}

export async function scheduleBullMqUnackRecovery(
  ports: P6BullMqUnackPorts,
  deadline: Deadline
): Promise<Assertion[]> {
  deadline.check();
  const res = await ports.simulateUnackRedelivery(deadline);
  deadline.check();

  requireCompletedJournal(res.beforeJournal, ports.input);
  requireCompletedJournal(res.afterJournal, ports.input);
  requireRedelivery(res.retainedJob, res.finalState, res.stream, ports.input);

  const beforeHash = hash(res.beforeJournal);
  const afterHash = hash(res.afterJournal);

  return [
    assertion(
      'BullMQ unacknowledged job stalls and redelivers once without altering committed LP economics',
      beforeHash === afterHash
    )
  ];
}

export async function qualifyP6Faults(
  ports: P6FaultPorts,
  deadline: Deadline,
  evidence: Record<string, unknown> = {}
): Promise<GateResult> {
  deadline.check();
  const redisAssertions = await scheduleRedisDrop(ports.redisDrop, deadline);
  deadline.check();
  const crashAssertions = await schedulePreCommitCrash(ports.preCommitCrash, deadline);
  deadline.check();
  const bullMqAssertions = await scheduleBullMqUnackRecovery(ports.bullMqUnack, deadline);
  deadline.check();

  return result('I6', [...redisAssertions, ...crashAssertions, ...bullMqAssertions], [], {
    ...evidence,
    scheduleCount: 3
  });
}
