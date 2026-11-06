import type { PolymarketMarketState } from './polymarket-market-state.js';
/**
 * Escalation ladder for a Polymarket exit that did not fill (checklist `S4-M17`).
 *
 * **Why exits get an escalation and entries do not.** A missed entry costs the
 * user an opportunity. A missed *exit* leaves them holding a position their
 * master has already left — long exposure nobody chose, on an outcome that is
 * about to become worth 1 or 0. So the FAK-only rule from `S4-M16` is an *entry*
 * rule. An exit that must complete is allowed to rest, and this module is the
 * bounded way it does so.
 *
 * **The ladder.** Rung zero is the original FAK submitted by `triggerPolymarket`.
 * Each escalation rung after that is a **GTD limit** priced progressively further
 * below the reference — the price the master exited at — so each attempt gives up
 * a little more to get out. Verified against `trading/place-orders`:
 *
 *   * A limit order "can rest on the book until it fills, expires, or you cancel
 *     it", and GTD "remains active until the expiration time you specify".
 *   * "GTD orders expire one minute before their stated expiration as a security
 *     threshold. To set an effective lifetime of N seconds, use `now + 60 + N`.
 *     In addition, the expiration must be at least **3 minutes** in the future —
 *     orders expiring sooner are rejected — so the minimum effective lifetime is
 *     about two minutes."
 *   * "The price must follow the market's minimum price increment" — so every rung
 *     price is placed on the tick grid.
 *
 * **Which way rungs round, and why it differs from `S4-M16`.** An entry bound
 * rounds so it can only tighten, because there the grid must never re-price what
 * the user was quoted. A rung rounds *down*, because a rung exists to fill and
 * rounding up concedes nothing — on a 0.01 grid a 150 bps rung off 0.59 would
 * round back to 0.59 and re-submit the price that just failed. The overshoot is
 * at most one tick and the whole ladder is floored by `POLYMARKET_MIN_EXIT_PRICE`,
 * so the concession stays bounded by an operator-set number rather than by
 * arithmetic.
 *
 * **What `referencePrice` is.** The price the attempt that just failed was
 * bounded at — the `S4-M16` mirror bound for the first escalation. Not the
 * master's raw fill: rungs measured from a price we never actually offered would
 * spend their first step re-offering it.
 *
 * GTD rather than GTC deliberately: a GTC exit that never fills is the original
 * problem with extra steps, and it would still be resting when the market
 * resolves. Each rung dies on its own.
 *
 * **Why it terminates in an alert rather than in a deeper price.** Two floors
 * bound the ladder, and hitting either is a human's decision, not ours:
 *
 *   * `POLYMARKET_MIN_EXIT_PRICE` — dumping below the operator's configured floor
 *     to "complete" an exit converts a stuck position into a realised loss.
 *   * ladder exhaustion — three rungs that all failed to fill is a liquidity
 *     fact, and the next lever (redeem, hold, or manual unwind) is a judgement.
 *
 * **Why a resolving market short-circuits to redemption.** Once the market stops
 * accepting orders no price fills, so escalating is pure latency. Redemption is
 * the exit (`S4-M19`), and it has no deadline, so routing there is strictly
 * better than alerting a human about an order that cannot exist.
 *
 * Pure planner plus a driver whose every port is injected (Standing Rule 2), so
 * the ladder can be tested without a venue and the signer stays a parameter.
 */
/** Basis points below the reference price for each escalation rung, in order. */
export declare const POLYMARKET_EXIT_ESCALATION_BPS: readonly number[];
/**
 * Effective resting life of each escalation rung.
 *
 * Two minutes is the documented minimum effective lifetime (a 3-minute
 * expiration less the venue's 1-minute security threshold). Chosen as the
 * minimum on purpose: a rung that rests longer than the next rung's price would
 * have been sensible is just a slower ladder.
 */
export declare const POLYMARKET_EXIT_RUNG_EFFECTIVE_MS = 120000;
/** The venue's floor on how far ahead a GTD expiration may be set. */
export declare const POLYMARKET_GTD_MINIMUM_HORIZON_MS = 180000;
/** The venue expires a GTD order this long before its stated expiration. */
export declare const POLYMARKET_GTD_SECURITY_THRESHOLD_MS = 60000;
export type PolymarketExitAlertCode = 
/** Every rung was submitted and none filled. */
'exit-escalation-exhausted'
/** The next rung would price below the operator's configured exit floor. */
 | 'exit-price-floor-reached'
/** What is left is too small for the venue to accept, so it cannot be sold. */
 | 'residual-below-venue-minimum'
