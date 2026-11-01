import type { LpChain } from '@swat/shared';
import type { LpStrategyType } from '@swat/db';
import { buildLadderPlan, type LadderRung } from './ladder-plan.js';
import { resolveStrategyTemplate, type StrategyTemplateName } from './templates.js';
import type { MeteoraBin, TickBand } from '../scanner/active-tvl.js';

/**
 * The live ladder preview (Track I2) — a read-only calculator for the manual
 * position builder. Range + distribution + deposit in, per-rung allocation
 * out, anchored on the pool's LIVE context (bins/ticks fetched now, not the
 * scan cache). Nothing is persisted and nothing touches a chain beyond reads;
 * the confirm step is `buildPosition` (E6), which re-plans and persists.
 *
 * E5 flow change: the strategy-template resolver PRE-FILLS the builder — the
 * preview resolves a template into concrete params, the user may edit them,
 * and the confirm handler validates the edited params before E6 runs. The
 * preview output is shaped so the UI can round-trip it: send `params` back
 * (edited or not) as `custom` on POST /v1/lp/positions/deploy.
 */

/** Live pool context, fetched at preview time. */
export interface LivePoolContext {
  readonly chain: LpChain;
  /** Quote-per-base, right now. */
  readonly currentPrice: number;
  /**
   * Meteora: active bin id. Uniswap: current tick. `null` on the scan-cache
   * fallback — the cache carries no anchor observation, and a fabricated one
   * (0) would read as a real bin id / tick to any consumer.
   */
  readonly anchor: { readonly kind: 'bin'; readonly activeBinId: number } | { readonly kind: 'tick'; readonly currentTick: number } | null;
  /** Granularity the ladder will snap to. */
  readonly binStep: number | null;
  readonly tickSpacing: number | null;
  /** Bin liquidity around the anchor, when available. */
  readonly bins: readonly MeteoraBin[] | null;
  /** Tick-band liquidity around the anchor, when available. */
  readonly bands: readonly TickBand[] | null;
  readonly fetchedAt: Date;
  /** What could not be fetched live — surfaced, never swallowed. */
  readonly warnings: readonly string[];
}

export interface LivePreviewInput {
  readonly chain: LpChain;
  readonly protocol: 'meteora-dlmm' | 'uniswap-v3' | 'uniswap-v4';
  /** Chain-prefixed pool address. */
  readonly poolAddress: string;
  /** Template to pre-fill from, or explicit (possibly user-edited) params. */
  readonly template?: StrategyTemplateName;
  readonly custom?: {
    readonly rangeLower: number;
    readonly rangeUpper: number;
    readonly rungCount: number;
    readonly distribution: LpStrategyType;
  };
  readonly currentPrice: number;
  readonly depositAmount?: number;
  /** From the live context. */
  readonly binStep?: number | null;
  readonly tickSpacing?: number | null;
  readonly bins?: readonly MeteoraBin[] | null;
  readonly bands?: readonly TickBand[] | null;
  readonly warnings?: readonly string[];
}

export interface LivePreviewRung extends LadderRung {
  /** Share of the pool's live liquidity already sitting in this rung's range, 0..1. */
  readonly liveLiquidityShare: number | null;
}

export interface LivePreview {
  readonly chain: LpChain;
  readonly poolAddress: string;
  /** The resolved params — round-trip these as `custom` on confirm. */
  readonly params: {
    readonly rangeLower: number;
    readonly rangeUpper: number;
    readonly rungCount: number;
    readonly distribution: LpStrategyType;
  };
  readonly rungs: readonly LivePreviewRung[];
  readonly depositAmount: number | null;
  readonly source: 'template' | 'custom';
  readonly contextWarning: string | null;
}

