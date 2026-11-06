import { QUEUES, TRADE_QUEUES_BY_CHAIN } from '@swat/shared';
export const TRADE_WORKER_CONCURRENCY = 1;
/**
 * Resolves worker concurrency per chain.
 * Defaults strictly to 1 to preserve ordering, exposure caps, and EVM nonce isolation.
 * For keyless Solana Anchor PDAs or Polymarket custodial signers, concurrency can be safely
 * scaled via env (e.g. TRADE_CONCURRENCY_SOLANA=5) to drain large multi-tenant cohorts in parallel.
 */
export function resolveWorkerConcurrency(chain, env = process.env) {
    if (chain === 'solana') {
        const raw = env.TRADE_CONCURRENCY_SOLANA;
        if (raw) {
            const parsed = parseInt(raw, 10);
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 10)
                return parsed;
        }
    }
    if (chain === 'polygon') {
        const raw = env.TRADE_CONCURRENCY_POLYGON;
        if (raw) {
            const parsed = parseInt(raw, 10);
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 10)
                return parsed;
        }
    }
    return TRADE_WORKER_CONCURRENCY;
}
/**
 * The workers the executor should run.
 *
 * `drainLegacyQueue` defaults to true because at cutover the previous release's
 * jobs are still in `swat-trades` and nothing else will ever read them. Once a
 * deploy has confirmed that queue is empty, pass false (or delete this and
 * `QUEUES.trades` together) — that is the "contract" half of `S3-25`.
 */
export function tradeWorkerSpecs(options = {}) {
    const drainLegacyQueue = options.drainLegacyQueue ?? true;
    const specs = Object.entries(TRADE_QUEUES_BY_CHAIN).map(([chain, queue]) => ({
        queue,
        chain,
        concurrency: options.concurrencyByChain?.[chain] ?? resolveWorkerConcurrency(chain, options.env),
        drainOnly: false
    }));
    if (drainLegacyQueue) {
        specs.push({
            queue: QUEUES.trades,
            chain: null,
            concurrency: TRADE_WORKER_CONCURRENCY,
            drainOnly: true
        });
    }
    return specs;
}
/**
 * Warns when a job lands on a queue that does not own its chain.
 *
 * Returns a message rather than throwing, and the caller executes the job
 * anyway. That asymmetry is deliberate: a misroute is a producer bug that costs
 * isolation, while refusing the job would cost a real fill. Losing the mirror of
 * a master's trade is strictly worse than losing head-of-line separation for one
 * job, so this is loud rather than fatal.
 *
 * Takes the already-derived chain rather than the payload, so there is exactly
 * one place that decides a job's chain (`chainFromTokenMint`, shared with the
 * producers). A second derivation here could disagree with the one the executor
 * actually routes on, and then the guard would report the wrong thing — or worse,
 * stay silent on a real misroute.
 */
export function misroutedJobWarning(spec, jobChain) {
    if (spec.chain === null)
        return null;
    if (jobChain === spec.chain)
        return null;
    return `[trade-executor] misrouted job: ${jobChain} job arrived on ${spec.queue} `
        + `(owns ${spec.chain}); executing anyway, but a producer is routing with the `
        + `wrong chain and per-chain isolation is broken`;
}
//# sourceMappingURL=trade-workers.js.map