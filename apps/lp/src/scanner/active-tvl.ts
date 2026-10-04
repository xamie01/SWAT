/**
 * Active TVL (Track B3) — liquidity actually tradeable at the current price,
 * computed per chain: bins near the active bin on Meteora DLMM, ticks near the
 * current tick on Uniswap v3/v4. Two implementations behind one interface,
 * because every consumer (scanner, ranking, rebalance economics) wants the same
 * number regardless of chain.
 *
 * All amounts are human-scale and priced: callers inject USD prices for base
 * and quote. A missing price is a real answer — the calculator returns null
 * ("cannot be priced") rather than valuing the unpriced leg at 0, which would
 * read as an empty pool.
 */

/** One DLMM bin, human-scale. `price` is quote-per-base at that bin. */
export interface MeteoraBin {
  readonly binId: number;
  readonly price: number;
  readonly baseAmount: number;
  readonly quoteAmount: number;
}

export interface MeteoraActiveTvlContext {
  readonly protocol: 'meteora-dlmm';
  readonly bins: readonly MeteoraBin[];
  readonly activeBinId: number;
  /** Half-width of the window, in bins. Bins with |binId − activeBinId| ≤ range count. */
  readonly range: number;
  readonly basePriceUsd: number | null;
  readonly quotePriceUsd: number | null;
}

/** One tick band from a `liquidityNet` walk, human-scale. */
export interface TickBand {
  readonly tickLower: number;
  readonly tickUpper: number;
  /** Net liquidity active for the whole band. */
  readonly liquidity: number;
}

export interface UniswapActiveTvlContext {
  readonly protocol: 'uniswap-v3' | 'uniswap-v4';
  readonly bands: readonly TickBand[];
  readonly currentTick: number;
  /** Half-width of the window, in ticks. */
  readonly range: number;
  readonly basePriceUsd: number | null;
  readonly quotePriceUsd: number | null;
}

export type ActiveTvlContext = MeteoraActiveTvlContext | UniswapActiveTvlContext;

export interface ActiveTvlCalculator {
  /** USD value of liquidity near the current price, or null when unpriced. */
  calculateActiveTvl(context: ActiveTvlContext): number | null;
}

/** One price, quoted in USD. Null propagates: unpriced legs void the whole valuation. */
function priceOrThrow(name: string, value: number | null): number {
  if (value === null || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite USD price or null, got ${value}`);
  }
  return value;
}

function meteoraActiveTvl(context: MeteoraActiveTvlContext): number | null {
  if (context.basePriceUsd === null || context.quotePriceUsd === null) return null;
  const basePriceUsd = priceOrThrow('basePriceUsd', context.basePriceUsd);
  const quotePriceUsd = priceOrThrow('quotePriceUsd', context.quotePriceUsd);

  let total = 0;
  for (const bin of context.bins) {
    if (Math.abs(bin.binId - context.activeBinId) > context.range) continue;
    if (!Number.isFinite(bin.price) || bin.price < 0) {
      throw new Error(`bin price must be a non-negative finite number, got ${bin.price}`);
    }
    total += bin.baseAmount * bin.price * basePriceUsd + bin.quoteAmount * quotePriceUsd;
  }
  return total;
}

/** Uniswap v3 math in human units: sqrt price at a tick, quote-per-base. */
function sqrtPriceAtTick(tick: number): number {
  return Math.sqrt(1.0001 ** tick);
}

function bandAmounts(
  band: TickBand,
  currentTick: number
): { baseAmount: number; quoteAmount: number } {
  const sqrtLower = sqrtPriceAtTick(band.tickLower);
  const sqrtUpper = sqrtPriceAtTick(band.tickUpper);

  if (currentTick >= band.tickUpper) {
    // Entirely below the current price: the position is fully in base.
    return { baseAmount: band.liquidity * (1 / sqrtLower - 1 / sqrtUpper), quoteAmount: 0 };
  }
  if (currentTick < band.tickLower) {
    // Entirely above the current price: fully in quote.
    return { baseAmount: 0, quoteAmount: band.liquidity * (sqrtUpper - sqrtLower) };
  }
  // Current band: split at the current price.
  const sqrtCurrent = sqrtPriceAtTick(currentTick);
  return {
    baseAmount: band.liquidity * (1 / sqrtCurrent - 1 / sqrtUpper),
    quoteAmount: band.liquidity * (sqrtUpper - sqrtCurrent)
  };
}

function uniswapActiveTvl(context: UniswapActiveTvlContext): number | null {
  if (context.basePriceUsd === null || context.quotePriceUsd === null) return null;
  const basePriceUsd = priceOrThrow('basePriceUsd', context.basePriceUsd);
  const quotePriceUsd = priceOrThrow('quotePriceUsd', context.quotePriceUsd);

  let total = 0;
  for (const band of context.bands) {
    if (band.tickLower >= band.tickUpper) {
      throw new Error(`tick band must satisfy tickLower < tickUpper, got ${band.tickLower}..${band.tickUpper}`);
    }
    if (band.tickUpper - band.tickLower > context.range * 2) continue;
    const { baseAmount, quoteAmount } = bandAmounts(band, context.currentTick);
    total += baseAmount * basePriceUsd + quoteAmount * quotePriceUsd;
  }
  return total;
}

export function createActiveTvlCalculator(): ActiveTvlCalculator {
  return {
    calculateActiveTvl(context: ActiveTvlContext): number | null {
      return context.protocol === 'meteora-dlmm'
        ? meteoraActiveTvl(context)
        : uniswapActiveTvl(context);
    }
  };
}
