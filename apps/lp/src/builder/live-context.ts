import type { LpChain } from '@swat/shared';
import { getLpPool } from '@swat/db';
import type { LivePoolContext } from './live-preview.js';
import type { MeteoraBinSource } from '../scanner/meteora-pools.js';
import type { EvmPoolReader } from '../scanner/evm-clmm-pools.js';
import { isEvmChain, type EvmSupportedChain } from '../scanner/evm-clmm-registry.js';

export interface LiveContextSource {
  fetchLiveContext(
    chain: LpChain,
    poolAddress: string
  ): Promise<LivePoolContext | null>;
}

export interface LiveContextSourceOptions {
  readonly solanaBinSource?: MeteoraBinSource;
  readonly evmReader?: EvmPoolReader;
  readonly evmReaders?: Partial<Record<EvmSupportedChain, EvmPoolReader>>;
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
      anchor: null,
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

        if (isEvmChain(chain)) {
          const reader = options.evmReaders?.[chain] ?? options.evmReader;
          if (!reader) return fromCache(chain, poolAddress);
          const colon = poolAddress.indexOf(':');
          const rawAddress = colon >= 0 ? poolAddress.slice(colon + 1) : poolAddress;
          const state = await reader.readPoolState(rawAddress);
          const sqrt = Number(state.sqrtPriceX96) / 2 ** 96;
          const currentPrice = sqrt * sqrt * 10 ** (state.token0Decimals - state.token1Decimals);
          return {
            chain,
            currentPrice,
            anchor: { kind: 'tick', currentTick: state.tick },
            binStep: null,
            tickSpacing: state.tickSpacing,
            bins: null,
            bands: await reader.liquidityBands(rawAddress, state.tick, 1200),
            fetchedAt: new Date(),
            warnings: []
          };
        }

        return fromCache(chain, poolAddress);
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
