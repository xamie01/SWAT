import type { Chain } from './types.js';
export declare const INGESTION_CHAINS: readonly Chain[];
export declare const INGESTION_HEALTH_POLICY: Record<Chain, {
    staleAfterSeconds: number;
    targetLagSeconds: number;
}>;
export type IngestionHealthStatus = 'healthy' | 'stale' | 'empty';
export type RawIngestionHealth = {
    chain: Chain;
    lastEventAt: Date | string | null;
    lastBatchAt: Date | string | null;
    lastSuccessAt: Date | string | null;
    inserted24h: number | string;
    skipped24h: number | string;
    failed24h: number | string;
};
export type IngestionHealthSnapshot = {
    chain: Chain;
    status: IngestionHealthStatus;
    lastEventAt: string | null;
    lastBatchAt: string | null;
    lastSuccessAt: string | null;
    lagSeconds: number | null;
    batchLagSeconds: number | null;
    staleAfterSeconds: number;
    targetLagSeconds: number;
    inserted24h: number;
    skipped24h: number;
    failed24h: number;
    insertRatio: number | null;
};
export declare function buildIngestionHealthSnapshots(rows: RawIngestionHealth[], now?: Date): IngestionHealthSnapshot[];
//# sourceMappingURL=ingestion-health.d.ts.map