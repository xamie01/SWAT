import { query } from '@swat/db';
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
// ---------------------------------------------------------------------------
// Windows and gating policy
// ---------------------------------------------------------------------------
export const MASTER_METRIC_WINDOWS = ['24h', '7d', '30d'];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const WINDOW_DURATION_MS = {
    '24h': DAY_MS,
    '7d': 7 * DAY_MS,
    '30d': 30 * DAY_MS
};
/**
 * Minimum closed round trips before a window reports numbers at all
 * (ADR-0005 section 5.2). Policy values, not measurements: they scale with the
 * window because "20 trades in 24h" would gate out every master who is not a
 * bot, while "3 trades in 30d" is the noise-wearing-a-number the ADR rejects.
 * Overridable per call so the API and the nightly batch can differ.
 */
export const DEFAULT_MIN_TRADES_BY_WINDOW = {
    '24h': 5,
    '7d': 10,
    '30d': 20
};
/**
 * How far back round-trip reconstruction reads. Entries older than this are not
 * fetched, so an episode opened before the bound is reported as excluded rather
 * than mismeasured. Bounds the scan for a wallet we have tracked for years.
 */
export const ROUND_TRIP_LOOKBACK_MS = 180 * DAY_MS;
/** Quantity below which a position counts as closed - mirrors `pnl-math.ts`. */
const QUANTITY_EPSILON = 1e-12;
function groupKey(row) {
    return `${row.walletAddress}\u0000${row.chain}\u0000${row.tokenMint}`;
}
function finiteOrNull(value) {
    return value != null && Number.isFinite(value) ? value : null;
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
export function buildMasterRoundTrips(rows) {
    const set = {
        roundTrips: [],
        openEpisodes: 0,
        incompleteEpisodes: 0,
        unmatchedSells: 0
    };
    const groups = new Map();
    for (const row of rows) {
        if (row.direction !== 'buy' && row.direction !== 'sell')
            continue;
        if (!Number.isFinite(row.tokenAmount) || row.tokenAmount <= 0)
            continue;
        if (!(row.eventAt instanceof Date) || Number.isNaN(row.eventAt.getTime()))
            continue;
        const key = groupKey(row);
        const bucket = groups.get(key);
        if (bucket)
            bucket.push(row);
        else
            groups.set(key, [row]);
    }
    for (const bucket of groups.values()) {
        bucket.sort((a, b) => a.eventAt.getTime() - b.eventAt.getTime());
        let episode = null;
        for (const row of bucket) {
            const amountUsd = finiteOrNull(row.amountUsd);
            const feeUsd = finiteOrNull(row.feeUsd);
            if (row.direction === 'buy') {
                if (!episode) {
                    episode = {
                        openedAt: row.eventAt,
                        quantity: 0,
                        basisUsd: 0,
                        costBasisUsd: 0,
                        proceedsUsd: 0,
                        realizedPnlUsd: 0,
                        feeUsd: 0,
                        feesRecorded: true,
                        legs: 0,
                        usdComplete: true
                    };
                }
                episode.quantity += row.tokenAmount;
                episode.basisUsd += (amountUsd ?? 0) + (feeUsd ?? 0);
                episode.costBasisUsd += (amountUsd ?? 0) + (feeUsd ?? 0);
                episode.feeUsd += feeUsd ?? 0;
                if (amountUsd === null || amountUsd < 0)
                    episode.usdComplete = false;
                if (feeUsd === null || feeUsd < 0)
                    episode.feesRecorded = false;
                episode.legs++;
                continue;
            }
            if (!episode || episode.quantity <= QUANTITY_EPSILON) {
                // A sell with nothing open: we are missing the entry. Never invent one.
                set.unmatchedSells++;
                continue;
            }
            let soldQuantity = row.tokenAmount;
            if (soldQuantity > episode.quantity) {
                set.unmatchedSells++;
                soldQuantity = episode.quantity;
            }
            const releasedBasis = (episode.basisUsd / episode.quantity) * soldQuantity;
            // Pro-rate a capped sell's USD so proceeds match the quantity we credited.
            const fraction = soldQuantity / row.tokenAmount;
            const legProceeds = (amountUsd ?? 0) * fraction;
            const legFee = (feeUsd ?? 0) * fraction;
            episode.realizedPnlUsd += legProceeds - legFee - releasedBasis;
            episode.proceedsUsd += legProceeds - legFee;
            episode.feeUsd += legFee;
            episode.quantity -= soldQuantity;
            episode.basisUsd -= releasedBasis;
            if (amountUsd === null || amountUsd < 0)
                episode.usdComplete = false;
            if (feeUsd === null || feeUsd < 0)
                episode.feesRecorded = false;
            episode.legs++;
            if (episode.quantity > QUANTITY_EPSILON)
                continue;
            if (episode.usdComplete) {
                set.roundTrips.push({
                    walletAddress: row.walletAddress,
                    chain: row.chain,
                    tokenMint: row.tokenMint,
                    openedAt: episode.openedAt,
                    closedAt: row.eventAt,
                    holdMs: row.eventAt.getTime() - episode.openedAt.getTime(),
                    costBasisUsd: episode.costBasisUsd,
                    proceedsUsd: episode.proceedsUsd,
                    realizedPnlUsd: episode.realizedPnlUsd,
                    feeUsd: episode.feeUsd,
                    feesRecorded: episode.feesRecorded,
                    legs: episode.legs
                });
            }
            else {
                set.incompleteEpisodes++;
            }
            episode = null;
        }
        if (episode && episode.quantity > QUANTITY_EPSILON)
            set.openEpisodes++;
    }
    set.roundTrips.sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
    return set;
}
/** Median of a numeric sample; null when the sample is empty. */
export function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
    if (sorted.length === 0)
        return null;
    const middle = sorted.length >> 1;
    if (sorted.length % 2 === 1)
        return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
}
/**
 * Peak-to-trough decline of the cumulative realized-PnL curve. The peak starts
 * at zero, so a master who only loses reports their whole loss as the drawdown
 * rather than zero.
 *
 * Expects `roundTrips` ordered by `closedAt`; `buildMasterRoundTrips` guarantees
 * that and `roundTripsInWindow` preserves it.
 */
