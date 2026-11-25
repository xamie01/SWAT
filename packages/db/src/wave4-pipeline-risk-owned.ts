import type { PoolClient } from 'pg';
import { workerMoney } from './worker-valuation-corrections.js';
import { pipelineRequire, pipelineText, pipelineUuid, type PipelineClientLease } from './wave4-pipeline-source-owned.js';
import { pipelinePayload, pipelineFields, pipelineScope, pipelineSame, requirePipelineApprovedPayload,
  requirePipelineWorkerRoutine, pipelineWriterTransaction } from './wave4-pipeline-capability-owned.js';

/** SQL072 exact control, authorized by an independent execution-specific protected
 * approval. accountingReady is proof to compare, not a caller opt-in. The fixed
 * SQL boundary MUST audit every retained liability/valuation/receipt in the
 * account/chain/paper scope before allowing ready/enabled and advancing epoch.
 * Existing unknown/submitted liabilities cannot be released by this writer. */
export interface PipelineRiskPolicyWrite {
  readonly executionId: string; readonly userId: string; readonly chain: 'solana' | 'polygon' | 'robinhood-chain';
  readonly tokenMint: string; readonly targetAccount: string; readonly account: string;
  readonly executionMode: 'paper'; readonly previousEpoch: string | null; readonly epoch: string;
  readonly enabled: boolean; readonly capUsd: string; readonly accountingReady: boolean;
}
export function preparePipelineRiskPolicy(candidate: PipelineRiskPolicyWrite) {
  const value = pipelinePayload(candidate);
  pipelineFields(value,['executionId','userId','chain','tokenMint','targetAccount','account','executionMode',
    'previousEpoch','epoch','enabled','capUsd','accountingReady']);
  pipelineUuid(value.executionId); pipelineUuid(value.userId); pipelineScope(value);
  pipelineRequire(value.account === value.userId && value.executionMode === 'paper'
    && pipelineText(value.epoch,19) && /^[1-9]\d{0,18}$/.test(value.epoch) && BigInt(value.epoch) <= 9223372036854775807n
    && (value.previousEpoch === null || pipelineText(value.previousEpoch,19) && /^[1-9]\d{0,18}$/.test(value.previousEpoch)
      && BigInt(value.previousEpoch) <= 9223372036854775807n && BigInt(value.epoch) > BigInt(value.previousEpoch))
    && typeof value.enabled === 'boolean' && typeof value.accountingReady === 'boolean'
    && (!value.enabled || value.accountingReady) && workerMoney(value.capUsd) !== '0',
  'exact protected risk epoch/coverage/control terms required');
  return value;
}
export async function writePipelineRiskPolicyWithClient(client: PoolClient, candidate: PipelineRiskPolicyWrite) {
  const value = preparePipelineRiskPolicy(candidate);
  await requirePipelineApprovedPayload(client,'risk-write',value.executionId,value);
  await requirePipelineWorkerRoutine(client,'risk');
  const result = await client.query('SELECT public.swat_pipeline_write_risk_policy($1::uuid,$2::jsonb) AS result',
    [value.executionId,JSON.stringify(value)]);
  pipelineRequire(result.rows.length === 1 && pipelineSame(result.rows[0].result,value),
    'protected SQL072 risk write/coverage/replay refused');
  return value;
}
export function createProtectedPipelineRiskWriter(input: { acquire: () => Promise<PipelineClientLease>; signal?: AbortSignal }) {
  pipelineRequire(typeof input.acquire === 'function','risk physical lease required');
  const { acquire,signal } = input;
  return { write(candidate: PipelineRiskPolicyWrite) {
    const value = preparePipelineRiskPolicy(candidate);
    return pipelineWriterTransaction(acquire,'risk-write',value.executionId,signal)(client => writePipelineRiskPolicyWithClient(client,value));
  } };
}
