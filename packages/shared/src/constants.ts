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
  tokenDiscovery: 'swat-token-discovery'
} as const;

export const DEFAULT_RISK_CONFIG = {
  maxPositionPct: 5,
  maxDailyExposurePct: 25,
  minLiquidityUsd: 50_000,
  tokenMinAgeMinutes: 5,
  stopLossPct: 20,
  maxConsecutiveFailures: 3
} as const;