function resolveParams(input: LivePreviewInput): { params: LivePreview['params']; source: 'template' | 'custom' } {
  if (input.template && input.custom) {
    throw new Error('pass either a template or custom ladder params, not both');
  }
  if (input.template) {
    return { params: resolveStrategyTemplate(input.template, input.currentPrice), source: 'template' };
  }
  if (input.custom) {
    // The user-edited validation step: same rules the confirm handler enforces,
    // applied here so the preview never shows a plan the deploy would refuse.
    const { rangeLower, rangeUpper, rungCount, distribution } = input.custom;
    if (!Number.isFinite(rangeLower) || rangeLower <= 0) {
      throw new Error('rangeLower must be a positive finite number');
    }
    if (!Number.isFinite(rangeUpper) || rangeUpper <= rangeLower) {
      throw new Error('rangeUpper must be greater than rangeLower');
    }
    if (!Number.isInteger(rungCount) || rungCount < 1 || rungCount > 64) {
      throw new Error('rungCount must be an integer in 1..64');
    }
    if (!['spot', 'curve', 'bidask'].includes(distribution)) {
      throw new Error('distribution must be spot, curve, or bidask');
    }
    return { params: input.custom, source: 'custom' };
  }
  throw new Error('a strategy template or custom ladder params is required');
}

/** Live liquidity share for one rung: existing pool liquidity in the rung's range. */
function liveLiquidityShare(
  rung: LadderRung,
  input: LivePreviewInput
): number | null {
  if (input.protocol === 'meteora-dlmm' && input.bins) {
    const inRange = input.bins.filter(
      (bin) => bin.price >= rung.priceLower && bin.price <= rung.priceUpper
    );
    const total = input.bins.reduce(
      (sum, bin) => sum + bin.baseAmount * bin.price + bin.quoteAmount, 0
    );
    if (total <= 0) return null;
    const inRung = inRange.reduce(
      (sum, bin) => sum + bin.baseAmount * bin.price + bin.quoteAmount, 0
    );
    return inRung / total;
  }
  if (input.protocol !== 'meteora-dlmm' && input.bands) {
    const total = input.bands.reduce((sum, band) => sum + band.liquidity, 0);
    if (total <= 0) return null;
    const inRung = input.bands
      .filter((band) => band.tickLower >= rung.tickLower! && band.tickUpper <= rung.tickUpper!)
      .reduce((sum, band) => sum + band.liquidity, 0);
    return inRung / total;
  }
  return null;
}

export function buildLivePreview(input: LivePreviewInput): LivePreview {
  if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
    throw new Error(`currentPrice must be positive, got ${input.currentPrice}`);
  }
  const { params, source } = resolveParams(input);

  if (input.protocol === 'meteora-dlmm' && !input.binStep) {
    throw new Error('live meteora preview needs the pool binStep from the live context');
  }
  if (input.protocol !== 'meteora-dlmm' && !input.tickSpacing) {
    throw new Error('live uniswap preview needs the pool tickSpacing from the live context');
  }

  // Deposit optional: weights are exact either way; allocations need a number.
  const planDeposit = input.depositAmount ?? 1;
  if (input.depositAmount !== undefined && (!Number.isFinite(input.depositAmount) || input.depositAmount <= 0)) {
    throw new Error(`depositAmount must be positive, got ${input.depositAmount}`);
  }

  const plan = buildLadderPlan({
    protocol: input.protocol,
    rangeLower: params.rangeLower,
    rangeUpper: params.rangeUpper,
    rungCount: params.rungCount,
    distribution: params.distribution,
    currentPrice: input.currentPrice,
    binStep: input.binStep ?? undefined,
    tickSpacing: input.tickSpacing ?? undefined,
    depositAmount: planDeposit
  });

  const warnings = [...(input.warnings ?? [])];
  const rungs: LivePreviewRung[] = plan.rungs.map((rung) => ({
    ...rung,
    allocation: input.depositAmount ? rung.allocation : 0,
    liveLiquidityShare: liveLiquidityShare(rung, input)
  }));
  if (rungs.some((rung) => rung.liveLiquidityShare === null)) {
    warnings.push('live bin/tick liquidity unavailable for part of the range — liveLiquidityShare is partial');
  }

  return {
    chain: input.chain,
    poolAddress: input.poolAddress,
    params,
    rungs,
    depositAmount: input.depositAmount ?? null,
    source,
    contextWarning: warnings.length > 0 ? warnings.join('; ') : null
  };
}
