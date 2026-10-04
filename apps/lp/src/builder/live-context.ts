import type { LpChain } from '@swat/shared';
import { getLpPool } from '@swat/db';
import type { LivePoolContext } from './live-preview.js';
import type { MeteoraBinSource } from '../scanner/meteora-pools.js';
import type { RobinhoodPoolReader } from '../scanner/robinhood-pools.js';

/**
 * Live pool context for the manual builder's preview (Track I1) — the bin/tick
 * state of the selected pool fetched NOW, not the scan cache.
 *
 * Two sources:
 *   - Solana: the RPC bin source (`solana-bins.ts`, mainnet-verified decode) —
 *     LbPair for active_id/bin_step, BinArrays for liquidity, prices Q64.64.
 *   - Robinhood Chain: the viem pool reader — slot0 for tick + price,
 *     tick-band liquidity through the reader's `liquidityBands` seam.
 *
 * When the live fetch fails, the source degrades to the scan cache with an
 * explicit warning on the context — a preview backed by stale data must say
 * so, because the user is about to size a real deposit against it.
 */

export interface LiveContextSource {
  fetchLiveContext(
    chain: LpChain,
    poolAddress: string
  ): Promise<LivePoolContext | null>;
}

export interface LiveContextSourceOptions {
  readonly solanaBinSource?: MeteoraBinSource;
  readonly evmReader?: RobinhoodPoolReader;
  /** Scan-cache fallback; injectable for tests. Defaults to getLpPool. */
  readonly getPool?: typeof getLpPool;
}

export function createLiveContextSource(options: LiveContextSourceOptions): LiveContextSource {
  const getPool = options.getPool ?? getLpPool;

  async function fromCache(chain: LpChain, poolAddress: string): Promise<LivePoolContext | null> {
    const pool = await getPool(chain, poolAddress);
    if (!pool || pool.currentPrice === null) return null;
    return {
      chain,
      currentPrice: pool.currentPrice,
      anchor:
        pool.protocol === 'meteora-dlmm'
          ? { kind: 'bin', activeBinId: 0 }
          : { kind: 'tick', currentTick: 0 },
      binStep: pool.binStep,
      tickSpacing: pool.tickSpacing,
      bins: null,
      bands: null,
      fetchedAt: new Date(),
      warnings: ['live context unavailable — anchored on the scan cache, which may be stale']
    };
  }

  return {
    async fetchLiveContext(chain, poolAddress) {
      try {
        if (chain === 'solana') {
          if (!options.solanaBinSource) return fromCache(chain, poolAddress);
          const { bins, activeBinId, binStep } = await options.solanaBinSource.fetchBins(poolAddress);
          const activeBin = bins.find((bin) => bin.binId === activeBinId);
          if (!activeBin) {
            throw new Error('active bin not present in the fetched window');
          }
          return {
            chain,
            currentPrice: activeBin.price,
            anchor: { kind: 'bin', activeBinId },
            binStep: binStep ?? null,
            tickSpacing: null,
            bins,
            bands: null,
            fetchedAt: new Date(),
            warnings: []
          };
        }

        if (!options.evmReader) return fromCache(chain, poolAddress);
        const rawAddress = poolAddress.startsWith('robinhood-chain:')
          ? poolAddress.slice('robinhood-chain:'.length)
          : poolAddress;
        const state = await options.evmReader.readPoolState(rawAddress);
        // Quote-per-base from sqrtPriceX96, scaled by the decimal difference —
        // same math as the scanner fetcher.
        const sqrt = Number(state.sqrtPriceX96) / 2 ** 96;
        const currentPrice = sqrt * sqrt * 10 ** (state.token0Decimals - state.token1Decimals);
        return {
          chain,
          currentPrice,
          anchor: { kind: 'tick', currentTick: state.tick },
          binStep: null,
          tickSpacing: state.tickSpacing,
          bins: null,
          bands: await options.evmReader.liquidityBands(rawAddress, state.tick, 1200),
          fetchedAt: new Date(),
          warnings: []
        };
      } catch (error) {
        const cached = await fromCache(chain, poolAddress);
        if (cached) {
          return {
            ...cached,
            warnings: [
              `live fetch failed (${error instanceof Error ? error.message : String(error)}); anchored on the scan cache, which may be stale`
            ]
          };
        }
        return null;
      }
    }
  };
}
