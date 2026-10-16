import { createPublicClient, http, type PublicClient } from 'viem';
import { prefixChainValue } from '@swat/shared';
import { createActiveTvlCalculator, type TickBand } from './active-tvl.js';
import type { NormalizedPool, PoolFetcher } from './types.js';

/**
 * Robinhood Chain pool-list fetcher (Track B2) — Uniswap v3 pools via direct
 * RPC reads. Pool addresses are operator-configured because factory enumeration
 * over a young chain is slow and fragile.
 */

export interface RobinhoodPoolState {
  readonly address: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly inRangeLiquidity: bigint;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
}

export interface RobinhoodVolumeSource {
  volume24hUsd(address: string): Promise<number | null>;
}

export interface RobinhoodTokenPriceSource {
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
  /** Stable quote token that may be treated as $1 when no oracle is supplied. */
  readonly stableQuoteToken?: string;
  readonly activeTickRange?: number;
  readonly protocol?: 'uniswap-v3' | 'uniswap-v4';
}

const V3_POOL_ABI = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  { name: 'tickSpacing', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'int24' }] },
  {
    name: 'slot0', type: 'function', stateMutability: 'view', inputs: [], outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' }
    ]
  },
  { name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    name: 'tickBitmap', type: 'function', stateMutability: 'view', inputs: [{ name: 'wordPosition', type: 'int16' }], outputs: [{ type: 'uint256' }]
  },
  {
    name: 'ticks', type: 'function', stateMutability: 'view', inputs: [{ name: 'tick', type: 'int24' }], outputs: [
      { name: 'liquidityGross', type: 'uint128' }, { name: 'liquidityNet', type: 'int128' },
      { name: 'feeGrowthOutside0X128', type: 'uint256' }, { name: 'feeGrowthOutside1X128', type: 'uint256' },
      { name: 'tickCumulativeOutside', type: 'int56' }, { name: 'secondsPerLiquidityOutsideX128', type: 'uint160' },
      { name: 'secondsOutside', type: 'uint32' }, { name: 'initialized', type: 'bool' }
    ]
  }
] as const;

function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

export function compressedTick(tick: number, tickSpacing: number): number {
  if (!Number.isInteger(tick) || !Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error(`invalid tick compression inputs: ${tick}, ${tickSpacing}`);
  }
  return floorDiv(tick, tickSpacing);
}

export function bitmapPosition(compressed: number): { wordPosition: number; bitPosition: number } {
  if (!Number.isInteger(compressed)) throw new Error(`compressed tick must be an integer, got ${compressed}`);
  const wordPosition = floorDiv(compressed, 256);
  return { wordPosition, bitPosition: compressed - wordPosition * 256 };
}

export function initializedTicksFromBitmap(wordPosition: number, bitmap: bigint, tickSpacing: number): number[] {
  if (!Number.isInteger(wordPosition) || !Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error('invalid bitmap enumeration inputs');
  }
  const ticks: number[] = [];
  let remaining = bitmap;
  while (remaining !== 0n) {
    const lowestBit = remaining & -remaining;
    const bit = lowestBit.toString(2).length - 1;
    ticks.push((wordPosition * 256 + bit) * tickSpacing);
    remaining ^= lowestBit;
  }
  return ticks.sort((left, right) => left - right);
}

function finiteLiquidity(value: bigint): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`liquidity does not fit a finite number: ${value}`);
  return numeric;
}

function signedLiquidityNet(value: bigint): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`liquidityNet does not fit a finite number: ${value}`);
  return numeric;
}

export function reconstructTickBands(input: {
  readonly currentTick: number;
  readonly tickSpacing: number;
  readonly range: number;
  readonly currentLiquidity: number;
  readonly liquidityNetByTick: ReadonlyMap<number, bigint>;
}): readonly TickBand[] {
  if (!Number.isInteger(input.currentTick) || !Number.isInteger(input.tickSpacing) || input.tickSpacing <= 0) {
    throw new Error('invalid tick band inputs');
  }
  if (!Number.isFinite(input.range) || input.range <= 0 || !Number.isFinite(input.currentLiquidity) || input.currentLiquidity < 0) {
    throw new Error('invalid tick band range or liquidity');
  }
  const lower = floorDiv(input.currentTick - input.range, input.tickSpacing) * input.tickSpacing;
  const upper = Math.ceil((input.currentTick + input.range) / input.tickSpacing) * input.tickSpacing;
  const currentLower = floorDiv(input.currentTick, input.tickSpacing) * input.tickSpacing;
  const regularBoundaries = Array.from(
    { length: Math.max(0, Math.round((upper - lower) / input.tickSpacing) + 1) },
    (_, index) => lower + index * input.tickSpacing
  );
  const boundaries = [...new Set([
    ...regularBoundaries,
    currentLower,
    ...Array.from(input.liquidityNetByTick.keys())
      .filter((tick) => tick > lower && tick < upper && tick % input.tickSpacing === 0)
  ])].sort((a, b) => a - b);

  const liquidityByInterval = new Map<number, number>();
  liquidityByInterval.set(currentLower, input.currentLiquidity);
  for (let index = boundaries.indexOf(currentLower) + 1; index < boundaries.length; index += 1) {
    const boundary = boundaries[index]!;
    const prior = liquidityByInterval.get(boundaries[index - 1]!)!;
    liquidityByInterval.set(boundary, prior + signedLiquidityNet(input.liquidityNetByTick.get(boundary) ?? 0n));
  }
  for (let index = boundaries.indexOf(currentLower) - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index]!;
    const next = boundaries[index + 1]!;
    liquidityByInterval.set(boundary, liquidityByInterval.get(next)! - signedLiquidityNet(input.liquidityNetByTick.get(next) ?? 0n));
  }

  return boundaries.slice(0, -1).map((tickLower, index) => ({
    tickLower,
    tickUpper: boundaries[index + 1]!,
    liquidity: liquidityByInterval.get(tickLower)!
  })).filter((band) => band.liquidity > 0 && band.tickLower < upper && band.tickUpper > lower);
}

