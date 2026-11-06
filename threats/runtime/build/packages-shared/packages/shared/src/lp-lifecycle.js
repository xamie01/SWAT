/**
 * LP position lifecycle (LP Dashboard Track A).
 *
 * Mirrors the copy-execution machine in this package: one frozen state list, one
 * transition table, and one `canTransition*` predicate. The DB side enforces the
 * same table a second time with a trigger (migration `059`), because an LP
 * position is a fund-touching row — the CHECK-only subscription precedent does
 * not apply.
 */
export const LP_POSITION_STATES = [
    'building',
    'active',
    'near_edge',
    'out_of_range',
    'rebalancing',
    'closed'
];
export function isLpPositionState(value) {
    return LP_POSITION_STATES.includes(value);
}
/**
 * `building → active → near_edge → out_of_range → rebalancing → closed` is the
 * happy path, but price moves are not monotonic: a position that drifted to
 * `near_edge` can return to `active`, and one that fell `out_of_range` can come
 * back in range without any transaction. `rebalancing` re-enters the range
 * states so the monitor re-classifies after the new ladder lands rather than
 * asserting an outcome it has not observed.
 *
 * `active → rebalancing` exists for the manual rebalance trigger (Track I):
 * a user may re-center an in-range position on purpose. The scheduled monitor
 * never uses it — it only re-labels from price observations.
 */
const LP_POSITION_TRANSITIONS = {
    building: ['active', 'closed'],
    active: ['near_edge', 'out_of_range', 'rebalancing', 'closed'],
    near_edge: ['active', 'out_of_range', 'rebalancing', 'closed'],
    out_of_range: ['active', 'rebalancing', 'closed'],
    rebalancing: ['active', 'near_edge', 'out_of_range', 'closed'],
    closed: []
};
export function canTransitionLpPosition(current, next) {
    return current === next || LP_POSITION_TRANSITIONS[current].includes(next);
}
//# sourceMappingURL=lp-lifecycle.js.map