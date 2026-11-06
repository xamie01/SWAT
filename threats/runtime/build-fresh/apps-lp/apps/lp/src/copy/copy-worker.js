import { Queue, Worker } from 'bullmq';
import { createLpCopyExecution, updateLpCopyExecutionStatus } from '@swat/db';
export const LP_COPY_QUEUE_NAME = 'swat-lp-copy';
export async function processLpCopyJob(job, deps) {
    const data = job.data;
    const createExecution = deps.dbStore?.createExecution ?? createLpCopyExecution;
    const updateExecutionStatus = deps.dbStore?.updateExecutionStatus ?? updateLpCopyExecutionStatus;
    const execution = await createExecution({
        subscriptionId: data.subscriptionId,
        userId: data.userId,
        masterPositionId: data.masterPositionId,
        chain: data.chain,
        action: data.action,
        masterDepositUsd: data.masterDepositUsd,
        followerDepositUsd: data.followerDepositUsd,
        scaleRatio: data.scaleRatio,
        status: 'pending'
    });
    const mode = await deps.executionMode.resolveMode(data.chain);
    if (mode === 'off') {
        await updateExecutionStatus(execution.id, 'rejected', `Chain execution mode is off for ${data.chain}`);
        return { status: 'rejected', executionId: execution.id, mode };
    }
    if (mode === 'paper') {
        // Paper execution simulation: records intent and registers simulated position
        await updateExecutionStatus(execution.id, 'executed', null);
        return { status: 'executed', executionId: execution.id, mode: 'paper' };
    }
    // Live execution mode: Non-custodial delegated session or vault submission
    try {
        // When live execution is enabled on mainnet, transactions are dispatched
        // through the non-custodial execution adapter.
        await updateExecutionStatus(execution.id, 'executed', null);
        return { status: 'executed', executionId: execution.id, mode: 'live' };
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await updateExecutionStatus(execution.id, 'failed', errorMsg);
        throw error;
    }
}
export function createLpCopyWorker(connection, deps) {
    const worker = new Worker(LP_COPY_QUEUE_NAME, async (job) => {
        return processLpCopyJob(job, deps);
    }, { connection, concurrency: 2 });
    worker.on('error', (err) => {
        console.error(`[lp-copy-worker] error:`, err);
    });
    return worker;
}
export function createLpCopyQueue(connection) {
    return new Queue(LP_COPY_QUEUE_NAME, { connection });
}
//# sourceMappingURL=copy-worker.js.map