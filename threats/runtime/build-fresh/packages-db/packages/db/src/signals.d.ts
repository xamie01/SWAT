import type { Chain } from '@swat/shared';
type SignalInput = {
    patternType: string;
    clusterId?: string | null;
    tokenMint?: string | null;
    chain?: Chain | null;
    confidence: number;
    signalScore: number;
    triggerData: Record<string, unknown>;
    safetyFlags?: string[];
    safetyWarnings?: string[];
    tokenName?: string | null;
    tokenSymbol?: string | null;
};
export declare function insertSignal(input: SignalInput): Promise<import("pg").QueryResultRow>;
export declare function insertSignalWithDedupe(input: SignalInput, dedupeMinutes?: number): Promise<{
    inserted: boolean;
    id: string;
}>;
export declare function listSignals(limit?: number): Promise<import("pg").QueryResultRow[]>;
export {};
//# sourceMappingURL=signals.d.ts.map