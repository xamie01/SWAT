import { type LpChain, type LpPositionState } from '@swat/shared';
import type { LpProtocol } from './lp-pools.js';
import { type UserScope } from './tenancy.js';
/**
 * User LP positions and their state machine (`059`).
 *
 * `transitionLpPosition` is the only writer of `lp_positions.state`. It runs
 * the shared predicate (`canTransitionLpPosition`) and the SQL trigger enforces
 * the same table a second time, so the two cannot drift silently: code drift is
 * caught by the trigger raising, trigger drift is caught by the code refusing
 * before the statement is even sent.
 *
 * The monitor sweep (`listPositionsForMonitor`) crosses tenants by design and
 * therefore requires a `crossTenantScope` at the call site, like every other
 * platform sweep in this package.
 */
export type LpStrategyType = 'spot' | 'curve' | 'bidask';
/** One ladder rung. Meteora rungs carry bin ids; Uniswap rungs carry tick bounds. */
export interface LpRungAllocation {
    readonly priceLower: number;
    readonly priceUpper: number;
    /** Fraction of the deposit assigned to this rung, 0..1. Rungs sum to ≤ 1. */
    readonly weight: number;
    readonly binId?: number;
    readonly tickLower?: number;
    readonly tickUpper?: number;
}
export interface LpPosition {
    readonly id: string;
    readonly userId: string;
    readonly chain: LpChain;
    readonly protocol: LpProtocol;
    /** Chain-prefixed. */
    readonly poolAddress: string;
    readonly strategyType: LpStrategyType;
    readonly rangeLower: number;
    readonly rangeUpper: number;
    readonly rungAllocations: readonly LpRungAllocation[];
    readonly depositAmount: number;
    /** Chain-prefixed mint of the single deposit token. */
    readonly depositAsset: string;
    readonly state: LpPositionState;
    /** Chain-prefixed; null while building or paper-only. */
    readonly onChainPositionAddress: string | null;
    /**
     * Track I: the owner's opt-in to automatic rebalancing. The scheduled
     * monitor only queues rebalances for opted-in positions; manual triggers
     * bypass this flag (the user IS the consent).
     */
    readonly autoRebalance: boolean;
    readonly openedAt: Date;
    readonly closedAt: Date | null;
    readonly updatedAt: Date;
}
export interface CreateLpPositionInput {
    readonly chain: LpChain;
    readonly protocol: LpProtocol;
    /** Chain-prefixed. */
    readonly poolAddress: string;
    readonly strategyType: LpStrategyType;
    readonly rangeLower: number;
    readonly rangeUpper: number;
    readonly rungAllocations: readonly LpRungAllocation[];
    readonly depositAmount: number;
    /** Chain-prefixed. */
    readonly depositAsset: string;
    /** Track I: opt into automatic rebalancing at deploy time. Default false. */
    readonly autoRebalance?: boolean;
}
export declare function createLpPosition(scope: UserScope, input: CreateLpPositionInput): Promise<LpPosition>;
export declare function getLpPosition(scope: UserScope, positionId: string): Promise<LpPosition | null>;
/**
 * Worker-side read of one position regardless of owner. Platform sweep — pass
 * `crossTenantScope(reason)`. The execution worker receives only the position
 * id in its job payload and must be able to see any user's row to refuse
 * acting on one that closed (or never left `building`) between enqueue and run.
 */
export declare function getLpPositionAnyOwner(scope: UserScope, positionId: string): Promise<LpPosition | null>;
export declare function listLpPositions(scope: UserScope, options?: {
    includeClosed?: boolean;
    limit?: number;
}): Promise<LpPosition[]>;
/**
 * Open positions due for a monitor pass on one chain. Platform sweep — pass
 * `crossTenantScope('lp position monitor sweep')`. Served by
 * idx_lp_positions_monitor.
 */
export declare function listPositionsForMonitor(scope: UserScope, chain: LpChain, limit?: number): Promise<LpPosition[]>;
/**
 * Track I: flips the auto-rebalance opt-in. A preference write, not a state
 * transition — it must not touch `state` or the journal.
 */
export declare function setLpPositionAutoRebalance(scope: UserScope, positionId: string, enabled: boolean): Promise<void>;
export interface LpPositionStateTransition {
    readonly toState: LpPositionState;
    /** Required for every transition; the history row is the audit trail. */
    readonly reason: string;
}
/**
 * The only writer of `lp_positions.state`.
 *
 * Locks the row FOR UPDATE first so two racing transitions (monitor sweep vs.
 * user close) serialize instead of both passing the predicate on the same
 * pre-image. Refusing a transition leaves the row untouched — a refused
 * transition that still writes is the failure mode the history table exists to
 * catch.
 */
export declare function transitionLpPosition(scope: UserScope, positionId: string, transition: LpPositionStateTransition): Promise<LpPosition>;
/** Track E wiring: records the on-chain position address once the ladder is built. */
export declare function attachOnChainPositionAddress(scope: UserScope, positionId: string, onChainPositionAddress: string): Promise<void>;
/**
 * Total open LP capital for a user, summed over non-closed positions. The
 * exposure cap (Track G1) measures a pool against this base, so a position
 * closing must shrink the base immediately — hence the state filter here
 * rather than a cached total.
 */
export declare function sumOpenLpDeposits(scope: UserScope): Promise<number>;
/**
 * The user's open capital currently committed to one pool. Chain rides along
 * because pool addresses are chain-prefixed and unique per chain.
 */
export declare function sumOpenLpPoolExposure(scope: UserScope, chain: LpChain, poolAddress: string): Promise<number>;
//# sourceMappingURL=lp-positions.d.ts.map