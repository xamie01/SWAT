export const REDIS_CHANNELS = {
    walletSwap: 'swat:wallet:swap',
    signalDetected: 'swat:signal:detected',
    alertQueue: 'swat:alert:queue',
    tradeQueue: 'swat:trade:queue'
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