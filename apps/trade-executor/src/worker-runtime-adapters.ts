import { randomUUID } from 'node:crypto';
import { createObligationScopedTransaction, withTransaction } from '@swat/db';
import type { CanonicalWorkerPorts } from './worker-policy.js';
import { createExactPaperQuote, type ReviewedPaperValuationProvider } from './worker-paper-quote.js';

export interface ReviewedExecutorRuntimeAdapters {
  readonly paperValuation: ReviewedPaperValuationProvider | null;
  readonly now: () => Date;
  readonly maximumAgeMs: number;
  /** Only reviewed existing transaction helper or an offline fixture. */
  readonly transaction?: CanonicalWorkerPorts['transaction'];
}
/** No environment key/flag, signing or wildcard scope. Actual boot calls this
 * factory. Default SQL capability lookup really runs but cannot grant authority
 * without separately provisioned protected registry and role/function grants. */
export function createExecutorRuntimePorts(input: ReviewedExecutorRuntimeAdapters, liveQuote: CanonicalWorkerPorts['quote']) {
  const paper = createExactPaperQuote({ provider: input.paperValuation, now: input.now, maximumAgeMs: input.maximumAgeMs });
  return {
    canonicalTransaction: createObligationScopedTransaction({ transaction: input.transaction ?? withTransaction,
      now: input.now, maximumAgeMs: input.maximumAgeMs }),
    canonicalQuote: ((execution, slippage) => execution.executionMode === 'paper'
      ? paper(execution) : liveQuote(execution, slippage)) as CanonicalWorkerPorts['quote'],
    deliveryOwner: `executor-${randomUUID()}`,
    now: input.now,
    deliveryLeaseMs: 240_000
  };
}
