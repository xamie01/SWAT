import { UnrecoverableError } from 'bullmq';

/**
 * Polymarket position identity — preserved per outcome, never normalised into an
 * economically-equivalent alternative (checklist `S4-M20`).
 *
 * **What was found before anything was written.** Nothing in this repo normalises
 * today, and the item is therefore a guard rather than a refactor. The canonical
 * ledger already keys on the outcome token: `buildPolymarketSourceTradeInput`
 * (`apps/indexer/src/source-trade-lifecycle.ts`) sets
 * `tokenMint = resolveChainValue(trade.asset, 'polygon').raw`, and `trade.asset`
 * is the ERC-1155 outcome token id, not the condition id. `polymarket_outcomes`
 * is keyed `(condition_id, outcome_index)` with its own `token_id`, and
 * `getPolymarketOutcomeContext` looks up by `token_id`. So YES and NO already
 * occupy distinct `copy_positions` rows. This module exists to make that a
 * checked invariant instead of an accident, because the next item in the
 * checklist is the one that will be tempted to break it.
 *
 * **Where the temptation is, concretely.** `S4-M19` wires redemption into the
 * mirroring path, and redemption is the one Polymarket operation that is
 * legitimately *condition*-scoped: `redeemPositions({conditionId})` takes no
 * amount and redeems both outcomes. Going from a condition back to "the
 * position" is exactly the step at which two outcome rows get collapsed into
 * one. A second temptation is exposure aggregation: netting a YES against a NO
 * on the same condition looks like flat risk and is not.
 *
 * **Why the economics being similar is not enough** (live docs, verified
 * 2026-08-20):
 *
 *   * `/concepts/negative-risk` states the equivalence in the venue's own words —
 *     "betting against one outcome is economically equivalent to betting *for*
 *     all other outcomes" — which is precisely the reasoning this item forbids
 *     acting on. The equivalence is realised only by an explicit call:
 *     *Conversion Mechanics* is "you hold 1 No token for Outcome A → call the
 *     convert function on the adapter → you receive 1 Yes token for every other
 *     outcome in the event". Until that call, the positions are different
 *     ERC-1155 assets with different token ids.
 *   * The complement is a **set**, and in a neg-risk event it is a set spread
 *     across *other conditions*. `/concepts/markets-events` → *Multi-Market
 *     Events* shows a neg-risk group as N separate Yes/No markets under one
 *     event, and `/concepts/positions-tokens` → *Outcome Tokens* confirms "each
 *     market has exactly two outcome tokens". So the complement of NO-on-A is
 *     N−1 YES tokens in N−1 distinct conditions. It cannot be the same position
 *     row under any keying, and merging it into one would create or destroy
 *     positions in conditions the user never traded.
 *   * The complement is not even **stable**. `/concepts/negative-risk` →
 *     *Augmented Negative Risk* documents placeholder outcomes clarified after
 *     trading begins via the bulletin board, with "the 'Other' definition
 *     narrow[ing] as placeholders are assigned". So the set that NO-on-A
 *     converts into today is not the set it converts into tomorrow. A
 *     normalisation computed at fill time would be wrong by resolution.
 *   * Even the binary case needs an explicit action. `/trading/positions/manage`
 *     → *Merge Positions* is "every 1 YES token and 1 NO token returns 1 pUSD",
 *     via `mergePositions(collateralToken, parentCollectionId, conditionId,
 *     partition [1,2], amount)`, requiring equal balances and a prior
 *     `setApprovalForAll` of the market's collateral adapter. A YES and a NO are
 *     interchangeable with collateral only after that call succeeds.
 *
 * **This does not re-introduce an adapter branch.** `negRisk` is carried here as
 * *context for reasoning about a position*, and deliberately plays no part in
 * `polymarketPositionKey` — the key is the outcome token either way. The client
 * still picks the collateral adapter from the condition id, and
 * `polymarket-negrisk.test.ts` still asserts no `negRisk`/`adapter`/`exchange`
 * key is ever sent on an order. Preserving representation is about what we
 * record and reason about, not about what we route on.
 *
 * Pure and dependency-injected: no clock, no environment, no I/O.
 */

/** Polymarket is chain `polygon`; a position key is a chain-prefixed token mint. */
const POLYGON_PREFIX = 'polygon:';

