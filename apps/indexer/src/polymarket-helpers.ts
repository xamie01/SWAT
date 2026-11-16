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

// Historical public name; parsed Data API rows are observations, not finality
// certificates, and carry no locally substantiated independent fill/log ID.
export type ConfirmedPolymarketTrade = {
  proxyWallet: string;
  timestamp: Date;
  conditionId: string;
  asset: string;
  size: string;
  price: string;
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

export function normalizePolymarketDecimal(value: unknown, field: string, maxScale: 36 | 42 = 36): string {
  const invalid = () => new Error(`Invalid Polymarket ${field}`);
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) throw invalid();
  const text = String(value);
  if (text.length > 128) throw invalid();
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (!match) throw invalid();
  const integer = match[1]!;
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  if (Math.abs(exponent) > 36) throw invalid();
  const digits = integer + fraction;
  const point = integer.length + exponent;
  const expanded = point <= 0
    ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length
      ? digits + '0'.repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole = '0', decimal = ''] = expanded.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedDecimal = decimal.replace(/0+$/, '');
  if (normalizedWhole.length > 78 || normalizedDecimal.length > maxScale) throw invalid();
  const normalized = normalizedDecimal ? `${normalizedWhole}.${normalizedDecimal}` : normalizedWhole;
  if (normalized === '0') throw invalid();
  return normalized;
}

export function normalizePolymarketPrice(value: unknown): string {
  const price = normalizePolymarketDecimal(value, 'trade price');
  if (price !== '1' && !price.startsWith('0.')) throw new Error('Invalid Polymarket trade price');
  return price;
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

function normalizeIdentityAliases(
  raw: Record<string, unknown>,
  keys: readonly string[],
  normalize: (value: unknown) => string,
  field: string
): string {
  const values = keys.filter((key) => raw[key] !== undefined).map((key) => normalize(raw[key]));
  if (values.length === 0) return normalize(undefined);
  if (values.some((value) => value !== values[0])) {
    throw new Error(`Conflicting Polymarket ${field} aliases`);
  }
  return values[0]!;
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
  const price = normalizePolymarketPrice(raw.price);

  return {
    proxyWallet: normalizeIdentityAliases(raw, ['proxy_wallet', 'proxyWallet'], normalizeProxyWallet, 'proxy wallet'),
    timestamp: parsePolymarketTimestamp((raw.timestamp ?? raw.created_at) as string | number),
    conditionId: normalizeConditionId(raw.condition_id ?? raw.conditionId),
    asset: normalizeTokenId(raw.token_id ?? raw.asset_id ?? raw.asset),
    size: normalizePolymarketDecimal(raw.size, 'trade size'),
    price,
    side,
    transactionHash: normalizeIdentityAliases(raw, ['transaction_hash', 'transactionHash'], normalizeTransactionHash, 'transaction hash'),
    outcome: nonEmptyString(raw.outcome, 'trade outcome'),
    title: nonEmptyString(raw.title, 'market title')
  };
}

function booleanState(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Missing or invalid Polymarket ${field} state`);
  return value;
}

export class PolymarketMetadataValidationError extends Error {}

function metadataAliases<T extends string | boolean>(
  raw: Record<string, unknown>, keys: readonly string[], normalize: (value: unknown) => T, field: string
): T | undefined {
  const values = keys.filter(key => raw[key] !== undefined).map(key => normalize(raw[key]));
  if (values.some(value => value !== values[0])) throw new Error(`Conflicting Polymarket ${field} aliases`);
  return values[0];
}

// Validate every supplied supported alias before a caller projects any of them.
// Missing evidence stays missing; null, malformed and contradictory evidence cannot fall back.
export function validatePolymarketMetadataAliases(raw: Record<string, unknown>): Record<string, unknown> {
  try {
    const conditionId = metadataAliases(raw, ['conditionId', 'condition_id'], normalizeConditionId, 'condition ID');
    const negRisk = metadataAliases(raw, ['negRisk', 'neg_risk'], value => booleanState(value, 'neg-risk'), 'neg-risk');
    const active = metadataAliases(raw, ['active'], value => booleanState(value, 'active'), 'active');
    const closed = metadataAliases(raw, ['closed'], value => booleanState(value, 'closed'), 'closed');
    const acceptingOrders = metadataAliases(raw, ['acceptingOrders', 'accepting_orders'],
      value => booleanState(value, 'accepting-orders'), 'accepting-orders');
    const endDate = metadataAliases(raw, ['endDate', 'end_date_iso', 'end_date'], value => {
      const date = new Date(nonEmptyString(value, 'end date'));
      if (Number.isNaN(date.getTime())) throw new Error('Invalid Polymarket end date');
      return date.toISOString();
    }, 'end date');
    const tick = metadataAliases(raw, ['orderPriceMinTickSize', 'minimumTickSize', 'minimum_tick_size'], value => {
      const normalized = normalizePolymarketDecimal(value, 'tick size');
      if (normalized !== '1' && !normalized.startsWith('0.')) throw new Error('Invalid Polymarket tick size');
      return normalized;
    }, 'tick size');
    return {
      ...raw,
      ...(conditionId === undefined ? {} : { conditionId }),
      ...(negRisk === undefined ? {} : { negRisk }),
      ...(active === undefined ? {} : { active }),
      ...(closed === undefined ? {} : { closed }),
      ...(acceptingOrders === undefined ? {} : { acceptingOrders }),
      ...(endDate === undefined ? {} : { endDate }),
      ...(tick === undefined ? {} : { orderPriceMinTickSize: tick })
    };
  } catch (error) {
    throw new PolymarketMetadataValidationError(
      error instanceof Error ? error.message : 'Invalid Polymarket metadata aliases', { cause: error }
    );
  }
}

export function parsePolymarketMarketContext(
  value: unknown,
  expectedConditionId: string,
  fallbackTickSize?: unknown
): PolymarketMarketContext {
  if (!value || typeof value !== 'object') {
    throw new Error(`Missing Polymarket market context for ${expectedConditionId}`);
  }
  const raw = validatePolymarketMetadataAliases(value as Record<string, unknown>);
  const conditionId = normalizeConditionId(raw.conditionId ?? expectedConditionId);
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
  const tickSize = positiveNumber(normalizePolymarketDecimal(
    raw.orderPriceMinTickSize ?? fallbackTickSize, 'tick size'
  ), 'tick size');
  if (tickSize > 1) throw new Error(`Invalid Polymarket tick size: ${tickSize}`);
  const active = booleanState(raw.active, 'active');
  const closed = booleanState(raw.closed, 'closed');
  const acceptingOrders = booleanState(raw.acceptingOrders ?? raw.accepting_orders, 'accepting-orders');
  const resolutionStatus = typeof raw.umaResolutionStatus === 'string' && raw.umaResolutionStatus.trim()
    ? raw.umaResolutionStatus.trim()
    : 'unknown';

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
