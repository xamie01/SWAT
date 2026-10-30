import type { Chain } from '@swat/shared';
import type { CloseAllLotJob, CopyExecutionRecord, LotExitExecutionInput } from '@swat/db';

export interface CloseAllSweepResult {
  readonly scanned: number;
  readonly claimed: number;
  readonly queued: number;
  readonly ended: number;
  readonly failed: number;
}

export interface CloseAllSellPayload {
  readonly signalId: string;
  readonly tokenMint: string;
  readonly direction: 'sell';
  readonly sellTokenAmount: number;
  readonly userId: string;
  readonly closeAll: true;
  readonly exitLotId: string;
  readonly copyExecutionId: string;
  readonly score: number;
}

export interface CloseAllSweepDeps {
  readonly listJobs: () => Promise<CloseAllLotJob[]>;
  readonly claimExit: (input: LotExitExecutionInput) => Promise<{ execution: CopyExecutionRecord; created: boolean }>;
  readonly enqueueSell: (payload: CloseAllSellPayload, jobId: string, chain: Chain) => Promise<unknown>;
  readonly endCompleted: () => Promise<number>;
}

/**
 * Sweeps subscriptions in 'winding_down' with a close_all request.
 *
 * Claims exact lot exits idempotently and enqueues sell jobs to the trade queue.
 * After all candidate lots are claimed and queued, checks if any subscriptions
 * have no remaining open lots and transitions them to 'ended'.
 */
export async function runCloseAllSweep(deps: CloseAllSweepDeps): Promise<CloseAllSweepResult> {
  const jobs = await deps.listJobs();
  let claimed = 0;
  let queued = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const claimResult = await deps.claimExit({
        lotId: job.lotId,
        userId: job.userId,
        requestId: job.jobId,
        trigger: 'close-all',
        requestedBaseQuantity: job.sellTokenAmount.toString()
      });
      claimed++;

      if (claimResult.execution.state !== 'confirmed' && claimResult.execution.state !== 'failed') {
        await deps.enqueueSell(
          {
            signalId: job.signalId,
            tokenMint: job.tokenMint,
            direction: 'sell',
            sellTokenAmount: job.sellTokenAmount,
            userId: job.userId,
            closeAll: true,
            exitLotId: job.lotId,
            copyExecutionId: claimResult.execution.id,
            score: 100
          },
          job.jobId,
          job.chain
        );
        queued++;
      }
    } catch (error) {
      failed++;
      console.error(`[scorer] Close-all exit claim/enqueue failed for lot ${job.lotId}:`, error);
    }
  }

  const ended = await deps.endCompleted();
  return {
    scanned: jobs.length,
    claimed,
    queued,
    ended,
    failed
  };
}
