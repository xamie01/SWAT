import { query } from './client.js';
import { withTransaction } from './transaction.js';
const WALLET_COLUMNS = 'id, chain, wallet_address, label, polling_cadence_seconds, last_indexed_at, created_at';
function toWallet(row) {
    return {
        id: row.id,
        chain: row.chain,
        walletAddress: row.wallet_address,
        label: row.label,
        pollingCadenceSeconds: row.polling_cadence_seconds,
        lastIndexedAt: row.last_indexed_at,
        createdAt: row.created_at
    };
}
export async function trackLpWallet(input) {
    if (input.walletAddress.indexOf(':') < 0) {
        throw new Error('tracked wallet address must be chain-prefixed');
    }
    const cadence = input.pollingCadenceSeconds ?? 300;
    if (!Number.isInteger(cadence) || cadence < 30 || cadence > 86_400) {
        throw new Error(`polling cadence must be an integer in 30..86400 seconds, got ${cadence}`);
    }
    const rows = await query(`INSERT INTO lp_tracked_wallets (chain, wallet_address, label, polling_cadence_seconds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chain, wallet_address) DO UPDATE
       SET label = COALESCE(EXCLUDED.label, lp_tracked_wallets.label),
           polling_cadence_seconds = EXCLUDED.polling_cadence_seconds
     RETURNING ${WALLET_COLUMNS}`, [input.chain, input.walletAddress, input.label ?? null, cadence]);
    return toWallet(rows[0]);
}
export async function untrackLpWallet(chain, walletAddress) {
    const rows = await query(`DELETE FROM lp_tracked_wallets WHERE chain = $1 AND wallet_address = $2 RETURNING id`, [chain, walletAddress]);
    return rows.length > 0;
}
export async function listTrackedLpWallets(options = {}) {
    const limit = options.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
        throw new Error(`listTrackedLpWallets limit must be an integer in 1..2000, got ${limit}`);
    }
    const rows = options.chain
        ? await query(`SELECT ${WALLET_COLUMNS} FROM lp_tracked_wallets WHERE chain = $1 ORDER BY created_at LIMIT $2`, [options.chain, limit])
        : await query(`SELECT ${WALLET_COLUMNS} FROM lp_tracked_wallets ORDER BY created_at LIMIT $1`, [limit]);
    return rows.map(toWallet);
}
function assertObservationUsd(name, value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`lp_wallet_snapshots.${name} must be a non-negative finite number, got ${value}`);
    }
}
/**
 * Records one index pass for a wallet: the snapshot rows and the freshness
 * stamp land in one transaction, so a wallet is never marked indexed with
 * observations that failed to write.
 */
export async function recordLpWalletIndexPass(trackedWalletId, observations) {
    for (const observation of observations) {
        assertObservationUsd('position_value_usd', observation.positionValueUsd);
        assertObservationUsd('uncollected_fees_usd', observation.uncollectedFeesUsd);
        if (observation.positionAddress.indexOf(':') < 0) {
            throw new Error('observation position address must be chain-prefixed');
        }
        if (observation.poolAddress.indexOf(':') < 0) {
            throw new Error('observation pool address must be chain-prefixed');
        }
    }
    await withTransaction(async (client) => {
        for (const observation of observations) {
            await client.query(`INSERT INTO lp_wallet_snapshots
           (tracked_wallet_id, position_address, pool_address, captured_at,
            position_value_usd, uncollected_fees_usd, in_range)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tracked_wallet_id, position_address, captured_at) DO NOTHING`, [
                trackedWalletId,
                observation.positionAddress,
                observation.poolAddress,
                observation.capturedAt,
                observation.positionValueUsd,
                observation.uncollectedFeesUsd,
                observation.inRange
            ]);
        }
        await client.query(`UPDATE lp_tracked_wallets SET last_indexed_at = NOW() WHERE id = $1`, [trackedWalletId]);
    });
}
/** Track D3 output: one closed book per position. Upsert, keyed by (wallet, position). */
export async function upsertLpWalletPositionResult(trackedWalletId, input) {
    if (!Number.isFinite(input.netResultUsd)) {
        throw new Error(`net_result_usd must be finite, got ${input.netResultUsd}`);
    }
    await query(`INSERT INTO lp_wallet_position_results
       (tracked_wallet_id, position_address, pool_address, chain, strategy_type,
        net_result_usd, first_observed_at, last_observed_at, closed, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (tracked_wallet_id, position_address) DO UPDATE
       SET net_result_usd    = EXCLUDED.net_result_usd,
           last_observed_at  = EXCLUDED.last_observed_at,
           closed            = EXCLUDED.closed,
           updated_at        = EXCLUDED.updated_at`, [
        trackedWalletId,
        input.positionAddress,
        input.poolAddress,
        input.chain,
        input.strategyType,
        input.netResultUsd,
        input.firstObservedAt,
        input.lastObservedAt,
        input.closed
    ]);
}
/** NUMERIC arrives as number (fits float64) or string (does not) — never round silently. */
function toSafeNumber(value) {
    if (typeof value === 'number')
        return value;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`stored NUMERIC ${String(value)} does not fit a float64`);
    }
    return parsed;
}
/**
 * The LP Wallets screen. Win rate counts closed positions only — an open
 * position has no realized result to vote on — and `dominant_strategy_type` is
 * the modal strategy across all observed positions.
 */