/** There is no bid at all; nothing to escalate into. */
 | 'no-bid-liquidity';
export interface PolymarketExitLimitRung {
    readonly kind: 'limit';
    /** Zero-based escalation attempt this rung represents. */
    readonly attempt: number;
    readonly rungBps: number;
    /** On the market's tick grid, floored to it so the rung actually concedes. */
    readonly price: number;
    readonly shares: number;
    /** Unix seconds, already including the venue's 1-minute security threshold. */
    readonly expiration: number;
    /** How long the rung actually rests before the venue kills it. */
    readonly effectiveLifetimeMs: number;
    /** True when the rung is at or below the best bid and should fill on arrival. */
    readonly crossesBook: boolean;
}
export interface PolymarketExitRedeem {
    readonly kind: 'redeem';
    readonly conditionId: string;
    readonly reason: string;
}
export interface PolymarketExitAlert {
    readonly kind: 'alert';
    readonly code: PolymarketExitAlertCode;
    readonly severity: 'warning' | 'critical';
    readonly reason: string;
    readonly remainingShares: number;
}
export interface PolymarketExitComplete {
    readonly kind: 'complete';
}
export type PolymarketExitStep = PolymarketExitLimitRung | PolymarketExitRedeem | PolymarketExitAlert | PolymarketExitComplete;
export interface PolymarketExitEscalationInput {
    /** Escalation attempts already made. 0 means the FAK has failed and nothing else has run. */
    readonly attempt: number;
    readonly remainingShares: number;
    /** `min_order_size` from the order book — a share count, not a notional. */
    readonly minimumShares: number;
    readonly tickSize: number;
    /** Price the last unfilled attempt was bounded at; rungs measure down from it. */
    readonly referencePrice: number;
    /** Current best bid, or null when the bid side is empty. */
    readonly bestBid: number | null;
    /** `POLYMARKET_MIN_EXIT_PRICE`; the ladder never prices below it. */
    readonly minimumExitPrice: number;
    readonly market: Pick<PolymarketMarketState, 'conditionId' | 'acceptingOrders' | 'closed' | 'resolutionStatus'>;
    readonly now: number;
    readonly escalationBps?: readonly number[];
    readonly rungEffectiveMs?: number;
}
/**
 * Convert an effective resting lifetime into the `expiration` the venue wants.
 *
 * The documented formula is `now + 60 + N`. Refusing anything under the
 * documented 3-minute horizon rather than silently raising it, because a rejected
 * order on an exit ladder costs a rung.
 */
export declare function polymarketGtdExpiration(now: number, effectiveMs: number): number;
export declare function planPolymarketExitEscalation(input: PolymarketExitEscalationInput): PolymarketExitStep;
export interface PolymarketExitEscalationPorts {
    /** Submit one GTD limit rung and report how many shares it filled. */
    readonly submitRung: (rung: PolymarketExitLimitRung) => Promise<{
        filledShares: number;
    }>;
    /** Re-read the live inputs between rungs; the book and the market both move. */
    readonly observe: () => Promise<{
        remainingShares: number;
        bestBid: number | null;
        minimumShares: number;
        tickSize: number;
        market: PolymarketExitEscalationInput['market'];
    }>;
    readonly emitAlert: (alert: PolymarketExitAlert) => Promise<void>;
    /** Hand a resolved market to the redemption sweep instead of escalating. */
    readonly requestRedemption: (redeem: PolymarketExitRedeem) => Promise<void>;
    readonly now?: () => number;
    readonly log?: (message: string) => void;
}
export interface PolymarketExitEscalationOutcome {
    readonly rungsSubmitted: number;
    readonly filledShares: number;
    readonly remainingShares: number;
    readonly terminal: 'complete' | 'redeem' | 'alert';
    readonly alert: PolymarketExitAlert | null;
    readonly redeem: PolymarketExitRedeem | null;
}
/**
 * Walk the ladder until the position is out, the market resolves, or a bound is
 * hit.
 *
 * The loop re-observes between rungs rather than trusting the snapshot it started
 * with: a two-minute rung is long enough for the book to empty or the market to
 * stop accepting orders, and escalating against a stale reading is how an exit
 * ends up priced into a market that no longer exists.
 */
export declare function escalatePolymarketExit(input: Omit<PolymarketExitEscalationInput, 'attempt' | 'now'>, ports: PolymarketExitEscalationPorts): Promise<PolymarketExitEscalationOutcome>;
//# sourceMappingURL=polymarket-exit-escalation.d.ts.map