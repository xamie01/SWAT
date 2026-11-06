import type { Chain, LpChain } from './types.js';
export declare const REDIS_CHANNELS: {
    readonly walletSwap: "swat:wallet:swap";
    readonly signalDetected: "swat:signal:detected";
    readonly alertQueue: "swat:alert:queue";
    readonly tradeQueue: "swat:trade:queue";
    readonly discoveryRun: "swat:discovery:run";
    readonly clusterRefresh: "swat:cluster:refresh";
    readonly scorerRun: "swat:scorer:run";
};
export declare const QUEUES: {
    readonly walletBackfill: "swat-backfill-wallet";
    readonly tokenDiscovery: "swat-token-discovery";
    /**
     * The pre-split trade queue. **No producer writes here any more** — the split
     * landed under `S3-25` and every producer routes through
     * `tradeQueueForTokenMint`.
     *
     * It is retained for one reason: jobs enqueued by the previous release are
     * still sitting in it at cutover, so the executor keeps a drain-only worker on
     * it (`tradeWorkerSpecs`). Delete the name and that worker together once a
     * deploy has confirmed the queue is empty — that is the "contract" half of
     * `S3-25`'s expand-and-contract.
     */
    readonly trades: "swat-trades";
    readonly alerts: "swat-alerts";
};
/**
 * Per-chain trade queues (D6, checklist `S3-25`). **Live** — producers route
 * here and the executor runs one concurrency-1 worker per queue.
 *
 * Splitting `swat-trades` gives 3× parallelism at zero risk-logic cost, because
 * exposure caps, the circuit breaker, and canonical claims are already
 * chain-keyed. The point is isolation, not throughput: a venue outage or a slow
 * settlement on one chain can no longer stall the other two (audit `F-ACC2`),
 * which is a hard prerequisite for per-user fan-out (`S4-14`) — through one
 * concurrency-1 queue, every user of every chain queues behind the slowest
 * venue.
 */
export declare const TRADE_QUEUES_BY_CHAIN: {
    readonly solana: "swat-trades-solana";
    readonly polygon: "swat-trades-polygon";
    readonly 'robinhood-chain': "swat-trades-robinhood";
    readonly base: "swat-trades-base";
    readonly ethereum: "swat-trades-ethereum";
    readonly bsc: "swat-trades-bsc";
};
/** Resolves the trade queue for a chain. */
export declare function tradeQueueForChain(chain: Chain): string;
/**
 * The chain a trade job belongs to, derived from its chain-prefixed token mint.
 *
 * This is the *single* definition of that derivation, and it has to be: the
 * producer picks the queue with it and the executor picks the circuit breaker,
 * risk policy and venue adapter with it. Before the split the two ends could
 * disagree harmlessly, because there was one queue. Now a disagreement puts a
 * job on a queue whose worker handles a different venue, so the derivation is
 * shared rather than reimplemented per service.
 *
 * Throws on an unsupported prefix rather than defaulting, for the same reason
 * `resolveChainValue` throws on a bare `0x...`: a wrong chain here routes real
 * money to the wrong venue. An unprefixed mint reads as Solana, which is the
 * historical shape of every Solana mint in this codebase.
 */
export declare function chainFromTokenMint(tokenMint: string): Chain;
/** Resolves the trade queue for a job, from its chain-prefixed token mint. */
export declare function tradeQueueForTokenMint(tokenMint: string): string;
/**
 * Per-chain LP execution queues (LP Dashboard Track E/F). **Live** — producers
 * route `build-position` and `rebalance` jobs here, and `apps/lp` runs one
 * concurrency-1 worker per queue.
 *
 * Same isolation rationale as `TRADE_QUEUES_BY_CHAIN`, and for the same reason
 * the concurrency is 1 per chain: an LP build or rebalance signs transactions
 * sequentially against one venue, so nonce safety and per-chain breakers are
 * chain-keyed. Scan and monitor passes are scheduled cron work inside `apps/lp`
 * (scorer pattern) and deliberately do not use queues; only jobs that sign and
 * submit, or decide to, are durable work.
 */
export declare const LP_CHAINS: readonly LpChain[];
export declare function isLpChain(chain: unknown): chain is LpChain;
/**
 * Per-chain LP execution queues (LP Dashboard Tracks E/F). **Live** — producers
 * route `build-position` and `rebalance` jobs here, and `apps/lp` runs one
 * concurrency-1 worker per queue.
 */
export declare const LP_EXECUTION_QUEUES_BY_CHAIN: Record<LpChain, string>;
/** Resolves the LP execution queue for an LP-supported chain. */
export declare function lpExecutionQueueForChain(chain: LpChain): string;
/**
 * The chain an LP job belongs to, derived from its chain-prefixed pool address.
 * Same contract as `chainFromTokenMint`: a disagreement between producer queue
 * routing and worker venue handling would send funds to the wrong venue, so it
 * throws on an unsupported prefix rather than defaulting.
 */
export declare function chainFromPoolAddress(poolAddress: string): LpChain;
/** Resolves the LP execution queue for a job, from its chain-prefixed pool address. */
export declare function lpExecutionQueueForPool(poolAddress: string): string;
export declare const DEFAULT_RISK_CONFIG: {
    readonly maxPositionPct: 5;
    readonly maxDailyExposurePct: 25;
    readonly minLiquidityUsd: 50000;
    readonly tokenMinAgeMinutes: 5;
    readonly stopLossPct: 20;
    readonly maxConsecutiveFailures: 3;
};
//# sourceMappingURL=constants.d.ts.map