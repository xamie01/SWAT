/**
 * Which of a tracked wallet's events are worth mirroring (checklist `S4-M5`).
 *
 * **The failure this prevents.** Under ADR-0005 a user follows one master wallet
 * and copies that wallet's own trades. A master, being a human with more than one
 * address, also moves funds between their own wallets, tops up a hot wallet,
 * deposits to an exchange, and closes a $2 remainder. None of those is an opinion
 * about a token, and copying one spends the user's money on the master's
 * bookkeeping. "The master moved 40 SOL" must not become "you bought 40 SOL of
 * something".
 *
 * **Why this is a guard and not a repair.** Nothing writes a transfer into
 * `source_trades` today. The three builders in
 * `apps/indexer/src/source-trade-lifecycle.ts` can only express `buy` or `sell`:
 * the Solana one passes `CanonicalSolanaSwapEvent.direction`, which `parse.ts`
 * types `'buy' | 'sell'` and only produces for a two-sided balance change; the
 * Polymarket one maps the venue's `BUY`/`SELL`; the Robinhood one takes a
 * `'buy' | 'sell'` parameter. But the *storage* is wider than the writers:
 * `SourceTradeSide` is `'buy' | 'sell' | 'transfer_in' | 'transfer_out'`, and
 * migration `028_copy_execution_lifecycle.sql:77` widened the column's CHECK to
 * accept all four — deliberately, because `rebuildSourcePosition` in
 * `packages/db/src/copy-trade-lifecycle.ts` already ledgers `transfer_in` and
 * `transfer_out` into a wallet's holdings. So the schema is *ready* for transfer
 * ingestion, position accounting *wants* it, and the day someone adds a transfer
 * writer there will be no reason for them to think about the copy path. This
 * module is the reason they do not have to.
 *
 * **Why it is a whitelist rather than a transfer blocklist.** A blocklist has to
 * be extended for every new non-trade event, by whoever adds it, in a file they
 * are not editing. A whitelist refuses anything it does not recognise, so a new
 * side is discovery-only until someone deliberately classifies it here. That also
 * makes the answer to "what about LP and staking?" honest: this vocabulary has no
 * LP or staking category, so there is nothing to enumerate — they are excluded by
 * not being `buy` or `sell`, along with everything else nobody has thought of.
 * (See the caveat in the report for `S4-M5`: a *swap-shaped* LP deposit reaching
 * the Solana delta parser is labelled `buy` before it ever gets here, and no
 * side filter can undo that. That exclusion belongs to the parser.)
 *
 * **Why a module with its own test.** `index.ts` starts `setInterval` at import
 * (recorded debt, `S4-M26`), so nothing in it can be unit-tested. The same
 * reasoning that put `mayPatternTrade` in `trade-eligibility.ts` applies here:
 * a gate that decides whether money moves should be reachable by a test.
 *
 * Pure and fully injected — no `process.env`, no `Date.now()`. The threshold
 * arrives as a number the caller resolved once at startup.
 */
/**
 * Every side classified as mirrorable or not.
 *
 * A total `Record` over `SourceTradeSide` rather than a list of the good ones,
 * because that makes the classification *exhaustive by construction*: adding a
 * member to `SourceTradeSide` in `@swat/shared` fails to compile here until
 * somebody decides whether a user's money should follow it. A list would have
 * compiled fine and quietly defaulted the new side to "not mirrorable" — which is
 * the safe answer, but arrived at by accident rather than by decision, and with
 * no diff for a reviewer to see.
 */
const SIDE_MIRRORABILITY = Object.freeze({
    buy: true,
    sell: true,
    // A master consolidating their own addresses. Ledgered into their position by
    // `rebuildSourcePosition`, never mirrored: there is no counterparty, no price,
    // and no view being expressed.
    transfer_in: false,
    transfer_out: false
});
/**
 * The sides a copy may follow.
 *
 * Frozen, and the lookup below is a *copy*, for the same reason
 * `TRADE_ELIGIBLE_PATTERNS` is: `readonly` is a compile-time claim that vanishes
 * at runtime, and a `Set` handed out of a module stays mutable. Neither mutating
 * this array nor reaching into the record above can widen what mirrors.
 *
 * Exported so the test can assert the membership exactly — widening it has to
 * change that assertion, which puts the decision in a reviewable diff.
 */
export const MIRRORABLE_SOURCE_SIDES = Object.freeze(Object.keys(SIDE_MIRRORABILITY).filter((side) => SIDE_MIRRORABILITY[side]));
/** Private lookups, copied so external mutation cannot reach them. */
const MIRRORABLE = new Set(MIRRORABLE_SOURCE_SIDES);
const CLASSIFIED = new Set(Object.keys(SIDE_MIRRORABILITY));
/**
 * Validate the configured floor.
 *
 * Throws rather than degrading, following `resolveToleranceBps` in
 * `apps/trade-executor/src/polymarket-mirror-bound.ts`: a misconfigured floor is
 * an operator error, and the two ways of absorbing it are both worse than a
 * refusal to start. Coercing a bad value to `0` silently disables the gate for
 * every trade; skipping every trade silently stops the product. `index.ts`
 * already validates its other numeric env knobs at import for the same reason.
 *
 * Takes the raw string rather than reading `process.env` itself so the parsing
 * and its failure modes are testable.
 */
