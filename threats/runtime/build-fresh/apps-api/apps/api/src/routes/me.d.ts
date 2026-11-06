import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
/**
 * Per-user routes (Stage 2).
 *
 * Every handler derives its scope from `requireUser`, which reads the session —
 * never a request payload (D12). The tenant-less legacy service key cannot
 * satisfy `requireUser`, so none of these routes are reachable with it.
 */
export interface StoredWithdrawalOtp {
    code: string;
    expiresAt: Date;
    destinationAddress: string;
    chainKind: string;
    amountUsd?: number;
    attempts: number;
}
export interface MeRouteOptions {
    readonly backfillQueue: Queue;
    readonly tokenDiscoveryQueue: Queue;
    readonly now?: () => Date;
    readonly coolingOffMs?: number;
    readonly otpStore?: Map<string, StoredWithdrawalOtp>;
    readonly sendWithdrawalOtpEmail?: (email: string, code: string) => Promise<boolean>;
}
export declare const DEFAULT_WITHDRAWAL_COOLING_OFF_MS: number;
export declare function isSameAddress(a: string, b: string, chainKind: string): boolean;
export declare function constantTimeCodeMatch(a: string, b: string): boolean;
export declare function isWalletCoolingOff(verifiedAt: Date, now?: Date, coolingOffMs?: number): {
    isCoolingOff: boolean;
    hoursRemaining: number;
};
export declare function registerMeRoutes(app: FastifyInstance, options: MeRouteOptions): Promise<void>;
//# sourceMappingURL=me.d.ts.map