/**
 * Live market-state gate applied immediately before a Polymarket submission.
 *
 * The order book tells you about liquidity; it says nothing about whether the
 * market is still accepting orders, has closed, or has gone to resolution. A
 * depth walk can therefore look perfectly healthy on a market that will reject
 * the order — or, worse, on one that is resolving, where an entry is simply a
 * donation.
 *
 * The stored `polymarket_markets` context cannot answer this either: it is
 * written by the indexer's backfill and is exactly as old as the last time that
 * ran. "Not accepting orders" is a state that flips between a signal and its
 * execution, which is precisely the window this gate covers, so the state is
 * re-read live and as close to submission as possible.
 *
 * The CLOB SDK has no market-state call keyed by condition (`fetchMarketInfo`
 * returns fees and tokens only), so this reads the same Gamma endpoint the
 * indexer uses to build market context.
 */
export class PolymarketMarketClosedError extends Error {
}
const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
function normalizeConditionId(value) {
    const normalized = value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
        throw new PolymarketMarketClosedError(`Invalid Polymarket condition ID: ${value}`);
    }
    return normalized;
}
/**
 * Parse only the fields this gate decides on. A market whose state cannot be
 * read is treated as untradable rather than assumed open.
 */
export function parsePolymarketMarketState(value, expectedConditionId) {
    const conditionId = normalizeConditionId(expectedConditionId);
    if (!value || typeof value !== 'object') {
        throw new PolymarketMarketClosedError(`Polymarket market state is unavailable for ${conditionId}`);
    }
    const raw = value;
    const returnedConditionId = raw.conditionId ?? raw.condition_id;
    if (typeof returnedConditionId === 'string'
        && normalizeConditionId(returnedConditionId) !== conditionId) {
        throw new PolymarketMarketClosedError(`Polymarket returned market ${returnedConditionId} for requested ${conditionId}`);
    }
    const active = raw.active === true;
    const closed = raw.closed === true;
    // Same derivation the indexer uses: an explicit flag wins, otherwise a market
    // is accepting orders only while it is active and not closed.
    const acceptingOrders = typeof raw.acceptingOrders === 'boolean'
        ? raw.acceptingOrders
        : active && !closed;
    const resolutionStatus = typeof raw.umaResolutionStatus === 'string' && raw.umaResolutionStatus.trim()
        ? raw.umaResolutionStatus.trim().toLowerCase()
        : closed ? 'unknown' : 'unresolved';
    // Gamma's market schema carries BOTH `endDate` (`string<date-time> | null`) and
    // `endDateIso` (`string | null`) — verified in
    // `/api-reference/markets/get-market-by-id`. Both are nullable, so reading only
    // one can miss a market that populated the other. All four spellings are tried
    // and a market that carries none is still refused: the gate below and the
    // `S4-M18` staleness rule both need this timestamp, and neither may guess it.
    const endDateValue = raw.endDate
        ?? raw.end_date
        ?? raw.endDateIso
        ?? raw.end_date_iso;
    if (typeof endDateValue !== 'string' || !endDateValue.trim()) {
        throw new PolymarketMarketClosedError(`Polymarket market ${conditionId} is missing its end date`);
    }
    const endDate = new Date(endDateValue);
    if (Number.isNaN(endDate.getTime())) {
        throw new PolymarketMarketClosedError(`Polymarket market ${conditionId} returned an invalid end date: ${endDateValue}`);
    }
    // A delay that is absent, negative, or not a number is reported as null rather
    // than as zero. Zero is a positive claim that orders match immediately; null
    // says we do not know, which is what `S4-M18` needs to see to stay honest.
    const rawSecondsDelay = raw.secondsDelay ?? raw.seconds_delay;
    const parsedSecondsDelay = typeof rawSecondsDelay === 'number'
        ? rawSecondsDelay
        : typeof rawSecondsDelay === 'string' && rawSecondsDelay.trim()
            ? Number(rawSecondsDelay)
            : Number.NaN;
    const secondsDelay = Number.isFinite(parsedSecondsDelay) && parsedSecondsDelay >= 0
        ? parsedSecondsDelay
        : null;
    return {
        conditionId,
        active,
        closed,
        acceptingOrders,
        resolutionStatus,
        endDate,
        secondsDelay
    };
}
/**
 * Throw unless the market is open for a new order right now.
 *
 * Applied to sells as well as buys: submitting into a market that has stopped
 * accepting orders produces a rejected or ambiguous execution either way, and a
 * resolving market is redeemed rather than sold.
 */
export function assertPolymarketMarketTradable(state, now = Date.now()) {
    if (state.closed) {
        throw new PolymarketMarketClosedError(`Polymarket Protection: market ${state.conditionId} is closed`);
    }
    if (!state.active) {
        throw new PolymarketMarketClosedError(`Polymarket Protection: market ${state.conditionId} is not active`);
    }
    if (!state.acceptingOrders) {
        throw new PolymarketMarketClosedError(`Polymarket Protection: market ${state.conditionId} is paused for orders`);
    }
    if (state.resolutionStatus !== 'unresolved') {
        throw new PolymarketMarketClosedError(`Polymarket Protection: market ${state.conditionId} is resolving (${state.resolutionStatus})`);
    }
    if (state.endDate.getTime() <= now) {
        throw new PolymarketMarketClosedError(`Polymarket Protection: market ${state.conditionId} ended at ${state.endDate.toISOString()}`);
    }
}
/**
 * Read the current market state for a condition. Any transport or shape failure
 * raises — an unreadable market is not a tradable one.
 */
export async function fetchPolymarketMarketState(conditionId, fetchImpl = fetch) {
    const normalized = normalizeConditionId(conditionId);
    const baseUrl = process.env.POLYMARKET_GAMMA_URL ?? GAMMA_BASE_URL;
    const response = await fetchImpl(`${baseUrl}/markets?condition_id=${encodeURIComponent(normalized)}`);
    if (!response.ok) {
        throw new PolymarketMarketClosedError(`Polymarket market state lookup failed with status ${response.status}`);
    }
    const payload = await response.json();
    const market = Array.isArray(payload) ? payload[0] : payload;
    return parsePolymarketMarketState(market, normalized);
}
/** Fetch and gate in one step, for use immediately before a submission. */
export async function assertPolymarketMarketOpenForSubmission(params) {
    const state = await fetchPolymarketMarketState(params.conditionId, params.fetchImpl);
    assertPolymarketMarketTradable(state, params.now);
    return state;
}
//# sourceMappingURL=polymarket-market-state.js.map