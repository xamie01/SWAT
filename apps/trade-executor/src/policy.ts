export type TradingMode = 'paper' | 'live';

function parseNumericValue(value: unknown, label: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.length > 0 && value.trim() === value) {
    return Number(value);
  }
  throw new Error(`${label} must be numeric`);
}

export function parseTradingMode(value: string | undefined): TradingMode {
  if (value === undefined) return 'paper';
  if (value === 'paper' || value === 'live') return value;
  throw new Error(`TRADING_MODE must be exactly "paper" or "live"; received ${JSON.stringify(value)}`);
}

export function parseScore(value: unknown, label: string): number {
  const score = parseNumericValue(value, label);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`${label} must be a finite number between 0 and 100`);
  }
  return score;
}

export function parsePositiveNumber(value: string | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : parseNumericValue(value, label);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return parsed;
}

export function parseNonNegativeNumber(value: string | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : parseNumericValue(value, label);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return parsed;
}

export function floorToPrecision(value: number, precision: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Value must be a finite, non-negative number');
  }
  if (!Number.isInteger(precision) || precision < 0 || precision > 12) {
    throw new Error('Precision must be an integer between 0 and 12');
  }

  const factor = 10 ** precision;
  return Math.floor(value * factor) / factor;
}

export function capPositionToAvailableBalance(opts: {
  requested: number;
  available: number;
  maximum: number;
  precision: number;
}): number {
  const values = [opts.requested, opts.available, opts.maximum];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Balance cap inputs must be finite, non-negative numbers');
  }

  return floorToPrecision(Math.min(opts.requested, opts.available, opts.maximum), opts.precision);
}

export function calculateBalanceAwareSize(opts: {
  balance: number;
  base: number;
  maximum: number;
  riskPct: number;
  tierMultiplier: number;
  scoreMultiplier: number;
  precision: number;
  dynamic: boolean;
}): number {
  const values = [
    opts.balance,
    opts.base,
    opts.maximum,
    opts.riskPct,
    opts.tierMultiplier,
    opts.scoreMultiplier
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Balance-aware sizing inputs must be finite, non-negative numbers');
  }
  if (opts.riskPct > 100) {
    throw new Error('Risk percentage cannot exceed 100');
  }

  const requested = opts.dynamic
    ? opts.balance * (opts.riskPct / 100) * opts.tierMultiplier * opts.scoreMultiplier
    : opts.base * opts.tierMultiplier * opts.scoreMultiplier;

  return capPositionToAvailableBalance({
    requested,
    available: opts.balance,
    maximum: opts.maximum,
    precision: opts.precision
  });
}

export function calculateRiskBasedSize(opts: {
  balance: number;
  riskPct: number;
  tierMultiplier: number;
  scoreMultiplier: number;
  maximum: number;
  precision: number;
}): number {
  const values = [
    opts.balance,
    opts.riskPct,
    opts.tierMultiplier,
    opts.scoreMultiplier,
    opts.maximum
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Risk sizing inputs must be finite, non-negative numbers');
  }
  if (opts.riskPct > 100) {
    throw new Error('Risk percentage cannot exceed 100');
  }

  const computed =
    opts.balance *
    (opts.riskPct / 100) *
    opts.tierMultiplier *
    opts.scoreMultiplier;
  return capPositionToAvailableBalance({
    requested: computed,
    available: opts.balance,
    maximum: opts.maximum,
    precision: opts.precision
  });
}
