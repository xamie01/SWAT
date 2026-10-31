export function parsePolymarketTimestamp(value: string | number): Date {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Invalid Polymarket timestamp: ${String(value)}`);
  }

  const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Polymarket timestamp: ${String(value)}`);
  }
  return date;
}

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

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid Polymarket ${field}`);
  }
  return value.trim();
}

function positiveNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid Polymarket ${field}: ${String(value)}`);
  }
  return parsed;
}

function normalizeConditionId(value: unknown): string {
  const conditionId = nonEmptyString(value, 'condition ID').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(conditionId)) {
    throw new Error(`Invalid Polymarket condition ID: ${conditionId}`);
  }
  return conditionId;
}

function normalizeProxyWallet(value: unknown): string {
  const proxyWallet = nonEmptyString(value, 'proxy wallet').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(proxyWallet)) {
    throw new Error(`Invalid Polymarket proxy wallet: ${proxyWallet}`);
  }
  return proxyWallet;
}

function normalizeTransactionHash(value: unknown): string {
  const hash = nonEmptyString(value, 'transaction hash').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`Invalid Polymarket transaction hash: ${hash}`);
  }
  return hash;
}

function normalizeTokenId(value: unknown): string {
  const tokenId = nonEmptyString(value, 'asset token ID');
  if (!/^\d+$/.test(tokenId)) {
    throw new Error(`Invalid Polymarket asset token ID: ${tokenId}`);
  }
  return tokenId;
}

function stringArray(value: unknown, field: string): string[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Invalid Polymarket ${field}`);
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Invalid Polymarket ${field}`);
  }
  return parsed.map((item) => nonEmptyString(item, field));
}

export function parseConfirmedPolymarketTrade(value: unknown): ConfirmedPolymarketTrade {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid Polymarket confirmed trade');
  }
  const raw = value as Record<string, unknown>;
  const side = nonEmptyString(raw.side, 'trade side').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') {
    throw new Error(`Invalid Polymarket trade side: ${side}`);
  }
  const price = positiveNumber(raw.price, 'trade price');
  if (price > 1) throw new Error(`Invalid Polymarket trade price: ${price}`);

  return {
    proxyWallet: normalizeProxyWallet(raw.proxyWallet),
    timestamp: parsePolymarketTimestamp(raw.timestamp as string | number),
    conditionId: normalizeConditionId(raw.conditionId),
    asset: normalizeTokenId(raw.asset),
    size: positiveNumber(raw.size, 'trade size'),
    price,
    side,
    transactionHash: normalizeTransactionHash(raw.transactionHash),
    outcome: nonEmptyString(raw.outcome, 'trade outcome'),
    title: nonEmptyString(raw.title, 'market title')
  };
}

export function parsePolymarketMarketContext(
  value: unknown,
  expectedConditionId: string,
  fallbackTickSize?: unknown
): PolymarketMarketContext {
  if (!value || typeof value !== 'object') {
    throw new Error(`Missing Polymarket market context for ${expectedConditionId}`);
  }
  const raw = value as Record<string, unknown>;
  const conditionId = normalizeConditionId(
    raw.conditionId ?? raw.condition_id ?? expectedConditionId
  );
  if (conditionId !== normalizeConditionId(expectedConditionId)) {
    throw new Error(`Polymarket condition mismatch: expected ${expectedConditionId}, received ${conditionId}`);
  }
  const outcomes = stringArray(raw.outcomes, 'outcomes');
  const tokenIds = stringArray(raw.clobTokenIds, 'CLOB token IDs').map(normalizeTokenId);
  if (outcomes.length !== tokenIds.length) {
    throw new Error(`Polymarket outcome/token count mismatch for ${conditionId}`);
  }
  if (typeof raw.negRisk !== 'boolean') {
    throw new Error(`Missing Polymarket neg-risk state for ${conditionId}`);
  }
  const endDateValue = nonEmptyString(raw.endDate ?? raw.end_date, 'end date');
  const endDate = new Date(endDateValue);
  if (Number.isNaN(endDate.getTime())) {
    throw new Error(`Invalid Polymarket end date: ${endDateValue}`);
  }
  const tickSize = positiveNumber(
    raw.orderPriceMinTickSize ?? raw.minimumTickSize ?? fallbackTickSize,
    'tick size'
  );
  if (tickSize > 1) throw new Error(`Invalid Polymarket tick size: ${tickSize}`);
  const active = raw.active === true;
  const closed = raw.closed === true;
  const acceptingOrders = typeof raw.acceptingOrders === 'boolean'
    ? raw.acceptingOrders
    : active && !closed;
  const resolutionStatus = typeof raw.umaResolutionStatus === 'string' && raw.umaResolutionStatus.trim()
    ? raw.umaResolutionStatus.trim()
    : closed ? 'unknown' : 'unresolved';

  return {
    conditionId,
    question: nonEmptyString(raw.question, 'market question'),
    slug: typeof raw.slug === 'string' && raw.slug.trim() ? raw.slug.trim() : null,
    endDate,
    resolutionSource: typeof raw.resolutionSource === 'string' && raw.resolutionSource.trim()
      ? raw.resolutionSource.trim()
      : null,
    active,
    closed,
    acceptingOrders,
    negRisk: raw.negRisk as boolean,
    tickSize,
    resolutionStatus,
    status: closed ? 'closed' : active ? 'active' : 'inactive',
    outcomes: outcomes.map((outcome, outcomeIndex) => ({
      tokenId: tokenIds[outcomeIndex]!,
      outcome,
      outcomeIndex
    }))
  };
}

export function assertPolymarketCertificationBatch(input: {
  trades: ConfirmedPolymarketTrade[];
  mappedTokenIds: Iterable<string>;
  now?: Date;
  maxLagSeconds?: number;
}): { contextCoverage: number; lagSeconds: number } {
  if (input.trades.length === 0) {
    throw new Error('Polymarket certification fixture contains no confirmed trades');
  }
  const mapped = new Set(input.mappedTokenIds);
  const mappedCount = input.trades.filter((trade) => mapped.has(trade.asset)).length;
  const contextCoverage = mappedCount / input.trades.length;
  if (contextCoverage !== 1) {
    throw new Error(`Polymarket market context coverage is ${(contextCoverage * 100).toFixed(2)}%, expected 100%`);
  }
  const now = input.now ?? new Date();
  const latestTimestamp = Math.max(...input.trades.map((trade) => trade.timestamp.getTime()));
  const lagSeconds = Math.max(0, Math.floor((now.getTime() - latestTimestamp) / 1000));
  const maxLagSeconds = input.maxLagSeconds ?? 5 * 60;
  if (lagSeconds > maxLagSeconds) {
    throw new Error(`Polymarket ingestion lag is ${lagSeconds}s, expected <= ${maxLagSeconds}s`);
  }
  return { contextCoverage, lagSeconds };
}
