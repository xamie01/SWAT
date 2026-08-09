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
   * The single trade queue every service currently uses.
   *
   * Previously string-inlined at four call sites (`api`, `scorer`,
   * `signal-engine`, `trade-executor`), which is why CLAUDE.md warns to grep
   * before assuming a queue name is centralised. Named here so the split below
   * has one place to switch.
   */
  trades: 'swat-trades',
  alerts: 'swat-alerts'
} as const;

/**
 * Per-chain trade queues (D6, checklist S3-25).
 *
 * **Not yet in use — the mechanism is built, the switch is not flipped.**
 * Splitting `swat-trades` gives 3× parallelism at zero risk-logic cost, because
 * exposure caps, the circuit breaker, and canonical claims are already
 * chain-keyed. It also means a venue outage on one chain cannot stall the other
 * two (audit `F-ACC2`).
 *
 * Cutover is deliberately a separate, tested step: it touches the money path in
 * four services at once, and a half-migrated producer/consumer pair would send
 * trade jobs into a queue nobody is reading. Expand-and-contract per Standing
 * Rule 4 — add the names, migrate producers and consumers together under test,
 * then retire the shared queue.
 */
export const TRADE_QUEUES_BY_CHAIN = {
  solana: 'swat-trades-solana',
  polygon: 'swat-trades-polygon',
  'robinhood-chain': 'swat-trades-robinhood'
} as const;

/**
 * Resolves the trade queue for a chain.
 *
 * While `enablePerChainQueues` is false this returns the shared queue for every
 * chain, so producers and consumers can adopt the helper *before* the split
 * lands and the cutover becomes a one-line change rather than a four-service
 * refactor.
 */
export function tradeQueueForChain(
  chain: keyof typeof TRADE_QUEUES_BY_CHAIN,
  enablePerChainQueues = false
): string {
  return enablePerChainQueues ? TRADE_QUEUES_BY_CHAIN[chain] : QUEUES.trades;
}

export const DEFAULT_RISK_CONFIG = {
  maxPositionPct: 5,
  maxDailyExposurePct: 25,
  minLiquidityUsd: 50_000,
  tokenMinAgeMinutes: 5,
  stopLossPct: 20,
  maxConsecutiveFailures: 3
} as const;
