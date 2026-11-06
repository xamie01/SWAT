export interface PerpsInstrumentRecord {
    instrument_id: number;
    symbol: string;
    category: string;
    base_asset: string;
    quote_asset: string;
    price_decimals: number;
    quantity_decimals: number;
    max_leverage: string;
    min_notional: string;
    max_market_notional: string;
    is_active: boolean;
    updated_at: Date;
}
export interface PerpsAccountRecord {
    user_id: string;
    total_account_value: string;
    available_order_margin: string;
    total_initial_margin: string;
    total_maintenance_margin: string;
    withdrawable: string;
    in_liquidation: boolean;
    synced_at: Date;
}
export interface PerpsPositionRecord {
    id: string;
    user_id: string;
    instrument_id: number;
    symbol: string;
    side: 'LONG' | 'SHORT';
    size: string;
    entry_price: string;
    leverage: string;
    initial_margin: string;
    maintenance_margin: string;
    liquidation_price: string | null;
    unrealized_pnl: string;
    take_profit_price: string | null;
    stop_loss_price: string | null;
    status: 'open' | 'closing' | 'closed' | 'liquidated';
    created_at: Date;
    updated_at: Date;
}
export interface PerpsOrderRecord {
    id: string;
    user_id: string;
    client_order_id: string | null;
    venue_order_id: string | null;
    instrument_id: number;
    symbol: string;
    side: 'BUY' | 'SELL';
    order_type: 'IOC' | 'GTC' | 'FOK';
    price: string;
    quantity: string;
    filled_quantity: string;
    status: string;
    builder_address: string | null;
    builder_fee_rate: string;
    raw_response: Record<string, unknown> | null;
    created_at: Date;
}
export declare function upsertPerpsInstrument(instrument: {
    instrumentId: number;
    symbol: string;
    category: string;
    baseAsset: string;
    quoteAsset?: string;
    priceDecimals: number;
    quantityDecimals: number;
    maxLeverage: number;
    minNotional?: string;
    maxMarketNotional?: string;
    isActive?: boolean;
}): Promise<PerpsInstrumentRecord>;
export declare function getPerpsInstruments(activeOnly?: boolean): Promise<PerpsInstrumentRecord[]>;
export declare function getPerpsInstrumentBySymbol(symbol: string): Promise<PerpsInstrumentRecord | null>;
export declare function upsertPerpsAccount(account: {
    userId: string;
    totalAccountValue: string;
    availableOrderMargin: string;
    totalInitialMargin: string;
    totalMaintenanceMargin: string;
    withdrawable: string;
    inLiquidation?: boolean;
}): Promise<PerpsAccountRecord>;
export declare function getPerpsAccount(userId: string): Promise<PerpsAccountRecord | null>;
export declare function upsertPerpsPosition(position: {
    userId: string;
    instrumentId: number;
    symbol: string;
    side: 'LONG' | 'SHORT';
    size: string;
    entryPrice: string;
    leverage: number;
    initialMargin: string;
    maintenanceMargin: string;
    liquidationPrice?: string | null;
    unrealizedPnl: string;
    takeProfitPrice?: string | null;
    stopLossPrice?: string | null;
    status?: 'open' | 'closing' | 'closed' | 'liquidated';
}): Promise<PerpsPositionRecord>;
export declare function getUserPerpsPositions(userId: string, status?: string): Promise<PerpsPositionRecord[]>;
export declare function recordPerpsOrder(order: {
    userId: string;
    clientOrderId?: string | null;
    venueOrderId?: string | null;
    instrumentId: number;
    symbol: string;
    side: 'BUY' | 'SELL';
    orderType?: 'IOC' | 'GTC' | 'FOK';
    price: string;
    quantity: string;
    filledQuantity?: string;
    status?: string;
    builderAddress?: string | null;
    builderFeeRate?: string;
    rawResponse?: Record<string, unknown> | null;
}): Promise<PerpsOrderRecord>;
export declare function closePerpsPosition(positionId: string, userId: string): Promise<boolean>;
//# sourceMappingURL=polymarket-perps.d.ts.map