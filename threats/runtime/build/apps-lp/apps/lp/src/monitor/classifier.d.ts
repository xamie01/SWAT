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
export declare const DEFAULT_EDGE_THRESHOLD = 0.1;
export declare function classifyRangeState(input: {
    readonly currentPrice: number;
    readonly rangeLower: number;
    readonly rangeUpper: number;
    readonly edgeThreshold?: number;
}): RangeState;
//# sourceMappingURL=classifier.d.ts.map