export function realizedMaxDrawdownUsd(roundTrips) {
    let cumulative = 0;
    let peak = 0;
    let worst = 0;
    for (const roundTrip of roundTrips) {
        cumulative += roundTrip.realizedPnlUsd;
        if (cumulative > peak)
            peak = cumulative;
        const drawdown = peak - cumulative;
        if (drawdown > worst)
            worst = drawdown;
    }
    return worst;
}
/**
 * Round trips assigned to a window by **exit** time. Exit time is the right
 * key: it is when the result became knowable, and it keeps a single trade from
 * appearing in one window's entry and another's exit.
 */
export function roundTripsInWindow(roundTrips, window, asOf) {
    const startMs = asOf.getTime() - WINDOW_DURATION_MS[window];
    const asOfMs = asOf.getTime();
    return roundTrips.filter((roundTrip) => {
        const closed = roundTrip.closedAt.getTime();
        return closed >= startMs && closed <= asOfMs;
    });
}
export function computeWindowMetrics(window, roundTrips, asOf, minTradeCount) {
    const windowStartAt = new Date(asOf.getTime() - WINDOW_DURATION_MS[window]);
    const common = {
        window,
        windowStartAt,
        tradeCount: roundTrips.length,
        minTradeCount
    };
    if (roundTrips.length < minTradeCount) {
        return { ...common, status: 'insufficient_history' };
    }
    let pnlNetUsd = 0;
    let deployedCapitalUsd = 0;
    let winCount = 0;
    let lossCount = 0;
    let netOfFees = true;
    const holdMinutes = [];
    for (const roundTrip of roundTrips) {
        pnlNetUsd += roundTrip.realizedPnlUsd;
        deployedCapitalUsd += roundTrip.costBasisUsd;
        if (roundTrip.realizedPnlUsd > 0)
            winCount++;
        else
            lossCount++;
        if (!roundTrip.feesRecorded)
            netOfFees = false;
        holdMinutes.push(roundTrip.holdMs / 60_000);
    }
    const maxDrawdownUsd = realizedMaxDrawdownUsd(roundTrips);
    return {
        ...common,
        status: 'ok',
        pnlNetUsd,
        pnlPerTradeUsd: pnlNetUsd / roundTrips.length,
        netOfFees,
        deployedCapitalUsd,
        maxDrawdownUsd,
        maxDrawdownPctOfDeployedCapital: deployedCapitalUsd > 0 ? (maxDrawdownUsd / deployedCapitalUsd) * 100 : null,
        hitRatePct: (winCount / roundTrips.length) * 100,
        winCount,
        lossCount,
        medianHoldMinutes: median(holdMinutes) ?? 0,
        capacityEstimate: null,
        capacityStatus: 'deferred-to-s4-m6'
    };
}
/**
 * Relative change at or below this counts as decay. -0.5 means the shorter
 * window's per-trade PnL has fallen by half the larger of the two magnitudes,
 * which a sign flip (for example +10 then -10, giving -2.0) always clears.
 */
