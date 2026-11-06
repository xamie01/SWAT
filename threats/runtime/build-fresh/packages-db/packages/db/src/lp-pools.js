import { query } from './client.js';
const POOL_COLUMNS = 'id, chain, protocol, pool_address, pair_label, base_token_mint, quote_token_mint, ' +
    'fee_bps, bin_step, tick_spacing, current_price, tvl, active_tvl, volume_24h, fee_apr_24h, fee_apr_7d, ' +
    'risk_score, risk_flags, last_scanned_at, created_at';
/** NUMERIC arrives as number (fits float64) or string (does not) — never round silently. */
function toSafeNumber(value) {
    if (value === null)
        return null;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    return null;
}
function toPool(row) {
    return {
        id: row.id,
        chain: row.chain,
        protocol: row.protocol,
        poolAddress: row.pool_address,
        pairLabel: row.pair_label,
        baseTokenMint: row.base_token_mint,
        quoteTokenMint: row.quote_token_mint,
        feeBps: Number(row.fee_bps),
        binStep: row.bin_step,
        tickSpacing: row.tick_spacing,
        currentPrice: toSafeNumber(row.current_price),
        tvl: toSafeNumber(row.tvl),
        activeTvl: toSafeNumber(row.active_tvl),
        volume24h: toSafeNumber(row.volume_24h),
        feeApr24h: toSafeNumber(row.fee_apr_24h),
        feeApr7d: toSafeNumber(row.fee_apr_7d),
        riskScore: toSafeNumber(row.risk_score),
        riskFlags: Array.isArray(row.risk_flags) ? row.risk_flags.map(String) : [],
        lastScannedAt: row.last_scanned_at,
        createdAt: row.created_at
    };
}
function assertNonNegative(name, value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`lp_pools.${name} must be a non-negative finite number, got ${value}`);
    }
}
/**
 * Writes one scanner observation, replacing the previous one for the identity
 * triple. `last_scanned_at = NOW()` is set by the database so a clock-skewed
 * scanner cannot write a future timestamp.
 */
export async function upsertLpPool(input) {
    if (input.poolAddress.indexOf(':') < 0) {
        throw new Error('lp_pools.pool_address must be chain-prefixed');
    }
    if (input.baseTokenMint.indexOf(':') < 0 || input.quoteTokenMint.indexOf(':') < 0) {
        throw new Error('lp_pools token mints must be chain-prefixed');
    }
    assertNonNegative('fee_bps', input.feeBps);
    assertNonNegative('tvl', input.tvl);
    assertNonNegative('active_tvl', input.activeTvl);
    assertNonNegative('volume_24h', input.volume24h);
    const rows = await query(`INSERT INTO lp_pools
       (chain, protocol, pool_address, pair_label, base_token_mint, quote_token_mint,
        fee_bps, bin_step, tick_spacing, current_price, tvl, active_tvl, volume_24h,
        fee_apr_24h, fee_apr_7d, last_scanned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
     ON CONFLICT (chain, protocol, pool_address) DO UPDATE
       SET pair_label        = EXCLUDED.pair_label,
           base_token_mint   = EXCLUDED.base_token_mint,
           quote_token_mint  = EXCLUDED.quote_token_mint,
           fee_bps           = EXCLUDED.fee_bps,
           bin_step          = EXCLUDED.bin_step,
           tick_spacing      = EXCLUDED.tick_spacing,
           current_price     = EXCLUDED.current_price,
           tvl               = EXCLUDED.tvl,
           active_tvl        = EXCLUDED.active_tvl,
           volume_24h        = EXCLUDED.volume_24h,
           fee_apr_24h       = EXCLUDED.fee_apr_24h,
           fee_apr_7d        = EXCLUDED.fee_apr_7d,
           last_scanned_at   = EXCLUDED.last_scanned_at
     RETURNING ${POOL_COLUMNS}`, [
        input.chain,
        input.protocol,
        input.poolAddress,
        input.pairLabel,
        input.baseTokenMint,
        input.quoteTokenMint,
        input.feeBps,
        input.binStep ?? null,
        input.tickSpacing ?? null,
        input.currentPrice ?? null,
        input.tvl,
        input.activeTvl,
        input.volume24h,
        input.feeApr24h ?? null,
        input.feeApr7d ?? null
    ]);
    return toPool(rows[0]);
}
const SORT_EXPRESSIONS = {
    volume: 'volume_24h DESC',
    activeTvl: 'active_tvl DESC',
    feeApr24h: 'fee_apr_24h DESC NULLS LAST'
};
/**
 * The Discover feed. Risk-unassessed pools are excluded in the WHERE clause,
 * not the caller — an unassessed row must read as *absent*, because showing it
 * would present "we have not looked yet" as "we looked and it passed".
 */
