import type { LpPosition } from '@swat/db';
import type { LpChain } from '@swat/shared';
import { type RangeState } from './classifier.js';
import { type RebalanceEconomicsInput } from './economic-check.js';
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
    transitions: {
        positionId: string;
        from: LpPosition['state'];
        to: LpPosition['state'];
    }[];
    rebalancesQueued: number;
    rebalancesDeclined: {
        positionId: string;
        reason: string;
    }[];
}
export declare function runMonitorPass(ports: MonitorJobPorts, chain: LpChain): Promise<MonitorPassSummary>;
//# sourceMappingURL=monitor-job.d.ts.map