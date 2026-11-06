/**
 * Sweeps subscriptions in 'winding_down' with a close_all request.
 *
 * Claims exact lot exits idempotently and enqueues sell jobs to the trade queue.
 * After all candidate lots are claimed and queued, checks if any subscriptions
 * have no remaining open lots and transitions them to 'ended'.
 */
export async function runCloseAllSweep(deps) {
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
                await deps.enqueueSell({
                    signalId: job.signalId,
                    tokenMint: job.tokenMint,
                    direction: 'sell',
                    sellTokenAmount: job.sellTokenAmount,
                    userId: job.userId,
                    closeAll: true,
                    exitLotId: job.lotId,
                    copyExecutionId: claimResult.execution.id,
                    score: 100
                }, job.jobId, job.chain);
                queued++;
            }
        }
        catch (error) {
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
//# sourceMappingURL=close-all.js.map