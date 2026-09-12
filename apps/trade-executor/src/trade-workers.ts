import { QUEUES, TRADE_QUEUES_BY_CHAIN } from '@swat/shared';
import type { Chain } from '@swat/shared';

/**
 * Trade worker topology (D6, checklist `S3-25`).
 *
 * The executor used to run one worker on `swat-trades` at concurrency 3, which
 * meant a slow venue held a slot that any chain's next job needed. Now each
 * chain gets its own queue and its own concurrency-1 worker, so a Polymarket
 * settlement delay or a Robinhood RPC outage cannot stall Solana copies (audit
 * `F-ACC2`). Total concurrency is unchanged at 3; what changes is that the three
 * slots are no longer shared.
 *
 * Concurrency stays at **1 per chain** deliberately. Ordering within a chain
 * matters — exposure caps, the circuit breaker and the per-chain nonce are all
 * chain-keyed, and two jobs for one chain running concurrently is exactly the
 * race `S4-M12` describes on EVM. Raising this is a per-chain decision that
 * needs per-user nonce allocation first.
 *
 * This module is deliberately separate from `index.ts` so the topology can be
 * asserted in a test: `index.ts` opens Redis connections and starts timers at
 * import, so it cannot be loaded from a unit test. The wiring in `index.ts` that
 * consumes these specs is therefore **not** covered by a test — only the specs
 * and the misroute guard are.
 */

export type TradeWorkerSpec = {
  queue: string;
  /**
   * The chain this worker owns, or `null` for the drain worker on the pre-split
   * queue, which necessarily carries every chain.
   */
  chain: Chain | null;
  concurrency: number;
  /** True for the pre-split queue: read to empty it, never written to. */
  drainOnly: boolean;
};

export const TRADE_WORKER_CONCURRENCY = 1;

/**
 * The workers the executor should run.
 *
 * `drainLegacyQueue` defaults to true because at cutover the previous release's
 * jobs are still in `swat-trades` and nothing else will ever read them. Once a
 * deploy has confirmed that queue is empty, pass false (or delete this and
 * `QUEUES.trades` together) — that is the "contract" half of `S3-25`.
 */
export function tradeWorkerSpecs(
  options: { drainLegacyQueue?: boolean } = {}
): TradeWorkerSpec[] {
  const drainLegacyQueue = options.drainLegacyQueue ?? true;
  const specs: TradeWorkerSpec[] = (
    Object.entries(TRADE_QUEUES_BY_CHAIN) as Array<[Chain, string]>
  ).map(([chain, queue]) => ({
    queue,
    chain,
    concurrency: TRADE_WORKER_CONCURRENCY,
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
export function misroutedJobWarning(
  spec: TradeWorkerSpec,
  jobChain: Chain
): string | null {
  if (spec.chain === null) return null;
  if (jobChain === spec.chain) return null;

  return `[trade-executor] misrouted job: ${jobChain} job arrived on ${spec.queue} `
    + `(owns ${spec.chain}); executing anyway, but a producer is routing with the `
    + `wrong chain and per-chain isolation is broken`;
}
