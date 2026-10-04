import type { LpChain } from '@swat/shared';
import { query } from './client.js';

/**
 * LP pool discovery cache (`059`).
 *
 * The table is a cache of what the scanner last saw, not authority: a pool that
 * vanished on-chain keeps its row until `pruneStaleLpPools` is called, and a
 * row whose `risk_score` is still NULL has not been through the Track C risk
 * filter. `listDiscoverPools` enforces that second rule in SQL so the Discover
 * feed can never ship an unassessed pool, even if a future caller forgets.
 *
 * There is no `UserScope` anywhere in this module: pools are a shared cache
 * with no user-owned column. Rows are upserted by the scan job
 * (`crossTenantScope` work) and read by whoever renders the feed.
 */

export type LpProtocol = 'meteora-dlmm' | 'uniswap-v3' | 'uniswap-v4';

export interface LpPool {
  readonly id: string;
  readonly chain: LpChain;
  readonly protocol: LpProtocol;
  /** Chain-prefixed. */
  readonly poolAddress: string;
  readonly pairLabel: string;
  /** Chain-prefixed. */
  readonly baseTokenMint: string;
  /** Chain-prefixed. */
  readonly quoteTokenMint: string;
  readonly feeBps: number;
  readonly binStep: number | null;
  readonly tickSpacing: number | null;
  /** `null` reads as "stored NUMERIC does not fit a float64" — never coerce to 0. */
  readonly tvl: number | null;
  readonly activeTvl: number | null;
  readonly volume24h: number | null;
  readonly feeApr24h: number | null;
  readonly feeApr7d: number | null;
  /** `null` means not yet risk-assessed; the Discover feed excludes these. */
  readonly riskScore: number | null;
  readonly riskFlags: readonly string[];
  readonly lastScannedAt: Date;
  readonly createdAt: Date;
}

interface PoolRow {
  id: string;
  chain: LpChain;
  protocol: LpProtocol;
  pool_address: string;
  pair_label: string;
  base_token_mint: string;
  quote_token_mint: string;
  fee_bps: number | string;
  bin_step: number | null;
  tick_spacing: number | null;
  tvl: number | string | null;
  active_tvl: number | string | null;
  volume_24h: number | string | null;
  fee_apr_24h: number | string | null;
  fee_apr_7d: number | string | null;
  risk_score: number | string | null;
  risk_flags: unknown;
  last_scanned_at: Date;
  created_at: Date;
}

const POOL_COLUMNS =
  'id, chain, protocol, pool_address, pair_label, base_token_mint, quote_token_mint, ' +
  'fee_bps, bin_step, tick_spacing, tvl, active_tvl, volume_24h, fee_apr_24h, fee_apr_7d, ' +
  'risk_score, risk_flags, last_scanned_at, created_at';

/** NUMERIC arrives as number (fits float64) or string (does not) — never round silently. */
function toSafeNumber(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

function toPool(row: PoolRow): LpPool {
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

export interface UpsertLpPoolInput {
  readonly chain: LpChain;
  readonly protocol: LpProtocol;
  /** Chain-prefixed. */
  readonly poolAddress: string;
  readonly pairLabel: string;
  /** Chain-prefixed. */
  readonly baseTokenMint: string;
  /** Chain-prefixed. */
  readonly quoteTokenMint: string;
  readonly feeBps: number;
  readonly binStep?: number | null;
  readonly tickSpacing?: number | null;
  readonly tvl: number;
  readonly activeTvl: number;
  readonly volume24h: number;
  readonly feeApr24h?: number | null;
  readonly feeApr7d?: number | null;
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`lp_pools.${name} must be a non-negative finite number, got ${value}`);
  }
}

/**
 * Writes one scanner observation, replacing the previous one for the identity
 * triple. `last_scanned_at = NOW()` is set by the database so a clock-skewed
 * scanner cannot write a future timestamp.
 */
export async function upsertLpPool(input: UpsertLpPoolInput): Promise<LpPool> {
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

  const rows = await query<PoolRow>(
    `INSERT INTO lp_pools
       (chain, protocol, pool_address, pair_label, base_token_mint, quote_token_mint,
        fee_bps, bin_step, tick_spacing, tvl, active_tvl, volume_24h,
        fee_apr_24h, fee_apr_7d, last_scanned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
     ON CONFLICT (chain, protocol, pool_address) DO UPDATE
       SET pair_label        = EXCLUDED.pair_label,
           base_token_mint   = EXCLUDED.base_token_mint,
           quote_token_mint  = EXCLUDED.quote_token_mint,
           fee_bps           = EXCLUDED.fee_bps,
           bin_step          = EXCLUDED.bin_step,
           tick_spacing      = EXCLUDED.tick_spacing,
           tvl               = EXCLUDED.tvl,
           active_tvl        = EXCLUDED.active_tvl,
           volume_24h        = EXCLUDED.volume_24h,
           fee_apr_24h       = EXCLUDED.fee_apr_24h,
           fee_apr_7d        = EXCLUDED.fee_apr_7d,
           last_scanned_at   = EXCLUDED.last_scanned_at
     RETURNING ${POOL_COLUMNS}`,
    [
      input.chain,
      input.protocol,
      input.poolAddress,
      input.pairLabel,
      input.baseTokenMint,
      input.quoteTokenMint,
      input.feeBps,
      input.binStep ?? null,
      input.tickSpacing ?? null,
      input.tvl,
      input.activeTvl,
      input.volume24h,
      input.feeApr24h ?? null,
      input.feeApr7d ?? null
    ]
  );
  return toPool(rows[0]!);
}

