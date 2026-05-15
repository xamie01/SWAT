type SignalInput = {
    patternType: string;
    clusterId?: string | null;
    tokenMint?: string | null;
    confidence: number;
    signalScore: number;
    triggerData: Record<string, unknown>;
    safetyFlags?: string[];
    safetyWarnings?: string[];
};
export declare function insertSignal(input: SignalInput): Promise<import("pg").QueryResultRow>;
export declare function insertSignalWithDedupe(input: SignalInput, dedupeMinutes?: number): Promise<{
    inserted: boolean;
    id: string;
}>;
export declare function listSignals(limit?: number): Promise<import("pg").QueryResultRow[]>;
export {};
//# sourceMappingURL=signals.d.ts.map