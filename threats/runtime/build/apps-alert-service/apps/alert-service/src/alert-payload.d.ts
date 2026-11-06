export type AlertSeverity = 'info' | 'warning' | 'high' | 'critical';
export type SignalAlertPayload = {
    kind: 'signal';
    signalId: string;
    pattern: string;
    tokenMint?: string;
    clusterId?: string;
    confidence?: number;
    score?: number;
    isSafe?: boolean;
    warnings?: string[];
    liquidity?: number | null;
    top10HolderPct?: number | null;
    buyerCount?: number;
    buyVolume?: number;
    exitVolume?: number;
    sellerCount?: number;
    clusterSize?: number;
    sellerPct?: number;
    soldToken?: string;
    boughtToken?: string;
    window?: string;
};
export type SystemAlertPayload = {
    kind: 'system';
    eventType: string;
    title: string;
    message: string;
    severity: AlertSeverity;
    chain?: string;
    requestedMode?: string;
    checkedAt?: string;
};
export type ExpectancyAlertPayload = {
    kind: 'expectancy';
    eventType: 'NIGHTLY_EXPECTANCY';
    title: string;
    message: string;
};
export type OperationalAlertPayload = SystemAlertPayload | ExpectancyAlertPayload;
export type AlertPayload = SignalAlertPayload | OperationalAlertPayload;
export declare class AlertPayloadValidationError extends Error {
    constructor(message: string);
}
export declare function parsePublishedAlertMessage(message: string): OperationalAlertPayload;
export declare function parseQueuedAlertPayload(value: unknown): AlertPayload;
export declare function escapeTelegramHtml(value: string): string;
export declare function formatOperationalAlert(payload: OperationalAlertPayload): string;
//# sourceMappingURL=alert-payload.d.ts.map