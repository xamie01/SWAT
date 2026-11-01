import type { LpChain } from '@swat/shared';
import { realizedFeeApr } from './fee-apr.js';
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

export async function runPoolScan(deps: ScanJobDeps): Promise<ScanSummary> {
  const scannedByChain: Record<string, number> = {};
  const failedFetchers: string[] = [];

  for (const fetcher of deps.fetchers) {
    try {
      const pools = await fetcher.fetch();
      let written = 0;
      for (const pool of pools) {
        const apr = realizedFeeApr({ fees24h: pool.fees24h, fees7d: pool.fees7d, tvl: pool.tvl });
        await deps.store.upsert({
          chain: pool.chain,
          protocol: pool.protocol,
          poolAddress: pool.poolAddress,
          pairLabel: pool.pairLabel,
          baseTokenMint: pool.baseTokenMint,
          quoteTokenMint: pool.quoteTokenMint,
          feeBps: pool.feeBps,
          binStep: pool.binStep,
          tickSpacing: pool.tickSpacing,
          currentPrice: pool.currentPrice,
          tvl: pool.tvl,
          activeTvl: pool.activeTvlUsd,
          volume24h: pool.volume24h,
          feeApr24h: apr.feeApr24h,
          feeApr7d: apr.feeApr7d
        });
        written += 1;
      }
      scannedByChain[fetcher.chain] = (scannedByChain[fetcher.chain] ?? 0) + written;
    } catch (error) {
      failedFetchers.push(`${fetcher.chain}:${fetcher.protocol}`);
      console.error(
        `[lp] scan fetcher failed for ${fetcher.chain}/${fetcher.protocol}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return { scannedByChain, failedFetchers };
}
