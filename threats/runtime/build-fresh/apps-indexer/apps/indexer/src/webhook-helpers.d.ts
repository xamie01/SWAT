import type { HeliusParsedTransaction } from './parse.js';
export type EnhancedTokenBalanceChange = {
    userAccount?: string;
    mint?: string;
    rawTokenAmount?: {
        tokenAmount?: string;
    };
};
export type EnhancedAccountData = {
    account?: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: EnhancedTokenBalanceChange[];
};
export type EnhancedNativeTransfer = {
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
};
export type EnhancedWebhookEvent = {
    type?: string;
    feePayer?: string;
    signature?: string;
    slot?: number;
    timestamp?: number;
    fee?: number;
    accountData?: EnhancedAccountData[];
    nativeTransfers?: EnhancedNativeTransfer[];
};
export declare function verifyStaticAuthorization(authHeader: string | undefined, configuredHeader: string | undefined): boolean;
export declare function isRawHeliusTransaction(value: unknown): value is HeliusParsedTransaction;
export declare function getEnhancedWalletCandidates(event: EnhancedWebhookEvent): string[];
export declare function enhancedEventToTransaction(event: EnhancedWebhookEvent, walletAddress: string): HeliusParsedTransaction;
//# sourceMappingURL=webhook-helpers.d.ts.map