import { type PolymarketOutcomePosition } from './polymarket-representation.js';
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
 * **Manual exit is the third entrant, not a third path** (`S4-M45`). A user
 * tapping "exit" moments before the master sells is the ordinary case, not the
 * edge, so manual exit joins *this* function and *this* claim rather than getting
 * its own. Everything below that was written for two entrants — the single-shot
 * guard, the failed-claim rule, one winner per position — covers three unchanged;
 * the only additions are one member on `PolymarketExitTrigger`, one field on the
 * race input, and one rung in the ordering. The chain-generic layer that decides
 * whether a manual exit is even expressible on a given chain lives in
 * `manual-exit.ts` and *delegates here* for Polymarket.
 *
 * Pure: no clock, no client, no database. The driver that owns the claim lives in
 * `polymarket-redemption.ts`.
 */
/** Which of the three racing triggers is acting. */
export type PolymarketExitTrigger = 
/** The master closed their position and we mirror the sell. */
'mirrored-sell'
/** The market resolved and the position redeems. */
 | 'redemption'
/**
 * The user asked to exit, and the position sells into the book.
 *
 * Mechanically identical to `mirrored-sell` — both are a FAK sell of the whole
 * position — and deliberately kept a separate *trigger* anyway, because the two
 * record different facts. "The position exited" and "the position exited
 * because the user asked" are not the same thing, and attribution reads the
 * second one. Also: a manual exit must be able to win in states where the
 * mirrored sell is not even eligible, so it cannot be folded into it.
 */
 | 'manual';
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
    /**
     * Whether the user has asked to exit this position (`S4-M45`).
     *
     * **Required, not optional.** An omitted field defaulting to `false` can only
     * ever under-exit, so it is safe on the double-exit axis — but it is silent on
     * the other one: a caller that forgot to thread the user's request would leave
     * the user tapping "exit" and nothing happening, with no error anywhere. Every
     * caller states it.
     */
    readonly manualExitRequested: boolean;
    /** An exit already claimed for this position, if any. */
    readonly existingClaim: PolymarketExitClaimState | null;
}
/**
 * Stable outcome codes, one per reachable branch.
 *
 * Freeform `reason` strings are for a human reading a log line; these are what an
 * operator dashboard, an alert rule and `S4-M24`'s skip rendering key on. Split
 * the way `solana-simulation.ts` splits `refuse` from `unavailable`: two holds
 * that look alike in prose ("nothing happened") are different findings, and
 * sending an operator to debug the wrong one is the cost of collapsing them.
 */
export type PolymarketExitCode = 
/** We hold nothing provable, so no trigger can act. Not a fault. */
'polymarket-exit-hold-no-proven-shares'
/** Another entrant already owns this position's exit. The race resolving. */
 | 'polymarket-exit-already-claimed'
/** The market stopped accepting orders; redemption is the only exit that exists. */
 | 'polymarket-exit-by-redemption'
/** The user asked to exit and the book is open, so it sells into the book. */
 | 'polymarket-exit-by-manual-request'
/** The master closed and the book is open, so the exit mirrors as a sell. */
 | 'polymarket-exit-by-mirrored-sell'
/** The master cross-reference is unread. Ignorance is not a trigger. */
 | 'polymarket-exit-hold-master-holdings-unread'
/** Market open, master still in, no manual request. Nothing is due. */
 | 'polymarket-exit-hold-no-trigger-fired';