export interface PolymarketOutcomePosition {
  /** Normalised `0x`-prefixed 64-hex condition id of the market holding this outcome. */
  readonly conditionId: string;
  /** The ERC-1155 outcome token id, as an unpadded decimal string. */
  readonly tokenId: string;
  /** Index of this outcome within its market — 0 or 1, since a market has two. */
  readonly outcomeIndex: number;
  /** The outcome label, preserved verbatim ('Yes', 'No', or a named outcome). */
  readonly outcome: string;
  /** Neg-risk membership. Context for reasoning; never an input to the key. */
  readonly negRisk: boolean;
}

export interface PolymarketNegRiskGroup {
  /**
   * Condition ids of the sibling markets in the neg-risk event, excluding the
   * position's own. Absent when we have not read the event, which makes the
   * complement undeterminable rather than empty.
   */
  readonly siblingConditionIds?: readonly string[];
  /**
   * Whether the event uses augmented neg risk. When true the outcome set can grow
   * after trading begins, so any complement we compute is a snapshot with an
   * expiry we cannot see.
   */
  readonly augmented?: boolean;
}

export type PolymarketComplementMechanism =
  /** `mergePositions` on the market's collateral adapter, partition [1, 2]. */
  | 'merge-positions'
  /** `convert` on the Neg Risk Adapter. */
  | 'neg-risk-convert';

export interface PolymarketComplementLeg {
  readonly conditionId: string;
  /** The outcome index that would have to be held in that condition. */
  readonly outcomeIndex: number;
}

export interface PolymarketComplementKnown {
  readonly kind: 'known';
  readonly mechanism: PolymarketComplementMechanism;
  /**
   * The positions the complement consists of. Length > 1, or spanning more than
   * one condition, is by itself proof that the complement is not this position.
   */
  readonly legs: readonly PolymarketComplementLeg[];
  /**
   * Always false. The complement becomes the same economic exposure only after an
   * on-chain call this executor does not make, so it is never a substitution we
   * are entitled to perform silently.
   */
  readonly interchangeableWithoutAction: false;
  /** False under augmented neg risk, where the outcome set can still change. */
  readonly outcomeSetStable: boolean;
}

export interface PolymarketComplementUndeterminable {
  readonly kind: 'undeterminable';
  readonly reason: string;
}

export type PolymarketComplement =
  | PolymarketComplementKnown
  | PolymarketComplementUndeterminable;

function normalizeConditionId(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new UnrecoverableError(`Polymarket ${label} must be a string`);
  }
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new UnrecoverableError(`Polymarket ${label} is not a condition id: ${value}`);
  }
  return normalized;
}

/**
 * Accept a bare or `polygon:`-prefixed outcome token id and return the bare form.
 *
 * Token ids arrive both ways — bare from the venue (`trade.asset`, order books)
 * and prefixed from our own tables (`token_mint`) — and confusing the two is how
 * a lookup silently misses.
 */
function normalizeTokenId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new UnrecoverableError('Polymarket outcome token id must be a string');
  }
  const trimmed = value.trim();
  const bare = trimmed.startsWith(POLYGON_PREFIX)
    ? trimmed.slice(POLYGON_PREFIX.length)
    : trimmed;
  // uint256 decimal, as the CLOB reports `asset_id`. Rejecting a condition id
  // here is the point: `0x…` never parses, so a condition id can never be
  // mistaken for a token id and become a position key.
  if (!/^[0-9]+$/.test(bare) || /^0+$/.test(bare)) {
    throw new UnrecoverableError(`Polymarket outcome token id is not a uint256: ${value}`);
  }
  return bare.replace(/^0+(?=[0-9])/, '');
}

/** Validate and normalise an outcome position, rejecting anything ambiguous. */
export function parsePolymarketOutcomePosition(input: {
  readonly conditionId: unknown;
  readonly tokenId: unknown;
  readonly outcomeIndex: unknown;
  readonly outcome: unknown;
  readonly negRisk?: unknown;
}): PolymarketOutcomePosition {
  const conditionId = normalizeConditionId(input.conditionId, 'condition id');
  const tokenId = normalizeTokenId(input.tokenId);
  if (typeof input.outcomeIndex !== 'number'
    || !Number.isInteger(input.outcomeIndex)
    || input.outcomeIndex < 0) {
    throw new UnrecoverableError(
      `Polymarket outcome index must be a non-negative integer, got ${String(input.outcomeIndex)}`
    );
  }
  if (typeof input.outcome !== 'string' || !input.outcome.trim()) {
    // The label is what a user reads on their position. An outcome we cannot name
    // is one we cannot show, and 'Yes'/'No' must not be inferred from the index —
    // a named neg-risk outcome carries a candidate name, not a polarity.
    throw new UnrecoverableError('Polymarket outcome label must be a non-empty string');
  }
  return {
    conditionId,
    tokenId,
    outcomeIndex: input.outcomeIndex,
    outcome: input.outcome.trim(),
    negRisk: input.negRisk === true
  };
}

