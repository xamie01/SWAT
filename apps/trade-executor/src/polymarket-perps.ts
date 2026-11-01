import {
  OrderSide,
  PerpsTimeInForce,
  type SecureClient,
  type PublicClient
} from '@polymarket/client';
import {
  upsertPerpsInstrument,
  upsertPerpsAccount,
  upsertPerpsPosition,
  recordPerpsOrder,
  getPerpsInstrumentBySymbol,
  type PerpsInstrumentRecord
} from '@swat/db';

export const POLYMARKET_PERPS_API_HOST = 'https://api.perpetuals.polymarket.com/v1';
export const POLYMARKET_PERPS_MAX_BUILDER_FEE_RATE = '0.001'; // 10 bps max per docs

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
export async function openAttributedPerpsSession(
  client: SecureClient,
  builderAddress?: string
): Promise<PerpsSession> {
  const session = await client.openPerpsSession({
    label: builderAddress ? `swat-builder-${builderAddress.slice(0, 10)}` : 'swat-perps-session'
  });
  return session;
}

/**
 * Sync instruments catalogue from Polymarket to PostgreSQL.
 */
export async function syncPerpsInstrumentsCatalogue(
  client: PublicClient | SecureClient
): Promise<PerpsInstrumentRecord[]> {
  const instruments = await client.fetchPerpsInstruments();
  const records: PerpsInstrumentRecord[] = [];

  for (const inst of instruments) {
    const record = await upsertPerpsInstrument({
      instrumentId: inst.id,
      symbol: inst.symbol,
      category: inst.category ?? 'crypto',
      baseAsset: inst.baseAsset,
      quoteAsset: inst.quoteAsset ?? 'USD',
      priceDecimals: inst.priceDecimals,
      quantityDecimals: inst.quantityDecimals,
      maxLeverage: inst.maxLeverage ?? 10,
      minNotional: inst.minNotional ?? '1',
      maxMarketNotional: inst.maxMarketNotional ?? '100000',
      isActive: true
    });
    records.push(record);
  }

  return records;
}

/**
 * Evaluate portfolio health, margin utilization, and liquidation risk.
 */
export function evaluatePerpsMarginHealth(portfolio: {
  margin: {
    totalAccountValue: string;
    totalInitialMargin: string;
    totalMaintenanceMargin: string;
    totalPositionValue: string;
  };
  inLiquidation: boolean;
  withdrawable?: string;
}): PerpsRiskEvaluation {
  const accountValue = Number(portfolio.margin.totalAccountValue) || 0;
  const maintenanceMargin = Number(portfolio.margin.totalMaintenanceMargin) || 0;
  const availableMargin = Number(portfolio.withdrawable) || Math.max(0, accountValue - Number(portfolio.margin.totalInitialMargin));

  if (portfolio.inLiquidation) {
    return {
      safe: false,
      marginRatio: 1,
      inLiquidation: true,
      totalAccountValue: accountValue,
      availableMargin,
      reason: 'Account is actively in liquidation'
    };
  }

  if (accountValue <= 0) {
    return {
      safe: false,
      marginRatio: 1,
      inLiquidation: false,
      totalAccountValue: accountValue,
      availableMargin,
      reason: 'Total account value is depleted or zero'
    };
  }

  const marginRatio = maintenanceMargin / accountValue;

  // Emergency safety trigger: > 85% maintenance margin used
  if (marginRatio > 0.85) {
    return {
      safe: false,
      marginRatio,
      inLiquidation: false,
      totalAccountValue: accountValue,
      availableMargin,
      reason: `Critical margin utilization: ${(marginRatio * 100).toFixed(1)}% of equity consumed by maintenance margin`
    };
  }

  return {
    safe: true,
    marginRatio,
    inLiquidation: false,
    totalAccountValue: accountValue,
    availableMargin
  };
}

/**
 * Execute a leveraged Perps copy trade order.
 */
