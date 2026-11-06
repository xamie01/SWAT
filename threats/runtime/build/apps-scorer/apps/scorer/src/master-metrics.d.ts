import type { Chain } from '@swat/shared';
/**
 * S4-M8 - out-of-sample master metrics over 24h / 7d / 30d.
 *
 * ADR-0005 section 5 is the specification. A *master* is a single wallet a user
 * copies (section 3), never a cluster, so every figure here is keyed on one
 * chain-prefixed wallet address.
 *
 * The module is split the way `stop-loss.ts` is: everything above
 * `runMasterMetricsBatch` is pure arithmetic over plain rows and is unit tested
 * without Postgres; the two `fetch*` / `list*` helpers at the bottom are the
 * only code that touches SQL, and the batch takes them as injected
 * dependencies.
 *
 * Deliberate omissions, each with a reason - a later contributor will read them
 * as oversights otherwise:
 *
 * - **No raw ROI, anywhere.** ADR-0005 section 5.1: it ranks the luckiest.
 *   `pnlNetUsd` and `pnlPerTradeUsd` are absolute dollars; the only ratio
 *   reported is drawdown, whose denominator is named in the field itself.
 * - **No follower count and no popularity figure** (ADR-0005 section 5.4,
 *   `S4-M9`). Nothing here reads a subscription count, and `capacityEstimate` is
 *   deliberately not derived from one.
 * - **`capacityEstimate` is always null.** Capacity is denominated in price
 *   impact as a fraction of usable liquidity (ADR-0005 section 4.1) and is owned
 *   by `S4-M6`. Returning null with `capacityStatus: 'deferred-to-s4-m6'` is
 *   honest; inventing a headcount-derived number would contradict section 4.1.
 */
export declare const MASTER_METRIC_WINDOWS: readonly ["24h", "7d", "30d"];
export type MasterMetricWindow = (typeof MASTER_METRIC_WINDOWS)[number];
export declare const WINDOW_DURATION_MS: Record<MasterMetricWindow, number>;
/**
 * Minimum closed round trips before a window reports numbers at all
 * (ADR-0005 section 5.2). Policy values, not measurements: they scale with the
 * window because "20 trades in 24h" would gate out every master who is not a
 * bot, while "3 trades in 30d" is the noise-wearing-a-number the ADR rejects.
 * Overridable per call so the API and the nightly batch can differ.
 */
export declare const DEFAULT_MIN_TRADES_BY_WINDOW: Record<MasterMetricWindow, number>;
/**
 * How far back round-trip reconstruction reads. Entries older than this are not
 * fetched, so an episode opened before the bound is reported as excluded rather
 * than mismeasured. Bounds the scan for a wallet we have tracked for years.
 */
export declare const ROUND_TRIP_LOOKBACK_MS: number;
/**
 * One confirmed, mirrorable trade by the master, as stored in `source_trades`.
 *
 * `direction` is narrowed to buy/sell on purpose: `source_trades` also carries
 * `transfer_in` / `transfer_out`, which are not mirrorable activity (ADR-0005
 * section 3.2, `S4-M5`) and must never enter a track record - a master
 * shuffling funds between their own wallets is not a trade.
 *
 * `feeUsd` is `null` on every `source_trades` row today: `031_execution_fees`
 * added `fee_usd` to `trades` (our own executions) only, and no migration adds a
 * fee column to `source_trades`. The field exists so the arithmetic is already
 * net-of-fees the day that column lands; until then `netOfFees` reports false
 * rather than presenting a gross figure as net.
 */
export interface MasterTradeRow {
    walletAddress: string;
    chain: Chain;
    tokenMint: string;
    direction: 'buy' | 'sell';
    tokenAmount: number;
    amountUsd: number | null;
    feeUsd: number | null;
    eventAt: Date;
}
/**
 * One entry-to-flat episode on a single (wallet, chain, token). Partial exits
 * are folded into the *same* round trip rather than emitted separately: three
 * sells that between them close one position are one decision with one hold
 * time, and splitting them would triple-count the entry in hit rate.
 */
