export type PolymarketMarketInsert = {
    conditionId: string;
    question: string;
    slug?: string | null;
    endDate?: Date | null;
    resolutionSource?: string | null;
    outcomeCount: number;
    clobTokenIds?: any;
    status?: string;
    tickSize?: string | number | null;
    negRisk?: boolean | null;
    acceptingOrders?: boolean | null;
    resolutionStatus?: string | null;
    contextComplete?: boolean;
};
export type PolymarketOutcomeInsert = {
    tokenId: string;
    outcome: string;
    outcomeIndex: number;
};
export type PolymarketContextInsert = PolymarketMarketInsert & {
    endDate: Date;
    tickSize: string | number;
    negRisk: boolean;
    acceptingOrders: boolean;
    resolutionStatus: string;
    outcomes: PolymarketOutcomeInsert[];
};
export type PolymarketOutcomeContext = {
    tokenId: string;
    conditionId: string;
    outcome: string;
    outcomeIndex: number;
    question: string;
    slug: string | null;
    endDate: Date;
    marketStatus: string;
    tickSize: string | number;
    negRisk: boolean;
    acceptingOrders: boolean;
    resolutionStatus: string;
    contextComplete: boolean;
};
export type ConfirmedPolymarketTradeInsert = {
    transactionHash: string;
    proxyWallet: string;
    asset: string;
    conditionId: string;
    side: 'BUY' | 'SELL';
    size: string | number;
    price: string | number;
    timestamp: Date;
};
export declare function getPolymarketMarket(conditionId: string): Promise<{
    condition_id: string;
    question: string;
    slug: string | null;
    end_date: Date | null;
    resolution_source: string | null;
    outcome_count: number;
    clob_token_ids: any;
    status: string;
    tick_size: string | null;
    neg_risk: boolean | null;
    accepting_orders: boolean | null;
    resolution_status: string | null;
    context_complete: boolean;
    created_at: Date;
    updated_at: Date;
}>;
export declare function upsertPolymarketContext(context: PolymarketContextInsert): Promise<void>;
export declare function getPolymarketOutcomeContext(tokenId: string): Promise<PolymarketOutcomeContext | null>;
export declare function recordConfirmedPolymarketTrade(trade: ConfirmedPolymarketTradeInsert): Promise<boolean>;
//# sourceMappingURL=polymarket.d.ts.map