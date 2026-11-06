import type { LpChain, LpProtocol } from '@swat/shared';
export type { LpProtocol };
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
    /** Quote-per-base at scan time; null when the chain read failed. */
    readonly currentPrice: number | null;
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
    readonly currentPrice?: number | null;
    readonly tvl: number;
    readonly activeTvl: number;
    readonly volume24h: number;
    readonly feeApr24h?: number | null;
    readonly feeApr7d?: number | null;
}
/**
 * Writes one scanner observation, replacing the previous one for the identity
 * triple. `last_scanned_at = NOW()` is set by the database so a clock-skewed
 * scanner cannot write a future timestamp.
 */
export declare function upsertLpPool(input: UpsertLpPoolInput): Promise<LpPool>;
export type DiscoverPoolSort = 'volume' | 'activeTvl' | 'feeApr24h';
/**
 * The Discover feed. Risk-unassessed pools are excluded in the WHERE clause,
 * not the caller — an unassessed row must read as *absent*, because showing it
 * would present "we have not looked yet" as "we looked and it passed".
 */
export declare function listDiscoverPools(options?: {
    chain?: LpChain;
    sort?: DiscoverPoolSort;
    limit?: number;
    offset?: number;
}): Promise<LpPool[]>;
export declare function getLpPool(chain: LpChain, poolAddress: string): Promise<LpPool | null>;
/** Track C6: attaches a risk score to a scanned pool. A pool without one never reaches the feed. */
export declare function attachLpPoolRisk(chain: LpChain, poolAddress: string, riskScore: number, riskFlags: readonly string[]): Promise<void>;
/** Scan-job input: pools due for a rescan, oldest first. Served by idx_lp_pools_scanned_at. */
export declare function listStaleLpPools(olderThanSeconds: number, limit?: number): Promise<LpPool[]>;
/** Risk-pass input (Track C6): scanned pools still waiting for their risk score. */
export declare function listUnassessedLpPools(limit?: number): Promise<LpPool[]>;
/**
 * Removes rows the scanner has not seen again within the window. Needed for the
 * same reason `pruneUserBalances` exists: an upsert-only cache can never zero
 * out a pool that stopped being listed, and a vanished pool on the feed is a
 * position waiting to happen.
 */
export declare function pruneStaleLpPools(olderThanSeconds: number): Promise<number>;
//# sourceMappingURL=lp-pools.d.ts.map