export interface MasterRoundTrip {
    walletAddress: string;
    chain: Chain;
    tokenMint: string;
    openedAt: Date;
    closedAt: Date;
    holdMs: number;
    /** Total basis committed over the episode, including buy-side fees. */
    costBasisUsd: number;
    /** Total proceeds returned, net of sell-side fees. */
    proceedsUsd: number;
    realizedPnlUsd: number;
    feeUsd: number;
    /** True only when every leg carried a non-null `feeUsd`. */
    feesRecorded: boolean;
    legs: number;
}
export interface MasterRoundTripSet {
    roundTrips: MasterRoundTrip[];
    /**
     * Positions still open at `asOf`. Excluded entirely - an open position has no
     * exit price, and counting it as a flat trade would silently dilute both hit
     * rate and PnL toward zero.
     */
    openEpisodes: number;
    /** Episodes with a leg missing `amountUsd`, so no PnL is derivable. */
    incompleteEpisodes: number;
    /**
     * Sells with no (or insufficient) open quantity - a history gap or a partial
     * fetch window. The sell is capped at what we can see, never taken negative
     * (same rule as ADR-0005 section 3.8).
     */
    unmatchedSells: number;
}
/**
 * Reconstruct closed round trips from a master's confirmed trade stream using
 * the same chronological average-cost convention as `calculateAverageCostPnl`
 * in `@swat/db` (`pnl-math.ts`) - buys add `amountUsd + feeUsd` to basis, a sell
 * releases `avgUnitCost * quantity` of it and realizes
 * `amountUsd - feeUsd - releasedBasis`. The test asserts the sum of round-trip
 * PnL equals that function's `realizedPnlUsd` for the same ledger, so the two
 * cannot drift apart.
 *
 * Rows may arrive in any order; they are sorted per group by `eventAt`.
 */
export declare function buildMasterRoundTrips(rows: MasterTradeRow[]): MasterRoundTripSet;
export interface MasterWindowCommon {
    window: MasterMetricWindow;
    windowStartAt: Date;
    /** Closed, out-of-sample round trips whose exit landed inside the window. */
    tradeCount: number;
    minTradeCount: number;
}
/**
 * The window is reported as a phrase, not a number. ADR-0005 section 5.2: a
 * 30-day metric from three trades is noise wearing a number, and a caller given
 * a number will render it.
 */
export interface MasterWindowInsufficient extends MasterWindowCommon {
    status: 'insufficient_history';
}
export interface MasterWindowFigures extends MasterWindowCommon {
    status: 'ok';
    /** Realized PnL in USD, net of every fee we hold. Never a return ratio. */
    pnlNetUsd: number;
    /**
     * `pnlNetUsd / tradeCount`. Exists so windows of different lengths are
     * comparable for the divergence finding without introducing a capital
     * denominator, which is the ROI ADR-0005 section 5.1 rejects.
     */
    pnlPerTradeUsd: number;
    /**
     * False when any contributing leg had no recorded fee. Today this is always
     * false for `source_trades`, so a caller must render the figure as
     * "gross of the master's own fees" rather than as a net number.
     */
    netOfFees: boolean;
    /** Sum of round-trip cost basis - the drawdown denominator. */
    deployedCapitalUsd: number;
    /**
     * Peak-to-trough of the cumulative realized-PnL curve, ordered by exit time.
     * This is a *realized* drawdown: we hold no continuous marks for a wallet we
     * merely observe, so an intra-hold excursion is invisible here. Stating that
     * is better than implying a mark-to-market drawdown we cannot compute.
     */
    maxDrawdownUsd: number;
    /**
     * `maxDrawdownUsd` as a percent of `deployedCapitalUsd`. The denominator is in
     * the field name deliberately: percent-of-peak-equity is undefined for a curve
     * that starts at zero, and percent-of-portfolio needs a portfolio we cannot
     * see. Null when no capital is attributable.
     */
    maxDrawdownPctOfDeployedCapital: number | null;
    hitRatePct: number;
    winCount: number;
    lossCount: number;
    medianHoldMinutes: number;
    /** Always null - see the module header. Owned by `S4-M6`. */
    capacityEstimate: null;
    capacityStatus: 'deferred-to-s4-m6';
}
export type MasterWindowMetrics = MasterWindowInsufficient | MasterWindowFigures;
/** Median of a numeric sample; null when the sample is empty. */
export declare function median(values: number[]): number | null;
/**
 * Peak-to-trough decline of the cumulative realized-PnL curve. The peak starts
 * at zero, so a master who only loses reports their whole loss as the drawdown
 * rather than zero.
 *
 * Expects `roundTrips` ordered by `closedAt`; `buildMasterRoundTrips` guarantees
 * that and `roundTripsInWindow` preserves it.
 */