/**
 * The canonical position key: the chain-prefixed **outcome token** mint.
 *
 * Derived from the token id and nothing else. In particular it is not derived
 * from the condition id — a condition holds two outcomes, so a condition-keyed
 * position would merge them — and not from `negRisk`, which is context rather
 * than identity.
 */
export function polymarketPositionKey(position: PolymarketOutcomePosition): string {
  return `${POLYGON_PREFIX}${position.tokenId}`;
}

/** Two positions are the same only when they are the same outcome token. */
export function isSamePolymarketPosition(
  left: PolymarketOutcomePosition,
  right: PolymarketOutcomePosition
): boolean {
  return left.tokenId === right.tokenId;
}

/**
 * Refuse a set of positions that a condition-level view would have collapsed.
 *
 * This is the guard the item asks for. Given the positions a caller is about to
 * net, aggregate, or write as one row, it throws when two of them share a
 * condition but name different outcomes — the shape that means someone has
 * reached the condition level and lost the outcome. Duplicates of the *same*
 * outcome token are fine; that is one position seen twice.
 *
 * Intended call sites are exposure aggregation and the `S4-M19` redemption
 * fan-out from `redeemPositions({conditionId})` back to positions.
 */
export function assertPolymarketPositionsDistinct(
  positions: readonly PolymarketOutcomePosition[]
): void {
  const byCondition = new Map<string, PolymarketOutcomePosition>();
  for (const position of positions) {
    const seen = byCondition.get(position.conditionId);
    if (seen && !isSamePolymarketPosition(seen, position)) {
      throw new UnrecoverableError(
        `Polymarket Protection: refusing to merge outcome ${seen.outcome} (index ${seen.outcomeIndex})`
        + ` with outcome ${position.outcome} (index ${position.outcomeIndex})`
        + ` on condition ${position.conditionId} — distinct outcomes are distinct positions`
      );
    }
    byCondition.set(position.conditionId, position);
  }
}

/**
 * Describe what this position's complement actually consists of.
 *
 * Returns a *description*, never a substitution. The point of the return value is
 * that a caller inspecting it cannot come away thinking the complement is one
 * interchangeable position: `interchangeableWithoutAction` is typed `false`, the
 * legs are enumerated, and `outcomeSetStable` reports when the set can still
 * change underneath us.
 */
export function describePolymarketComplement(
  position: PolymarketOutcomePosition,
  group: PolymarketNegRiskGroup = {}
): PolymarketComplement {
  if (!position.negRisk) {
    // Binary market: the complement is the other outcome of the same condition,
    // and reaching collateral from the pair requires `mergePositions` with equal
    // balances and a prior adapter approval.
    if (position.outcomeIndex > 1) {
      return {
        kind: 'undeterminable',
        reason: `Outcome index ${position.outcomeIndex} exceeds the two outcomes a standard market has`
      };
    }
    return {
      kind: 'known',
      mechanism: 'merge-positions',
      legs: [{
        conditionId: position.conditionId,
        outcomeIndex: position.outcomeIndex === 0 ? 1 : 0
      }],
      interchangeableWithoutAction: false,
      outcomeSetStable: true
    };
  }

  const siblings = group.siblingConditionIds;
  if (!siblings) {
    // Not "no complement" — an unread event. Saying so is the honest answer and
    // is itself a reason never to normalise on a hunch.
    return {
      kind: 'undeterminable',
      reason: `Neg-risk event for condition ${position.conditionId} has not been read,`
        + ' so its complement set is unknown'
    };
  }
  const normalizedSiblings = siblings
    .map((value) => normalizeConditionId(value, 'sibling condition id'))
    .filter((value) => value !== position.conditionId);
  if (normalizedSiblings.length === 0) {
    return {
      kind: 'undeterminable',
      reason: `Neg-risk event for condition ${position.conditionId} reported no sibling markets`
    };
  }

  return {
    kind: 'known',
    mechanism: 'neg-risk-convert',
    // One YES per other market in the event, per the documented conversion.
    legs: normalizedSiblings.map((conditionId) => ({ conditionId, outcomeIndex: 0 })),
    interchangeableWithoutAction: false,
    // Augmented neg risk can add named outcomes after trading opens, so a
    // complement computed now may be incomplete by resolution.
    outcomeSetStable: group.augmented !== true
  };
}
