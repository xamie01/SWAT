import type { LpStrategyType } from '@swat/db';
import type { LpProtocol } from '../scanner/types.js';

/**
 * Strategy template resolver (Track E5) — maps a named preset to concrete
 * ladder parameters for either chain.
 *
 * Ranges are expressed as relative widths around the current price (e.g. ±2%),
 * so a preset stays valid as prices move; the resolver anchors them at call
 * time. The four presets are the build plan's:
 *
 *   - `tight-spot-scalp`              — narrow spot ladder, fast fills.
 *   - `deep-bidask-accumulation`      — wide bid-ask ladder, heavy edges.
 *   - `wide-range-dump-capture`       — curve tilt down-range, catches dumps.
 *   - `passive-majors-auto-compound`  — very wide spot ladder, few rungs.
 */

export const STRATEGY_TEMPLATE_NAMES = [
  'tight-spot-scalp',
  'deep-bidask-accumulation',
  'wide-range-dump-capture',
  'passive-majors-auto-compound'
] as const;

export type StrategyTemplateName = (typeof STRATEGY_TEMPLATE_NAMES)[number];

export interface ResolvedLadderParams {
  readonly rangeLower: number;
  readonly rangeUpper: number;
  readonly rungCount: number;
  readonly distribution: LpStrategyType;
}

interface StrategyTemplate {
  /** Half-width of the range, as a fraction of the current price. */
  readonly widthPct: number;
  /** Asymmetric tilt: negative shifts the range down (dump capture). */
  readonly skewPct: number;
  readonly rungCount: number;
  readonly distribution: LpStrategyType;
  readonly description: string;
}

const TEMPLATES: Readonly<Record<StrategyTemplateName, StrategyTemplate>> = {
  'tight-spot-scalp': {
    widthPct: 0.02,
    skewPct: 0,
    rungCount: 5,
    distribution: 'spot',
    description: 'Tight spot ladder around the current price for high fill frequency.'
  },
  'deep-bidask-accumulation': {
    widthPct: 0.15,
    skewPct: 0,
    rungCount: 6,
    distribution: 'bidask',
    description: 'Wide bid-ask ladder with weight at the edges for accumulation ranges.'
  },
  'wide-range-dump-capture': {
    widthPct: 0.25,
    skewPct: -0.05,
    rungCount: 4,
    distribution: 'curve',
    description: 'Wide curve ladder tilted below price to buy down-moves.'
  },
  'passive-majors-auto-compound': {
    widthPct: 0.6,
    skewPct: 0,
    rungCount: 3,
    distribution: 'spot',
    description: 'Very wide spot ladder for passive majors with infrequent rebalances.'
  }
};

export interface StrategyTemplateSummary {
  readonly name: StrategyTemplateName;
  readonly description: string;
  readonly widthPct: number;
  readonly rungCount: number;
  readonly distribution: LpStrategyType;
}

export function listStrategyTemplates(): readonly StrategyTemplateSummary[] {
  return STRATEGY_TEMPLATE_NAMES.map((name) => ({
    name,
    description: TEMPLATES[name].description,
    widthPct: TEMPLATES[name].widthPct,
    rungCount: TEMPLATES[name].rungCount,
    distribution: TEMPLATES[name].distribution
  }));
}

export function resolveStrategyTemplate(
  name: StrategyTemplateName,
  currentPrice: number
): ResolvedLadderParams {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error(`currentPrice must be a positive finite number, got ${currentPrice}`);
  }
  const template = TEMPLATES[name];
  if (!template) {
    throw new Error(`unknown strategy template: ${name}`);
  }
  const anchor = currentPrice * (1 + template.skewPct);
  const halfWidth = anchor * (template.widthPct / 2);
  return {
    rangeLower: anchor - halfWidth,
    rangeUpper: anchor + halfWidth,
    rungCount: template.rungCount,
    distribution: template.distribution
  };
}