export declare function realizedMaxDrawdownUsd(roundTrips: Pick<MasterRoundTrip, 'realizedPnlUsd'>[]): number;
/**
 * Round trips assigned to a window by **exit** time. Exit time is the right
 * key: it is when the result became knowable, and it keeps a single trade from
 * appearing in one window's entry and another's exit.
 */
export declare function roundTripsInWindow(roundTrips: MasterRoundTrip[], window: MasterMetricWindow, asOf: Date): MasterRoundTrip[];
export declare function computeWindowMetrics(window: MasterMetricWindow, roundTrips: MasterRoundTrip[], asOf: Date, minTradeCount: number): MasterWindowMetrics;
export type MasterTrend = 'decaying' | 'improving' | 'stable' | 'indeterminate';
/**
 * Relative change at or below this counts as decay. -0.5 means the shorter
 * window's per-trade PnL has fallen by half the larger of the two magnitudes,
 * which a sign flip (for example +10 then -10, giving -2.0) always clears.
 */
export declare const DIVERGENCE_DECAY_THRESHOLD = -0.5;
export declare const DIVERGENCE_IMPROVEMENT_THRESHOLD = 0.5;
export interface MasterWindowDivergence {
    shorter: MasterMetricWindow;
    longer: MasterMetricWindow;
    trend: MasterTrend;
    /**
     * `(shorter - longer) / max(|shorter|, |longer|)` over `pnlPerTradeUsd`, so it
     * is bounded in [-2, 2] and handles a sign flip without dividing by a number
     * that crosses zero.
     */
    relativeChange: number | null;
    hitRatePctDelta: number | null;
    /** Populated only when `trend` is `indeterminate`. */
    reason: string | null;
}
/** Pairs compared. `24h` vs `30d` is the headline the ADR names. */
export declare const DIVERGENCE_PAIRS: ReadonlyArray<readonly [MasterMetricWindow, MasterMetricWindow]>;
export declare const HEADLINE_DIVERGENCE_PAIR: readonly [MasterMetricWindow, MasterMetricWindow];
export declare function compareWindows(shorter: MasterWindowMetrics, longer: MasterWindowMetrics): MasterWindowDivergence;
export interface MasterMetricsReport {
    walletAddress: string;
    chain: Chain;
    asOf: Date;
    /**
     * The instant our observation of this master began. Round trips **entered**
     * before it are in-sample - they are the history that got the wallet selected
     * in the first place - and are excluded. Null means we cannot establish it, in
     * which case nothing is treated as out-of-sample and every window reports
     * insufficient history. Fail closed: a metric we cannot prove is out-of-sample
     * is worse than no metric.
     */
    observationStartAt: Date | null;
    outOfSampleRoundTrips: number;
    inSampleRoundTripsExcluded: number;
    openEpisodes: number;
    incompleteEpisodes: number;
    unmatchedSells: number;
    /** False whenever any contributing leg lacked a recorded fee. */
    feesRecordedOnEveryRoundTrip: boolean;
    windows: Record<MasterMetricWindow, MasterWindowMetrics>;
    divergence: MasterWindowDivergence[];
    /** Headline trend, from the 24h-vs-30d comparison. */
    trend: MasterTrend;
}
export interface ComputeMasterMetricsInput {
    walletAddress: string;
    chain: Chain;
    rows: MasterTradeRow[];
    asOf: Date;
    observationStartAt: Date | null;
    minTradesByWindow?: Partial<Record<MasterMetricWindow, number>>;
}
export declare function resolveMinTradesByWindow(overrides?: Partial<Record<MasterMetricWindow, number>>): Record<MasterMetricWindow, number>;
/**
 * The whole metric set for one master, from raw rows. Pure: no clock, no DB.
 *
 * Order of operations matters and is not interchangeable:
 * 1. Build round trips from **all** supplied rows, so a sell is matched to the
 *    buy that opened it even when that buy predates every window.
 * 2. Drop round trips entered before `observationStartAt` - the out-of-sample
 *    cut, applied at episode level rather than row level so an episode
 *    straddling the boundary is excluded rather than half-counted.
 * 3. Assign what remains to windows by exit time.
 */
