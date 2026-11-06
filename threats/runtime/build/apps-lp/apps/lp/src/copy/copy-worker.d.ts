import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { LpChain, LpProtocol } from '@swat/shared';
import { createLpCopyExecution, updateLpCopyExecutionStatus, type LpCopyAction } from '@swat/db';
export declare const LP_COPY_QUEUE_NAME = "swat-lp-copy";
export interface LpCopyJobPayload {
    readonly subscriptionId: string;
    readonly userId: string;
    readonly chain: LpChain;
    readonly venue: LpProtocol;
    readonly action: LpCopyAction;
    readonly masterPositionId: string;
    readonly poolAddress: string;
    readonly masterDepositUsd: number;
    readonly followerDepositUsd: number;
    readonly scaleRatio: number;
}
export interface LpCopyWorkerDeps {
    readonly executionMode: {
        readonly resolveMode: (chain: LpChain) => Promise<'off' | 'paper' | 'live'>;
    };
    readonly dbStore?: {
        readonly createExecution: typeof createLpCopyExecution;
        readonly updateExecutionStatus: typeof updateLpCopyExecutionStatus;
    };
}
export declare function processLpCopyJob(job: Job<LpCopyJobPayload>, deps: LpCopyWorkerDeps): Promise<{
    status: string;
    executionId: string;
    mode: string;
}>;
export declare function createLpCopyWorker(connection: Redis, deps: LpCopyWorkerDeps): Worker<LpCopyJobPayload>;
export declare function createLpCopyQueue(connection: Redis): Queue<LpCopyJobPayload>;
//# sourceMappingURL=copy-worker.d.ts.map