import { OrderSide, PerpsTimeInForce, type SecureClient, type PublicClient } from '@polymarket/client';
import { type PerpsInstrumentRecord } from '@swat/db';
export declare const POLYMARKET_PERPS_API_HOST = "https://api.perpetuals.polymarket.com/v1";
export declare const POLYMARKET_PERPS_MAX_BUILDER_FEE_RATE = "0.001";
export type PerpsSession = Awaited<ReturnType<SecureClient['openPerpsSession']>>;
export interface PerpsExecutionPlan {
    instrumentId: number;
    symbol: string;
    side: OrderSide;
    quantity: string;
    price: string;
    leverage: number;
    timeInForce: PerpsTimeInForce;
    takeProfitPrice?: string;
    stopLossPrice?: string;
}
export interface PerpsRiskEvaluation {
    safe: boolean;
    marginRatio: number;
    inLiquidation: boolean;
    totalAccountValue: number;
    availableMargin: number;
    reason?: string;
}
/**
 * Open an authenticated Perps session with optional credentials/expiration.
 */
export declare function openAttributedPerpsSession(client: SecureClient, builderAddress?: string): Promise<PerpsSession>;
/**
 * Sync instruments catalogue from Polymarket to PostgreSQL.
 */
export declare function syncPerpsInstrumentsCatalogue(client: PublicClient | SecureClient): Promise<PerpsInstrumentRecord[]>;
/**
 * Evaluate portfolio health, margin utilization, and liquidation risk.
 */
export declare function evaluatePerpsMarginHealth(portfolio: {
    margin: {
        totalAccountValue: string;
        totalInitialMargin: string;
        totalMaintenanceMargin: string;
        totalPositionValue: string;
    };
    inLiquidation: boolean;
    withdrawable?: string;
}): PerpsRiskEvaluation;
/**
 * Execute a leveraged Perps copy trade order.
 */
export declare function executePerpsOrder(params: {
    userId: string;
    session: PerpsSession;
    instrumentId: number;
    symbol: string;
    side: OrderSide;
    quantity: string;
    price: string;
    leverage?: number;
    timeInForce?: PerpsTimeInForce;
    takeProfitPrice?: string;
    stopLossPrice?: string;
    builderAddress?: string;
    clientOrderId?: string;
}): Promise<{
    orderId: import("@polymarket/client").PerpsOrderId;
    status: import("@polymarket/client").PerpsOrderStatus;
    filledQuantity: import("@polymarket/bindings").DecimalString;
    price: import("@polymarket/bindings").DecimalString;
    recordedOrderId: string;
}>;
/**
 * Approximate liquidation price calculation for leveraged perps.
 */
export declare function calculateApproxLiquidationPrice(side: OrderSide, entryPrice: number, leverage: number, maintenanceMarginRatio?: number): string;
//# sourceMappingURL=polymarket-perps.d.ts.map