export const REDIS_CHANNELS = {
    walletSwap: 'swat:wallet:swap',
    signalDetected: 'swat:signal:detected',
    alertQueue: 'swat:alert:queue',
    tradeQueue: 'swat:trade:queue',
    // Discovery / clustering control channels (producer: API, consumers:
    // discovery service + scorer). Use these constants on both ends so the
    // channel names can't drift.
    discoveryRun: 'swat:discovery:run',
    discoverySeedToken: 'swat:discovery:seed-token',
    clusterRefresh: 'swat:cluster:refresh'
};
// BullMQ queue names shared between producers (API) and consumers (indexer),
// so they can't drift. (The backfill queue name 'swat-backfill-wallet' predates
// this and is still inlined in the indexer/API.)
export const QUEUES = {
    tokenDiscovery: 'swat-token-discovery'
};
export const DEFAULT_RISK_CONFIG = {
    maxPositionPct: 5,
    maxDailyExposurePct: 25,
    minLiquidityUsd: 50_000,
    tokenMinAgeMinutes: 5,
    stopLossPct: 20,
    maxConsecutiveFailures: 3
};
//# sourceMappingURL=constants.js.map