/** viem-backed read-only Robinhood Chain v3 pool reader. */
export function createViemRobinhoodPoolReader(options: {
  readonly rpcUrl: string;
  readonly configuredPools: readonly string[];
}): RobinhoodPoolReader {
  const client: PublicClient = createPublicClient({ transport: http(options.rpcUrl) });

  return {
    async listConfiguredPools() { return options.configuredPools; },
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
        address, token0, token1, fee: Number(fee), tickSpacing: Number(tickSpacing),
        sqrtPriceX96: slot0[0], tick: Number(slot0[1]), inRangeLiquidity: liquidity,
        token0Decimals: Number(decimals0), token1Decimals: Number(decimals1)
      };
    },
    async liquidityBands(rawAddress, currentTick, range) {
      const state = await this.readPoolState(rawAddress);
      const lowerWord = bitmapPosition(compressedTick(currentTick - range, state.tickSpacing)).wordPosition;
      const upperWord = bitmapPosition(compressedTick(currentTick + range, state.tickSpacing)).wordPosition;
      const words = await Promise.all(Array.from({ length: upperWord - lowerWord + 1 }, (_, index) => {
        const wordPosition = lowerWord + index;
        return client.readContract({ address: rawAddress as `0x${string}`, abi: V3_POOL_ABI, functionName: 'tickBitmap', args: [wordPosition] }).then((bitmap) => ({ wordPosition, bitmap }));
      }));
      const initializedTicks = words.flatMap(({ wordPosition, bitmap }) => initializedTicksFromBitmap(wordPosition, bitmap, state.tickSpacing))
        .filter((tick) => tick >= currentTick - range && tick <= currentTick + range);
      const records: readonly (readonly [number, bigint])[] = await initializedTicks.reduce<Promise<readonly (readonly [number, bigint])[]>>(async (pending, tick) => {
        const prior = await pending;
        const record = await client.readContract({ address: rawAddress as `0x${string}`, abi: V3_POOL_ABI, functionName: 'ticks', args: [tick] });
        return [...prior, [tick, record[1]] as const];
      }, Promise.resolve([]));
      return reconstructTickBands({
        currentTick,
        tickSpacing: state.tickSpacing,
        range,
        currentLiquidity: finiteLiquidity(state.inRangeLiquidity),
        liquidityNetByTick: new Map(records)
      });
    }
  };
}

export function createRobinhoodPoolFetcher(options: RobinhoodPoolFetcherOptions): PoolFetcher {
  const activeTickRange = options.activeTickRange ?? 1200;
  const protocol = options.protocol ?? 'uniswap-v3';
  const activeTvlCalculator = createActiveTvlCalculator();
  return {
    chain: 'robinhood-chain', protocol,
    async fetch(): Promise<readonly NormalizedPool[]> {
      const addresses = await options.reader.listConfiguredPools();
      const pools: NormalizedPool[] = [];
      for (const address of addresses) {
        const state = await options.reader.readPoolState(address);
        const sqrt = Number(state.sqrtPriceX96) / 2 ** 96;
        const currentPrice = sqrt * sqrt * 10 ** (state.token0Decimals - state.token1Decimals);
        const bands = await options.reader.liquidityBands(address, state.tick, activeTickRange);
        const token0 = state.token0.toLowerCase();
        const token1 = state.token1.toLowerCase();
        const externalBasePriceUsd = await options.priceSource?.priceUsd(token0);
        const externalQuotePriceUsd = await options.priceSource?.priceUsd(token1);
        const stableQuoteToken = options.stableQuoteToken?.toLowerCase();
        const quotePriceUsd = externalQuotePriceUsd
          ?? (stableQuoteToken && token1 === stableQuoteToken ? 1 : null);
        const basePriceUsd = externalBasePriceUsd
          ?? (quotePriceUsd !== null && quotePriceUsd !== undefined ? currentPrice * quotePriceUsd : null);
        const activeTvlUsd = bands.length > 0 && basePriceUsd !== null && quotePriceUsd !== null
          ? activeTvlCalculator.calculateActiveTvl({
              protocol,
              bands,
              currentTick: state.tick,
              range: activeTickRange,
              basePriceUsd,
              quotePriceUsd,
              baseTokenDecimals: state.token0Decimals,
              quoteTokenDecimals: state.token1Decimals
            })
          : null;
        const volume24h = (await options.volumeSource?.volume24hUsd(address)) ?? null;
        pools.push({
          chain: 'robinhood-chain', protocol,
          poolAddress: prefixChainValue(address.toLowerCase(), 'robinhood-chain'),
          pairLabel: `${state.token0}/${state.token1}`,
          baseTokenMint: prefixChainValue(state.token0.toLowerCase(), 'robinhood-chain'),
          quoteTokenMint: prefixChainValue(state.token1.toLowerCase(), 'robinhood-chain'),
          feeBps: state.fee / 100, binStep: null, tickSpacing: state.tickSpacing,
          currentPrice, tvl: activeTvlUsd ?? 0, activeTvlUsd: activeTvlUsd ?? 0,
          activeTvlExact: activeTvlUsd !== null, volume24h: volume24h ?? 0, fees24h: 0, fees7d: null
        });
      }
      return pools;
    }
  };
}
