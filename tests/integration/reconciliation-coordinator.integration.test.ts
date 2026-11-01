import { afterAll, describe, expect, it } from 'vitest';
import type { Chain } from '@swat/shared';
import {
  claimCopyExecutionsForReconciliation,
  closePool,
  getCopyExecutionByClientOrderId,
  recordSourceTradeEvent,
  releaseCopyExecutionReconciliationClaim,
  requestCopyExecution,
  transitionCopyExecution,
  type CopyExecutionRecord
} from '../../packages/db/src/index.js';
import {
  RECONCILIATION_ACCOUNT,
  runReconciliationCoordinator
} from '../../apps/trade-executor/src/reconciliation-coordinator.js';
import { withLifecycleFixture } from './helpers/lifecycle-fixture.js';

/**
 * C1 acceptance: an execution left in `reconciliation_required` must be picked
 * up on a later sweep, which is what happens after a process restart.
 *
 * The scenario this covers is the one the per-venue sweeps structurally cannot:
 * the venue-side pending record is gone (Redis expiry, flush, or a process that
 * died before writing it), so nothing but a sweep over `copy_executions` itself
 * will ever look at the row again.
 */

const eventAt = new Date('2026-01-01T12:00:00.000Z');
const observedAt = new Date('2026-01-01T12:00:01.000Z');

afterAll(async () => {
  await closePool();
});

async function stageAmbiguousExecution(fixture: {
  chain: Chain;
  sourceEventPrefix: string;
  sourceWallet: string;
  targetAccount: string;
  tokenMint: string;
}): Promise<CopyExecutionRecord> {
  const source = await recordSourceTradeEvent({
    chain: fixture.chain,
    sourceEventType: 'transaction',
    sourceEventId: `${fixture.sourceEventPrefix}stuck-buy`,
    transactionHash: `${fixture.sourceEventPrefix}stuck-buy`,
    walletAddress: fixture.sourceWallet,
    tokenMint: fixture.tokenMint,
    side: 'buy',
    quantity: '10',
    amountUsd: '100',
    priceUsd: '10',
    eventAt,
    observedAt,
    confirmationState: 'finalized',
    confirmationEvidenceId: `${fixture.sourceEventPrefix}stuck-finalized`
  });
  const requested = await requestCopyExecution({
    sourceTradeId: source.event.id,
    targetAccount: fixture.targetAccount,
    executionMode: 'paper',
    requestedBaseQuantity: '5',
    maxReconciliationAttempts: 3
  });
  await transitionCopyExecution({
    executionId: requested.execution.id,
    nextState: 'simulated',
    simulationId: `${fixture.sourceEventPrefix}simulation`
  });
  await transitionCopyExecution({
    executionId: requested.execution.id,
    nextState: 'submitted',
    submissionType: 'transaction',
    submissionId: `${fixture.sourceEventPrefix}submission`,
    nextReconciliationAt: new Date(Date.now() - 1_000)
  });
  // Whatever submitted this execution then died, leaving it ambiguous with its
  // venue-side pending record gone.
  const stuck = await transitionCopyExecution({
    executionId: requested.execution.id,
    nextState: 'reconciliation_required',
    reason: 'venue pending record was lost',
    nextReconciliationAt: new Date(Date.now() - 1_000)
  });
  expect(stuck.state).toBe('reconciliation_required');
  return stuck;
}

