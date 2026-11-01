import type { LpChain, LpProtocol } from '@swat/shared';

export type { LpProtocol };

/**
 * One pool as the scan job writes it — chain-normalized so every downstream
 * consumer (fee APR, ranking, the Discover feed) is chain-agnostic.
 *
 * Addresses are chain-prefixed per the repo invariant. Money fields are USD;
 * `fees7d` is nullable because a pool younger than 7 days has no 7d window.
 */
export interface NormalizedPool {
  readonly chain: LpChain;
  readonly protocol: LpProtocol;
  /** Chain-prefixed. */
  readonly poolAddress: string;
  readonly pairLabel: string;
  /** Chain-prefixed base (Solana: token X; Uniswap: token0). */
  readonly baseTokenMint: string;
  /** Chain-prefixed quote (Solana: token Y; Uniswap: token1). */
  readonly quoteTokenMint: string;
  readonly feeBps: number;
  readonly binStep: number | null;
  readonly tickSpacing: number | null;
  /** Quote-per-base at scan time; `null` when the chain read failed. */
  readonly currentPrice: number | null;
  /** Total liquidity in the pool, USD. */
  readonly tvl: number;
  /**
   * Liquidity tradeable at the current price, USD. Falls back to `tvl` (with
   * `activeTvlExact: false`) when bin/tick context or prices are unavailable —
   * a ceiling, never an underestimate.
   */
  readonly activeTvlUsd: number;
  /** False when `activeTvlUsd` is the total-TVL fallback rather than an observation. */
  readonly activeTvlExact: boolean;
  /** Trailing 24h volume, USD; 0 when not measurable. */
  readonly volume24h: number;
  /** Trailing 24h protocol fees, USD. */
  readonly fees24h: number;
  /** Trailing 7d protocol fees, USD; `null` when the window is unavailable. */
  readonly fees7d: number | null;
}

/**
 * The chain boundary the scan job sees. Each chain implements this once
 * (Track B1/B2); everything downstream is shared. Implementations own their
 * active-TVL context internally and return it already computed.
 */
export interface PoolFetcher {
  readonly chain: LpChain;
  readonly protocol: LpProtocol;
  /** One scan pass over the chain's pool list. */
  fetch(): Promise<readonly NormalizedPool[]>;
}

export interface ScanSummary {
  readonly scannedByChain: Record<string, number>;
  readonly failedFetchers: readonly string[];
}
