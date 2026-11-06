import type { Chain } from '@swat/shared';
export interface CloseAllLotJob {
    readonly claimId?: string;
    readonly userId: string;
    readonly walletAddress: string;
    readonly lotId: string;
    readonly signalId: string;
    readonly tokenMint: string;
    readonly chain: Chain;
    readonly sellTokenAmount: number;
    readonly jobId: string;
}
/**
 * Enumerate exact-quantity close-all sells without changing lifecycle state.
 *
 * The lot is the unit of work and the deterministic job id. A repeated poll
 * therefore produces the same BullMQ identity until evidence reduces the lot;
 * only confirmed reductions may make a winding-down subscription eligible for
 * `endSubscription`.
 */
export declare function listCloseAllLotJobs(): Promise<CloseAllLotJob[]>;
/**
 * End only subscriptions whose requested close-all has no open lot left.
 *
 * The predicate is evaluated in the UPDATE itself, so a concurrent confirmed
 * reduction wins the race with this sweep rather than being stranded by an
 * in-memory read. This is intentionally separate from enumeration: enqueueing
 * a sell is not evidence that the lot was reduced.
 */
export declare function endCompletedCloseAllSubscriptions(): Promise<number>;
//# sourceMappingURL=close-all.d.ts.map