import type { LpChain, LpProtocol } from '@swat/shared';
import type { ObservedPosition } from '../wallets/types.js';
import type { MasterLpEvent } from './sizing.js';
export interface WalletPositionState {
    readonly positionAddress: string;
    readonly poolAddress: string;
    readonly positionValueUsd: number;
    readonly uncollectedFeesUsd: number;
    readonly inRange: boolean;
    readonly firstObservedAt: Date;
}
/**
 * Compares two snapshots of a master wallet's open positions and emits
 * discrete MasterLpEvent notifications (mint, increase, decrease, burn, collect).
 */
export declare function diffMasterPositions(masterWalletAddress: string, chain: LpChain, venue: LpProtocol, previousPositions: ReadonlyMap<string, WalletPositionState>, currentPositions: readonly ObservedPosition[], now?: Date): {
    readonly events: readonly MasterLpEvent[];
    readonly nextState: Map<string, WalletPositionState>;
};
//# sourceMappingURL=master-listener.d.ts.map