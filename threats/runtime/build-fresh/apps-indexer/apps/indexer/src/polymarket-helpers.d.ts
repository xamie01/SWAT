export declare function parsePolymarketTimestamp(value: string | number): Date;
export type ConfirmedPolymarketTrade = {
    proxyWallet: string;
    timestamp: Date;
    conditionId: string;
    asset: string;
    size: number;
    price: number;
    side: 'BUY' | 'SELL';
    transactionHash: string;
    outcome: string;
    title: string;
};
export type PolymarketMarketContext = {
    conditionId: string;
    question: string;
    slug: string | null;
    endDate: Date;
    resolutionSource: string | null;
    active: boolean;
    closed: boolean;
    acceptingOrders: boolean;
    negRisk: boolean;
    tickSize: number;
    resolutionStatus: string;
    status: 'active' | 'inactive' | 'closed';
    outcomes: Array<{
        tokenId: string;
        outcome: string;
        outcomeIndex: number;
    }>;
};
export declare function parseConfirmedPolymarketTrade(value: unknown): ConfirmedPolymarketTrade;
export declare function parsePolymarketMarketContext(value: unknown, expectedConditionId: string, fallbackTickSize?: unknown): PolymarketMarketContext;
export declare function assertPolymarketCertificationBatch(input: {
    trades: ConfirmedPolymarketTrade[];
    mappedTokenIds: Iterable<string>;
    now?: Date;
    maxLagSeconds?: number;
}): {
    contextCoverage: number;
    lagSeconds: number;
};
//# sourceMappingURL=polymarket-helpers.d.ts.map