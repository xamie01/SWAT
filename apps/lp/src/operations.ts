import { resolveChainMode, forUser, type UserScope, type getLpPosition, type findLpPaperOperation, type getLpOperationPosition,
  type requestLpPaperOperation, type completeLpPaperOperation, type listPendingLpPaperOperations, type LpPosition, type LpPaperPlan } from '@swat/db';
import type { LpChain } from '@swat/shared';
import type { LpPaperService } from '@swat/db/dist/lp-paper-service.js';
import type { ExecutionModePort, BuildPositionDeps } from './builder/build-position.js';

export function createLpExecutionMode(resolve: typeof resolveChainMode = resolveChainMode): ExecutionModePort {
  return { resolveMode: async chain => {
    const { effectiveMode } = await resolve(chain, { forceFresh: true });
    return effectiveMode === 'off' || effectiveMode === 'live' ? effectiveMode : 'paper';
  } };
}
/** Deprecated legacy seams are inert; only the exact durable receipt domain may mutate financial state. */
export interface LpOperationDeps {
  readonly executionMode: ExecutionModePort;
  readonly exactPaper?: LpPaperService;
  /** Tenant enumeration itself needs a separately reviewed operator capability; no wildcard fallback. */
  readonly recoveryScopes?: () => Promise<readonly UserScope[]>;
  readonly getPosition?: typeof getLpPosition;
  readonly findOperation?: typeof findLpPaperOperation;
  readonly operationPosition?: typeof getLpOperationPosition;
  readonly request?: typeof requestLpPaperOperation;
  readonly complete?: typeof completeLpPaperOperation;
  readonly pending?: typeof listPendingLpPaperOperations;
  readonly replan: (position: LpPosition) => Promise<LpPaperPlan>;
  readonly enqueue: (input: { operationId: string; userId: string; chain: LpChain }) => Promise<void>;
}
export async function requestLpOperation(deps: LpOperationDeps, scope: UserScope,
  input: { positionId: string; operationKey: string; kind: 'rebalance' | 'close'; automatic?: boolean }) {
  if (!deps.exactPaper) throw new Error('LP exact durable receipt operations unavailable');
  return deps.exactPaper.requestOperation(scope, { positionId: input.positionId, operationKey: input.operationKey,
    action: input.kind, ...(input.automatic === undefined ? {} : { automatic: input.automatic }) });
}
export async function processLpOperationJob(deps: Pick<LpOperationDeps, 'executionMode' | 'exactPaper' | 'complete' | 'operationPosition'>,
  input: { operationId: string; userId: string; chain: LpChain }) {
  if (!deps.exactPaper) throw new Error('LP exact durable receipt worker unavailable');
  return deps.exactPaper.process(forUser(input.userId), { operationId: input.operationId, chain: input.chain });
}
export async function recoverLpOperations(deps: LpOperationDeps): Promise<{ queued: number; deferred: number; capabilityUnavailable?: true }> {
  if (!deps.exactPaper || !deps.recoveryScopes) return { queued: 0, deferred: 0, capabilityUnavailable: true };
  const scopes = await deps.recoveryScopes();
  if (scopes.length > 500 || scopes.some(scope => !scope.userId.trim() || scope.userId === '*')) throw new Error('LP bounded tenant recovery capability required');
  let queued = 0, deferred = 0;
  for (const scope of scopes) {
    const result = await deps.exactPaper.recover(scope); queued += result.queued; deferred += result.deferred;
  }
  return { queued, deferred };
}
export function createPaperReplanner(_deps: BuildPositionDeps): LpOperationDeps['replan'] {
  return async () => { throw new Error('LP legacy receiptless replanner unavailable; exact injected protocol required'); };
}