export const DIVERGENCE_DECAY_THRESHOLD = -0.5;
export const DIVERGENCE_IMPROVEMENT_THRESHOLD = 0.5;
/** Pairs compared. `24h` vs `30d` is the headline the ADR names. */
export const DIVERGENCE_PAIRS = [
    ['24h', '7d'],
    ['7d', '30d'],
    ['24h', '30d']
];
export const HEADLINE_DIVERGENCE_PAIR = ['24h', '30d'];
export function compareWindows(shorter, longer) {
    const base = { shorter: shorter.window, longer: longer.window };
    if (shorter.status !== 'ok' || longer.status !== 'ok') {
        const missing = [shorter, longer]
            .filter((side) => side.status !== 'ok')
            .map((side) => side.window)
            .join(' and ');
        return {
            ...base,
            trend: 'indeterminate',
            relativeChange: null,
            hitRatePctDelta: null,
            reason: `insufficient history in ${missing}`
        };
    }
    const scale = Math.max(Math.abs(shorter.pnlPerTradeUsd), Math.abs(longer.pnlPerTradeUsd));
    const relativeChange = scale === 0 ? 0 : (shorter.pnlPerTradeUsd - longer.pnlPerTradeUsd) / scale;
    let trend = 'stable';
    if (relativeChange <= DIVERGENCE_DECAY_THRESHOLD)
        trend = 'decaying';
    else if (relativeChange >= DIVERGENCE_IMPROVEMENT_THRESHOLD)
        trend = 'improving';
    return {
        ...base,
        trend,
        relativeChange,
        hitRatePctDelta: shorter.hitRatePct - longer.hitRatePct,
        reason: null
    };
}
export function resolveMinTradesByWindow(overrides) {
    const resolved = { ...DEFAULT_MIN_TRADES_BY_WINDOW };
    if (!overrides)
        return resolved;
    for (const window of MASTER_METRIC_WINDOWS) {
        const override = overrides[window];
        if (override != null && Number.isFinite(override) && override > 0) {
            resolved[window] = Math.floor(override);
        }
    }
    return resolved;
}
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
export function computeMasterMetrics(input) {
    const minTradesByWindow = resolveMinTradesByWindow(input.minTradesByWindow);
    const built = buildMasterRoundTrips(input.rows);
    const startMs = input.observationStartAt?.getTime() ?? null;
    const outOfSample = startMs === null
        ? []
        : built.roundTrips.filter((roundTrip) => roundTrip.openedAt.getTime() >= startMs);
    const windows = {};
    for (const window of MASTER_METRIC_WINDOWS) {
        windows[window] = computeWindowMetrics(window, roundTripsInWindow(outOfSample, window, input.asOf), input.asOf, minTradesByWindow[window]);
    }
    const divergence = DIVERGENCE_PAIRS.map(([shorter, longer]) => compareWindows(windows[shorter], windows[longer]));
    const headline = divergence.find((entry) => entry.shorter === HEADLINE_DIVERGENCE_PAIR[0] && entry.longer === HEADLINE_DIVERGENCE_PAIR[1]);
    return {
        walletAddress: input.walletAddress,
        chain: input.chain,
        asOf: input.asOf,
        observationStartAt: input.observationStartAt,
        outOfSampleRoundTrips: outOfSample.length,
        inSampleRoundTripsExcluded: built.roundTrips.length - outOfSample.length,
        openEpisodes: built.openEpisodes,
        incompleteEpisodes: built.incompleteEpisodes,
        unmatchedSells: built.unmatchedSells,
        feesRecordedOnEveryRoundTrip: outOfSample.length > 0 && outOfSample.every((roundTrip) => roundTrip.feesRecorded),
        windows,
        divergence,
        trend: headline?.trend ?? 'indeterminate'
    };
}
/** One log line per master. Never mentions follower count (`S4-M9`). */
export function formatMasterMetricsLine(report) {
    const windows = MASTER_METRIC_WINDOWS.map((window) => {
        const metrics = report.windows[window];
        if (metrics.status !== 'ok') {
            return `${window}: insufficient history (${metrics.tradeCount}/${metrics.minTradeCount})`;
        }
        const drawdown = metrics.maxDrawdownPctOfDeployedCapital;
        return (`${window}: n=${metrics.tradeCount} ` +
            `pnl=$${metrics.pnlNetUsd.toFixed(2)}${metrics.netOfFees ? '' : ' (gross of master fees)'} ` +
            `hr=${metrics.hitRatePct.toFixed(1)}% ` +
            `mdd=$${metrics.maxDrawdownUsd.toFixed(2)}` +
            `${drawdown === null ? '' : ` (${drawdown.toFixed(1)}% of deployed)`} ` +
            `hold=${metrics.medianHoldMinutes.toFixed(1)}m`);
    }).join(' | ');
    return `${report.walletAddress} trend=${report.trend} | ${windows}`;
}
/**
 * Compute the metric set for every candidate master. One failure is contained to
 * one master: this runs inside the nightly batch alongside scoring, and a single
 * unparseable wallet must not cost the run.
 */
