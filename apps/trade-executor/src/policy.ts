import type { Chain, ExecutionMode } from '@swat/shared';
import { isChain, isValidSlippageBps } from '@swat/shared';

export type TradingMode = 'paper' | 'live';

/** Scope must be resolved from the source/tenant, not inferred from queued flags. */
export interface ExecutionPolicyScope {
  readonly account: string;
  readonly chain: Chain;
  readonly tokenMint: string;
  readonly masterWalletAddress: string;
}

export interface ExecutionPolicySnapshot {
  readonly scope: ExecutionPolicyScope;
  readonly policyId: string;
  readonly revision: string;
  readonly mode: ExecutionMode;
  readonly mirrors: 'buys-and-sells' | 'sells-only' | 'none';
  readonly autoExecute: boolean;
  readonly killed: boolean;
  /** Resolved at capture time: do not re-resolve a queued null against a new default. */
  readonly maxSlippageBps: number;
}

/** Fresh ledger read; never accept this object from the queue as ownership proof. */
export interface OwnedReducingExit {
  readonly scope: ExecutionPolicyScope;
  readonly lotId: string;
  /** Exact plain unsigned decimal text, at most 256 characters; never a Number. */
  readonly availableQuantity: string;
  readonly requestedQuantity: string;
  readonly acquisitionMode: 'paper' | 'live' | 'shadow';
  readonly maxSlippageBps: number;
}

export interface ExecutionPolicyInput {
  readonly scope: ExecutionPolicyScope;
  readonly direction: 'buy' | 'sell';
  readonly score: unknown;
  readonly minimumScore: number;
  readonly platformMode: ExecutionMode;
  readonly queued: ExecutionPolicySnapshot | null;
  readonly current: ExecutionPolicySnapshot | null;
  readonly ownedExit?: OwnedReducingExit | null;
}

export type ExecutionPolicyDecision =
  | { readonly allowed: false; readonly reason: string }
  | {
    readonly allowed: true;
    readonly executionMode: ExecutionMode;
    readonly maxSlippageBps: number;
    readonly reducing: boolean;
  };

function sameScope(left: ExecutionPolicyScope, right: ExecutionPolicyScope): boolean {
  return left.account === right.account && left.chain === right.chain
    && left.tokenMint === right.tokenMint && left.masterWalletAddress === right.masterWalletAddress;
}

function validScope(scope: ExecutionPolicyScope): boolean {
  return [scope.account, scope.tokenMint, scope.masterWalletAddress].every(
    value => typeof value === 'string' && value.length > 0 && value.trim() === value
  ) && isChain(scope.chain) && scope.tokenMint.startsWith(`${scope.chain}:`)
    && scope.tokenMint.length > scope.chain.length + 1
    && scope.masterWalletAddress.startsWith(`${scope.chain}:`)
    && scope.masterWalletAddress.length > scope.chain.length + 1;
}

function validMode(mode: unknown): mode is ExecutionMode {
  return mode === 'off' || mode === 'paper' || mode === 'live' || mode === 'live+shadow';
}

// Lot quantities are unqualified PostgreSQL NUMERIC (058_copy_position_lots.sql),
// not fixed-scale atomic units. Cap the entire spelling before regex/BigInt work:
// 256 characters permit ample ledger precision while bounding digits and scale,
// including redundant leading/trailing zeroes. This is a policy resource ceiling,
// not the database's precision limit or a token-specific decimal conversion.
const MAX_OWNED_EXIT_QUANTITY_LENGTH = 256;
const OWNED_EXIT_UNSIGNED_DECIMAL = /^(?:\d+\.?\d*|\d*\.\d+)$/;

function positiveOwnedExitQuantity(value: unknown): { digits: bigint; scale: number } | null {
  if (typeof value !== 'string' || value.length === 0
    || value.length > MAX_OWNED_EXIT_QUANTITY_LENGTH || value.trim() !== value
    || !OWNED_EXIT_UNSIGNED_DECIMAL.test(value)) return null;
  const [whole = '', fraction = ''] = value.split('.');
  const digits = BigInt(`${whole}${fraction}`);
  return digits > 0n ? { digits, scale: fraction.length } : null;
}

function validOwnedExitQuantities(available: unknown, requested: unknown): boolean {
  const availableParts = positiveOwnedExitQuantity(available);
  const requestedParts = positiveOwnedExitQuantity(requested);
  if (!availableParts || !requestedParts) return false;
  const scale = Math.max(availableParts.scale, requestedParts.scale);
  return requestedParts.digits * 10n ** BigInt(scale - requestedParts.scale)
    <= availableParts.digits * 10n ** BigInt(scale - availableParts.scale);
}