export type DiscoverPoolSort = 'volume' | 'activeTvl' | 'feeApr24h';

const SORT_EXPRESSIONS: Record<DiscoverPoolSort, string> = {
  volume: 'volume_24h DESC',
  activeTvl: 'active_tvl DESC',
  feeApr24h: 'fee_apr_24h DESC NULLS LAST'
};

/**
 * The Discover feed. Risk-unassessed pools are excluded in the WHERE clause,
 * not the caller — an unassessed row must read as *absent*, because showing it
 * would present "we have not looked yet" as "we looked and it passed".
 */
export async function listDiscoverPools(options: {
  chain?: LpChain;
  sort?: DiscoverPoolSort;
  limit?: number;
  offset?: number;
} = {}): Promise<LpPool[]> {
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
    ? await query<PoolRow>(
        `SELECT ${POOL_COLUMNS} FROM lp_pools
          WHERE chain = $1 AND risk_score IS NOT NULL
          ORDER BY ${sortExpression}
          LIMIT $2 OFFSET $3`,
        [options.chain, limit, offset]
      )
    : await query<PoolRow>(
        `SELECT ${POOL_COLUMNS} FROM lp_pools
          WHERE risk_score IS NOT NULL
          ORDER BY ${sortExpression}
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
  return rows.map(toPool);
}

export async function getLpPool(
  chain: LpChain,
  poolAddress: string
): Promise<LpPool | null> {
  const rows = await query<PoolRow>(
    `SELECT ${POOL_COLUMNS} FROM lp_pools WHERE chain = $1 AND pool_address = $2`,
    [chain, poolAddress]
  );
  return rows[0] ? toPool(rows[0]) : null;
}

/** Track C6: attaches a risk score to a scanned pool. A pool without one never reaches the feed. */
export async function attachLpPoolRisk(
  chain: LpChain,
  poolAddress: string,
  riskScore: number,
  riskFlags: readonly string[]
): Promise<void> {
  if (!Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
    throw new Error(`lp_pools.risk_score must be a finite number in 0..100, got ${riskScore}`);
  }
  await query(
    `UPDATE lp_pools
       SET risk_score = $3, risk_flags = $4::jsonb
       WHERE chain = $1 AND pool_address = $2`,
    [chain, poolAddress, riskScore, JSON.stringify(riskFlags)]
  );
}

/** Scan-job input: pools due for a rescan, oldest first. Served by idx_lp_pools_scanned_at. */
export async function listStaleLpPools(olderThanSeconds: number, limit = 200): Promise<LpPool[]> {
  if (!Number.isFinite(olderThanSeconds) || olderThanSeconds < 0) {
    throw new Error(`listStaleLpPools olderThanSeconds must be non-negative, got ${olderThanSeconds}`);
  }
  const rows = await query<PoolRow>(
    `SELECT ${POOL_COLUMNS} FROM lp_pools
      WHERE last_scanned_at < NOW() - make_interval(secs => $1::double precision)
      ORDER BY last_scanned_at
      LIMIT $2`,
    [olderThanSeconds, limit]
  );
  return rows.map(toPool);
}

/**
 * Removes rows the scanner has not seen again within the window. Needed for the
 * same reason `pruneUserBalances` exists: an upsert-only cache can never zero
 * out a pool that stopped being listed, and a vanished pool on the feed is a
 * position waiting to happen.
 */
export async function pruneStaleLpPools(olderThanSeconds: number): Promise<number> {
  if (!Number.isFinite(olderThanSeconds) || olderThanSeconds < 0) {
    throw new Error(`pruneStaleLpPools olderThanSeconds must be non-negative, got ${olderThanSeconds}`);
  }
  const rows = await query<{ pool_address: string }>(
    `DELETE FROM lp_pools
      WHERE last_scanned_at < NOW() - make_interval(secs => $1::double precision)
      RETURNING pool_address`,
    [olderThanSeconds]
  );
  return rows.length;
}
