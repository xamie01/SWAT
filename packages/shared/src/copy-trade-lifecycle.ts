import type { Chain, ExecutionMode } from './types.js';

export type SourceTradeSide = 'buy' | 'sell' | 'transfer_in' | 'transfer_out';

export type SourceConfirmationState =
  | 'observed'
  | 'confirmed'
  | 'finalized'
  | 'reversed';

export type CopyExecutionState =
  | 'requested'
  | 'simulated'
  | 'submitted'
  | 'partially_filled'
  | 'confirmed'
  | 'failed'
  | 'cancelled'
  | 'reconciliation_required';

export type CopyExecutionMode = Exclude<ExecutionMode, 'off' | 'live+shadow'> | 'shadow';

export interface PositionEvent {
  id: string;
  side: SourceTradeSide;
  quantity: number;
  amountUsd?: number | null;
  priceUsd?: number | null;
  eventAt: Date;
}

export interface PositionSnapshot {
  confirmedQuantity: number;
  costBasisUsd: number;
  totalAcquiredQuantity: number;
  totalReducedQuantity: number;
  unmatchedReductionQuantity: number;
}

export interface CopyPolicyInput {
  chain: Chain;
  selectedWallet: boolean;
  selectedCluster: boolean;
  eventAt: Date;
  now: Date;
  maxEventAgeMs: number;
  maxClockSkewMs?: number;
  sourceActivityUsd: number;
  minimumSourceActivityUsd: number;
  liquidityUsd: number;
  minimumLiquidityUsd: number;
  currentExposureUsd: number;
  requestedExposureUsd: number;
  maximumExposureUsd: number;
  chainReady: boolean;
  supportedAsset: boolean;
  safetyAllowed: boolean;
  safetyReasons?: string[];
}

export interface CopyPolicyDecision {
  allowed: boolean;
  reasons: string[];
}

const EXECUTION_TRANSITIONS: Readonly<Record<CopyExecutionState, readonly CopyExecutionState[]>> = {
  requested: ['simulated', 'failed', 'cancelled', 'reconciliation_required'],
  simulated: ['submitted', 'confirmed', 'failed', 'cancelled', 'reconciliation_required'],
  submitted: ['partially_filled', 'confirmed', 'failed', 'cancelled', 'reconciliation_required'],
  partially_filled: ['partially_filled', 'confirmed', 'cancelled', 'reconciliation_required'],
  reconciliation_required: [
    'submitted',
    'partially_filled',
    'confirmed',
    'failed',
    'cancelled',
    'reconciliation_required'
  ],
  confirmed: ['reconciliation_required'],
  failed: [],
  cancelled: []
};

const CONFIRMATION_TRANSITIONS: Readonly<Record<SourceConfirmationState, readonly SourceConfirmationState[]>> = {
  observed: ['confirmed', 'finalized', 'reversed'],
  confirmed: ['finalized', 'reversed'],
  finalized: ['reversed'],
  reversed: []
};

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}

function eventCostUsd(event: PositionEvent): number {
  if (event.amountUsd !== undefined && event.amountUsd !== null) {
    assertFiniteNonNegative('amountUsd', event.amountUsd);
    return event.amountUsd;
  }
  if (event.priceUsd !== undefined && event.priceUsd !== null) {
    assertFiniteNonNegative('priceUsd', event.priceUsd);
    return event.quantity * event.priceUsd;
  }
  return 0;
}

/**
 * Rebuild a position deterministically from confirmed, immutable events.
 * Reductions are capped to the quantity proven by this ledger; any excess is
 * retained as an unmatched reduction instead of creating a negative holding.
 */
export function reducePositionEvents(
  opening: Pick<PositionSnapshot, 'confirmedQuantity' | 'costBasisUsd'>,
  events: readonly PositionEvent[]
): PositionSnapshot {
  assertFiniteNonNegative('opening.confirmedQuantity', opening.confirmedQuantity);
  assertFiniteNonNegative('opening.costBasisUsd', opening.costBasisUsd);

  let confirmedQuantity = opening.confirmedQuantity;
  let costBasisUsd = opening.costBasisUsd;
  let totalAcquiredQuantity = 0;
  let totalReducedQuantity = 0;
  let unmatchedReductionQuantity = 0;

  const orderedEvents = [...events].sort((left, right) => {
    const timeDifference = left.eventAt.getTime() - right.eventAt.getTime();
    return timeDifference === 0 ? left.id.localeCompare(right.id) : timeDifference;
  });

  for (const event of orderedEvents) {
    if (!Number.isFinite(event.quantity) || event.quantity <= 0) {
      throw new Error('event quantity must be a finite positive number');
    }
    if (Number.isNaN(event.eventAt.getTime())) {
      throw new Error('eventAt must be a valid date');
    }

    if (event.side === 'buy' || event.side === 'transfer_in') {
      confirmedQuantity += event.quantity;
      totalAcquiredQuantity += event.quantity;
      costBasisUsd += eventCostUsd(event);
      continue;
    }

    totalReducedQuantity += event.quantity;
    const appliedReduction = Math.min(confirmedQuantity, event.quantity);
    const averageCost = confirmedQuantity > 0 ? costBasisUsd / confirmedQuantity : 0;
    confirmedQuantity -= appliedReduction;
    costBasisUsd = Math.max(0, costBasisUsd - averageCost * appliedReduction);
    unmatchedReductionQuantity += event.quantity - appliedReduction;
  }

  return {
    confirmedQuantity,
    costBasisUsd,
    totalAcquiredQuantity,
    totalReducedQuantity,
    unmatchedReductionQuantity
  };
}

