import { UnrecoverableError } from 'bullmq';
import {
  assertPolymarketPositionsDistinct,
  parsePolymarketOutcomePosition,
  polymarketPositionKey,
  type PolymarketOutcomePosition
} from './polymarket-representation.js';

/**
 * Redemption as a first-class exit, raced against the mirrored sell
 * (checklist `S4-M19`).
 *
 * **The gap this closes.** Our copy exits today only when the master's sell is
 * mirrored. If the master holds to resolution they never sell, so there is no
 * sell to mirror and the copy never exits — the position simply sits until
 * someone notices, on an outcome that is by then worth exactly 1 or 0.
 *
 * **The decided design: two triggers, whichever fires first wins.**
 *
 *   1. the master closes their position, which mirrors as a sell today;
 *   2. the market resolves, which redeems.
 *
 * Neither alone is sufficient. Waiting only for the master's sell strands every
 * hold-to-resolution position. Waiting only for resolution exits late on every
 * position the master actually traded out of. So both are tracked and the earlier
 * one acts.
 *
 * **Single-shot per position, not per trigger.** The two triggers can fire close
 * together — a master selling moments before resolution is the ordinary case, not
 * the edge — so the race needs exactly one winner *per position*. That is what
 * `polymarket_position_exits` and `claimPolymarketPositionExit` provide: a
 * position-scoped claim with the same partial-unique-index shape as
 * `polymarket_redemptions`, which is condition-scoped and therefore cannot be the
 * guard (see below).
 *
 * **Why the claim cannot be condition-scoped.** `redeemPositions({conditionId})`
 * takes no amount and redeems the wallet's balances for *both* outcomes, so the
 * on-chain call is condition-scoped and `polymarket_redemptions` correctly guards
 * it once per condition. But a condition holds **two** outcome positions, and
 * mapping a condition-scoped result back to positions is the exact step at which
 * two outcome rows get collapsed into one. `S4-M20` says so explicitly and names
 * this as the call site for `assertPolymarketPositionsDistinct`, which
 * `mapPolymarketRedemptionToPositions` below calls, as does
 * `aggregatePolymarketExposure`.
 *
 * **The master's holdings are a cross-reference, never a source** (`S4-M37`).
 * What we are allowed to exit comes from *our* confirmed positions. Whether an
 * exit is *due* may consult whether the master still holds. Reversing that is how
 * a redemption sweep ends up trying to redeem a market we never entered.
 *
 * Pure: no clock, no client, no database. The driver that owns the claim lives in
 * `polymarket-redemption.ts`.
 */

/** Which of the two racing triggers is acting. */
export type PolymarketExitTrigger =
  /** The master closed their position and we mirror the sell. */
  | 'mirrored-sell'
  /** The market resolved and the position redeems. */
  | 'redemption';

export type PolymarketExitClaimStatus = 'claimed' | 'confirmed' | 'failed';

export interface PolymarketExitClaimState {
  readonly trigger: PolymarketExitTrigger;
  readonly status: PolymarketExitClaimStatus;
}

export interface PolymarketExitRaceInput {
  readonly position: PolymarketOutcomePosition;
  /** Shares we can prove we hold. Zero means there is nothing to exit. */
  readonly heldShares: number;
  /**
   * Whether the master still holds this outcome. `null` when we have not read it
   * — which is ignorance, not evidence of a close.
   */
  readonly masterHoldsPosition: boolean | null;
  readonly marketResolved: boolean;
  readonly acceptingOrders: boolean;
  /** An exit already claimed for this position, if any. */
  readonly existingClaim: PolymarketExitClaimState | null;
}

export type PolymarketExitRaceDecision =
  /** This trigger wins the race and should claim the position. */
  | { readonly kind: 'exit'; readonly trigger: PolymarketExitTrigger; readonly reason: string }
  /** Another trigger already won. The loser is a no-op, not an error. */
  | {
    readonly kind: 'already-exiting';
    readonly trigger: PolymarketExitTrigger;
    readonly reason: string;
  }
  /** No trigger has fired yet. */
  | { readonly kind: 'hold'; readonly reason: string };

/**
 * Decide which exit trigger, if any, acts on this position now.
 *
 * Resolution outranks the mirrored sell when both look true at the same
 * observation, and that ordering is a venue fact rather than a preference: a
 * resolved market stops accepting orders, so a mirrored sell into it cannot fill
 * at any price. Redemption is then the only exit that exists.
 */
