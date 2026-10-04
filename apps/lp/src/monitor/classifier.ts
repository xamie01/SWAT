/**
 * Range-state classifier (Track F2) — pure, so the monitor's labeling logic is
 * testable against mock data before anything touches a chain.
 *
 * `edgeThreshold` is a fraction of the ladder's width: a position is
 * `near_edge` when the current price sits within that fraction of either
 * boundary, `out_of_range` once it crosses, `active` otherwise. Width-relative
 * (not price-relative) so a 1%-wide scalp and a 60%-wide passive ladder get
 * the same early-warning distance in *ladder* terms.
 */

export type RangeState = 'active' | 'near_edge' | 'out_of_range';

export const DEFAULT_EDGE_THRESHOLD = 0.1;

export function classifyRangeState(input: {
  readonly currentPrice: number;
  readonly rangeLower: number;
  readonly rangeUpper: number;
  readonly edgeThreshold?: number;
}): RangeState {
  const { currentPrice, rangeLower, rangeUpper } = input;
  const edgeThreshold = input.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD;

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error(`currentPrice must be positive, got ${currentPrice}`);
  }
  if (!Number.isFinite(rangeLower) || rangeLower <= 0 || !Number.isFinite(rangeUpper) || rangeUpper <= rangeLower) {
    throw new Error('range must satisfy 0 < rangeLower < rangeUpper');
  }
  if (!Number.isFinite(edgeThreshold) || edgeThreshold < 0 || edgeThreshold >= 1) {
    throw new Error(`edgeThreshold must be a fraction in [0, 1), got ${edgeThreshold}`);
  }

  if (currentPrice < rangeLower || currentPrice > rangeUpper) {
    return 'out_of_range';
  }
  const width = rangeUpper - rangeLower;
  const distanceToEdge = Math.min(currentPrice - rangeLower, rangeUpper - currentPrice);
  return distanceToEdge <= width * edgeThreshold ? 'near_edge' : 'active';
}
