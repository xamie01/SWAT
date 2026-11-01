import { query } from './client.js';

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

export async function upsertPerpsInstrument(instrument: {
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
}): Promise<PerpsInstrumentRecord> {
  const rows = await query<PerpsInstrumentRecord>(
    `INSERT INTO polymarket_perps_instruments (
       instrument_id, symbol, category, base_asset, quote_asset,
       price_decimals, quantity_decimals, max_leverage, min_notional,
       max_market_notional, is_active, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (instrument_id) DO UPDATE SET
       symbol = EXCLUDED.symbol,
       category = EXCLUDED.category,
       base_asset = EXCLUDED.base_asset,
       quote_asset = EXCLUDED.quote_asset,
       price_decimals = EXCLUDED.price_decimals,
       quantity_decimals = EXCLUDED.quantity_decimals,
       max_leverage = EXCLUDED.max_leverage,
       min_notional = EXCLUDED.min_notional,
       max_market_notional = EXCLUDED.max_market_notional,
       is_active = EXCLUDED.is_active,
       updated_at = NOW()
     RETURNING *`,
    [
      instrument.instrumentId,
      instrument.symbol,
      instrument.category,
      instrument.baseAsset,
      instrument.quoteAsset ?? 'USD',
      instrument.priceDecimals,
      instrument.quantityDecimals,
      instrument.maxLeverage,
      instrument.minNotional ?? '1',
      instrument.maxMarketNotional ?? '100000',
      instrument.isActive ?? true
    ]
  );
  return rows[0]!;
}

export async function getPerpsInstruments(activeOnly = true): Promise<PerpsInstrumentRecord[]> {
  const sql = activeOnly
    ? `SELECT * FROM polymarket_perps_instruments WHERE is_active = true ORDER BY instrument_id ASC`
    : `SELECT * FROM polymarket_perps_instruments ORDER BY instrument_id ASC`;
  return query<PerpsInstrumentRecord>(sql);
}

export async function getPerpsInstrumentBySymbol(symbol: string): Promise<PerpsInstrumentRecord | null> {
  const rows = await query<PerpsInstrumentRecord>(
    `SELECT * FROM polymarket_perps_instruments WHERE UPPER(symbol) = UPPER($1) LIMIT 1`,
    [symbol]
  );
  return rows[0] ?? null;
}

export async function upsertPerpsAccount(account: {
  userId: string;
  totalAccountValue: string;
  availableOrderMargin: string;
  totalInitialMargin: string;
  totalMaintenanceMargin: string;
  withdrawable: string;
  inLiquidation?: boolean;
}): Promise<PerpsAccountRecord> {
  const rows = await query<PerpsAccountRecord>(
    `INSERT INTO polymarket_perps_accounts (
       user_id, total_account_value, available_order_margin,
       total_initial_margin, total_maintenance_margin,
       withdrawable, in_liquidation, synced_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       total_account_value = EXCLUDED.total_account_value,
       available_order_margin = EXCLUDED.available_order_margin,
       total_initial_margin = EXCLUDED.total_initial_margin,
       total_maintenance_margin = EXCLUDED.total_maintenance_margin,
       withdrawable = EXCLUDED.withdrawable,
       in_liquidation = EXCLUDED.in_liquidation,
       synced_at = NOW()
     RETURNING *`,
    [
      account.userId,
      account.totalAccountValue,
      account.availableOrderMargin,
      account.totalInitialMargin,
      account.totalMaintenanceMargin,
      account.withdrawable,
      account.inLiquidation ?? false
    ]
  );
  return rows[0]!;
}

export async function getPerpsAccount(userId: string): Promise<PerpsAccountRecord | null> {
  const rows = await query<PerpsAccountRecord>(
    `SELECT * FROM polymarket_perps_accounts WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function upsertPerpsPosition(position: {
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
}): Promise<PerpsPositionRecord> {
  const rows = await query<PerpsPositionRecord>(
    `INSERT INTO polymarket_perps_positions (
       user_id, instrument_id, symbol, side, size,
       entry_price, leverage, initial_margin, maintenance_margin,
       liquidation_price, unrealized_pnl, take_profit_price,
       stop_loss_price, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
     RETURNING *`,
    [
      position.userId,
      position.instrumentId,
      position.symbol,
      position.side,
      position.size,
      position.entryPrice,
      position.leverage,
      position.initialMargin,
      position.maintenanceMargin,
      position.liquidationPrice ?? null,
      position.unrealizedPnl,
      position.takeProfitPrice ?? null,
      position.stopLossPrice ?? null,
      position.status ?? 'open'
    ]
  );
  return rows[0]!;
}

export async function getUserPerpsPositions(
  userId: string,
  status = 'open'
): Promise<PerpsPositionRecord[]> {
  return query<PerpsPositionRecord>(
    `SELECT * FROM polymarket_perps_positions 
      WHERE user_id = $1 AND status = $2 
      ORDER BY updated_at DESC`,
    [userId, status]
  );
}

export async function recordPerpsOrder(order: {
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
}): Promise<PerpsOrderRecord> {
  const rows = await query<PerpsOrderRecord>(
    `INSERT INTO polymarket_perps_orders (
       user_id, client_order_id, venue_order_id, instrument_id,
       symbol, side, order_type, price, quantity, filled_quantity,
       status, builder_address, builder_fee_rate, raw_response, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
     RETURNING *`,
    [
      order.userId,
      order.clientOrderId ?? null,
      order.venueOrderId ?? null,
      order.instrumentId,
      order.symbol,
      order.side,
      order.orderType ?? 'IOC',
      order.price,
      order.quantity,
      order.filledQuantity ?? '0',
      order.status ?? 'pending',
      order.builderAddress ?? null,
      order.builderFeeRate ?? '0.001',
      order.rawResponse ? JSON.stringify(order.rawResponse) : null
    ]
  );
  return rows[0]!;
}

export async function closePerpsPosition(positionId: string, userId: string): Promise<boolean> {
  const result = await query(
    `UPDATE polymarket_perps_positions 
        SET status = 'closed', updated_at = NOW() 
      WHERE id = $1 AND user_id = $2 AND status = 'open'`,
    [positionId, userId]
  );
  return (result.length ?? 0) > 0;
}
