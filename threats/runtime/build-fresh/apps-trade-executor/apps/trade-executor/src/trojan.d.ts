export declare const MAX_TROJAN_ATTEMPTS = 3;
export declare const MAX_TROJAN_TIMEOUT_MS = 60000;
export type TrojanBalanceSnapshot = {
    walletAddress: string;
    tokenMint: string;
    nativeLamports: string;
    tokenBaseUnits: string;
    observedAt: Date;
    slot?: number;
};
type TrojanOrderBase = {
    signalId: string;
    tokenMint: string;
    slippageBps: number;
    beforeBalance: TrojanBalanceSnapshot;
};
export type TrojanBuyOrder = TrojanOrderBase & {
    side: 'buy';
    amountLamports: string;
};
export type TrojanSellOrder = TrojanOrderBase & {
    side: 'sell';
    /** 1 = 0.01%, 10_000 = the full pre-submit token balance. */
    sellProportionBps: number;
    /** Canonical copied-position cap; the live balance may be larger. */
    maximumTokenAmountBaseUnits?: string;
};
export type TrojanOrder = TrojanBuyOrder | TrojanSellOrder;
export type PreparedTrojanOrder = TrojanOrderBase & {
    clientOrderId: string;
} & ({
    side: 'buy';
    amountLamports: string;
} | {
    side: 'sell';
    sellProportionBps: number;
    tokenAmountBaseUnits: string;
});
export type TrojanTransportReceipt = {
    /** Returned Solana transaction signature/identity; never synthesized by SWAT. */
    transactionIdentity: string;
    providerStatus?: string;
};
export type TrojanTransportContext = {
    attempt: number;
    maxAttempts: number;
    timeoutMs: number;
    idempotencyKey: string;
    signal: AbortSignal;
};
export type TrojanTransport = (order: PreparedTrojanOrder, context: TrojanTransportContext) => Promise<TrojanTransportReceipt>;
type SubmissionTiming = {
    firstAttemptAt: Date;
    lastAttemptAt: Date;
    attempts: number;
};
export type TrojanSubmissionResult = (SubmissionTiming & {
    status: 'pending_confirmation';
    clientOrderId: string;
    transactionIdentity: string;
    acknowledgedAt: Date;
    order: PreparedTrojanOrder;
}) | (SubmissionTiming & {
    status: 'submission_unknown';
    clientOrderId: string;
    reason: 'timeout-after-submit' | 'transport-error' | 'missing-transaction-identity';
    order: PreparedTrojanOrder;
}) | (SubmissionTiming & {
    status: 'rejected';
    clientOrderId: string;
    httpStatus: number;
    order: PreparedTrojanOrder;
});
export declare class TrojanRequestRejectedError extends Error {
    readonly httpStatus: number;
    constructor(httpStatus: number);
}
export type TrojanAdapterOptions = {
    timeoutMs: number;
    maxAttempts: number;
    retryDelayMs?: number;
    now?: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
};
export declare function prepareTrojanOrder(order: TrojanOrder): PreparedTrojanOrder;
export declare function createTrojanAdapter(transport: TrojanTransport, options: TrojanAdapterOptions): {
    submit(orderInput: TrojanOrder): Promise<TrojanSubmissionResult>;
};
export type TrojanWebhookCodec = {
    encode(order: PreparedTrojanOrder): unknown;
    decode(responseBody: unknown): TrojanTransportReceipt;
};
export type TrojanWebhookTransportOptions = {
    url: string;
    apiKey?: string;
    codec: TrojanWebhookCodec;
    fetchImpl?: typeof fetch;
};
/**
 * HTTP transport for a reviewed Trojan webhook codec. Payload fields are not
 * guessed here: live wiring must provide a codec matching the configured bot.
 */
export declare function createTrojanWebhookTransport(options: TrojanWebhookTransportOptions): TrojanTransport;
export type TrojanConfirmationEvidence = {
    transactionIdentity: string;
    status: 'confirmed' | 'failed' | 'not-found';
    observedAt: Date;
    slot?: number;
};
export type TrojanReconciliationResult = {
    status: 'pending_confirmation';
    transactionIdentity: string;
} | {
    status: 'submission_unknown';
    clientOrderId: string;
} | {
    status: 'pending_reconciliation';
    transactionIdentity: string;
} | {
    status: 'failed';
    transactionIdentity: string;
} | {
    status: 'inconsistent';
    transactionIdentity: string;
    reason: string;
} | {
    status: 'filled';
    transactionIdentity: string;
    fillKind: 'entry' | 'partial-exit' | 'full-exit';
    nativeLamportsDelta: string;
    tokenBaseUnitsDelta: string;
    confirmedAt: Date;
    slot?: number;
};
export declare function reconcileTrojanSubmission(input: {
    submission: Extract<TrojanSubmissionResult, {
        status: 'pending_confirmation' | 'submission_unknown';
    }>;
    confirmation?: TrojanConfirmationEvidence;
    afterBalance?: TrojanBalanceSnapshot;
}): TrojanReconciliationResult;
export {};
//# sourceMappingURL=trojan.d.ts.map