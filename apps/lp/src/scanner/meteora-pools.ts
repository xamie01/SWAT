import { prefixChainValue } from '@swat/shared';
import type { MeteoraBin } from './active-tvl.js';
import { createActiveTvlCalculator } from './active-tvl.js';
import type { NormalizedPool, PoolFetcher } from './types.js';

/**
 * Meteora DLMM pool-list fetcher (Track B1).
 *
 * Pool metadata comes from Meteora's current Data API. Bins around the active
 * bin come from an injected RPC source because the pool list does not carry
 * per-bin liquidity. When bins or prices are unavailable the fetcher degrades
 * to `activeTvl = tvl` with `activeTvlExact: false`.
 */

const DEFAULT_API_BASE = 'https://dlmm.datapi.meteora.ag';
const MAX_PAGE_SIZE = 1000;

type NumericWindow = Readonly<Record<string, number | string | undefined>>;

export interface MeteoraTokenApiRow {
  readonly address: string;
  readonly price?: number | string;
}

export interface MeteoraPairApiRow {
  readonly address: string;
  readonly name: string;
  readonly token_x: MeteoraTokenApiRow;
  readonly token_y: MeteoraTokenApiRow;
  readonly pool_config: {
    readonly bin_step: number;
    readonly base_fee_pct?: number | string;
  };
  readonly current_price?: number | string;
  readonly tvl?: number | string;
  readonly volume?: NumericWindow;
  readonly fees?: NumericWindow;
}

export interface MeteoraPoolsApiResponse {
  readonly total: number;
  readonly pages: number;
  readonly current_page: number;
  readonly page_size: number;
  readonly data: readonly MeteoraPairApiRow[];
}

export interface MeteoraTokenPrices {
  /** USD price by chain-prefixed mint; null when unknown. */
  readonly prices: ReadonlyMap<string, number>;
  /** Assumed USD price for the quote leg when it has no oracle entry (stables). */
  readonly stableQuotePriceUsd?: number;
}

export interface MeteoraBinSource {
  fetchBins(poolAddress: string): Promise<{ bins: readonly MeteoraBin[]; activeBinId: number; binStep?: number }>;
}

export interface MeteoraPoolFetcherOptions {
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  /** Restrict the scan to one pair, e.g. `SOL/USDC`. */
  readonly searchTerm?: string;
  /** Maximum number of pools returned across all API pages. */
  readonly maxPairs?: number;
  readonly tokenPrices?: MeteoraTokenPrices;
  readonly binSource?: MeteoraBinSource;
  readonly activeBinRange?: number;
}

function toNumber(value: number | string | undefined, fallback: number | null = null): number | null {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function windowValue(window: NumericWindow | undefined, key: string, fallback: number | null = null): number | null {
  return toNumber(window?.[key], fallback);
}

function percentToBps(value: number | string | undefined): number {
  return (toNumber(value, 0) ?? 0) * 100;
}

function isApiResponse(value: unknown): value is MeteoraPoolsApiResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<MeteoraPoolsApiResponse>;
  return Number.isInteger(response.total)
    && Number.isInteger(response.pages)
    && Number.isInteger(response.current_page)
    && Number.isInteger(response.page_size)
    && Array.isArray(response.data);
}

function isPoolRow(value: unknown): value is MeteoraPairApiRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<MeteoraPairApiRow>;
  return typeof row.address === 'string'
    && row.address.length > 0
    && typeof row.name === 'string'
    && Boolean(row.token_x && typeof row.token_x.address === 'string' && row.token_x.address.length > 0)
    && Boolean(row.token_y && typeof row.token_y.address === 'string' && row.token_y.address.length > 0)
    && Boolean(row.pool_config && Number.isFinite(Number(row.pool_config.bin_step)));
}

export function createMeteoraPoolFetcher(options: MeteoraPoolFetcherOptions = {}): PoolFetcher {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const activeBinRange = options.activeBinRange ?? 10;
  const activeTvlCalculator = createActiveTvlCalculator();
  const requestedMax = options.maxPairs === undefined
    ? MAX_PAGE_SIZE
    : Math.max(0, Math.floor(options.maxPairs));

  return {
    chain: 'solana',
    protocol: 'meteora-dlmm',
    async fetch(): Promise<readonly NormalizedPool[]> {
      if (requestedMax === 0) return [];

      const pageSize = Math.min(requestedMax, MAX_PAGE_SIZE);
      const rows: MeteoraPairApiRow[] = [];
      let page = 1;
      let pages = 1;

      while (page <= pages && rows.length < requestedMax) {
        const url = new URL('/pools', apiBase);
        url.searchParams.set('page', String(page));
        url.searchParams.set('page_size', String(pageSize));
        url.searchParams.set('sort_by', 'volume_24h:desc');
        if (options.searchTerm) url.searchParams.set('query', options.searchTerm);

        const response = await fetchImpl(url, { method: 'GET' });
        if (!response.ok) {
          throw new Error(`Meteora DLMM API returned ${response.status} for ${url.pathname}`);
        }
        const payload: unknown = await response.json();
        if (!isApiResponse(payload)) {
          throw new Error('Meteora DLMM API returned an invalid paginated payload');
        }

        pages = Math.max(page, payload.pages);
        for (const row of payload.data) {
          if (isPoolRow(row)) rows.push(row);
          if (rows.length >= requestedMax) break;
        }
        if (payload.data.length === 0) break;
        page += 1;
      }

      const pools: NormalizedPool[] = [];
      for (const row of rows.slice(0, requestedMax)) {
        const poolAddress = prefixChainValue(row.address, 'solana');
        const baseTokenMint = prefixChainValue(row.token_x.address, 'solana');
        const quoteTokenMint = prefixChainValue(row.token_y.address, 'solana');
        const tvl = toNumber(row.tvl, 0) ?? 0;
        const volume24h = windowValue(row.volume, '24h', 0) ?? 0;
        const fees24h = windowValue(row.fees, '24h', 0) ?? 0;
        const apiPrices = new Map<string, number>();
        const baseApiPrice = toNumber(row.token_x.price);
        const quoteApiPrice = toNumber(row.token_y.price);
        if (baseApiPrice !== null) apiPrices.set(baseTokenMint, baseApiPrice);
        if (quoteApiPrice !== null) apiPrices.set(quoteTokenMint, quoteApiPrice);
        const activeTvl = await resolveActiveTvl(
          poolAddress,
          baseTokenMint,
          quoteTokenMint,
          tvl,
          options,
          activeTvlCalculator,
          apiPrices
        );

        pools.push({
          chain: 'solana',
          protocol: 'meteora-dlmm',
          poolAddress,
          pairLabel: row.name,
          baseTokenMint,
          quoteTokenMint,
          feeBps: percentToBps(row.pool_config.base_fee_pct),
          binStep: toNumber(row.pool_config.bin_step),
          tickSpacing: null,
          currentPrice: toNumber(row.current_price),
          tvl,
          activeTvlUsd: activeTvl.usd,
          activeTvlExact: activeTvl.exact,
          volume24h,
          fees24h,
          fees7d: null
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
  activeTvlCalculator: ReturnType<typeof createActiveTvlCalculator>,
  apiPrices: ReadonlyMap<string, number>
): Promise<{ usd: number; exact: boolean }> {
  const binSource = options.binSource;
  const prices = options.tokenPrices?.prices ?? apiPrices;
  const basePriceUsd = prices.get(baseTokenMint) ?? null;
  const quotePriceUsd = prices.get(quoteTokenMint) ?? options.tokenPrices?.stableQuotePriceUsd ?? null;

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
