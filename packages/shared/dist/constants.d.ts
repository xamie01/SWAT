export declare const REDIS_CHANNELS: {
    readonly walletSwap: "swat:wallet:swap";
    readonly signalDetected: "swat:signal:detected";
    readonly alertQueue: "swat:alert:queue";
    readonly tradeQueue: "swat:trade:queue";
    readonly discoveryRun: "swat:discovery:run";
    readonly discoverySeedToken: "swat:discovery:seed-token";
    readonly clusterRefresh: "swat:cluster:refresh";
};
export declare const QUEUES: {
    readonly tokenDiscovery: "swat-token-discovery";
};
export declare const DEFAULT_RISK_CONFIG: {
    readonly maxPositionPct: 5;
    readonly maxDailyExposurePct: 25;
    readonly minLiquidityUsd: 50000;
    readonly tokenMinAgeMinutes: 5;
    readonly stopLossPct: 20;
    readonly maxConsecutiveFailures: 3;
};
//# sourceMappingURL=constants.d.ts.map