export async function executePerpsOrder(params: {
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
}) {
  // 1. Fetch live portfolio and check margin safety
  const portfolio = await params.session.fetchPortfolio();
  const risk = evaluatePerpsMarginHealth(portfolio);
  if (!risk.safe) {
    throw new Error(`Perps Pre-Trade Risk Refusal: ${risk.reason}`);
  }

  // 2. Check available order margin
  const notionalUsd = Number(params.price) * Number(params.quantity);
  const leverage = params.leverage ?? 1;
  const requiredInitialMargin = notionalUsd / leverage;

  if (requiredInitialMargin > risk.availableMargin) {
    throw new Error(
      `Perps Margin Insufficient: order requires $${requiredInitialMargin.toFixed(2)} initial margin, but available margin is $${risk.availableMargin.toFixed(2)}`
    );
  }

  // 3. Build and place order on Polymarket Perps
  const orderPayload: any = {
    instrumentId: params.instrumentId,
    side: params.side,
    quantity: params.quantity,
    price: params.price,
    timeInForce: params.timeInForce ?? PerpsTimeInForce.IOC
  };

  if (params.takeProfitPrice) {
    orderPayload.takeProfit = { triggerPrice: params.takeProfitPrice };
  }
  if (params.stopLossPrice) {
    orderPayload.stopLoss = { triggerPrice: params.stopLossPrice };
  }

  const result = await params.session.placeOrder(orderPayload);
  const order = result.order;

  // 4. Record order execution to database
  const recordedOrder = await recordPerpsOrder({
    userId: params.userId,
    clientOrderId: params.clientOrderId ?? order.clientOrderId,
    venueOrderId: String(order.id),
    instrumentId: params.instrumentId,
    symbol: params.symbol,
    side: params.side === OrderSide.BUY ? 'BUY' : 'SELL',
    orderType: params.timeInForce === PerpsTimeInForce.GTC ? 'GTC' : 'IOC',
    price: order.price,
    quantity: order.quantity,
    filledQuantity: order.filledQuantity,
    status: order.status,
    builderAddress: params.builderAddress,
    builderFeeRate: POLYMARKET_PERPS_MAX_BUILDER_FEE_RATE,
    rawResponse: order as unknown as Record<string, unknown>
  });

  // 5. If filled, update position in database
  if (order.status === 'filled' || Number(order.filledQuantity) > 0) {
    await upsertPerpsPosition({
      userId: params.userId,
      instrumentId: params.instrumentId,
      symbol: params.symbol,
      side: params.side === OrderSide.BUY ? 'LONG' : 'SHORT',
      size: order.filledQuantity,
      entryPrice: order.price,
      leverage,
      initialMargin: requiredInitialMargin.toFixed(6),
      maintenanceMargin: (requiredInitialMargin * 0.5).toFixed(6),
      liquidationPrice: calculateApproxLiquidationPrice(
        params.side,
        Number(order.price),
        leverage
      ),
      unrealizedPnl: '0',
      takeProfitPrice: params.takeProfitPrice,
      stopLossPrice: params.stopLossPrice,
      status: 'open'
    });
  }

  // 6. Sync updated account margin state
  await upsertPerpsAccount({
    userId: params.userId,
    totalAccountValue: portfolio.margin.totalAccountValue,
    availableOrderMargin: String(risk.availableMargin),
    totalInitialMargin: portfolio.margin.totalInitialMargin,
    totalMaintenanceMargin: portfolio.margin.totalMaintenanceMargin,
    withdrawable: portfolio.withdrawable ?? '0',
    inLiquidation: portfolio.inLiquidation ?? false
  });

  return {
    orderId: order.id,
    status: order.status,
    filledQuantity: order.filledQuantity,
    price: order.price,
    recordedOrderId: recordedOrder.id
  };
}

/**
 * Approximate liquidation price calculation for leveraged perps.
 */
export function calculateApproxLiquidationPrice(
  side: OrderSide,
  entryPrice: number,
  leverage: number,
  maintenanceMarginRatio = 0.05
): string {
  if (leverage <= 1) return '0';
  // Long liquidation = entryPrice * (1 - 1/leverage + maintenanceMarginRatio)
  // Short liquidation = entryPrice * (1 + 1/leverage - maintenanceMarginRatio)
  if (side === OrderSide.BUY) {
    const liq = entryPrice * (1 - (1 / leverage) + maintenanceMarginRatio);
    return Math.max(0, liq).toFixed(2);
  } else {
    const liq = entryPrice * (1 + (1 / leverage) - maintenanceMarginRatio);
    return Math.max(0, liq).toFixed(2);
  }
}