export async function listDiscoverPools(options = {}) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new Error(`listDiscoverPools limit must be an integer in 1..200, got ${limit}`);
    }
    const offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`listDiscoverPools offset must be a non-negative integer, got ${offset}`);
    }
    const sortExpression = SORT_EXPRESSIONS[options.sort ?? 'volume'];
    const rows = options.chain
        ? await query(`SELECT ${POOL_COLUMNS} FROM lp_pools
          WHERE chain = $1 AND risk_score IS NOT NULL
          ORDER BY ${sortExpression}
          LIMIT $2 OFFSET $3`, [options.chain, limit, offset])
        : await query(`SELECT ${POOL_COLUMNS} FROM lp_pools
          WHERE risk_score IS NOT NULL
          ORDER BY ${sortExpression}
          LIMIT $1 OFFSET $2`, [limit, offset]);
    return rows.map(toPool);
}
export async function getLpPool(chain, poolAddress) {
    const rows = await query(`SELECT ${POOL_COLUMNS} FROM lp_pools WHERE chain = $1 AND pool_address = $2`, [chain, poolAddress]);
    return rows[0] ? toPool(rows[0]) : null;
}
/** Track C6: attaches a risk score to a scanned pool. A pool without one never reaches the feed. */
export async function attachLpPoolRisk(chain, poolAddress, riskScore, riskFlags) {
    if (!Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
        throw new Error(`lp_pools.risk_score must be a finite number in 0..100, got ${riskScore}`);
    }
    await query(`UPDATE lp_pools
       SET risk_score = $3, risk_flags = $4::jsonb
       WHERE chain = $1 AND pool_address = $2`, [chain, poolAddress, riskScore, JSON.stringify(riskFlags)]);
}
/** Scan-job input: pools due for a rescan, oldest first. Served by idx_lp_pools_scanned_at. */
export async function listStaleLpPools(olderThanSeconds, limit = 200) {
    if (!Number.isFinite(olderThanSeconds) || olderThanSeconds < 0) {
        throw new Error(`listStaleLpPools olderThanSeconds must be non-negative, got ${olderThanSeconds}`);
    }
    const rows = await query(`SELECT ${POOL_COLUMNS} FROM lp_pools
      WHERE last_scanned_at < NOW() - make_interval(secs => $1::double precision)
      ORDER BY last_scanned_at
      LIMIT $2`, [olderThanSeconds, limit]);
    return rows.map(toPool);
}
/** Risk-pass input (Track C6): scanned pools still waiting for their risk score. */
export async function listUnassessedLpPools(limit = 200) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error(`listUnassessedLpPools limit must be an integer in 1..1000, got ${limit}`);
    }
    const rows = await query(`SELECT ${POOL_COLUMNS} FROM lp_pools
      WHERE risk_score IS NULL
      ORDER BY last_scanned_at
      LIMIT $1`, [limit]);
    return rows.map(toPool);
}
/**
 * Removes rows the scanner has not seen again within the window. Needed for the
 * same reason `pruneUserBalances` exists: an upsert-only cache can never zero
 * out a pool that stopped being listed, and a vanished pool on the feed is a
 * position waiting to happen.
 */
export async function pruneStaleLpPools(olderThanSeconds) {
    if (!Number.isFinite(olderThanSeconds) || olderThanSeconds < 0) {
        throw new Error(`pruneStaleLpPools olderThanSeconds must be non-negative, got ${olderThanSeconds}`);
    }
    const rows = await query(`DELETE FROM lp_pools
      WHERE last_scanned_at < NOW() - make_interval(secs => $1::double precision)
      RETURNING pool_address`, [olderThanSeconds]);
    return rows.length;
}
//# sourceMappingURL=lp-pools.js.map