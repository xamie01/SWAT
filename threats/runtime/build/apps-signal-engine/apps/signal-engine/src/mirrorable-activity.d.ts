import type { SourceTradeSide } from '@swat/shared';
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
export declare const MIRRORABLE_SOURCE_SIDES: readonly SourceTradeSide[];
/**
 * Why a source event was not mirrored.
 *
 * Codes, not prose, because `S4-M24` needs a skip a user can act on: "your
 * master moved funds between their own wallets" and "we could not price your
 * master's trade, and you have a $50 floor set" call for different responses, and
 * a single `mirrorable: false` collapses them into a shrug.
 */
export type MirrorableActivitySkipCode = 
/** A classified non-trade — today that means a transfer between the master's own addresses. */
'source-side-not-mirrorable'
/** A side this module has never classified. Fails closed. */
 | 'source-side-unrecognised'
/** Real, priced, and too small to be worth a fee and a slippage bound. */
 | 'source-notional-below-minimum'
/** No USD notional recorded, and a floor is set that it therefore cannot be proven to clear. */
 | 'source-notional-unknown'
/** A notional that is present but not a usable number. Fails closed. */
 | 'source-notional-unreadable';
export interface MirrorableActivityMirror {
    readonly kind: 'mirror';
    /** Narrowed from the loose input, so the caller does not re-derive it. */
    readonly side: 'buy' | 'sell';
    /**
     * The USD notional this decision was taken on, or `null` when none was
     * recorded and no floor was set. Never a substituted value.
     */
    readonly notionalUsd: number | null;
}
export interface MirrorableActivitySkip {
    readonly kind: 'skip';
    readonly code: MirrorableActivitySkipCode;
    /** Operator- and user-readable, and specific enough to act on. */
    readonly reason: string;
}
export type MirrorableActivityDecision = MirrorableActivityMirror | MirrorableActivitySkip;
export interface MirrorableActivityInput {
    /**
     * `source_trades.direction`.
     *
     * Typed `string`, not `SourceTradeSide`, on purpose. `SourceTradeSignalCandidate.side`
     * is declared `'buy' | 'sell'`, but that is an *assertion about a SQL query*
     * (`listSourceTradeSignalCandidates`), not a runtime guarantee — the column
     * accepts four values and the row is mapped straight through. A type that
     * cannot be wrong makes a fail-closed branch unreachable and untestable, which
     * is precisely the shape that lets an unknown side through.
     */
    readonly side: string;
    /**
     * `source_trades.amount_usd`, verified nullable at
     * `packages/db/sql/023_copy_trade_lifecycle.sql:10` and surfaced as
     * `amount_usd::text`, hence `string | null`.
     */
    readonly amountUsd: string | number | null | undefined;
    /**
     * Minimum USD notional. `0` disables the floor — see
     * {@link resolveMinimumMirrorableNotionalUsd}.
     */
    readonly minimumNotionalUsd: number;
}
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
export declare function resolveMinimumMirrorableNotionalUsd(raw: string | undefined): number;
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
export declare function evaluateMirrorableActivity(input: MirrorableActivityInput): MirrorableActivityDecision;
//# sourceMappingURL=mirrorable-activity.d.ts.map