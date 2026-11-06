import type { LpStrategyType } from '@swat/db';
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
export declare const STRATEGY_TEMPLATE_NAMES: readonly ["tight-spot-scalp", "deep-bidask-accumulation", "wide-range-dump-capture", "passive-majors-auto-compound"];
export type StrategyTemplateName = (typeof STRATEGY_TEMPLATE_NAMES)[number];
export interface ResolvedLadderParams {
    readonly rangeLower: number;
    readonly rangeUpper: number;
    readonly rungCount: number;
    readonly distribution: LpStrategyType;
}
export interface StrategyTemplateSummary {
    readonly name: StrategyTemplateName;
    readonly description: string;
    readonly widthPct: number;
    readonly rungCount: number;
    readonly distribution: LpStrategyType;
}
export declare function listStrategyTemplates(): readonly StrategyTemplateSummary[];
export declare function resolveStrategyTemplate(name: StrategyTemplateName, currentPrice: number): ResolvedLadderParams;
//# sourceMappingURL=templates.d.ts.map