/** Policy intersection only. This is not a verifier, execution grant, or reservation. */
export function evaluateExecutionPolicy(input: ExecutionPolicyInput): ExecutionPolicyDecision {
  const deny = (reason: string): ExecutionPolicyDecision => ({ allowed: false, reason });
  const { queued, current, ownedExit } = input;
  if (!validScope(input.scope)) return deny('execution-scope-invalid');
  if (!queued || !current) return deny('execution-policy-unavailable');
  for (const snapshot of [queued, current]) {
    if (!sameScope(snapshot.scope, input.scope)) return deny('execution-policy-scope-mismatch');
    if (!snapshot.policyId || !snapshot.revision || !validMode(snapshot.mode)
      || !isValidSlippageBps(snapshot.maxSlippageBps)
      || typeof snapshot.autoExecute !== 'boolean' || typeof snapshot.killed !== 'boolean'
      || !['none', 'sells-only', 'buys-and-sells'].includes(snapshot.mirrors)) {
      return deny('execution-policy-invalid');
    }
    if (snapshot.killed || !snapshot.autoExecute || snapshot.mode === 'off') {
      return deny('execution-stopped');
    }
    if (snapshot.mirrors === 'none' || (input.direction === 'buy' && snapshot.mirrors !== 'buys-and-sells')) {
      return deny('subscription-not-permitted');
    }
  }
  if (queued.policyId !== current.policyId) return deny('execution-policy-identity-changed');
  if (!validMode(input.platformMode) || input.platformMode === 'off') return deny('chain-execution-stopped');
  if (input.direction !== 'buy' && input.direction !== 'sell') return deny('execution-direction-invalid');
  if (input.direction === 'buy' && queued.revision !== current.revision) return deny('stale-entry-policy');

  let mode: ExecutionMode = [queued.mode, current.mode, input.platformMode].includes('paper')
    ? 'paper'
    : [queued.mode, current.mode, input.platformMode].every(value => value === 'live+shadow')
      ? 'live+shadow' : 'live';
  let maxSlippageBps = Math.min(queued.maxSlippageBps, current.maxSlippageBps);
  if (input.direction === 'sell') {
    if (!ownedExit) return deny('owned-exit-unavailable');
    if (!sameScope(ownedExit.scope, input.scope)) return deny('owned-exit-scope-mismatch');
    if (!ownedExit.lotId || !validOwnedExitQuantities(ownedExit.availableQuantity, ownedExit.requestedQuantity)
      || !isValidSlippageBps(ownedExit.maxSlippageBps)) return deny('owned-exit-invalid');
    // A platform downgrade cannot turn an acquired live lot into a paper sale.
    // Conversely a paper lot can never become a live order, even on a live platform.
    if (ownedExit.acquisitionMode === 'live') {
      if (mode === 'paper') return deny('acquisition-mode-not-permitted');
      mode = 'live';
    } else if (ownedExit.acquisitionMode === 'paper') {
      mode = 'paper';
    } else {
      return deny('acquisition-mode-not-permitted');
    }
    maxSlippageBps = Math.min(maxSlippageBps, ownedExit.maxSlippageBps);
    return { allowed: true, executionMode: mode, maxSlippageBps, reducing: true };
  }
  if (ownedExit) return deny('entry-cannot-use-owned-exit');
  try {
    if (parseScore(input.score, 'entry score') < parseScore(input.minimumScore, 'minimum score')) {
      return deny('entry-score-below-minimum');
    }
  } catch {
    return deny('entry-score-invalid');
  }
  return { allowed: true, executionMode: mode, maxSlippageBps, reducing: false };
}


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

export interface BalanceAwareSizingInput {
  balance: number;
  base: number;
  maximum: number;
  riskPct: number;
  tierMultiplier: number;
  scoreMultiplier: number;
  precision: number;
  dynamic: boolean;
}

/**
 * The size this configuration *asks for*, before any cap is applied.
 *
 * Extracted from `calculateBalanceAwareSize` rather than reimplemented, and it is
 * the only statement of the formula in this repo. `per-user-sizing.ts` needs the
 * pre-clamp figure so it can report *which* bound reduced a user's size — an
 * operator asking "why did I get 0.05 and not 0.2" cannot be answered from a
 * single already-clamped number. Deriving the request a second time there would
 * have put two copies of the sizing formula in the tree, and the copy that drifted
 * would misattribute the clamp while still returning a plausible size.
 *
 * Validation lives here, so both this and `calculateBalanceAwareSize` refuse the
 * same inputs.
 */
export function requestedBalanceAwareSize(opts: BalanceAwareSizingInput): number {
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

  return opts.dynamic
    ? opts.balance * (opts.riskPct / 100) * opts.tierMultiplier * opts.scoreMultiplier
    : opts.base * opts.tierMultiplier * opts.scoreMultiplier;
}

export function calculateBalanceAwareSize(opts: BalanceAwareSizingInput): number {
  return capPositionToAvailableBalance({
    requested: requestedBalanceAwareSize(opts),
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
