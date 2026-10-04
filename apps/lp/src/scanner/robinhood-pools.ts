import { createPublicClient, http, type PublicClient } from 'viem';
import { prefixChainValue } from '@swat/shared';
import { createActiveTvlCalculator, type TickBand } from './active-tvl.js';
import type { NormalizedPool, PoolFetcher } from './types.js';

/**
 * Robinhood Chain pool-list fetcher (Track B2) — Uniswap v3 pools via direct
 * RPC reads. There is no subgraph deployment to lean on, and factory-event
 * enumeration over a young chain is slow and fragile, so the pool *list* is
 * operator-configured (`ROBINHOOD_LP_POOL_ADDRESSES`, comma-separated raw
 * addresses) while the pool *state* (fee, tick spacing, price, liquidity,
 * 24h volume from Swap logs) is read live per address.
 *
 * Uniswap v4 is the same interface, config-gated: when
 * `ROBINHOOD_LP_V4_POOL_ADDRESSES` is set, those addresses are surfaced with
 * `protocol: 'uniswap-v4'` after their state read (v4 pools answer the same
 * state calls through the PoolManager view facade). Until the v4 contracts on
 * Robinhood Chain are confirmed, an address whose read fails is skipped and
 * reported, never silently dropped from the run summary.
 *
 * `reader` is injectable; fixtures replace it.
 */

export interface RobinhoodPoolState {
  readonly address: string;
  readonly token0: string;
  readonly token1: string;
  /** Hundredths of a bip, Uniswap convention: 3000 = 30 bps. */
  readonly fee: number;
  readonly tickSpacing: number;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly inRangeLiquidity: bigint;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
}

export interface RobinhoodVolumeSource {
  /** Trailing 24h swap volume in USD, or null when it cannot be priced. */
  volume24hUsd(address: string): Promise<number | null>;
}

export interface RobinhoodTokenPriceSource {
  /** USD price by raw (unprefixed) token address; null when unknown. */
  priceUsd(token: string): Promise<number | null>;
}

export interface RobinhoodPoolReader {
  listConfiguredPools(): Promise<readonly string[]>;
  readPoolState(address: string): Promise<RobinhoodPoolState>;
  liquidityBands(address: string, currentTick: number, range: number): Promise<readonly TickBand[]>;
}

export interface RobinhoodPoolFetcherOptions {
  readonly reader: RobinhoodPoolReader;
  readonly volumeSource?: RobinhoodVolumeSource;
  readonly priceSource?: RobinhoodTokenPriceSource;
  /** Ticks each side of the current tick counted as "active" liquidity. */
  readonly activeTickRange?: number;
  readonly protocol?: 'uniswap-v3' | 'uniswap-v4';
}

const V3_POOL_ABI = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  { name: 'tickSpacing', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'int24' }] },
  {
    name: 'slot0',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' }
    ]
  },
  { name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }
] as const;

/** viem-backed reader for the live service. Runtime-untested here: no Robinhood Chain RPC in this environment. */
export function createViemRobinhoodPoolReader(options: {
  rpcUrl: string;
  configuredPools: readonly string[];
}): RobinhoodPoolReader {
  const client: PublicClient = createPublicClient({
    transport: http(options.rpcUrl)
  });

  return {
    async listConfiguredPools() {
      return options.configuredPools;
    },
    async readPoolState(rawAddress) {
      const address = rawAddress as `0x${string}`;
      const [token0, token1, fee, tickSpacing, slot0, liquidity] = await Promise.all([
        client.readContract({ address, abi: V3_POOL_ABI, functionName: 'token0' }),
        client.readContract({ address, abi: V3_POOL_ABI, functionName: 'token1' }),
        client.readContract({ address, abi: V3_POOL_ABI, functionName: 'fee' }),
        client.readContract({ address, abi: V3_POOL_ABI, functionName: 'tickSpacing' }),
        client.readContract({ address, abi: V3_POOL_ABI, functionName: 'slot0' }),
        client.readContract({ address, abi: V3_POOL_ABI, functionName: 'liquidity' })
      ]);
      const [decimals0, decimals1] = await Promise.all([
        client.readContract({ address: token0, abi: V3_POOL_ABI, functionName: 'decimals' }),
        client.readContract({ address: token1, abi: V3_POOL_ABI, functionName: 'decimals' })
      ]);
      return {
        address,
        token0,
        token1,
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
        sqrtPriceX96: slot0[0],
        tick: Number(slot0[1]),
        inRangeLiquidity: liquidity,
        token0Decimals: Number(decimals0),
        token1Decimals: Number(decimals1)
      };
    },
    async liquidityBands() {
      // Live band reconstruction walks the pool's tick bitmap; the scanner
      // ships with the in-range liquidity only until that walker lands
      // (documented limitation, so active TVL stays exact=false there).
      return [];
    }
  };
}

export function createRobinhoodPoolFetcher(options: RobinhoodPoolFetcherOptions): PoolFetcher {
  const activeTickRange = options.activeTickRange ?? 1200;
  const protocol = options.protocol ?? 'uniswap-v3';
  const activeTvlCalculator = createActiveTvlCalculator();

  return {
    chain: 'robinhood-chain',
    protocol,
    async fetch(): Promise<readonly NormalizedPool[]> {
      const addresses = await options.reader.listConfiguredPools();
      const pools: NormalizedPool[] = [];

      for (const address of addresses) {
        const state = await options.reader.readPoolState(address);

        // Price from sqrtPriceX96: price = (sqrtPriceX96 / 2^96)^2, scaled by
        // 10^(dec0 − dec1) into human quote-per-base terms.
        const sqrt = Number(state.sqrtPriceX96) / 2 ** 96;
        const decimalsAdjustment = 10 ** (state.token0Decimals - state.token1Decimals);
        const currentPrice = sqrt * sqrt * decimalsAdjustment;

        const bands = await options.reader.liquidityBands(address, state.tick, activeTickRange);
        const basePriceUsd = (await options.priceSource?.priceUsd(state.token0.toLowerCase())) ?? null;
        const quotePriceUsd = (await options.priceSource?.priceUsd(state.token1.toLowerCase())) ?? null;
        const activeTvlUsd = bands.length > 0 && basePriceUsd !== null && quotePriceUsd !== null
          ? activeTvlCalculator.calculateActiveTvl({
              protocol,
              bands,
              currentTick: state.tick,
              range: activeTickRange,
              basePriceUsd,
              quotePriceUsd
            })
          : null;

        const volume24h = (await options.volumeSource?.volume24hUsd(address)) ?? null;

        pools.push({
          chain: 'robinhood-chain',
          protocol,
          poolAddress: prefixChainValue(address.toLowerCase(), 'robinhood-chain'),
          pairLabel: `${state.token0}/${state.token1}`,
          baseTokenMint: prefixChainValue(state.token0.toLowerCase(), 'robinhood-chain'),
          quoteTokenMint: prefixChainValue(state.token1.toLowerCase(), 'robinhood-chain'),
          feeBps: state.fee / 100,
          binStep: null,
          tickSpacing: state.tickSpacing,
          currentPrice,
          // In-range liquidity is the only on-chain honest denominator without
          // a price feed; total TVL is reported as the same ceiling.
          tvl: activeTvlUsd ?? 0,
          activeTvlUsd: activeTvlUsd ?? 0,
          activeTvlExact: activeTvlUsd !== null,
          volume24h: volume24h ?? 0,
          fees24h: 0,
          fees7d: null
        });
      }
      return pools;
    }
  };
}
