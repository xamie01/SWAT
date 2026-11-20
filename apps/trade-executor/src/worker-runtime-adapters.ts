import { withTransaction } from '@swat/db/dist/transaction.js';
import type { CanonicalWorkerPorts } from './worker-policy.js';
import { createOwnedExecutorRuntimePorts, type OwnedExecutorRuntimeAdapters } from './worker-runtime-owned-adapters.js';

export interface ReviewedExecutorRuntimeAdapters extends Omit<OwnedExecutorRuntimeAdapters, 'transaction'> {
  /** Only reviewed existing transaction helper or an offline fixture. */
  readonly transaction?: CanonicalWorkerPorts['transaction'];
}

/** Ambient boot compatibility delegates the shared mandatory-transaction factory.
 * Protected registry/function grants remain separately reviewed and unavailable
 * by default; no environment flag or queue tenant confers runtime authority. */
export function createExecutorRuntimePorts(input: ReviewedExecutorRuntimeAdapters, liveQuote: CanonicalWorkerPorts['quote']) {
  return createOwnedExecutorRuntimePorts({ ...input, transaction: input.transaction ?? withTransaction }, liveQuote);
}
