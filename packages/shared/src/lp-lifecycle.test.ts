import { describe, expect, it } from 'vitest';

import { canTransitionLpPosition, isLpPositionState, LP_POSITION_STATES } from './lp-lifecycle.js';

describe('lp position lifecycle', () => {
  it('allows the happy path end to end', () => {
    expect(canTransitionLpPosition('building', 'active')).toBe(true);
    expect(canTransitionLpPosition('active', 'near_edge')).toBe(true);
    expect(canTransitionLpPosition('near_edge', 'out_of_range')).toBe(true);
    expect(canTransitionLpPosition('out_of_range', 'rebalancing')).toBe(true);
    expect(canTransitionLpPosition('rebalancing', 'active')).toBe(true);
    expect(canTransitionLpPosition('active', 'closed')).toBe(true);
  });

  it('rebalancing re-enters every range state so the monitor re-classifies', () => {
    expect(canTransitionLpPosition('rebalancing', 'active')).toBe(true);
    expect(canTransitionLpPosition('rebalancing', 'near_edge')).toBe(true);
    expect(canTransitionLpPosition('rebalancing', 'out_of_range')).toBe(true);
    expect(canTransitionLpPosition('rebalancing', 'closed')).toBe(true);
    expect(canTransitionLpPosition('rebalancing', 'building')).toBe(false);
  });

  it('price moves are not monotonic: drift can recover on its own', () => {
    expect(canTransitionLpPosition('near_edge', 'active')).toBe(true);
    expect(canTransitionLpPosition('out_of_range', 'active')).toBe(true);
  });

  it('the manual trigger (Track I) may re-center an in-range position', () => {
    expect(canTransitionLpPosition('active', 'rebalancing')).toBe(true);
  });

  it('closed is terminal and building cannot skip to rebalancing', () => {
    expect(canTransitionLpPosition('closed', 'active')).toBe(false);
    expect(canTransitionLpPosition('building', 'rebalancing')).toBe(false);
    expect(canTransitionLpPosition('building', 'out_of_range')).toBe(false);
  });

  it('same-state transitions are allowed (idempotent relabeling)', () => {
    expect(canTransitionLpPosition('active', 'active')).toBe(true);
    expect(canTransitionLpPosition('closed', 'closed')).toBe(true);
  });

  it('every declared state has a transition row and a valid guard', () => {
    expect(LP_POSITION_STATES).toHaveLength(6);
    for (const state of LP_POSITION_STATES) {
      expect(isLpPositionState(state)).toBe(true);
    }
    expect(isLpPositionState('liquidated')).toBe(false);
  });
});