export async function runMasterMetricsBatch(dependencies) {
    const asOf = dependencies.asOf ?? new Date();
    const lookbackMs = dependencies.lookbackMs ?? ROUND_TRIP_LOOKBACK_MS;
    const lookbackStart = new Date(asOf.getTime() - lookbackMs);
    const result = {
        masters: 0,
        reports: [],
        failed: 0,
        decaying: 0,
        improving: 0,
        insufficientEverywhere: 0
    };
    const masters = await dependencies.listMasters();
    result.masters = masters.length;
    for (const master of masters) {
        try {
            // Clamp the observation start to the fetch bound. Without the clamp an
            // episode opened before the bound would pass the out-of-sample cut with
            // its entry legs unfetched, and be scored off proceeds alone.
            const observationStartAt = master.observationStartAt
                ? (master.observationStartAt.getTime() > lookbackStart.getTime()
                    ? master.observationStartAt
                    : lookbackStart)
                : null;
            const rows = observationStartAt === null
                ? []
                : await dependencies.fetchTrades({
                    walletAddress: master.walletAddress,
                    chain: master.chain,
                    since: observationStartAt,
                    asOf
                });
            const report = computeMasterMetrics({
                walletAddress: master.walletAddress,
                chain: master.chain,
                rows,
                asOf,
                observationStartAt,
                minTradesByWindow: dependencies.minTradesByWindow
            });
            result.reports.push(report);
            if (report.trend === 'decaying')
                result.decaying++;
            if (report.trend === 'improving')
                result.improving++;
            if (MASTER_METRIC_WINDOWS.every((window) => report.windows[window].status !== 'ok')) {
                result.insufficientEverywhere++;
            }
            if (dependencies.persistReport)
                await dependencies.persistReport(report);
        }
        catch (error) {
            console.error(`[scorer] master metrics failed for ${master.walletAddress}`, error);
            result.failed++;
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// SQL - the only part that needs Postgres
// ---------------------------------------------------------------------------
/** NUMERIC comes back as number or string depending on magnitude; normalise. */
function numberOrNull(value) {
    if (value === null || value === undefined)
        return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function dateOrNull(value) {
    if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string' || typeof value === 'number') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
}
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
export async function listMasterCandidates(input) {
    const activityWindowMs = input.activityWindowMs ?? WINDOW_DURATION_MS['30d'];
    const rows = await query(`SELECT w.address AS wallet_address,
            w.chain AS chain,
            w.first_seen AS first_seen
       FROM wallets w
      WHERE w.status = 'active'
        AND EXISTS (
              SELECT 1
                FROM source_trades st
               WHERE st.wallet_address = w.address
                 AND st.chain = w.chain
                 AND st.confirmation_state IN ('confirmed', 'finalized')
                 AND st.direction IN ('buy', 'sell')
                 AND st.event_at >= $1::timestamptz - ($2::bigint * INTERVAL '1 millisecond')
                 AND st.event_at <= $1::timestamptz
            )
      ORDER BY w.address`, [input.asOf.toISOString(), Math.floor(activityWindowMs)]);
    return rows.map((row) => ({
        walletAddress: row.wallet_address,
        chain: row.chain,
        observationStartAt: dateOrNull(row.first_seen)
    }));
}
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
export async function fetchMasterTradeRows(input) {
    const rows = await query(`SELECT st.wallet_address,
            st.chain,
            st.token_mint,
            st.direction,
            st.token_amount,
            st.amount_usd,
            NULL::numeric AS fee_usd,
            st.event_at
       FROM source_trades st
      WHERE st.wallet_address = $1
        AND st.chain = $2
        AND st.confirmation_state IN ('confirmed', 'finalized')
        AND st.direction IN ('buy', 'sell')
        AND st.event_at >= $3::timestamptz
        AND st.event_at <= $4::timestamptz
      ORDER BY st.event_at ASC, st.id ASC`, [input.walletAddress, input.chain, input.since.toISOString(), input.asOf.toISOString()]);
    const mapped = [];
    for (const row of rows) {
        const tokenAmount = numberOrNull(row.token_amount);
        const eventAt = dateOrNull(row.event_at);
        if (tokenAmount === null || tokenAmount <= 0 || eventAt === null)
            continue;
        if (row.direction !== 'buy' && row.direction !== 'sell')
            continue;
        mapped.push({
            walletAddress: row.wallet_address,
            chain: row.chain,
            tokenMint: row.token_mint,
            direction: row.direction,
            tokenAmount,
            amountUsd: numberOrNull(row.amount_usd),
            feeUsd: numberOrNull(row.fee_usd),
            eventAt
        });
    }
    return mapped;
}
//# sourceMappingURL=master-metrics.js.map