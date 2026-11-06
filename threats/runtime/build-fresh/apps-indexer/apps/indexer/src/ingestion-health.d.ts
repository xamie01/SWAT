import type { RecordIngestionBatchInput } from '@swat/db';
import type { Chain } from '@swat/shared';
export type IngestionBatchResult = {
    fetched: number;
    inserted: number;
    skipped: number;
    failed: number;
    lastEventAt: Date | null;
};
export declare class IngestionBatchError extends Error {
    readonly result: IngestionBatchResult;
    constructor(message: string, result: IngestionBatchResult, options?: {
        cause?: unknown;
    });
}
type Recorder = (input: RecordIngestionBatchInput) => Promise<void>;
export declare function runTrackedIngestion(input: {
    chain: Chain;
    source: string;
    run: () => Promise<IngestionBatchResult>;
}, recorder: Recorder): Promise<IngestionBatchResult>;
export {};
//# sourceMappingURL=ingestion-health.d.ts.map