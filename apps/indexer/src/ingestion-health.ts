import type { RecordIngestionBatchInput } from '@swat/db';
import { parseIngestionEvidence, type Chain, type IngestionEvidence } from '@swat/shared';

export type IngestionBatchResult = {
  fetched: number;
  inserted: number;
  skipped: number;
  failed: number;
  lastEventAt: Date | null;
  evidence?: IngestionEvidence;
};

export function observedIngestionEvidence(
  observed: number,
  quarantined: number,
  accepted: number,
  completeness: IngestionEvidence['completeness'],
  scope: IngestionEvidence['scope']
): IngestionEvidence {
  const evidence = parseIngestionEvidence({
    observed, quarantined, accepted, completeness, scope, confirmation: 'withheld'
  });
  if (!evidence) throw new Error('Invalid ingestion evidence counters or scope');
  return evidence;
}

export class IngestionBatchError extends Error {
  constructor(
    message: string,
    readonly result: IngestionBatchResult,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'IngestionBatchError';
    this.result = result.evidence
      ? { ...result, evidence: { ...result.evidence, completeness: 'partial' } }
      : result;
  }
}

type Recorder = (input: RecordIngestionBatchInput) => Promise<void>;

export async function runTrackedIngestion(
  input: {
    chain: Chain;
    source: string;
    run: () => Promise<IngestionBatchResult>;
  },
  recorder: Recorder
): Promise<IngestionBatchResult> {
  const batchAt = new Date();
  let result: IngestionBatchResult;

  try {
    result = await input.run();
  } catch (error) {
    const failedResult: IngestionBatchResult = error instanceof IngestionBatchError
      ? error.result
      : {
          fetched: 0,
          inserted: 0,
          skipped: 0,
          failed: 1,
          lastEventAt: null
        };

    try {
      await recorder({
        chain: input.chain,
        source: input.source,
        batchAt,
        lastEventAt: failedResult.lastEventAt,
        inserted: failedResult.inserted,
        skipped: failedResult.skipped,
        failed: Math.max(1, failedResult.failed),
        evidence: failedResult.evidence
          ? { ...failedResult.evidence, completeness: 'partial' }
          : undefined,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    } catch (recordError) {
      throw new AggregateError(
        [error, recordError],
        `Ingestion and health recording both failed for ${input.chain}`
      );
    }
    throw error;
  }

  // A completed call can still contain known failed items. Preserve its counters
  // and scope, but do not project that evidence as unknown or complete.
  if (result.failed > 0 && result.evidence) {
    result = { ...result, evidence: { ...result.evidence, completeness: 'partial' } };
  }
  await recorder({
    chain: input.chain,
    source: input.source,
    batchAt,
    lastEventAt: result.lastEventAt,
    inserted: result.inserted,
    skipped: result.skipped,
    failed: result.failed,
    evidence: result.evidence
  });
  return result;
}