export function decidePolymarketExit(
  input: PolymarketExitRaceInput
): PolymarketExitRaceDecision {
  const key = polymarketPositionKey(input.position);

  if (!Number.isFinite(input.heldShares) || input.heldShares <= 0) {
    return {
      kind: 'hold',
      reason: `position ${key} holds no proven shares, so there is nothing to exit`
    };
  }

  // The single-shot guard. A 'failed' claim is deliberately not a winner: a
  // redemption that failed must be retryable, and redemption has no deadline.
  if (input.existingClaim && input.existingClaim.status !== 'failed') {
    return {
      kind: 'already-exiting',
      trigger: input.existingClaim.trigger,
      reason:
        `position ${key} is already exiting via ${input.existingClaim.trigger} `
        + `(${input.existingClaim.status}); the race has one winner per position`
    };
  }

  if (input.marketResolved || !input.acceptingOrders) {
    return {
      kind: 'exit',
      trigger: 'redemption',
      reason:
        `condition ${input.position.conditionId} no longer accepts orders `
        + `(resolved=${input.marketResolved}, acceptingOrders=${input.acceptingOrders}), `
        + `so the ${input.heldShares} shares of ${input.position.outcome} exit by redemption`
    };
  }

  if (input.masterHoldsPosition === false) {
    return {
      kind: 'exit',
      trigger: 'mirrored-sell',
      reason:
        `the master no longer holds ${input.position.outcome} on `
        + `${input.position.conditionId}, so the exit mirrors as a sell`
    };
  }

  if (input.masterHoldsPosition === null) {
    // Ignorance is not a trigger. Treating an unread cross-reference as "the
    // master has closed" would exit a position on missing data.
    return {
      kind: 'hold',
      reason:
        `master holdings for ${key} are unread, and an unknown cross-reference is `
        + 'not evidence the master closed'
    };
  }

  return {
    kind: 'hold',
    reason: `master still holds ${key} and the market is open; neither trigger has fired`
  };
}

export interface PolymarketRedemptionPositionRow {
  readonly conditionId: unknown;
  readonly tokenId: unknown;
  readonly outcome: unknown;
  readonly outcomeIndex: unknown;
  readonly negRisk?: unknown;
}

export interface PolymarketRedeemedPosition {
  readonly position: PolymarketOutcomePosition;
  readonly positionKey: string;
}

/**
 * Map a condition-scoped redemption back to the individual outcome positions it
 * settled.
 *
 * This is the call site `S4-M20` names. `redeemPositions({conditionId})` returns
 * one transaction for a condition that holds two outcomes, so the natural sloppy
 * implementation writes one row per condition and loses the outcome.
 *
 * **How the guard is applied, and why not to the whole set.**
 * `assertPolymarketPositionsDistinct` throws on any set *a condition-level view
 * would have collapsed* — which means handing it YES and NO together throws, and
 * holding both outcomes of a market is perfectly ordinary. So the guard is applied
 * to each group of rows that is about to be treated as **one** position, i.e. each
 * group sharing a `polymarketPositionKey`. That is the shape the guard is for, and
 * it is not decoration: if the position key were ever re-derived from the
 * condition id, YES and NO would land in the same group and this throws instead of
 * silently merging them.
 *
 * Refuses an empty set. A redemption attributed to no position is a redemption we
 * cannot attribute at all, and recording it would put unexplained proceeds in the
 * ledger.
 */
export function mapPolymarketRedemptionToPositions(
  conditionId: string,
  rows: readonly PolymarketRedemptionPositionRow[]
): PolymarketRedeemedPosition[] {
  if (rows.length === 0) {
    throw new UnrecoverableError(
      `Polymarket redemption of condition ${conditionId} maps to no held position, `
      + 'so its proceeds cannot be attributed'
    );
  }

  const positions = rows.map((row) => parsePolymarketOutcomePosition({
    conditionId: row.conditionId,
    tokenId: row.tokenId,
    outcome: row.outcome,
    outcomeIndex: row.outcomeIndex,
    negRisk: row.negRisk
  }));

  const expected = conditionId.trim().toLowerCase();
  for (const position of positions) {
    if (position.conditionId !== expected) {
      throw new UnrecoverableError(
        `Polymarket redemption of condition ${conditionId} was handed a position on `
        + `condition ${position.conditionId}`
      );
    }
  }

  return [...groupByPositionKey(positions).entries()].map(([positionKey, group]) => {
    // The `S4-M20` guard, on exactly the set about to become one position.
    assertPolymarketPositionsDistinct(group);
    return { position: group[0]!, positionKey };
  });
}

/**
 * Group positions by the key they would be written under.
 *
 * Extracted because both call sites the checklist names — the redemption fan-out
 * and exposure aggregation — need the same "what is about to become one row"
 * grouping before the distinctness guard can say anything useful.
 */
