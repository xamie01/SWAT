/**
 * LP position lifecycle (LP Dashboard Track A).
 *
 * Mirrors the copy-execution machine in this package: one frozen state list, one
 * transition table, and one `canTransition*` predicate. The DB side enforces the
 * same table a second time with a trigger (migration `059`), because an LP
 * position is a fund-touching row — the CHECK-only subscription precedent does
 * not apply.
 */
export type LpPositionState = 'building' | 'active' | 'near_edge' | 'out_of_range' | 'rebalancing' | 'closed';
export declare const LP_POSITION_STATES: readonly LpPositionState[];
export declare function isLpPositionState(value: string): value is LpPositionState;
export declare function canTransitionLpPosition(current: LpPositionState, next: LpPositionState): boolean;
//# sourceMappingURL=lp-lifecycle.d.ts.map