export function resolveMinimumMirrorableNotionalUsd(raw) {
    if (raw === undefined || raw.trim() === '')
        return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`SOURCE_COPY_MIN_NOTIONAL_USD must be a non-negative finite number, received ${JSON.stringify(raw)}`);
    }
    return value;
}
/**
 * Whether a tracked wallet's event is one a copy should follow.
 *
 * ## The NULL notional decision
 *
 * `amount_usd IS NULL` is an **unknown** notional, not a dust one, and the two get
 * different codes and different treatment. This matters more than it sounds,
 * because unknown is not an edge case here — it is the common case on two of
 * three chains:
 *
 *   * `buildRobinhoodSourceTradeInput` hardcodes `amountUsd: null`.
 *   * `deterministicSolanaPricing` returns `amountUsd: null` whenever neither leg
 *     is USDC or USDT, deliberately, so that externally-fetched metadata cannot
 *     enter the immutable source payload.
 *
 * So a blanket fail-closed on NULL is not a cautious default — it is an
 * undeclared kill switch on all of `robinhood-chain` and on every non-stable
 * Solana route, which would present as "copying quietly stopped working" rather
 * than as a policy. Equally, waving NULL through when an operator has set a $50
 * floor would make that floor a decoration.
 *
 * The floor's own value settles it, and the resolution is the honest one:
 *
 *   * **Floor is 0** — no claim about notional is being made, so there is nothing
 *     an unknown notional can fail. Mirror, reporting `notionalUsd: null` so the
 *     caller can see the decision was taken without a price rather than on a
 *     substituted zero. (0 is the shipped default, matching
 *     `COPY_MIN_SOURCE_ACTIVITY_USD=0` and its stated reason: notional is
 *     strategy-dependent, so the floor is opt-in.)
 *   * **Floor is above 0** — the operator has asserted a minimum, and an amount
 *     nobody recorded cannot be shown to clear it. Skip, as
 *     `source-notional-unknown` rather than `source-notional-below-minimum`, so
 *     the operator is told "we cannot price this chain's trades" and not "your
 *     master trades dust". The first is fixable; the second is a lie.
 *
 * A present-but-unparseable notional fails closed unconditionally: unlike NULL it
 * is evidence that something upstream is wrong, and no chain produces it by
 * design.
 */
export function evaluateMirrorableActivity(input) {
    const minimumNotionalUsd = input.minimumNotionalUsd;
    if (!Number.isFinite(minimumNotionalUsd) || minimumNotionalUsd < 0) {
        throw new Error(`minimumNotionalUsd must be a non-negative finite number, received ${String(minimumNotionalUsd)}`);
    }
    if (!MIRRORABLE.has(input.side)) {
        return CLASSIFIED.has(input.side)
            ? {
                kind: 'skip',
                code: 'source-side-not-mirrorable',
                reason: `the tracked wallet's event is a ${input.side}, which moves its own funds rather than taking a position, so there is nothing to copy`
            }
            : {
                kind: 'skip',
                code: 'source-side-unrecognised',
                reason: `the tracked wallet's event has side ${JSON.stringify(input.side)}, which is not a buy or a sell this build knows how to mirror`
            };
    }
    // Narrowing is safe only because `MIRRORABLE` is derived from the exhaustive
    // record above and contains exactly the two trade sides.
    const side = input.side;
    if (input.amountUsd === null || input.amountUsd === undefined) {
        if (minimumNotionalUsd === 0)
            return { kind: 'mirror', side, notionalUsd: null };
        return {
            kind: 'skip',
            code: 'source-notional-unknown',
            reason: `no USD notional is recorded for this ${side}, so it cannot be shown to clear the ${minimumNotionalUsd} USD minimum`
        };
    }
    let notionalUsd;
    if (typeof input.amountUsd === 'number') {
        notionalUsd = input.amountUsd;
    }
    else {
        const text = input.amountUsd.trim();
        // `Number('')` and `Number('   ')` are **0**, not NaN. Coercing first would
        // turn an empty notional into a real zero-dollar trade and mirror it
        // whenever the floor is 0, so emptiness is decided before the coercion.
        notionalUsd = text === '' ? Number.NaN : Number(text);
    }
    if (!Number.isFinite(notionalUsd) || notionalUsd < 0) {
        return {
            kind: 'skip',
            code: 'source-notional-unreadable',
            reason: `the recorded USD notional ${JSON.stringify(input.amountUsd)} is not a usable amount, so this ${side} cannot be sized or bounded`
        };
    }
    if (notionalUsd < minimumNotionalUsd) {
        return {
            kind: 'skip',
            code: 'source-notional-below-minimum',
            reason: `this ${side} is ${notionalUsd} USD, below the ${minimumNotionalUsd} USD minimum — too small to be worth a fee and a slippage bound`
        };
    }
    return { kind: 'mirror', side, notionalUsd };
}
//# sourceMappingURL=mirrorable-activity.js.map