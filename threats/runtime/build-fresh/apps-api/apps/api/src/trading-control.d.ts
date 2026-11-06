import { type ChainModeResolution } from '@swat/db';
import type { Chain, ExecutionMode } from '@swat/shared';
import { z } from 'zod';
export declare const tradingChains: readonly ["solana", "polygon", "robinhood-chain", "base", "ethereum", "bsc"];
export declare const executionModeUpdateSchema: z.ZodObject<{
    chain: z.ZodEnum<["solana", "polygon", "robinhood-chain", "base", "ethereum", "bsc"]>;
    mode: z.ZodEnum<["off", "paper", "live", "live+shadow"]>;
}, "strict", z.ZodTypeAny, {
    chain: "solana" | "polygon" | "robinhood-chain" | "base" | "ethereum" | "bsc";
    mode: "off" | "paper" | "live" | "live+shadow";
}, {
    chain: "solana" | "polygon" | "robinhood-chain" | "base" | "ethereum" | "bsc";
    mode: "off" | "paper" | "live" | "live+shadow";
}>;
export interface TradingModeUpdate {
    chain: Chain;
    mode: ExecutionMode;
}
export interface TradingControlStatus {
    modes: Record<Chain, ChainModeResolution>;
    killSwitchActive: boolean;
}
export declare function getTradingControlStatus(): Promise<TradingControlStatus>;
export declare function updateTradingMode(update: TradingModeUpdate): Promise<TradingControlStatus>;
export declare function emergencyOff(): Promise<TradingControlStatus>;
//# sourceMappingURL=trading-control.d.ts.map