describe('canonical reconciliation coordinator', () => {
  it('picks up an execution left in reconciliation_required and releases its claim', async () => {
    await withLifecycleFixture(async (fixture) => {
      const stuck = await stageAmbiguousExecution(fixture);

      const seen: string[] = [];
      const escalated: string[] = [];
      const result = await runReconciliationCoordinator({
        account: RECONCILIATION_ACCOUNT,
        limit: 100,
        claim: ({ limit }) => claimCopyExecutionsForReconciliation({
          chain: fixture.chain,
          limit
        }),
        release: (input) => releaseCopyExecutionReconciliationClaim(input),
        reconcilers: {
          [fixture.chain]: async (execution: CopyExecutionRecord) => {
            seen.push(execution.id);
            // The venue still has no answer, which is the realistic first pass.
            return { status: 'pending' };
          }
        },
        escalate: async (execution) => {
          escalated.push(execution.id);
        }
      });

      expect(seen).toContain(stuck.id);
      expect(result.pending).toBeGreaterThanOrEqual(1);
      expect(escalated).toHaveLength(0);

      // The claim must be handed back, otherwise the row stays locked for the
      // full stale-claim window — the exact stuck state this prevents.
      const afterSweep = await getCopyExecutionByClientOrderId({
        chain: fixture.chain,
        targetAccount: fixture.targetAccount,
        clientOrderId: stuck.clientOrderId
      });
      expect(afterSweep).toMatchObject({
        state: 'reconciliation_required',
        reconciliationClaimId: null,
        reconciliationAttempts: 1
      });
    });
  });

  it('resolves the execution when the venue proves the submission failed', async () => {
    await withLifecycleFixture(async (fixture) => {
      const stuck = await stageAmbiguousExecution(fixture);

      const result = await runReconciliationCoordinator({
        limit: 100,
        claim: ({ limit }) => claimCopyExecutionsForReconciliation({
          chain: fixture.chain,
          limit
        }),
        release: (input) => releaseCopyExecutionReconciliationClaim(input),
        reconcilers: {
          [fixture.chain]: async (execution: CopyExecutionRecord) => {
            await transitionCopyExecution({
              executionId: execution.id,
              nextState: 'failed',
              reason: 'venue reported the transaction reverted'
            });
            return { status: 'resolved' };
          }
        },
        escalate: async () => undefined
      });

      expect(result.resolved).toBeGreaterThanOrEqual(1);

      const settled = await getCopyExecutionByClientOrderId({
        chain: fixture.chain,
        targetAccount: fixture.targetAccount,
        clientOrderId: stuck.clientOrderId
      });
      expect(settled).toMatchObject({ state: 'failed', reconciliationClaimId: null });

      // A terminal execution must not be claimable again.
      const reclaimed = await claimCopyExecutionsForReconciliation({
        chain: fixture.chain,
        limit: 100
      });
      expect(reclaimed.some((candidate) => candidate.id === stuck.id)).toBe(false);
    });
  });

  // Attempts are consumed by the claim itself, so a repeatedly unobservable
  // execution eventually stops being claimed. It must reach a human first.
  it('escalates rather than abandoning an execution that exhausts its attempts', async () => {
    await withLifecycleFixture(async (fixture) => {
      const stuck = await stageAmbiguousExecution(fixture);
      const escalated: Array<{ id: string; reason: string }> = [];

      const sweep = () => runReconciliationCoordinator({
        limit: 100,
        claim: ({ limit }) => claimCopyExecutionsForReconciliation({
          chain: fixture.chain,
          limit,
          // Ignore the claim cooldown so consecutive sweeps in one test see it.
          staleClaimBefore: new Date(Date.now() + 60_000)
        }),
        release: (input) => releaseCopyExecutionReconciliationClaim({
          ...input,
          retryAt: new Date(Date.now() - 1_000)
        }),
        reconcilers: {
          [fixture.chain]: async () => ({ status: 'unresolved', reason: 'venue unreachable' })
        },
        escalate: async (execution, reason) => {
          escalated.push({ id: execution.id, reason });
        }
      });

      // maxReconciliationAttempts is 3, so the third sweep is the last one that
      // can claim the row.
      await sweep();
      await sweep();
      const third = await sweep();

      expect(third.exhausted).toBe(1);
      expect(escalated).toEqual([
        { id: stuck.id, reason: expect.stringContaining('venue unreachable') }
      ]);

      const exhausted = await claimCopyExecutionsForReconciliation({
        chain: fixture.chain,
        limit: 100,
        staleClaimBefore: new Date(Date.now() + 60_000)
      });
      expect(exhausted.some((candidate) => candidate.id === stuck.id)).toBe(false);
    });
  });
});
