import type { OwnedObligationTransaction } from './obligation-runtime-owned.js';
import { createOwnedObligationScopedTransaction } from './obligation-runtime-owned.js';
import { withTransaction } from './transaction.js';

export type { OwnedObligationTransaction as ObligationTransaction,
  OwnedWorkerRuntimeCapability as WorkerRuntimeCapability } from './obligation-runtime-owned.js';
export { readOwnedWorkerRuntimeCapability as readWorkerRuntimeCapabilityWithClient } from './obligation-runtime-owned.js';

/** Legacy ambient convenience only. Protected lookup, persisted scope validation
 * and every-transaction checks are the same owned production implementation. */
export function createObligationScopedTransaction(input: {
  readonly transaction?: OwnedObligationTransaction;
  readonly now: () => Date;
  readonly maximumAgeMs: number;
}) {
  return createOwnedObligationScopedTransaction({ transaction: input.transaction ?? withTransaction,
    now: input.now, maximumAgeMs: input.maximumAgeMs });
}
