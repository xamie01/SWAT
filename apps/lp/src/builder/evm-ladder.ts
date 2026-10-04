import type { LpStrategyType } from '@swat/db';
import type { LadderPlan } from './ladder-plan.js';

/**
 * Uniswap v3/v4 ladder builder on Robinhood Chain (Tracks E3/E4).
 *
 * Same ladder semantics as the Meteora builder, in tick space: one position
 * (NFT) per rung, minted through the NonfungiblePositionManager behind the
 * port. A single-token deposit is zapped by first swapping into the rung's
 * required leg ratio (E3) — the swap leg is behind the same port so the live
 * service can route it through the existing Robinhood swap-router config while
 * tests replace it.
 *
 * v4 is the same interface: when the pool was discovered as `uniswap-v4`, the
 * executor resolves the v4 PositionManager; the plan shape here is identical.
 */

export interface EvmRungStep {
  readonly rungIndex: number;
  readonly kind: 'swap' | 'mint-position';
  /** Swap step: how much of the deposit moves, in deposit-asset terms. */
  readonly amountIn?: number;
  readonly description: string;
  /** Opaque executor payload: calldata fragments for the NFPM/router. */
  readonly payload: Record<string, unknown>;
}

export interface EvmPositionPort {
  /** Mint one rung position; the live impl encodes NFPM `mint` calldata. */
  buildMintStep(step: EvmRungStep, context: { readonly recipient: string; readonly deadlineSeconds: number }): Promise<EvmRungStep>;
  /** Swap deposit asset into the rung's leg ratio; live impl uses the swap router. */
  buildSwapStep(step: EvmRungStep, context: { readonly recipient: string; readonly slippageBps: number }): Promise<EvmRungStep>;
}

/**
 * The leg split a straddling rung needs, in value terms — the same sqrt-band
 * math the active-TVL calculator uses, inverted: for a unit of liquidity
 * spanning the rung at the current price, how much value sits in each leg.
 */
export function splitRungLegs(
  rung: { priceLower: number; priceUpper: number; allocation: number },
  currentPrice: number
): { amountBase: number; amountQuote: number } {
  if (rung.priceUpper <= currentPrice) {
    return { amountBase: rung.allocation, amountQuote: 0 };
  }
  if (rung.priceLower >= currentPrice) {
    return { amountBase: 0, amountQuote: rung.allocation };
  }
  const shareBase =
    Math.log(currentPrice / rung.priceLower) / Math.log(rung.priceUpper / rung.priceLower);
  return {
    amountBase: rung.allocation * shareBase,
    amountQuote: rung.allocation * (1 - shareBase)
  };
}

export interface EvmLadderBuilder {
  buildLadder(input: {
    readonly plan: LadderPlan;
    readonly poolAddress: string;
    readonly recipient: string;
    readonly currentPrice: number;
    readonly distribution: LpStrategyType;
    readonly slippageBps?: number;
  }): Promise<readonly EvmRungStep[]>;
}

export function createEvmLadderBuilder(port: EvmPositionPort): EvmLadderBuilder {
  return {
    async buildLadder({ plan, recipient, currentPrice, slippageBps = 100 }) {
      const steps: EvmRungStep[] = [];
      const deadlineSeconds = Math.floor(Date.now() / 1000) + 1800;

      for (const [index, rung] of plan.rungs.entries()) {
        const legs = splitRungLegs(rung, currentPrice);
        // The quote leg is the deposit asset for a single-token deposit: swap
        // the fraction of the allocation that must become base.
        const baseNeededShare = rung.allocation > 0 ? legs.amountBase / rung.allocation : 0;
        if (baseNeededShare > 0.0001) {
          steps.push(
            await port.buildSwapStep(
              {
                rungIndex: index,
                kind: 'swap',
                amountIn: rung.allocation * baseNeededShare,
                description: `rung ${index}: swap to base for ${Math.round(baseNeededShare * 100)}% of allocation`,
                payload: { priceLower: rung.priceLower, priceUpper: rung.priceUpper }
              },
              { recipient, slippageBps }
            )
          );
        }
        steps.push(
          await port.buildMintStep(
            {
              rungIndex: index,
              kind: 'mint-position',
              description: `rung ${index}: mint ticks [${rung.tickLower}, ${rung.tickUpper}]`,
              payload: {
                priceLower: rung.priceLower,
                priceUpper: rung.priceUpper,
                tickLower: rung.tickLower,
                tickUpper: rung.tickUpper,
                amountBase: legs.amountBase,
                amountQuote: legs.amountQuote
              }
            },
            { recipient, deadlineSeconds }
          )
        );
      }
      return steps;
    }
  };
}
