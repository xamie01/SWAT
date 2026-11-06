import { type Chain, type RawIngestionHealth } from '@swat/shared';
export type RecordIngestionBatchInput = {
    chain: Chain;
    source: string;
    batchAt?: Date;
    lastEventAt?: Date | null;
    inserted?: number;
    skipped?: number;
    failed?: number;
    errorMessage?: string | null;
};
export type IngestionAlertTarget = 'healthy' | 'stale';
export declare function recordIngestionBatch(input: RecordIngestionBatchInput): Promise<void>;
export declare function getIngestionHealth24h(): Promise<RawIngestionHealth[]>;
export declare function reserveIngestionHealthAlert(chain: Chain, target: IngestionAlertTarget): Promise<string | null>;
export declare function completeIngestionHealthAlert(chain: Chain, reservation: string, target: IngestionAlertTarget): Promise<boolean>;
export declare function releaseIngestionHealthAlert(chain: Chain, reservation: string): Promise<void>;
//# sourceMappingURL=ingestion-health.d.ts.map