export declare function computeMasterMetrics(input: ComputeMasterMetricsInput): MasterMetricsReport;
/** One log line per master. Never mentions follower count (`S4-M9`). */
export declare function formatMasterMetricsLine(report: MasterMetricsReport): string;
export interface MasterCandidate {
    walletAddress: string;
    chain: Chain;
    observationStartAt: Date | null;
}
export interface MasterTradeFetchInput {
    walletAddress: string;
    chain: Chain;
    since: Date;
    asOf: Date;
}
export interface MasterMetricsBatchDependencies {
    listMasters: () => Promise<MasterCandidate[]>;
    fetchTrades: (input: MasterTradeFetchInput) => Promise<MasterTradeRow[]>;
    /**
     * Optional sink for `S6-27`'s suggestions list. Left unwired: persisting these
     * needs a table this item does not own (the `052`/`053` band in the plan), so
     * the batch currently computes, logs and discards rather than writing to a
     * schema that does not exist.
     */
    persistReport?: (report: MasterMetricsReport) => Promise<unknown>;
    asOf?: Date;
    minTradesByWindow?: Partial<Record<MasterMetricWindow, number>>;
    lookbackMs?: number;
}
export interface MasterMetricsBatchResult {
    masters: number;
    reports: MasterMetricsReport[];
    failed: number;
    decaying: number;
    improving: number;
    /** Masters with no window that cleared its minimum trade count. */
    insufficientEverywhere: number;
}
/**
 * Compute the metric set for every candidate master. One failure is contained to
 * one master: this runs inside the nightly batch alongside scoring, and a single
 * unparseable wallet must not cost the run.
 */
export declare function runMasterMetricsBatch(dependencies: MasterMetricsBatchDependencies): Promise<MasterMetricsBatchResult>;
/**
 * Wallets that are candidate masters: active, and with at least one confirmed
 * mirrorable trade inside the longest window. Derived from `source_trades`
 * rather than from `user_wallet_subscriptions` on purpose - the suggestion
 * engine needs wallets nobody copies yet, and reading a subscription table here
 * would be the first step toward the popularity ranking `S4-M9` forbids.
 *
 * `wallets.first_seen` is the observation start: the row is created when we begin
 * tracking, so backfilled history carries an `event_at` earlier than it.
 */
export declare function listMasterCandidates(input: {
    asOf: Date;
    activityWindowMs?: number;
}): Promise<MasterCandidate[]>;
/**
 * A master's confirmed mirrorable trades. Filters match the partial index
 * `idx_source_trades_position_order`, which covers
 * `confirmation_state IN ('confirmed','finalized')`.
 *
 * `fee_usd` is selected as a NULL literal because **`source_trades` has no fee
 * column**: `031_execution_fees` added `fee_usd` to `trades` only. The literal
 * is here rather than absent so the gap is visible at the one place it is
 * introduced, and so closing it is a one-line change.
 */
export declare function fetchMasterTradeRows(input: MasterTradeFetchInput): Promise<MasterTradeRow[]>;
//# sourceMappingURL=master-metrics.d.ts.map