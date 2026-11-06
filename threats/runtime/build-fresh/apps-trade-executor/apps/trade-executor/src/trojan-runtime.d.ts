import { createTrojanAdapter, type TrojanBalanceSnapshot, type TrojanConfirmationEvidence, type TrojanReconciliationResult, type TrojanSubmissionResult, type TrojanWebhookCodec } from './trojan.js';
import { type RedisHashClient } from './runtime-codec.js';
export type TrojanTerminalResolution = Extract<TrojanReconciliationResult, {
    status: 'filled' | 'failed' | 'inconsistent';
}> | {
    status: 'rejected';
    clientOrderId: string;
    httpStatus: number;
} | {
    status: 'ambiguous';
    clientOrderId: string;
    reason: string;
};
export type PendingTrojanSubmission = {
    submission: Extract<TrojanSubmissionResult, {
        status: 'pending_confirmation' | 'submission_unknown';
    }>;
    expiresAt: Date;
};
export interface TrojanPendingStore {
    findPending(clientOrderId: string): Promise<PendingTrojanSubmission | null>;
    findResolution(clientOrderId: string): Promise<TrojanTerminalResolution | null>;
    listPending(): Promise<PendingTrojanSubmission[]>;
    save(pending: PendingTrojanSubmission): Promise<void>;
    resolve(clientOrderId: string, resolution: TrojanTerminalResolution): Promise<void>;
}
export declare function createRedisTrojanPendingStore(redis: RedisHashClient, key?: string): TrojanPendingStore;
type TrojanAdapter = ReturnType<typeof createTrojanAdapter>;
export type TrojanRuntimeSubmission = TrojanSubmissionResult | {
    status: 'already_resolved';
    clientOrderId: string;
    resolution: TrojanTerminalResolution;
};
export type TrojanSubmitInput = {
    signalId: string;
    tokenMint: string;
    direction: 'buy' | 'sell';
    amountLamports?: string;
    sellProportionBps?: number;
    maximumTokenAmountBaseUnits?: string;
    slippageBps: number;
};
export declare function createTrojanRuntime(options: {
    adapter: TrojanAdapter;
    pendingStore: TrojanPendingStore;
    readBalance: (tokenMint: string) => Promise<TrojanBalanceSnapshot>;
    readConfirmation?: (transactionIdentity: string) => Promise<TrojanConfirmationEvidence>;
    pendingTtlMs: number;
    now?: () => Date;
}): {
    /**
     * Probe one signature directly, bypassing the pending store.
     *
     * The canonical reconciliation coordinator needs this: it handles executions
     * whose pending-store entry is already gone, so `reconcile()` below — which
     * iterates that store — structurally cannot see them.
     */
    readConfirmation: ((transactionIdentity: string) => Promise<TrojanConfirmationEvidence>) | undefined;
    submit(input: TrojanSubmitInput): Promise<TrojanRuntimeSubmission>;
    reconcile(nowAt?: Date): Promise<({
        status: "pending_confirmation";
        transactionIdentity: string;
    } | {
        status: "submission_unknown";
        clientOrderId: string;
    } | {
        status: "pending_reconciliation";
        transactionIdentity: string;
    } | {
        status: "failed";
        transactionIdentity: string;
    } | {
        status: "inconsistent";
        transactionIdentity: string;
        reason: string;
    } | {
        status: "filled";
        transactionIdentity: string;
        fillKind: "entry" | "partial-exit" | "full-exit";
        nativeLamportsDelta: string;
        tokenBaseUnitsDelta: string;
        confirmedAt: Date;
        slot?: number;
    } | {
        status: "rejected";
        clientOrderId: string;
        httpStatus: number;
    } | {
        status: "ambiguous";
        clientOrderId: string;
        reason: string;
    })[] | TrojanReconciliationResult[]>;
};
export declare function reconcileTrojanPending(input: {
    pendingStore: TrojanPendingStore;
    readConfirmation: (transactionIdentity: string) => Promise<TrojanConfirmationEvidence>;
    readBalance: (tokenMint: string) => Promise<TrojanBalanceSnapshot>;
    now?: Date;
}): Promise<TrojanReconciliationResult[] | Array<TrojanReconciliationResult | TrojanTerminalResolution>>;
export declare function createHeliusTrojanRuntimeClient(options: {
    walletAddress: string;
    apiKey: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    now?: () => Date;
}): {
    readBalance(tokenMint: string): Promise<TrojanBalanceSnapshot>;
    readConfirmation(transactionIdentity: string): Promise<TrojanConfirmationEvidence>;
};
export declare function createSwatTrojanWebhookCodec(): TrojanWebhookCodec;
export type TrojanRuntime = ReturnType<typeof createTrojanRuntime>;
export declare function configureTrojanRuntime(runtime: TrojanRuntime): void;
export declare function setTrojanRuntimeUnavailable(reason: string): void;
export declare function getTrojanLiveReadiness(): {
    ready: boolean;
    reason: string;
};
export declare function getConfiguredTrojanRuntime(): TrojanRuntime | null;
export declare function createTrojanRuntimeFromEnvironment(redis: RedisHashClient): TrojanRuntime;
export declare function triggerTrojan(params: {
    signalId: string;
    tokenMint: string;
    amountSol: number;
    slippageBps?: number;
    direction?: 'buy' | 'sell';
    sellProportionBps?: number;
    maximumTokenAmountBaseUnits?: string;
}): Promise<TrojanRuntimeSubmission>;
export {};
//# sourceMappingURL=trojan-runtime.d.ts.map