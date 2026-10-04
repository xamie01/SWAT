import type { LpPosition } from '@swat/db';
import type { LpChain } from '@swat/shared';
import { classifyRangeState, type RangeState } from './classifier.js';
import { evaluateRebalanceEconomics, type RebalanceEconomicsInput } from './economic-check.js';

/**
 * The monitor pass (Tracks F1/F2/F6) — polls current prices against every open
 * position's range on a schedule, re-labels range states, and — only for
 * `near_edge` / `out_of_range` positions — runs the economic check and queues
 * a rebalance when it comes back positive and the chain's execution mode allows.
 *
 * The state machine does the safety work: `transitionLpPosition` refuses
 * illegal transitions, so a stale price flip-flop cannot march a position from
 * `closed` back to `active` — the monitor just records the refusal.
 */

export type { RangeState };

export interface MonitorPosition {
  readonly id: string;
  readonly chain: LpChain;
  readonly poolAddress: string;
  readonly strategyType: string;
  readonly rangeLower: number;
  readonly rangeUpper: number;
  readonly state: LpPosition['state'];
  readonly onChainPositionAddress: string | null;
  /**
   * Track I / F6 change: the owner's opt-in. The monitor never auto-fires a
   * rebalance for a position whose owner did not opt in — it re-labels the
   * state (which IS the recommendation the position manager surfaces) and
   * stops. Manual triggers bypass this flag by design.
   */
  readonly autoRebalance: boolean;
}

export interface PricePollerPort {
  /** Current quote-per-base price for a chain-prefixed pool, or null when unreadable. */
  currentPrice(poolAddress: string): Promise<number | null>;
}

export interface RebalanceEconomicsPort {
  /** The live service's fee model projects these; mock data in tests. */
  estimate(input: {
    readonly position: MonitorPosition;
    readonly currentPrice: number;
    readonly state: RangeState;
  }): Promise<RebalanceEconomicsInput>;
}

export interface MonitorJobPorts {
  readonly pricePoller: PricePollerPort;
  readonly economics: RebalanceEconomicsPort;
  listPositions(chain: LpChain): Promise<readonly MonitorPosition[]>;
  transition(positionId: string, toState: LpPosition['state'], reason: string): Promise<unknown>;
  /** Queues a rebalance for execution (BullMQ LP execution queue for the chain). */
  queueRebalance(input: {
    readonly positionId: string;
    readonly chain: LpChain;
    readonly poolAddress: string;
    readonly netBenefitUsd: number;
  }): Promise<void>;
  readonly edgeThreshold?: number;
}

export interface MonitorPassSummary {
  positionsChecked: number;
  unreadablePrices: number;
  transitions: { positionId: string; from: LpPosition['state']; to: LpPosition['state'] }[];
  rebalancesQueued: number;
  rebalancesDeclined: { positionId: string; reason: string }[];
}

export async function runMonitorPass(ports: MonitorJobPorts, chain: LpChain): Promise<MonitorPassSummary> {
  const positions = await ports.listPositions(chain);
  const summary: MonitorPassSummary = {
    positionsChecked: 0,
    unreadablePrices: 0,
    transitions: [],
    rebalancesQueued: 0,
    rebalancesDeclined: []
  };

  for (const position of positions) {
    summary.positionsChecked += 1;
    const currentPrice = await ports.pricePoller.currentPrice(position.poolAddress);
    if (currentPrice === null) {
      summary.unreadablePrices += 1;
      continue;
    }

    const observed = classifyRangeState({
      currentPrice,
      rangeLower: position.rangeLower,
      rangeUpper: position.rangeUpper,
      edgeThreshold: ports.edgeThreshold
    });
    const currentState = position.state as RangeState;

    // Only the transition is skipped when the observation matches the stored
    // state — the economic gate below still runs every pass for near_edge and
    // out_of_range positions, because fee projections move even when the label
    // does not.
    if (observed !== currentState) {
      try {
        await ports.transition(
          position.id,
          observed,
          `monitor: price ${currentPrice} vs range ${position.rangeLower}..${position.rangeUpper} -> ${observed}`
        );
        summary.transitions.push({ positionId: position.id, from: position.state, to: observed });
      } catch (error) {
        // An illegal transition (e.g. racing a close) must not abort the sweep;
        // the history row already holds the refusal context.
        console.error('[lp] monitor transition refused for', position.id, error instanceof Error ? error.message : error);
        continue;
      }
    }
    if (observed !== 'near_edge' && observed !== 'out_of_range') continue;

    // F6 change: no auto-fire by default. Without the owner's opt-in the
    // re-labeled state is the deliverable — the position manager shows it as
    // `rebalanceRecommended` and the user decides (manual trigger endpoint).
    if (!position.autoRebalance) {
      summary.rebalancesDeclined.push({
        positionId: position.id,
        reason: 'auto-rebalance-not-opted-in'
      });
      continue;
    }

    // Economic gate: only a strictly positive projection earns a rebalance.
    const economicsInput = await ports.economics.estimate({ position, currentPrice, state: observed });
    const economics = evaluateRebalanceEconomics(economicsInput);
    if (!economics.shouldRebalance) {
      summary.rebalancesDeclined.push({
        positionId: position.id,
        reason: economics.reasons.join(',') || 'not-positive'
      });
      continue;
    }

    await ports.queueRebalance({
      positionId: position.id,
      chain,
      poolAddress: position.poolAddress,
      netBenefitUsd: economics.netBenefitUsd
    });
    summary.rebalancesQueued += 1;
  }

  return summary;
}
