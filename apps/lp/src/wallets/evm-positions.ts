import { prefixChainValue } from '@swat/shared';
import type { LpPositionReader, ObservedPosition } from './types.js';

/**
 * Robinhood Chain position reader (Track D2) — Uniswap v3 position NFTs, with
 * v4 positions behind the same port once the v4 contracts are confirmed.
 *
 * `positions(tokenId)` gives the raw position; valuation needs the pool state
 * and both token prices, which the port provides already computed per leg, so
 * this reader only normalizes and prefixes.
 */

export interface V3PositionView {
  readonly tokenId: string;
  /** Raw token contract addresses. */
  readonly token0: string;
  readonly token1: string;
  /** Raw pool address backing the position. */
  readonly poolAddress: string;
  /** Human-scale amounts under the current price, priced legs. */
  readonly amount0: number;
  readonly amount1: number;
  /** Human-scale uncollected fees per leg. */
  readonly uncollectedFees0: number;
  readonly uncollectedFees1: number;
  readonly inRange: boolean;
}

export interface V3PositionsPort {
  /** All position NFTs the wallet owns, with priced amounts. */
  fetchWalletPositions(walletAddress: string): Promise<readonly V3PositionView[]>;
  /** The NonfungiblePositionManager contract holding these token ids. */
  readonly positionManagerAddress: string;
}

export interface LegUsdPriceSource {
  /** USD price by raw token address (lowercased); null when unknown. */
  priceUsd(token: string): Promise<number | null>;
}

export function createRobinhoodLpPositionReader(options: {
  port: V3PositionsPort;
  prices: LegUsdPriceSource;
  protocol?: 'uniswap-v3' | 'uniswap-v4';
}): LpPositionReader {
  void options.protocol; // valuation is protocol-agnostic through the port
  return {
    chain: 'robinhood-chain',
    async readPositions(walletAddress: string): Promise<readonly ObservedPosition[]> {
      const views = await options.port.fetchWalletPositions(walletAddress);
      const observed: ObservedPosition[] = [];

      for (const view of views) {
        const [price0, price1] = await Promise.all([
          options.prices.priceUsd(view.token0.toLowerCase()),
          options.prices.priceUsd(view.token1.toLowerCase())
        ]);
        if (price0 === null || price1 === null) continue;

        observed.push({
          // An EVM position's identity is its tokenId inside the position
          // manager, not an address. The chain prefix stays first and the
          // (contract, tokenId) pair rides behind it:
          // `robinhood-chain:<positionManager>:<tokenId>`.
          positionAddress: `robinhood-chain:${options.port.positionManagerAddress.toLowerCase()}:${view.tokenId}`,
          poolAddress: prefixChainValue(view.poolAddress.toLowerCase(), 'robinhood-chain'),
          positionValueUsd: view.amount0 * price0 + view.amount1 * price1,
          uncollectedFeesUsd: view.uncollectedFees0 * price0 + view.uncollectedFees1 * price1,
          inRange: view.inRange
        });
      }
      return observed;
    }
  };
}
