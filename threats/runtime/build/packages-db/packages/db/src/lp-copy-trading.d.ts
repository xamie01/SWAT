import type { LpChain, LpProtocol } from '@swat/shared';
import type { UserScope } from './tenancy.js';
export type LpCopySubscriptionStatus = 'active' | 'paused' | 'closed';
export type LpCopyAction = 'mint' | 'increase' | 'decrease' | 'burn' | 'collect';
export type LpCopyExecutionStatus = 'pending' | 'executing' | 'executed' | 'failed' | 'rejected';
export interface LpCopySubscription {
    readonly id: string;
    readonly userId: string;
    readonly masterWalletAddress: string;
    readonly chain: LpChain;
    readonly venue: LpProtocol;
    readonly allocatedBudgetUsd: number;
    readonly maxCapitalPerPositionUsd: number;
    readonly status: LpCopySubscriptionStatus;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
export interface LpCopyExecution {
    readonly id: string;
    readonly subscriptionId: string;
    readonly userId: string;
    readonly masterPositionId: string;
    readonly followerPositionId: string | null;
    readonly chain: LpChain;
    readonly action: LpCopyAction;
    readonly masterDepositUsd: number;
    readonly followerDepositUsd: number;
    readonly scaleRatio: number;
    readonly status: LpCopyExecutionStatus;
    readonly errorMessage: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
export declare function createLpCopySubscription(scope: UserScope, input: {
    masterWalletAddress: string;
    chain: LpChain;
    venue: LpProtocol;
    allocatedBudgetUsd: number;
    maxCapitalPerPositionUsd: number;
}): Promise<LpCopySubscription>;
export declare function getLpCopySubscription(scope: UserScope, id: string): Promise<LpCopySubscription | null>;
export declare function listLpCopySubscriptions(scope: UserScope, status?: LpCopySubscriptionStatus): Promise<readonly LpCopySubscription[]>;
export declare function listActiveFollowersForMaster(masterWalletAddress: string, chain: LpChain, venue: LpProtocol): Promise<readonly LpCopySubscription[]>;
export declare function updateLpCopySubscriptionStatus(scope: UserScope, id: string, status: LpCopySubscriptionStatus): Promise<LpCopySubscription | null>;
export declare function createLpCopyExecution(input: {
    subscriptionId: string;
    userId: string;
    masterPositionId: string;
    followerPositionId?: string | null;
    chain: LpChain;
    action: LpCopyAction;
    masterDepositUsd?: number;
    followerDepositUsd?: number;
    scaleRatio?: number;
    status?: LpCopyExecutionStatus;
    errorMessage?: string | null;
}): Promise<LpCopyExecution>;
export declare function updateLpCopyExecutionStatus(id: string, status: LpCopyExecutionStatus, errorMessage?: string | null): Promise<boolean>;
export declare function listLpCopyExecutions(scope: UserScope, subscriptionId?: string): Promise<readonly LpCopyExecution[]>;
//# sourceMappingURL=lp-copy-trading.d.ts.map