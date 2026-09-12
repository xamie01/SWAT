import { isChain } from './address.js';
import type { Chain } from './types.js';

export const REDIS_CHANNELS = {
  walletSwap: 'swat:wallet:swap',
  signalDetected: 'swat:signal:detected',
  alertQueue: 'swat:alert:queue',
  tradeQueue: 'swat:trade:queue',
  // Discovery / clustering control channels (producer: API, consumers:
  // discovery service + scorer). Use these constants on both ends so the
  // channel names can't drift.
  discoveryRun: 'swat:discovery:run',
  clusterRefresh: 'swat:cluster:refresh',
  scorerRun: 'swat:scorer:run'
} as const;

// BullMQ queue names shared between producers and consumers.
export const QUEUES = {
  walletBackfill: 'swat-backfill-wallet',
  tokenDiscovery: 'swat-token-discovery',
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
  trades: 'swat-trades',
  alerts: 'swat-alerts'
} as const;

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
export const TRADE_QUEUES_BY_CHAIN = {
  solana: 'swat-trades-solana',
  polygon: 'swat-trades-polygon',
  'robinhood-chain': 'swat-trades-robinhood'
} as const;

/** Resolves the trade queue for a chain. */
export function tradeQueueForChain(chain: Chain): string {
  return TRADE_QUEUES_BY_CHAIN[chain];
}

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
export function chainFromTokenMint(tokenMint: string): Chain {
  const separator = tokenMint.indexOf(':');
  const chain = separator >= 0 ? tokenMint.slice(0, separator) : 'solana';
  if (!isChain(chain)) {
    throw new Error(`Unsupported trade chain: ${chain}`);
  }
  return chain;
}

/** Resolves the trade queue for a job, from its chain-prefixed token mint. */
export function tradeQueueForTokenMint(tokenMint: string): string {
  return tradeQueueForChain(chainFromTokenMint(tokenMint));
}

export const DEFAULT_RISK_CONFIG = {
  maxPositionPct: 5,
  maxDailyExposurePct: 25,
  minLiquidityUsd: 50_000,
  tokenMinAgeMinutes: 5,
  stopLossPct: 20,
  maxConsecutiveFailures: 3
} as const;
