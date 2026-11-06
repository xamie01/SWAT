/**
 * The read side of the Polymarket order-book bridge (`S4-M38`, and the feed
 * `S4-M6` has been waiting on).
 *
 * ── What this closes ──────────────────────────────────────────────────────
 *
 * `indexer` streams books into Redis (`polymarket-book-subscriber.ts` writing
 * through `createPolymarketBookPublisher`). `signal-engine` decides fan-out. The
 * two are separate processes, so the subscriber's in-process cache is invisible
 * here, and until this module existed `resolveFanoutCapacity` was called without
 * a `polymarketBook` argument at all. Its own doc comment names the consequence:
 * omitted means *no subscriber is wired*, which makes every polygon fan-out
 * `capacity-unknown`, which under `unassessablePolicy: 'skip'` admits nobody.
 *
 * This module turns one Redis read into the `UsableLiquidity` that call site
 * takes. It is the only new fact in the path; every decision it rests on was
 * already built and tested elsewhere:
 *
 *   * whether a cached entry is fresh, decodable and version-compatible —
 *     `loadPolymarketBookEntry` / `buildPolymarketBookSnapshot`
 *     (`packages/shared/src/polymarket-book-transport.ts`);
 *   * what a ladder is worth inside a bps bound, and which of the seven unknown
 *     causes applies — `assessPolymarketBookDepth`
 *     (`packages/shared/src/polymarket-book-depth.ts`);
 *   * what the cap does with the figure — `assessMasterCapacity`
 *     (`packages/db/src/master-capacity.ts`).
 *
 * ── Calibration is the reason this takes a cap argument ───────────────────
 *
 * The depth model does not publish raw depth. It publishes
 * `capacityNotionalUsd * 10_000 / impactCapBps` — an *equivalent one-sided
 * reserve* chosen so that the constant-product `priceImpactBps(N, reserve)` the
 * cap already runs stays within the cap exactly when `N` fits the real book walk.
 * That equality holds only at the cap the reserve was built for.
 *
 * So the cap in force has to be known **before** the book is read, not after. It
 * is a per-master, per-chain value (`master_capacity_policy.max_aggregate_impact_bps`
 * overriding `PLATFORM_MAX_AGGREGATE_IMPACT_BPS[chain]`), which is why `read`
 * takes `impactCapBps` per call rather than fixing one at construction: a single
 * signal-engine process fans out for many masters, and a reader that cached one
 * master's cap would price another master's book against the wrong denominator
 * and be wrong in a direction nothing downstream could detect.
 *
 * `assertPolymarketBookLiquidityCalibration` is run on every priced verdict for
 * exactly that reason — it is cheap, and a mismatch here is a fail-open bug.
 *
 * ── Unknown is never a number, and never "fine" ───────────────────────────
 *
 * Every failure — no key, stale entry, undecodable value, version skew, empty
 * or crossed ladder, a transport that threw — returns `unknownLiquidity`, never
 * `0` and never a last-known value. Zero is a *figure*: it would flow into the
 * cap as "this market has no liquidity" and produce a confident refusal, where
 * unknown produces `capacity-unknown` and sends an operator to the feed. The
 * distinction is the whole discipline of `S4-M41`/`S4-M42` and it is the single
 * most load-bearing line in this file.
 *
 * ── Never throws ──────────────────────────────────────────────────────────
 *
 * `resolveFanoutCapacity` wraps its reads in a try/catch that returns
 * `capacity: null` on any throw — which excludes everyone on *every* chain in
 * that fan-out, not just polygon. A Redis blip must not do that. So this returns
 * unknown-with-a-note instead, which lands in the same safe place while saying
 * which of the two happened.
 */
import type { Chain } from '@swat/shared';
import { type PolymarketBookDepthVerdict, type PolymarketBookKeyValueTransport } from '@swat/shared';
import { type UsableLiquidity } from '@swat/db';
/**
 * The chain whose liquidity is an order book rather than a pool.
 *
 * Named rather than inlined so the one place that knows this is the one place
 * that has to change if another CLOB venue is ever added.
 */
