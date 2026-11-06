import type { Job } from 'bullmq';
import type { RecordIngestionBatchInput } from '@swat/db';
import { type Chain } from '@swat/shared';
import { type IngestionBatchResult } from './ingestion-health.js';
type BatchRecorder = (input: RecordIngestionBatchInput) => Promise<void>;
export type WalletBackfillProcessorDependencies = {
    backfillSolana(address: string): Promise<IngestionBatchResult>;
    backfillPolygon(address: string): Promise<IngestionBatchResult>;
    backfillRobinhood(address: string): Promise<IngestionBatchResult>;
    recordBatch: BatchRecorder;
    sourceForChain?: (chain: Chain) => string;
};
export declare function getBackfillSource(chain: Chain): string;
export declare function createWalletBackfillProcessor(dependencies: WalletBackfillProcessorDependencies): (job: Pick<Job, "data">) => Promise<{
    fetched: number;
    inserted: number;
    skipped: number;
    failed: number;
    lastEventAt: Date | null;
    address: string;
    chain: Chain;
}>;
export {};
//# sourceMappingURL=backfill-worker.d.ts.map