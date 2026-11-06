/**
 * Per-user concurrent-position cap (`S4-M4`, migration `049`), and the derived
 * below-minimum warning that belongs at the slider rather than in a skip reason.
 *
 * Everything in this module is **pure**: no database, no clock, no network. The
 * cap itself is a column on `user_execution_settings` (see
 * `user-execution-settings.ts`); what lives here is the arithmetic the API and the
 * UI both need to answer *"is the number you just typed going to work?"* before it
 * is stored.
 *
 * Two separate jobs, deliberately not merged:
 *
 *   * `clampConcurrentPositionCap` applies the **platform hard ceiling**. That is a
 *     platform decision, not a user preference, so it is enforced here and mirrored
 *     by a CHECK in `049` — a caller that skips this function still cannot write a
 *     value past the ceiling.
 *   * `assessPositionCap` derives the **warning**. It is advisory by construction:
 *     it never changes the cap, because the honest minimums it can reach at
 *     configuration time are approximations (see below) and an approximation must
 *     not silently overrule what a user asked for.
 */
/**
 * The platform hard ceiling on one user's concurrent positions.
 *
 * **The shape of the argument is real; the exact number is a judgement.** Stated
 * plainly so nobody reads 50 as a measured limit.
 *
 * Every open position is a *future forced exit* the platform is obliged to act on.
 * Stop-loss evaluation rides the mark-to-market cadence, which is **every 5
 * minutes** (`apps/scorer/src/index.ts` — "Mark-to-market every 5 minutes"), and
 * exits are submitted through the per-chain trade queues, each served by **exactly
 * one concurrency-1 worker** (`TRADE_QUEUES_BY_CHAIN`, `apps/trade-executor`). A
 * market-wide drawdown fires stop-losses on many of a user's positions at once, and
 * those exits then serialise behind that single worker. If the queue cannot drain
 * inside the 5-minute window, the next evaluation re-fires on positions whose exit
 * is still queued.
 *
 * So the ceiling is a *blast-radius bound on one user's share of a serialised exit
 * queue*. At a conservative 6 seconds per exit — a fresh book read (Polymarket
 * refuses a book older than `POLYMARKET_MAX_BOOK_AGE_MS=15000`), a signature and a
 * submission — one worker drains about 300/6 = 50 orders per window. 50 is that
 * number.
 *
 * **What this ceiling does NOT promise.** The queue is shared across all users, so
 * ten users at the ceiling put 500 exits behind one worker and the window is blown
 * regardless. A per-user ceiling cannot bound an aggregate; only per-chain
 * admission control can, and that does not exist. The 6-seconds-per-exit figure is
 * an estimate, not a measurement — nothing in this repo records observed exit
 * latency. Treat 50 as "small enough that one user alone is not the problem", and
 * revisit it against real latency once exits run in production.
 */
export const PLATFORM_MAX_CONCURRENT_POSITIONS = 50;
/**
 * The floor is 1, not 0.
 *
 * A cap of 0 would mean "never open a position", which the settings row already
 * expresses twice and more legibly — `killed` (the per-user kill switch) and a
 * per-chain `mode` of `off`. Admitting 0 here would create a third way to say stop,
 * one that reads to a skimming operator as "unlimited" rather than as "halted".
 */
export const MIN_CONCURRENT_POSITIONS = 1;
/**
 * The default for a user who has never touched the control.
 *
 * Derived from the other defaults in `049` rather than picked: `max_position_pct`
 * defaults to 5 and `max_daily_exposure_pct` to 25, so five positions at the
 * default per-position size is exactly the point where the default daily exposure
 * cap is used up. A default above that would ship a cap that the daily limit makes
 * unreachable, which is a control that appears to do something and does not.
 */
export const DEFAULT_MAX_CONCURRENT_POSITIONS = 5;
/**
 * Per-chain minimum order notional, as far as it is honestly knowable at
 * configuration time.
 *
 * Typed `Record<Chain, ...>` so adding a chain to the union fails to compile until
 * somebody decides what its minimum is. A silent `undefined` would read as
 * "no minimum" and quietly stop warning.
 *
 * **Polymarket (polygon) is the only venue here with a minimum at all.** Solana
 * routes through the Jupiter aggregator and Robinhood Chain through a Uniswap V3
 * router (`apps/trade-executor/src/robinhood.ts` — `uniswap-v3-swap-router-01/02`);
 * both are AMMs and will quote any size. They have *economic* floors — Solana ATA
 * rent, priority fees, gas — but those are costs, not a venue rule that rejects an
 * order, and a trade under them is not "skipped", it is merely bad value. Modelling
 * them as a minimum order size would be inventing a rule the venue does not have,
 * so this warning does not cover them and says so.
 */