export declare const POLYMARKET_BOOK_CHAIN: Chain;
export interface PolymarketBookLiquidityReaderOptions {
    readonly transport: PolymarketBookKeyValueTransport;
    /** Injected clock. Nothing in this module calls `Date.now()`. */
    readonly now: () => number;
    /**
     * Freshness budget. Defaults to the shared `POLYMARKET_BOOK_MAX_AGE_MS`, which
     * the subscriber's resync cadence is asserted against
     * (`assertPolymarketBookResyncBudget`). Overriding it here without moving that
     * cadence would make entries read stale that the writer believes it is
     * refreshing in time.
     */
    readonly maxAgeMs?: number;
    readonly logger?: {
        readonly warn: (message: string, error?: unknown) => void;
    };
}
export interface PolymarketBookLiquidityRequest {
    /**
     * Chain-prefixed as the repo stores it (`polygon:<tokenId>`). The transport
     * strips the prefix to derive the key, so either form reads the same slot; the
     * prefixed form is what the rest of the fan-out path carries.
     */
    readonly tokenMint: string;
    /** The direction the **cohort** trades. Picks the side of the book consumed. */
    readonly cohortDirection: 'buy' | 'sell';
    /**
     * The aggregate impact cap in force for this master on this chain. Required:
     * the published reserve is exact only at its own cap, so there is no safe
     * default here and a wrong one fails open.
     */
    readonly impactCapBps: number;
    /** Optional bound override, forwarded to the depth model unchanged. */
    readonly boundBps?: number;
}
export interface PolymarketBookLiquidityRead {
    /** Exactly what `resolveFanoutCapacity`'s `polymarketBook` param takes. */
    readonly liquidity: UsableLiquidity;
    /**
     * The verdict behind it, or `null` when the read failed before one could be
     * formed. Carries the stable unknown code an operator needs.
     */
    readonly verdict: PolymarketBookDepthVerdict | null;
    /** One ops line. Carries figures, so it is never rendered to a user. */
    readonly logLine: string;
}
export interface PolymarketBookLiquidityReader {
    readonly read: (request: PolymarketBookLiquidityRequest) => Promise<PolymarketBookLiquidityRead>;
    /** The freshness budget in force, so a service can log what it configured. */
    readonly maxAgeMs: number;
}
/**
 * Wrong-chain guard, as a pure function so the rule is testable without a
 * transport.
 *
 * A caller asking for Solana book depth has a bug, but throwing would abort the
 * whole fan-out through `resolveFanoutCapacity`'s catch — punishing every chain
 * in that signal for one caller's mistake. Unknown-with-a-note fails closed in
 * the ordinary way and names the caller error in the place an operator reads.
 */
export declare function polymarketBookChainMismatch(chain: Chain, tokenMint: string): UsableLiquidity | null;
/**
 * Turn a depth verdict into the fan-out's liquidity input. Pure.
 *
 * Split from the I/O so every branch here is testable with no transport at all,
 * matching `pusd-liquidity.ts` and `master-capacity.ts`.
 *
 * **The `'assessed'` check is on the outcome, not on the figure being truthy.**
 * `no-depth-within-bound` is a *known zero* — the ladder was read and holds
 * nothing inside the bound — and it is deliberately routed to unknown here, not
 * published as `0`. The reasoning: the depth model already sets
 * `liquidity.basis: 'unknown'` on that outcome (it publishes a reserve only on
 * `'assessed'`), so passing it through as a figure would require inventing one.
 * The note preserves which of the two it was, so an operator is not sent to the
 * feed for a market that is merely empty.
 */
export declare function usableLiquidityFromBookVerdict(verdict: PolymarketBookDepthVerdict, impactCapBps: number): UsableLiquidity;
/**
 * One Redis read, one pure assessment, one liquidity value.
 *
 * **No local caching between calls, deliberately.** The fan-out runs on a 15s
 * interval and the entry TTL is tens of seconds; a memo in front of a read that
 * is *already* a point-in-time snapshot with its own freshness check would let a
 * decision rest on an entry the snapshot would have called stale, and would
 * defeat the one guarantee this path has. The read is a single `GET`.
 */
export declare function createPolymarketBookLiquidityReader(options: PolymarketBookLiquidityReaderOptions): PolymarketBookLiquidityReader;
//# sourceMappingURL=polymarket-book-reader.d.ts.map