export function isAppliedSourceConfirmation(state: SourceConfirmationState): boolean {
  return state === 'confirmed' || state === 'finalized';
}

export function canTransitionSourceConfirmation(
  current: SourceConfirmationState,
  next: SourceConfirmationState
): boolean {
  return current === next || CONFIRMATION_TRANSITIONS[current].includes(next);
}

export function canTransitionCopyExecution(
  current: CopyExecutionState,
  next: CopyExecutionState
): boolean {
  return current === next || EXECUTION_TRANSITIONS[current].includes(next);
}

/** Fail-closed policy evaluation shared by all chain adapters. */
export function evaluateCopyPolicy(input: CopyPolicyInput): CopyPolicyDecision {
  const reasons: string[] = [];
  const numericInputs: Array<[string, number]> = [
    ['maxEventAgeMs', input.maxEventAgeMs],
    ['maxClockSkewMs', input.maxClockSkewMs ?? 0],
    ['sourceActivityUsd', input.sourceActivityUsd],
    ['minimumSourceActivityUsd', input.minimumSourceActivityUsd],
    ['liquidityUsd', input.liquidityUsd],
    ['minimumLiquidityUsd', input.minimumLiquidityUsd],
    ['currentExposureUsd', input.currentExposureUsd],
    ['requestedExposureUsd', input.requestedExposureUsd],
    ['maximumExposureUsd', input.maximumExposureUsd]
  ];

  if (numericInputs.some(([, value]) => !Number.isFinite(value) || value < 0)) {
    reasons.push('invalid-policy-input');
  }

  const eventTime = input.eventAt.getTime();
  const nowTime = input.now.getTime();
  if (!Number.isFinite(eventTime) || !Number.isFinite(nowTime)) {
    reasons.push('invalid-event-time');
  } else {
    if (nowTime - eventTime > input.maxEventAgeMs) reasons.push('stale-source-event');
    if (eventTime - nowTime > (input.maxClockSkewMs ?? 0)) reasons.push('future-source-event');
  }

  if (!input.selectedWallet && !input.selectedCluster) reasons.push('source-not-selected');
  if (input.sourceActivityUsd < input.minimumSourceActivityUsd) reasons.push('source-activity-below-minimum');
  if (input.liquidityUsd < input.minimumLiquidityUsd) reasons.push('liquidity-below-minimum');
  if (input.currentExposureUsd + input.requestedExposureUsd > input.maximumExposureUsd) {
    reasons.push('exposure-limit-exceeded');
  }
  if (!input.chainReady) reasons.push(`${input.chain}-not-ready`);
  if (!input.supportedAsset) reasons.push('unsupported-asset');
  if (!input.safetyAllowed) {
    reasons.push(...(input.safetyReasons?.length ? input.safetyReasons : ['chain-safety-rejected']));
  }

  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function calculateProportionalSell(input: {
  sourceReductionQuantity: number;
  sourcePositionBeforeQuantity: number;
  swatConfirmedAvailableQuantity: number;
}): { proportion: number; quantity: number } {
  assertFiniteNonNegative('sourceReductionQuantity', input.sourceReductionQuantity);
  assertFiniteNonNegative('sourcePositionBeforeQuantity', input.sourcePositionBeforeQuantity);
  assertFiniteNonNegative('swatConfirmedAvailableQuantity', input.swatConfirmedAvailableQuantity);

  if (
    input.sourceReductionQuantity === 0
    || input.sourcePositionBeforeQuantity === 0
    || input.swatConfirmedAvailableQuantity === 0
  ) {
    return { proportion: 0, quantity: 0 };
  }

  const proportion = Math.min(1, input.sourceReductionQuantity / input.sourcePositionBeforeQuantity);
  return {
    proportion,
    quantity: Math.min(
      input.swatConfirmedAvailableQuantity,
      input.swatConfirmedAvailableQuantity * proportion
    )
  };
}
