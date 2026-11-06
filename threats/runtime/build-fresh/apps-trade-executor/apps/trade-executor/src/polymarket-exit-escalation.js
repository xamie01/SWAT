import { UnrecoverableError } from 'bullmq';
import { floorToPolymarketTick } from './polymarket-mirror-bound.js';
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
export const POLYMARKET_EXIT_ESCALATION_BPS = [150, 400, 900];
/**
 * Effective resting life of each escalation rung.
 *
 * Two minutes is the documented minimum effective lifetime (a 3-minute
 * expiration less the venue's 1-minute security threshold). Chosen as the
 * minimum on purpose: a rung that rests longer than the next rung's price would
 * have been sensible is just a slower ladder.
 */
export const POLYMARKET_EXIT_RUNG_EFFECTIVE_MS = 120_000;
/** The venue's floor on how far ahead a GTD expiration may be set. */
export const POLYMARKET_GTD_MINIMUM_HORIZON_MS = 180_000;
/** The venue expires a GTD order this long before its stated expiration. */
export const POLYMARKET_GTD_SECURITY_THRESHOLD_MS = 60_000;
/**
 * Convert an effective resting lifetime into the `expiration` the venue wants.
 *
 * The documented formula is `now + 60 + N`. Refusing anything under the
 * documented 3-minute horizon rather than silently raising it, because a rejected
 * order on an exit ladder costs a rung.
 */
