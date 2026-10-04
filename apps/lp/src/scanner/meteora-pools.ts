import { prefixChainValue } from '@swat/shared';
import type { MeteoraBin } from './active-tvl.js';
import { createActiveTvlCalculator } from './active-tvl.js';
import type { NormalizedPool, PoolFetcher } from './types.js';

/**
 * Meteora DLMM pool-list fetcher (Track B1).
 *
 * Pool list comes from Meteora's public DLMM REST API; bins around the active
 * bin come from an injected `binSource` (the `@meteora-ag/dlmm` SDK in the
 * live service) because the REST list does not carry per-bin liquidity. When
 * bins or prices are unavailable the fetcher degrades to `activeTvl = tvl`
 * with `activeTvlExact: false` — a ceiling, never an underestimate.
 *
 * `fetchImpl` and `binSource` are injectable; fixtures replace both.
 */

const DEFAULT_API_BASE = 'https://dlmm-api.meteora.ag';

/** The fields of a `/pair/all` row this fetcher consumes. Extra fields are ignored. */
export interface MeteoraPairApiRow {
  readonly address: string;
  readonly name: string;
  readonly mint_x: string;
  readonly mint_y: string;
  readonly bin_step: number;
  /** Fraction, e.g. 0.002 = 0.2% = 20 bps. */
  readonly base_fee_percentage?: number | string;
  readonly current_price?: number | string;
  readonly tvl?: number | string;
  readonly trade_volume_24h?: number | string;
  readonly fees_24h?: number | string;
  readonly fees_7d?: number | string;
}

export interface MeteoraTokenPrices {
  /** USD price by chain-prefixed mint; null when unknown. */
  readonly prices: ReadonlyMap<string, number>;
  /** Assumed USD price for the quote leg when it has no oracle entry (stables). */
  readonly stableQuotePriceUsd?: number;
}

export interface MeteoraBinSource {
  /**
   * Bins around the active bin, human-scale. `binStep` rides along when the
   * source knows it (the RPC source reads it from the LbPair) so callers can
   * snap ladder plans without a second lookup.
   */
  fetchBins(poolAddress: string): Promise<{ bins: readonly MeteoraBin[]; activeBinId: number; binStep?: number }>;
}

export interface MeteoraPoolFetcherOptions {
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  /** Restrict the scan to one pair, e.g. `SOL/USDC`. Omitted = all pairs. */
  readonly searchTerm?: string;
  readonly maxPairs?: number;
  readonly tokenPrices?: MeteoraTokenPrices;
  readonly binSource?: MeteoraBinSource;
  /** Bins each side of the active bin counted as "active" liquidity. */
  readonly activeBinRange?: number;
}

function toNumber(value: number | string | undefined, fallback: number | null = null): number | null {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fractionToBps(value: number | string | undefined): number {
  const fraction = toNumber(value, 0) ?? 0;
  return fraction * 10_000;
}

export function createMeteoraPoolFetcher(options: MeteoraPoolFetcherOptions = {}): PoolFetcher {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const activeBinRange = options.activeBinRange ?? 10;
  const activeTvlCalculator = createActiveTvlCalculator();

  return {
    chain: 'solana',
    protocol: 'meteora-dlmm',
    async fetch(): Promise<readonly NormalizedPool[]> {
      const url = new URL('/pair/all', apiBase);
      if (options.searchTerm) url.searchParams.set('searchTerm', options.searchTerm);
      if (options.maxPairs) url.searchParams.set('limit', String(options.maxPairs));

      const response = await fetchImpl(url, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`Meteora DLMM API returned ${response.status} for ${url.pathname}`);
      }
      const rows = (await response.json()) as readonly MeteoraPairApiRow[];
      if (!Array.isArray(rows)) {
        throw new Error('Meteora DLMM API returned a non-array payload');
      }

      const pools: NormalizedPool[] = [];
      for (const row of rows) {
        if (!row?.address || !row.mint_x || !row.mint_y) continue;

        const poolAddress = prefixChainValue(row.address, 'solana');
        const baseTokenMint = prefixChainValue(row.mint_x, 'solana');
        const quoteTokenMint = prefixChainValue(row.mint_y, 'solana');

        const tvl = toNumber(row.tvl, 0) ?? 0;
        const volume24h = toNumber(row.trade_volume_24h, 0) ?? 0;
        const fees24h = toNumber(row.fees_24h, 0) ?? 0;
        const fees7d = toNumber(row.fees_7d);

        const activeTvl = await resolveActiveTvl(poolAddress, baseTokenMint, quoteTokenMint, tvl, options, activeTvlCalculator);

        pools.push({
          chain: 'solana',
          protocol: 'meteora-dlmm',
          poolAddress,
          pairLabel: row.name ?? `${row.mint_x}/${row.mint_y}`,
          baseTokenMint,
          quoteTokenMint,
          feeBps: fractionToBps(row.base_fee_percentage),
          binStep: toNumber(row.bin_step) ?? null,
          tickSpacing: null,
          currentPrice: toNumber(row.current_price),
          tvl,
          activeTvlUsd: activeTvl.usd,
          activeTvlExact: activeTvl.exact,
          volume24h,
          fees24h,
          fees7d
        });
      }
      return pools;
    }
  };
}

async function resolveActiveTvl(
  poolAddress: string,
  baseTokenMint: string,
  quoteTokenMint: string,
  tvl: number,
  options: MeteoraPoolFetcherOptions,
  activeTvlCalculator: ReturnType<typeof createActiveTvlCalculator>
): Promise<{ usd: number; exact: boolean }> {
  const binSource = options.binSource;
  const prices = options.tokenPrices?.prices;
  const basePriceUsd = prices?.get(baseTokenMint) ?? null;
  const quotePriceUsd = prices?.get(quoteTokenMint) ?? options.tokenPrices?.stableQuotePriceUsd ?? null;

  if (binSource && basePriceUsd !== null && quotePriceUsd !== null) {
    try {
      const { bins, activeBinId } = await binSource.fetchBins(poolAddress);
      if (Number.isInteger(activeBinId)) {
        const usd = activeTvlCalculator.calculateActiveTvl({
          protocol: 'meteora-dlmm',
          bins,
          activeBinId,
          range: options.activeBinRange ?? 10,
          basePriceUsd,
          quotePriceUsd
        });
        if (usd !== null) return { usd, exact: true };
      }
    } catch {
      // Fall through to the total-TVL ceiling.
    }
  }
  return { usd: tvl, exact: false };
}
