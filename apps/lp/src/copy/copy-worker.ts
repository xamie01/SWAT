import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { LpChain, LpProtocol } from '@swat/shared';
import { forUser, type createLpCopyExecution, type updateLpCopyExecutionStatus, type LpCopyAction } from '@swat/db';
import type { LpPaperService } from '@swat/db/dist/lp-paper-service.js';

export const LP_COPY_QUEUE_NAME = 'swat-lp-copy';
/** Queue hints do not carry sizing, quote or source authority. Legacy fields ignored. */
export interface LpCopyJobPayload {
  readonly subscriptionId: string;
  readonly userId: string;
  readonly chain: LpChain;
  readonly venue: LpProtocol;
  readonly action: LpCopyAction;
  readonly eventId?: string;
  readonly assetScale?: number;
  readonly masterPositionId: string;
  readonly poolAddress: string;
  readonly masterDepositUsd: number;
  readonly followerDepositUsd: number;
  readonly scaleRatio: number;
}
export interface LpCopyWorkerDeps {
  readonly executionMode: { readonly resolveMode: (chain: LpChain) => Promise<'off' | 'paper' | 'live'> };
  readonly exactPaper?: LpPaperService;
  readonly dbStore?: { readonly createExecution: typeof createLpCopyExecution; readonly updateExecutionStatus: typeof updateLpCopyExecutionStatus };
}
export async function processLpCopyJob(job: Job<LpCopyJobPayload>, deps: LpCopyWorkerDeps) {
  const data = job.data;
  const mode = await deps.executionMode.resolveMode(data.chain);
  if (mode !== 'paper' || !deps.exactPaper || data.action !== 'mint' || !data.eventId || data.assetScale === undefined) {
    // Do not insert an unverified queue user's financial execution row, and never report fake execution.
    return { status: 'rejected', executionId: '', mode, reason: 'LP canonical exact copy mint capability unavailable' };
  }
  // Service resolves subscription/master evidence and current mode from canonical records, then calls the same acquisition commit.
  const position = await deps.exactPaper.copyMint(forUser(data.userId), { subscriptionId: data.subscriptionId,
    eventId: data.eventId, assetScale: data.assetScale });
  return { status: 'executed', executionId: position.id, followerPositionId: position.id, mode: 'paper', broadcast: false };
}
export function createLpCopyWorker(connection: Redis, deps: LpCopyWorkerDeps): Worker<LpCopyJobPayload> {
  const worker = new Worker<LpCopyJobPayload>(LP_COPY_QUEUE_NAME, job => processLpCopyJob(job, deps), { connection, concurrency: 2 });
  worker.on('error', err => console.error('[lp-copy-worker] error', err));
  return worker;
}
export function createLpCopyQueue(connection: Redis): Queue<LpCopyJobPayload> { return new Queue<LpCopyJobPayload>(LP_COPY_QUEUE_NAME, { connection }); }