export type PolymarketExitRaceDecision = 
/** This trigger wins the race and should claim the position. */
{
    readonly kind: 'exit';
    readonly trigger: PolymarketExitTrigger;
    readonly code: PolymarketExitCode;
    readonly reason: string;
}
/** Another trigger already won. The loser is a no-op, not an error. */
 | {
    readonly kind: 'already-exiting';
    readonly trigger: PolymarketExitTrigger;
    readonly code: PolymarketExitCode;
    readonly reason: string;
}
/** No trigger has fired yet. */
 | {
    readonly kind: 'hold';
    readonly code: PolymarketExitCode;
    readonly reason: string;
};
/**
 * Decide which exit trigger, if any, acts on this position now.
 *
 * **One function for all three entrants, and the ordering below is the whole
 * design.** The rungs are checked in a fixed order and the first that fires
 * returns, so exactly one trigger can win per call — and because the single-shot
 * guard sits above every one of them, exactly one can win per position across
 * calls. Adding a fourth entrant means adding a rung here, never a second
 * function.
 *
 * The order, and why each step is where it is:
 *
 *   0. **Nothing held → hold.** Above everything, including a manual request: a
 *      user asking to exit a position we cannot prove we hold must not send an
 *      order. Sizing has no honest input.
 *   1. **A live claim → stand down.** The single-shot guard. Covers all three
 *      entrants because it reads the *claim*, never the trigger being offered.
 *   2. **Resolution → redemption**, outranking both selling entrants — a venue
 *      fact, not a preference. A resolved market stops accepting orders, so a sell
 *      into it cannot fill at any price. This is the rung that makes "redemption
 *      is just another sell" false: a manual exit on a resolved market is still
 *      honoured, but it is honoured *by redeeming*, because selling is no longer
 *      a thing the venue will do.
 *   3. **Manual request → manual**, outranking the mirrored sell. Both are the
 *      same FAK sell of the whole position, so the winner does not change what is
 *      sent to the venue — it changes what is *recorded*. The user's own
 *      instruction is the more specific fact, and attributing it to the master
 *      would show the user an audit trail in which their tap did nothing. It also
 *      has to sit above rung 5: a manual exit must work when the master
 *      cross-reference is unread, and for a subscription that mirrors nothing at
 *      all.
 *   4. **Master closed → mirrored sell.**
 *   5. **Master unread → hold.** Ignorance is not a trigger.
 *   6. **Nothing due → hold.**
 */
export declare function decidePolymarketExit(input: PolymarketExitRaceInput): PolymarketExitRaceDecision;
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
export declare function mapPolymarketRedemptionToPositions(conditionId: string, rows: readonly PolymarketRedemptionPositionRow[]): PolymarketRedeemedPosition[];
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
    }) => Promise<{
        id: string;
    } | null>;
    readonly log?: (message: string) => void;
}
export type PolymarketMirroredSellClaim = 
/** This entrant owns the position's exit. Proceed with the sell. */
{
    readonly kind: 'won';
    readonly claimId: string;
}
/** Another entrant already owns it. Do not sell — it is already exiting. */
 | {
    readonly kind: 'lost';
    readonly reason: string;
    readonly code: PolymarketExitCode;
};
/**
 * Take the position-scoped exit claim on behalf of one entrant.
 *
 * **This is the single door into the claim, and that is the point of `S4-M45`.**
 * The mirrored sell and the manual exit are two callers of *this* function with a
 * different `trigger`, not two code paths — a manual exit that took its own claim,
 * or none, would reintroduce the double-exit the claim exists to prevent. The
 * redemption sweep reaches the same row through the same port in
 * `polymarket-redemption.ts`; it fans out per condition, so it owns its loop but
 * not a second guard.
 *
 * The claim has to be taken *before* the order is signed rather than after it
 * fills. A resolved market stops accepting orders, so if redemption has already
 * claimed the position the sell cannot fill anyway — but on a market that resolves
 * mid-flight the sell can partially fill while redemption settles the remainder,
 * and without this claim the ledger would record two exits for one position.
 *
 * Losing the race is not an error. It is the design: whichever entrant got there
 * first exits the position, and the others stand down.
 */
export declare function claimPolymarketExit(input: {
    position: PolymarketOutcomePosition;
    userId: string | null;
    trigger: PolymarketExitTrigger;
}, ports: PolymarketMirroredSellClaimPorts): Promise<PolymarketMirroredSellClaim>;
/**
 * The mirrored-sell entrant. A named wrapper, not a path of its own — it exists so
 * the call site reads as what it is and cannot pass the wrong trigger.
 */
export declare function claimPolymarketMirroredSellExit(input: {
    position: PolymarketOutcomePosition;
    userId: string | null;
}, ports: PolymarketMirroredSellClaimPorts): Promise<PolymarketMirroredSellClaim>;
/**
 * The manual entrant, `S4-M45`'s third one.
 *
 * Identical body to the mirrored sell by construction — one `claimPolymarketExit`
 * call with a different trigger. If this function ever grows a branch the mirrored
 * sell does not have, the two have stopped being one race.
 */
export declare function claimPolymarketManualExit(input: {
    position: PolymarketOutcomePosition;
    userId: string | null;
}, ports: PolymarketMirroredSellClaimPorts): Promise<PolymarketMirroredSellClaim>;
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
export declare function aggregatePolymarketExposure(legs: readonly PolymarketExposureLeg[]): PolymarketExposureAggregate;
//# sourceMappingURL=polymarket-exit-race.d.ts.map