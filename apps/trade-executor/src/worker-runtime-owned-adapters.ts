import { randomUUID } from 'node:crypto';
import { createOwnedObligationScopedTransaction } from '@swat/db/dist/obligation-runtime-owned.js';
import type { CanonicalWorkerPorts } from './worker-policy.js';
import { createExactPaperQuote, type ReviewedPaperValuationProvider } from './worker-paper-quote.js';

export interface OwnedExecutorRuntimeAdapters {
  readonly paperValuation: ReviewedPaperValuationProvider | null;
  readonly now: () => Date;
  readonly maximumAgeMs: number;
  /** Mandatory caller-owned transaction; no pool or ambient fallback in this graph. */
  readonly transaction: CanonicalWorkerPorts['transaction'];
}

/** Shared production factory. Queue identity selects a protected lookup only;
 * persisted ownership scopes every short transaction before a worker callback. */
export function createOwnedExecutorRuntimePorts(input: OwnedExecutorRuntimeAdapters, liveQuote: CanonicalWorkerPorts['quote']) {
  const paper = createExactPaperQuote({ provider: input.paperValuation, now: input.now, maximumAgeMs: input.maximumAgeMs });
  return {
    canonicalTransaction: createOwnedObligationScopedTransaction({ transaction: input.transaction,
      now: input.now, maximumAgeMs: input.maximumAgeMs }),
    canonicalQuote: ((execution, slippage) => execution.executionMode === 'paper'
      ? paper(execution) : liveQuote(execution, slippage)) as CanonicalWorkerPorts['quote'],
    deliveryOwner: `executor-${randomUUID()}`,
    now: input.now,
    deliveryLeaseMs: 240_000
  };
}
