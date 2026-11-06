import type { FastifyInstance } from 'fastify';
import { type BillingChain, type BillingPlanId, type UserTier } from '@swat/shared';
import { type CryptoPaymentRecord, type PaymentIntentRecord, type UserBillingStatus } from '@swat/db';
import { type UserScope } from '@swat/db';
export interface BillingDependencies {
    readonly createPaymentIntent: (scope: UserScope, planId: BillingPlanId) => Promise<PaymentIntentRecord>;
    readonly recordCryptoPaymentAndGrantTier: (input: {
        scope: UserScope;
        chain: BillingChain;
        txHash: string;
        amountUsdc: number;
        planId: BillingPlanId;
        payerAddress?: string | null;
        treasuryAddress: string;
        memo?: string | null;
    }) => Promise<{
        payment: CryptoPaymentRecord;
        updatedTier: UserTier;
        updatedExpiresAt: Date | null;
    }>;
    readonly getUserBillingStatus: (scope: UserScope) => Promise<UserBillingStatus>;
    readonly listUserCryptoPayments: (scope: UserScope) => Promise<CryptoPaymentRecord[]>;
    readonly runTierDowngradeSweep: () => Promise<{
        downgradedCount: number;
        downgradedUserIds: string[];
    }>;
    readonly verifyOnChainPayment: (input: {
        chain: BillingChain;
        txHash: string;
        expectedUsdc: number;
        treasuryAddress: string;
        memo?: string | null;
    }) => Promise<{
        verified: boolean;
        payerAddress: string | null;
        amountUsdc: number;
    }>;
    readonly findPaymentIntentByMemo?: (memo: string) => Promise<{
        userId: string;
        status: string;
    } | null>;
}
export declare const DEFAULT_TREASURY_ADDRESSES: {
    readonly solana: string;
    readonly polygon: string;
};
/**
 * On-chain EVM / Polygon USDC verification using viem.
 */
export declare function verifyPolygonUsdcTransferOnChain(input: {
    txHash: string;
    expectedUsdc: number;
    treasuryAddress: string;
}): Promise<{
    verified: boolean;
    payerAddress: string | null;
    amountUsdc: number;
}>;
/**
 * On-chain Solana SPL USDC verification using standard JSON-RPC.
 */
export declare function verifySolanaUsdcTransferOnChain(input: {
    txHash: string;
    expectedUsdc: number;
    treasuryAddress: string;
    memo?: string | null;
}): Promise<{
    verified: boolean;
    payerAddress: string | null;
    amountUsdc: number;
}>;
export declare function registerBillingRoutes(app: FastifyInstance, deps?: BillingDependencies): Promise<void>;
//# sourceMappingURL=billing.d.ts.map