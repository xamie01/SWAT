import { type SourceTradeEventInput } from '@swat/db';
import { type CanonicalSolanaSwapEvent } from './parse.js';
import type { ConfirmedPolymarketTrade } from './polymarket-helpers.js';
export type SolanaIngestionSource = 'solana-backfill' | 'solana-webhook';
export declare class SourceTradePersistenceError extends Error {
    readonly chain: SourceTradeEventInput['chain'];
    constructor(chain: SourceTradeEventInput['chain'], options: {
        cause: unknown;
    });
}
export declare function buildSolanaSourceTradeInput(input: {
    event: CanonicalSolanaSwapEvent;
    source: SolanaIngestionSource;
}): SourceTradeEventInput;
export declare function persistSolanaSourceTrade(input: {
    event: CanonicalSolanaSwapEvent;
    source: SolanaIngestionSource;
}): Promise<{
    event: import("@swat/db").CanonicalSourceTrade;
    position: import("@swat/db").PositionRecord;
    inserted: boolean;
}>;
export declare function buildPolymarketSourceTradeInput(input: {
    trade: ConfirmedPolymarketTrade;
    quantity: string;
    amountUsd: number;
}): SourceTradeEventInput;
export declare function persistPolymarketSourceTrade(input: {
    trade: ConfirmedPolymarketTrade;
    quantity: string;
    amountUsd: number;
}): Promise<{
    event: import("@swat/db").CanonicalSourceTrade;
    position: import("@swat/db").PositionRecord;
    inserted: boolean;
}>;
export declare function buildRobinhoodSourceTradeInput(input: {
    transactionHash: string;
    walletAddress: string;
    tokenMint: string;
    side: 'buy' | 'sell';
    quantity: string;
    eventAt: Date;
    blockNumber: bigint;
}): SourceTradeEventInput;
export declare function persistRobinhoodSourceTrade(input: {
    transactionHash: string;
    walletAddress: string;
    tokenMint: string;
    side: 'buy' | 'sell';
    quantity: string;
    eventAt: Date;
    blockNumber: bigint;
}): Promise<{
    event: import("@swat/db").CanonicalSourceTrade;
    position: import("@swat/db").PositionRecord;
    inserted: boolean;
}>;
//# sourceMappingURL=source-trade-lifecycle.d.ts.map