export function polymarketGtdExpiration(now, effectiveMs) {
    const horizonMs = effectiveMs + POLYMARKET_GTD_SECURITY_THRESHOLD_MS;
    if (!Number.isFinite(effectiveMs) || horizonMs < POLYMARKET_GTD_MINIMUM_HORIZON_MS) {
        throw new UnrecoverableError('Polymarket GTD expiration must be at least 3 minutes ahead, so the effective lifetime must be at least 120000ms');
    }
    return Math.floor((now + horizonMs) / 1000);
}
export function planPolymarketExitEscalation(input) {
    const ladder = input.escalationBps ?? POLYMARKET_EXIT_ESCALATION_BPS;
    if (!Number.isInteger(input.attempt) || input.attempt < 0) {
        throw new UnrecoverableError('Polymarket exit escalation attempt must be a non-negative integer');
    }
    // A ladder that does not deepen is not an escalation, and a non-integer or
    // out-of-range rung would produce a price nobody chose. Both are operator
    // configuration errors, so they raise rather than skip.
    for (const [index, rungBps] of ladder.entries()) {
        if (!Number.isInteger(rungBps) || rungBps <= 0 || rungBps > 10_000) {
            throw new UnrecoverableError(`Polymarket exit escalation rung ${rungBps} must be an integer from 1 to 10000 basis points`);
        }
        if (index > 0 && rungBps <= ladder[index - 1]) {
            throw new UnrecoverableError('Polymarket exit escalation rungs must increase strictly; a flat ladder re-offers a price that already failed');
        }
    }
    if (!Number.isFinite(input.referencePrice)
        || input.referencePrice <= 0
        || input.referencePrice >= 1) {
        throw new UnrecoverableError(`Polymarket exit reference price ${input.referencePrice} is not a valid outcome price`);
    }
    if (!Number.isFinite(input.minimumExitPrice)
        || input.minimumExitPrice <= 0
        || input.minimumExitPrice >= 1) {
        throw new UnrecoverableError('POLYMARKET_MIN_EXIT_PRICE must be between 0 and 1 exclusive');
    }
    if (!Number.isFinite(input.remainingShares) || input.remainingShares <= 1e-9) {
        return { kind: 'complete' };
    }
    // Checked before anything price-shaped: once the market stops taking orders no
    // rung can fill, and redemption has no deadline, so this is the exit.
    if (input.market.closed
        || !input.market.acceptingOrders
        || input.market.resolutionStatus !== 'unresolved') {
        return {
            kind: 'redeem',
            conditionId: input.market.conditionId,
            reason: `market ${input.market.conditionId} is no longer accepting orders (closed=${input.market.closed}, resolution=${input.market.resolutionStatus}); the remaining ${input.remainingShares} shares exit by redemption`
        };
    }
    if (input.remainingShares + 1e-9 < input.minimumShares) {
        return {
            kind: 'alert',
            code: 'residual-below-venue-minimum',
            // Not critical: the position is dust the venue will not accept in either
            // direction, and it redeems for its true value at resolution anyway.
            severity: 'warning',
            reason: `${input.remainingShares} shares remain, below the venue's ${input.minimumShares}-share minimum, so the residual cannot be sold and will settle at resolution`,
            remainingShares: input.remainingShares
        };
    }
    if (input.bestBid === null) {
        return {
            kind: 'alert',
            code: 'no-bid-liquidity',
            severity: 'critical',
            reason: `no bids exist for this outcome, so ${input.remainingShares} shares cannot be exited at any price`,
            remainingShares: input.remainingShares
        };
    }
    if (input.attempt >= ladder.length) {
        return {
            kind: 'alert',
            code: 'exit-escalation-exhausted',
            severity: 'critical',
            reason: `all ${ladder.length} escalation rungs (${ladder.join('/')} bps below ${input.referencePrice}) failed to fill; ${input.remainingShares} shares are still held`,
            remainingShares: input.remainingShares
        };
    }
    const rungBps = ladder[input.attempt];
    const price = floorToPolymarketTick(input.referencePrice * (1 - rungBps / 10_000), input.tickSize);
    if (price <= 0 || price < input.minimumExitPrice - 1e-9) {
        return {
            kind: 'alert',
            code: 'exit-price-floor-reached',
            severity: 'critical',
            reason: `the next escalation rung would price at ${price}, below the ${input.minimumExitPrice} exit floor; selling under the floor to force a fill is not a decision this executor makes`,
            remainingShares: input.remainingShares
        };
    }
    const rungEffectiveMs = input.rungEffectiveMs ?? POLYMARKET_EXIT_RUNG_EFFECTIVE_MS;
    return {
        kind: 'limit',
        attempt: input.attempt,
        rungBps,
        price,
        shares: input.remainingShares,
        expiration: polymarketGtdExpiration(input.now, rungEffectiveMs),
        effectiveLifetimeMs: rungEffectiveMs,
        crossesBook: price <= input.bestBid + 1e-9
    };
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
export async function escalatePolymarketExit(input, ports) {
    const now = ports.now ?? Date.now;
    const log = ports.log ?? (() => { });
    const ladderLength = (input.escalationBps ?? POLYMARKET_EXIT_ESCALATION_BPS).length;
    let observed = {
        remainingShares: input.remainingShares,
        bestBid: input.bestBid,
        minimumShares: input.minimumShares,
        tickSize: input.tickSize,
        market: input.market
    };
    let filledShares = 0;
    let rungsSubmitted = 0;
    let lastRungPrice = null;
    // Bounded by the ladder length plus one, so the terminal step is always
    // reached from a decision rather than from running out of iterations.
    for (let attempt = 0; attempt <= ladderLength; attempt += 1) {
        const step = planPolymarketExitEscalation({
            ...input,
            ...observed,
            attempt,
            now: now()
        });
        if (step.kind === 'complete') {
            return {
                rungsSubmitted,
                filledShares,
                remainingShares: observed.remainingShares,
                terminal: 'complete',
                alert: null,
                redeem: null
            };
        }
        if (step.kind === 'redeem') {
            await ports.requestRedemption(step);
            log(`[polymarket-exit] ${step.reason}`);
            return {
                rungsSubmitted,
                filledShares,
                remainingShares: observed.remainingShares,
                terminal: 'redeem',
                alert: null,
                redeem: step
            };
        }
        if (step.kind === 'alert') {
            await ports.emitAlert(step);
            log(`[polymarket-exit] ${step.code}: ${step.reason}`);
            return {
                rungsSubmitted,
                filledShares,
                remainingShares: observed.remainingShares,
                terminal: 'alert',
                alert: step,
                redeem: null
            };
        }
        // A coarse tick grid can collapse two rungs onto the same price. Re-offering
        // a price that already failed to fill would burn a rung and two minutes for
        // nothing, so the ladder advances instead of submitting it again.
        if (lastRungPrice !== null && step.price >= lastRungPrice - 1e-9) {
            log(`[polymarket-exit] rung ${step.attempt} at ${step.price} repeats the previous rung `
                + `on a ${observed.tickSize} tick grid; advancing`);
            continue;
        }
        const { filledShares: rungFill } = await ports.submitRung(step);
        lastRungPrice = step.price;
        rungsSubmitted += 1;
        filledShares += Math.max(0, rungFill);
        log(`[polymarket-exit] rung ${step.attempt} at ${step.price} (${step.rungBps} bps) `
            + `filled ${rungFill} of ${step.shares}`);
        observed = await ports.observe();
    }
    // Unreachable: the loop runs `ladderLength + 1` times and the final pass always
    // exhausts the ladder into an alert. Present so the contract is total rather
    // than relying on a reader to verify the bound.
    throw new UnrecoverableError('Polymarket exit escalation ended without a terminal decision');
}
//# sourceMappingURL=polymarket-exit-escalation.js.map