export const VENUE_MINIMUM_ORDER_NOTIONAL_USD = Object.freeze({
    polygon: Object.freeze({
        chain: 'polygon',
        // 5 is the value Polymarket's own docs use in every worked example of a
        // market's trading constraints (`market-data/market-details`, whose Gamma
        // mapping shows `orderMinSize: 5`, and `trading/place-orders`, whose order-book
        // sample shows `min_order_size: "5"`). It is NOT a platform-wide constant: the
        // real value is per market and this executor already reads it per order from
        // the book (`book.minOrderSize` in `apps/trade-executor/src/polymarket.ts`,
        // enforced in `polymarket-mirror-bound.ts`). Hence `approximate: true`.
        minOrderNotionalUsd: 5,
        basis: 'venue-enforced-per-market',
        approximate: true,
        note: 'Typical Polymarket per-market minimum. The binding value is read from the '
            + 'order book at submission and may be higher or lower for the market a copy '
            + 'lands in. Polymarket documents the units inconsistently: '
            + 'market-data/market-details calls minimumOrderSize a USDC notional while '
            + 'trading/place-orders calls min_order_size a share count. This executor '
            + 'treats it as a share count. Since an outcome share costs under $1, a share '
            + 'count of 5 needs at most $5 of notional, so comparing against $5 warns at '
            + 'or before the real boundary under either reading.'
    }),
    solana: Object.freeze({
        chain: 'solana',
        minOrderNotionalUsd: 0,
        basis: 'no-venue-minimum',
        approximate: false,
        note: 'Jupiter is an AMM aggregator and quotes any size. Rent, priority fees and '
            + 'slippage make a tiny swap poor value, but no venue rule rejects it, so '
            + 'there is no minimum order size to warn about.'
    }),
    'robinhood-chain': Object.freeze({
        chain: 'robinhood-chain',
        minOrderNotionalUsd: 0,
        basis: 'no-venue-minimum',
        approximate: false,
        note: 'A Uniswap V3 router quotes any size. Gas makes a tiny swap poor value, but '
            + 'no venue rule rejects it, so there is no minimum order size to warn about.'
    }),
    base: Object.freeze({
        chain: 'base',
        minOrderNotionalUsd: 0,
        basis: 'no-venue-minimum',
        approximate: false,
        note: 'Uniswap v3 quotes any size.'
    }),
    ethereum: Object.freeze({
        chain: 'ethereum',
        minOrderNotionalUsd: 0,
        basis: 'no-venue-minimum',
        approximate: false,
        note: 'Uniswap v3 quotes any size.'
    }),
    bsc: Object.freeze({
        chain: 'bsc',
        minOrderNotionalUsd: 0,
        basis: 'no-venue-minimum',
        approximate: false,
        note: 'PancakeSwap v3 quotes any size.'
    })
});
/**
 * A requested cap is not an integer in range.
 *
 * Separate from clamping on purpose. A request of 500 is a *coherent* wish the
 * platform declines, and clamping it to 50 is a defensible answer. A request of
 * `2.5` or `NaN` is not a wish about position counts at all, and clamping it would
 * be guessing which number the caller meant.
 */
export class InvalidPositionCapError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidPositionCapError';
    }
}
/**
 * Brings a requested cap inside `[MIN_CONCURRENT_POSITIONS, ceiling]`.
 *
 * Clamps rather than rejects an out-of-range integer so the UI can show the user
 * what they will actually get, and reports *which* bound moved it so the UI can say
 * so instead of silently displaying a different number than was typed.
 */
export function clampConcurrentPositionCap(requested, ceiling = PLATFORM_MAX_CONCURRENT_POSITIONS) {
    if (!Number.isInteger(requested)) {
        throw new InvalidPositionCapError(`maxConcurrentPositions must be an integer, got ${requested}`);
    }
    if (!Number.isInteger(ceiling) || ceiling < MIN_CONCURRENT_POSITIONS) {
        throw new InvalidPositionCapError(`position cap ceiling must be an integer >= ${MIN_CONCURRENT_POSITIONS}, got ${ceiling}`);
    }
    if (requested > ceiling) {
        return { cap: ceiling, clampedByCeiling: true, clampedByFloor: false, ceiling };
    }
    if (requested < MIN_CONCURRENT_POSITIONS) {
        return {
            cap: MIN_CONCURRENT_POSITIONS,
            clampedByCeiling: false,
            clampedByFloor: true,
            ceiling
        };
    }
    return { cap: requested, clampedByCeiling: false, clampedByFloor: false, ceiling };
}
/**
 * What one copy is worth when the user is holding `cap` positions at once.
 *
 * Two limits, and the tighter one binds:
 *
 *   * `maxPositionPct` caps a single position as a share of the balance. It does
 *     not shrink as the cap rises.
 *   * Holding `cap` positions simultaneously out of one balance means each gets at
 *     most `balance / cap`. This is the term the slider moves, and it is why the
 *     warning exists at all: past `balance / minimum` positions, every copy is
 *     under the venue minimum no matter what `maxPositionPct` says.
 *
 * Exported because the UI needs the same number the warning was computed from, and
 * a second implementation in the frontend would drift.
 */
