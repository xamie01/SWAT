import { type IngestionBatchResult } from './ingestion-health.js';
type FetchImplementation = typeof fetch;
export type PolymarketBackfillDependencies = {
    fetchImpl?: FetchImplementation;
    publish?: (channel: string, message: string) => Promise<unknown>;
};
/**
 * Read a wallet's confirmed-trade history out of Polymarket Data API v2.
 *
 * Uses opaque cursor pagination via `next_cursor` across `https://data-api.polymarket.com/v2/trades`.
 * Handles both the v2 envelope `{ data: [...], pagination: { next_cursor, has_more } }`
 * and bare arrays for backwards compatibility with legacy mocks.
 */
export declare function fetchConfirmedPolymarketTradePages(input: {
    user: string;
    fetchImpl: FetchImplementation;
    pageLimit?: number;
    maxOffset?: number;
}): Promise<unknown[]>;
export declare function backfillPolymarketWallet(address: string, dependencies?: PolymarketBackfillDependencies): Promise<IngestionBatchResult>;
export declare function pollPolymarketResolutions(): Promise<void>;
export {};
//# sourceMappingURL=polymarket.d.ts.map