function groupByPositionKey(
  positions: readonly PolymarketOutcomePosition[]
): Map<string, PolymarketOutcomePosition[]> {
  const groups = new Map<string, PolymarketOutcomePosition[]>();
  for (const position of positions) {
    const key = polymarketPositionKey(position);
    const group = groups.get(key);
    if (group) group.push(position);
    else groups.set(key, [position]);
  }
  return groups;
}

export interface PolymarketMirroredSellClaimPorts {
  /**
   * Take the position-scoped exit claim. Returns null when redemption already won
   * the race for this position.
   */
  readonly claimPositionExit: (input: {
    positionKey: string;
    conditionId: string;
    outcomeTokenId: string;
    exitTrigger: PolymarketExitTrigger;
    userId: string | null;
  }) => Promise<{ id: string } | null>;
  readonly log?: (message: string) => void;
}

export type PolymarketMirroredSellClaim =
  /** The mirrored sell owns this position's exit. Proceed with the sell. */
  | { readonly kind: 'won'; readonly claimId: string }
  /** Redemption already owns it. Do not sell — the shares are being redeemed. */
  | { readonly kind: 'lost'; readonly reason: string };

/**
 * Claim a position for the mirrored-sell trigger before submitting the sell.
 *
 * This is the other half of the race, and it has to be taken *before* the order
 * is signed rather than after it fills. A resolved market stops accepting orders,
 * so if redemption has already claimed the position the sell cannot fill anyway —
 * but on a market that resolves mid-flight the sell can partially fill while
 * redemption settles the remainder, and without this claim the ledger would
 * record two exits for one position.
 *
 * Losing the race is not an error. It is the design: whichever trigger got there
 * first exits the position, and the other one stands down.
 */
export async function claimPolymarketMirroredSellExit(
  input: { position: PolymarketOutcomePosition; userId: string | null },
  ports: PolymarketMirroredSellClaimPorts
): Promise<PolymarketMirroredSellClaim> {
  const positionKey = polymarketPositionKey(input.position);
  const log = ports.log ?? (() => {});
  const claim = await ports.claimPositionExit({
    positionKey,
    conditionId: input.position.conditionId,
    outcomeTokenId: input.position.tokenId,
    exitTrigger: 'mirrored-sell',
    userId: input.userId
  });
  if (!claim) {
    const reason =
      `position ${positionKey} is already exiting via redemption, so the mirrored sell `
      + 'stands down rather than exiting it a second time';
    log(`[polymarket-exit-race] ${reason}`);
    return { kind: 'lost', reason };
  }
  return { kind: 'won', claimId: claim.id };
}

export interface PolymarketExposureLeg {
  readonly position: PolymarketOutcomePosition;
  readonly positionKey: string;
  readonly shares: number;
}

export interface PolymarketExposureAggregate {
  /** One entry per outcome token. Never per condition. */
  readonly legs: readonly PolymarketExposureLeg[];
  /** Sum of shares across legs. Not a net: nothing is subtracted. */
  readonly totalShares: number;
}

/**
 * Aggregate exposure without netting a YES against a NO.
 *
 * The second call site `S4-M20` names. Netting the two outcomes of one condition
 * looks like flat risk and is not: reaching collateral from a YES/NO pair needs
 * `mergePositions` with equal balances and a prior adapter approval, an on-chain
 * call this executor never makes. So the aggregate keeps one leg per outcome
 * token, and the distinctness guard runs on each group that is about to become one
 * leg — which is what makes a condition-derived key throw here instead of silently
 * halving the reported exposure.
 */
export function aggregatePolymarketExposure(
  legs: readonly PolymarketExposureLeg[]
): PolymarketExposureAggregate {
  const byKey = new Map<string, PolymarketExposureLeg>();
  const grouped = new Map<string, PolymarketOutcomePosition[]>();

  for (const leg of legs) {
    if (!Number.isFinite(leg.shares) || leg.shares < 0) {
      throw new UnrecoverableError(
        `Polymarket exposure leg ${leg.positionKey} has a non-finite or negative share count`
      );
    }
    const group = grouped.get(leg.positionKey);
    if (group) group.push(leg.position);
    else grouped.set(leg.positionKey, [leg.position]);

    const existing = byKey.get(leg.positionKey);
    byKey.set(
      leg.positionKey,
      existing ? { ...existing, shares: existing.shares + leg.shares } : leg
    );
  }

  for (const group of grouped.values()) {
    assertPolymarketPositionsDistinct(group);
  }

  const merged = [...byKey.values()];
  return {
    legs: merged,
    totalShares: merged.reduce((total, leg) => total + leg.shares, 0)
  };
}