export function perPositionNotionalUsd(balanceUsd, cap, maxPositionPct) {
    if (!Number.isFinite(balanceUsd) || balanceUsd < 0) {
        throw new InvalidPositionCapError(`balanceUsd must be a non-negative finite number, got ${balanceUsd}`);
    }
    if (!Number.isInteger(cap) || cap < 1) {
        throw new InvalidPositionCapError(`cap must be an integer >= 1, got ${cap}`);
    }
    if (!Number.isFinite(maxPositionPct) || maxPositionPct <= 0 || maxPositionPct > 100) {
        throw new InvalidPositionCapError(`maxPositionPct must be in (0, 100], got ${maxPositionPct}`);
    }
    return balanceUsd * Math.min(maxPositionPct / 100, 1 / cap);
}
/**
 * Comparison tolerance, so a balance that divides to exactly the minimum in exact
 * arithmetic is not warned about because float division landed a hair under.
 *
 * A cent is far below any venue minimum, so this cannot mask a real breach.
 */
const NOTIONAL_EPSILON = 1e-9;
/**
 * The derived warning, for a proposed cap.
 *
 * **Advisory only.** It returns the clamped cap so the caller can display it, but
 * the warnings never alter it: the minimums available at configuration time are
 * approximations, and an approximation must not override what a user asked for.
 *
 * Fails *loud* on an incoherent input (`InvalidPositionCapError`) and *closed* on a
 * missing one — an unknown balance produces an `unassessed` entry, never a silent
 * pass. Pure: no database, no clock.
 */
export function assessPositionCap(input) {
    const clamped = clampConcurrentPositionCap(input.requestedCap, input.ceiling);
    const minimums = input.minimums ?? VENUE_MINIMUM_ORDER_NOTIONAL_USD;
    const warnings = [];
    const unassessed = [];
    for (const chain of Object.keys(minimums)) {
        const minimum = minimums[chain];
        if (minimum.basis === 'no-venue-minimum') {
            unassessed.push({ chain, reason: 'no-venue-minimum' });
            continue;
        }
        const balanceUsd = input.balancesUsd[chain];
        if (balanceUsd === null || balanceUsd === undefined || !Number.isFinite(balanceUsd)) {
            unassessed.push({ chain, reason: 'balance-unknown' });
            continue;
        }
        const perPositionUsd = perPositionNotionalUsd(balanceUsd, clamped.cap, input.maxPositionPct);
        if (perPositionUsd + NOTIONAL_EPSILON >= minimum.minOrderNotionalUsd)
            continue;
        // The highest cap at which balance/cap still clears the minimum. Floor, because
        // a fractional cap is not a cap. Zero when the balance cannot fund one order.
        const maxCapClearingMinimum = Math.floor((balanceUsd + NOTIONAL_EPSILON) / minimum.minOrderNotionalUsd);
        // Which of the two terms in `perPositionNotionalUsd` is actually under the
        // minimum decides the code, because the two have different fixes. Checked on
        // the percentage term alone: if THAT is short, no cap value rescues it.
        const pctTermUsd = balanceUsd * (input.maxPositionPct / 100);
        const pctTermShort = pctTermUsd + NOTIONAL_EPSILON < minimum.minOrderNotionalUsd;
        const approximateSuffix = minimum.approximate
            ? ' This uses a typical minimum, not the one for the specific market; the '
                + 'binding value is read from the order book when the order is placed.'
            : '';
        warnings.push({
            chain,
            code: pctTermShort
                ? 'position-pct-below-venue-minimum'
                : 'cap-spreads-balance-below-venue-minimum',
            perPositionUsd,
            minOrderNotionalUsd: minimum.minOrderNotionalUsd,
            approximate: minimum.approximate,
            maxCapClearingMinimum,
            message: pctTermShort
                ? `At $${balanceUsd} on ${chain}, ${input.maxPositionPct}% per position is `
                    + `$${pctTermUsd}, below the ~$${minimum.minOrderNotionalUsd} minimum order `
                    + 'size — every copy would be skipped at any position cap. Raise the '
                    + 'per-position size or add funds.'
                    + approximateSuffix
                : `At $${balanceUsd} on ${chain}, ${clamped.cap} concurrent positions leaves `
                    + `$${perPositionUsd} per copy, below the ~$${minimum.minOrderNotionalUsd} `
                    + 'minimum order size, so every copy would be skipped. '
                    + (maxCapClearingMinimum >= MIN_CONCURRENT_POSITIONS
                        ? `At most ${maxCapClearingMinimum} position`
                            + `${maxCapClearingMinimum === 1 ? '' : 's'} clears it at this balance.`
                        : 'This balance cannot fund even one order.')
                    + approximateSuffix
        });
    }
    return {
        requestedCap: input.requestedCap,
        effectiveCap: clamped.cap,
        clampedByCeiling: clamped.clampedByCeiling,
        clampedByFloor: clamped.clampedByFloor,
        ceiling: clamped.ceiling,
        warnings,
        unassessed
    };
}
//# sourceMappingURL=position-cap.js.map