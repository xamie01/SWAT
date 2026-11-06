export type RobinhoodDirection = 'buy' | 'sell';
export type RobinhoodReceiptLog = {
    address: string;
    data: `0x${string}`;
    topics: readonly [`0x${string}`, ...`0x${string}`[]] | readonly `0x${string}`[];
    logIndex?: number | null;
    transactionHash?: string | null;
};
export type RobinhoodReviewedPool = {
    address: string;
    token0: string;
    token1: string;
};
export type RobinhoodIngestionConfig = {
    routers: ReadonlySet<string>;
    baseAsset: string;
    pools: ReadonlyMap<string, {
        token0: string;
        token1: string;
    }>;
};
export type RobinhoodClassifiedSwap = {
    status: 'classified';
    direction: RobinhoodDirection;
    tokenIn: string;
    tokenOut: string;
    targetToken: string;
    amountIn: bigint;
    amountOut: bigint;
    poolAddresses: string[];
};
export type RobinhoodRejectedReceipt = {
    status: 'rejected';
    reason: 'reverted_receipt' | 'wallet_not_sender' | 'unreviewed_router' | 'no_reviewed_pool_swap' | 'ambiguous_route' | 'missing_wallet_transfer';
};
export type RobinhoodReceiptClassification = RobinhoodClassifiedSwap | RobinhoodRejectedReceipt;
type ReceiptInput = {
    status: 'success' | 'reverted';
    from: string;
    to: string | null;
    transactionHash: string;
    logs: readonly RobinhoodReceiptLog[];
};
export type RobinhoodReviewedFixture = {
    name: string;
    reviewed: boolean;
    wallet: string;
    receipt: ReceiptInput;
    expected: 'classify' | 'reject';
    expectedDirection?: RobinhoodDirection;
};
export type RobinhoodFixtureMetrics = {
    totalFixtures: number;
    reviewedFixtures: number;
    expectedSwaps: number;
    inserted: number;
    skipped: number;
    falsePositives: number;
    completeness: number | null;
    directionSamples: number;
    correctDirections: number;
    directionAccuracy: number | null;
};
export declare function parseRobinhoodIngestionConfig(values?: Record<string, string | undefined>): RobinhoodIngestionConfig;
export declare function classifyRobinhoodReceipt(receipt: ReceiptInput, walletValue: string, config: RobinhoodIngestionConfig): RobinhoodReceiptClassification;
export declare function measureRobinhoodFixtures(fixtures: readonly RobinhoodReviewedFixture[], config: RobinhoodIngestionConfig): RobinhoodFixtureMetrics;
export declare function evaluateRobinhoodFixtureGate(metrics: RobinhoodFixtureMetrics): {
    passed: boolean;
    reasons: string[];
};
export {};
//# sourceMappingURL=robinhood-ingestion.d.ts.map