export async function queryLpWalletLeaderboard(options = {}) {
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error(`queryLpWalletLeaderboard limit must be an integer in 1..100, got ${limit}`);
    }
    const sortExpression = options.sort === 'winRate'
        ? 'win_rate DESC NULLS LAST, realized_pnl_usd DESC'
        : 'realized_pnl_usd DESC';
    const rows = options.chain
        ? await query(`SELECT
           w.id                                   AS tracked_wallet_id,
           w.chain                                AS chain,
           w.wallet_address                       AS wallet_address,
           w.label                                AS label,
           COALESCE(SUM(r.net_result_usd), 0)     AS realized_pnl_usd,
           CASE WHEN COUNT(*) FILTER (WHERE r.closed) > 0
                THEN COUNT(*) FILTER (WHERE r.closed AND r.net_result_usd > 0)::numeric
                     / COUNT(*) FILTER (WHERE r.closed)
                END                                AS win_rate,
           COUNT(*) FILTER (WHERE r.closed)        AS closed_position_count,
           MODE() WITHIN GROUP (ORDER BY r.strategy_type) AS dominant_strategy_type
         FROM lp_tracked_wallets w
         LEFT JOIN lp_wallet_position_results r ON r.tracked_wallet_id = w.id
         WHERE w.chain = $1
         GROUP BY w.id, w.chain, w.wallet_address, w.label
         ORDER BY ${sortExpression}
         LIMIT $2`, [options.chain, limit])
        : await query(`SELECT
           w.id                                   AS tracked_wallet_id,
           w.chain                                AS chain,
           w.wallet_address                       AS wallet_address,
           w.label                                AS label,
           COALESCE(SUM(r.net_result_usd), 0)     AS realized_pnl_usd,
           CASE WHEN COUNT(*) FILTER (WHERE r.closed) > 0
                THEN COUNT(*) FILTER (WHERE r.closed AND r.net_result_usd > 0)::numeric
                     / COUNT(*) FILTER (WHERE r.closed)
                END                                AS win_rate,
           COUNT(*) FILTER (WHERE r.closed)        AS closed_position_count,
           MODE() WITHIN GROUP (ORDER BY r.strategy_type) AS dominant_strategy_type
         FROM lp_tracked_wallets w
         LEFT JOIN lp_wallet_position_results r ON r.tracked_wallet_id = w.id
         GROUP BY w.id, w.chain, w.wallet_address, w.label
         ORDER BY ${sortExpression}
         LIMIT $1`, [limit]);
    return rows.map((row) => ({
        trackedWalletId: row.tracked_wallet_id,
        chain: row.chain,
        walletAddress: row.wallet_address,
        label: row.label,
        realizedPnlUsd: toSafeNumber(row.realized_pnl_usd),
        winRate: row.win_rate === null ? null : toSafeNumber(row.win_rate),
        closedPositionCount: Number(row.closed_position_count),
        dominantStrategyType: row.dominant_strategy_type
    }));
}
//# sourceMappingURL=lp-tracked-wallets.js.map