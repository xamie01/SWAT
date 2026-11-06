/**
 * Live market-state gate applied immediately before a Polymarket submission.
 *
 * The order book tells you about liquidity; it says nothing about whether the
 * market is still accepting orders, has closed, or has gone to resolution. A
 * depth walk can therefore look perfectly healthy on a market that will reject
 * the order — or, worse, on one that is resolving, where an entry is simply a
 * donation.
 *
 * The stored `polymarket_markets` context cannot answer this either: it is
 * written by the indexer's backfill and is exactly as old as the last time that
 * ran. "Not accepting orders" is a state that flips between a signal and its
 * execution, which is precisely the window this gate covers, so the state is
 * re-read live and as close to submission as possible.
 *
 * The CLOB SDK has no market-state call keyed by condition (`fetchMarketInfo`
 * returns fees and tokens only), so this reads the same Gamma endpoint the
 * indexer uses to build market context.
 */
export type PolymarketMarketState = {
    conditionId: string;
    active: boolean;
    closed: boolean;
    acceptingOrders: boolean;
    resolutionStatus: string;
    /**
     * When the market becomes eligible for resolution — per `/concepts/resolution`
     * that is what an end date *means*, which is why `polymarket-staleness.ts`
     * (`S4-M18`) uses it as the denominator for time-to-resolution rather than as
     * a display value.
     */
    endDate: Date;
    /**
     * The market's configured matching delay in seconds, or null when it reports
     * none. `/market-data/market-details` → *Market Timing* documents
     * `secondsDelay` as the "delay, in seconds, before a newly placed marketable
     * order can match", and `/trading/place-orders` returns an order status of
     * `delayed` for exactly that case.
     *
     * Read here rather than inferred because it is latency *we* incur between
     * submission and any fill, so `S4-M18` charges it against the staleness
     * budget. Typed nullable to match the documented `integer | null`.
     */
    secondsDelay: number | null;
};
export declare class PolymarketMarketClosedError extends Error {
}
/**
 * Parse only the fields this gate decides on. A market whose state cannot be
 * read is treated as untradable rather than assumed open.
 */
export declare function parsePolymarketMarketState(value: unknown, expectedConditionId: string): PolymarketMarketState;
/**
 * Throw unless the market is open for a new order right now.
 *
 * Applied to sells as well as buys: submitting into a market that has stopped
 * accepting orders produces a rejected or ambiguous execution either way, and a
 * resolving market is redeemed rather than sold.
 */
export declare function assertPolymarketMarketTradable(state: PolymarketMarketState, now?: number): void;
/**
 * Read the current market state for a condition. Any transport or shape failure
 * raises — an unreadable market is not a tradable one.
 */
export declare function fetchPolymarketMarketState(conditionId: string, fetchImpl?: typeof fetch): Promise<PolymarketMarketState>;
/** Fetch and gate in one step, for use immediately before a submission. */
export declare function assertPolymarketMarketOpenForSubmission(params: {
    conditionId: string;
    fetchImpl?: typeof fetch;
    now?: number;
}): Promise<PolymarketMarketState>;
//# sourceMappingURL=polymarket-market-state.d.ts.map