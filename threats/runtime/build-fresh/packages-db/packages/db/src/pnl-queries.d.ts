import type { OpenPositionSnapshot } from './stop-loss.js';
export { calculateAverageCostPnl, markToMarketPnl } from './pnl-math.js';
export type { PositionLedgerTrade, PositionPnl } from './pnl-math.js';
export type MarkToMarketResult = {
    /** Signals whose `pnl_usd` / `realized_pnl_usd` / `unrealized_pnl_usd` were written. */
    updated: number;
    /**
     * `(signal, user)` ledgers that could not be valued, counted per ledger rather than
     * per signal. With one tenant -- every row at `user_id NULL` -- the two are the same
     * number, which is why the pre-`S4-M46` counts are unchanged.
     */
    skipped: number;
    /**
     * Every still-open position this pass priced, one per `(signal, user)`.
     *
     * This is the stop-loss sweep's input, so it is also the reason the sweep needs no
     * subscription lookup: a user appears here because they hold something, not because
     * a subscription row says they should.
     */
    positions: OpenPositionSnapshot[];
};
/**
 * Recompute realized and unrealized average-cost P&L from ordered filled trades.
 * Token prices are fetched once per distinct mint and only for open positions.
 *
 * Also returns a snapshot of every still-open position it priced, so stop-loss
 * enforcement can reuse this pass instead of re-querying the ledger and
 * re-fetching prices on its own schedule.
 *
 * ## Two groupings, deliberately
 *
 * Valuation is per `(signal, user)` -- see `LedgerKey` for why. The `signals` table has
 * no user dimension (`001_init.sql` / `025`), so its three P&L columns stay a
 * platform-wide total, and this pass writes them by **summing the per-user results**.
 *
 * That sum is not an approximation of the old merged number, it is a correction of it.
 * Realized P&L, unrealized P&L, open quantity and open cost basis are all additive over
 * disjoint sub-ledgers; average unit *cost* is not. Valuing each tenant against their
 * own basis and adding is right; blending the bases first and then valuing invents a
 * cost neither tenant paid. With a single tenant the two agree exactly, which is what
 * keeps the operator path byte-identical.
 *
 * ## A partly unvaluable cohort does not produce a signal-level number
 *
 * If any one tenant's slice of a signal is unusable (oversold ledger, mixed mints, no
 * price), the signal's total is unknown and the UPDATE is skipped rather than written
 * from the tenants that did resolve. A total that silently omits a holder is a
 * fabricated input to the performance dashboard. The tenants that *did* resolve still
 * get their `positions` entry, because an open position needs a stop-loss regardless of
 * whether some other tenant's books balance.
 */
export declare function markToMarketOpenPositions(signalId?: string): Promise<MarkToMarketResult>;
//# sourceMappingURL=pnl-queries.d.ts.map