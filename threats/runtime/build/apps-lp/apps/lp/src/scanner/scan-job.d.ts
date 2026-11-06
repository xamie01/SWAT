import type { LpChain } from '@swat/shared';
import type { NormalizedPool, PoolFetcher, ScanSummary } from './types.js';
/**
 * The scan job (Track B6) — wires the fetchers (B1/B2), the active-TVL
 * calculators (B3, inside the fetchers), the fee APR calculator (B4), and the
 * ranking function (B5, applied by the API at request time) into one scheduled
 * pass that writes the `lp_pools` cache, tagged by chain.
 *
 * One fetcher failing must not lose the other chain's scan: failed fetchers
 * are reported in the summary, not thrown. A pool without a risk score still
 * gets written (Track C6 attaches the score in a second step) — the *feed*
 * excludes unassessed pools, so a crash between scan and risk pass degrades
 * freshness, never correctness.
 */
export interface UpsertLpPoolPort {
    upsert(input: {
        chain: LpChain;
        protocol: NormalizedPool['protocol'];
        poolAddress: string;
        pairLabel: string;
        baseTokenMint: string;
        quoteTokenMint: string;
        feeBps: number;
        binStep: number | null;
        tickSpacing: number | null;
        currentPrice: number | null;
        tvl: number;
        activeTvl: number;
        volume24h: number;
        feeApr24h: number | null;
        feeApr7d: number | null;
    }): Promise<unknown>;
}
export interface ScanJobDeps {
    readonly fetchers: readonly PoolFetcher[];
    readonly store: UpsertLpPoolPort;
}
export declare function runPoolScan(deps: ScanJobDeps): Promise<ScanSummary>;
//# sourceMappingURL=scan-job.d.ts.map