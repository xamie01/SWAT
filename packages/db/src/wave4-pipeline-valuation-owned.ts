import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CopyExecutionRecord } from './copy-trade-lifecycle-owned.js';
import { workerMoney } from './worker-valuation-corrections.js';
import { exactDecimal, compareExactDecimal } from './runtime-exact-decimal.js';
import { pipelineRequire, pipelineText, pipelineUuid, pipelineTime, readPipelineBackendApproval,
  type PipelineClientLease } from './wave4-pipeline-source-owned.js';
import { pipelinePayload, pipelineFields, pipelineIso, pipelineDigest, pipelineChain, pipelineScope,
  pipelineSame, requirePipelineApprovedPayload, requirePipelineWorkerRoutine,
  pipelineWriterTransaction } from './wave4-pipeline-capability-owned.js';

/** Exact SQL080 authority. Existing migrator-only authority/trusted guards need
 * a reviewed FORWARD capability before this writer is usable, not credentials
 * alone. Only immutable INSERT/exact replay and one-way revocation are permitted;
 * runtime obtains no authority INSERT, enable or provider enrollment grant. */
export interface PipelineValuationAuthority {
  readonly authorityId: string; readonly userId: string; readonly chain: CopyExecutionRecord['chain'];
  readonly network: string; readonly providerId: string; readonly identityDigest: string;
  readonly verifierVersion: string; readonly enabled: true; readonly validUntil: string;
  readonly maxQuoteUsd: string; readonly maxFeeUsd: string;
}
export function preparePipelineValuationAuthority(candidate: PipelineValuationAuthority) {
  const value = pipelinePayload(candidate);
  pipelineFields(value,['authorityId','userId','chain','network','providerId','identityDigest','verifierVersion',
    'enabled','validUntil','maxQuoteUsd','maxFeeUsd']);
  pipelineUuid(value.userId); pipelineChain(value.chain); pipelineDigest(value.identityDigest); pipelineIso(value.validUntil);
  pipelineRequire([value.authorityId,value.providerId,value.verifierVersion].every(v => pipelineText(v))
    && pipelineText(value.network,128) && value.enabled === true,'exact independent valuation authority required');
  workerMoney(value.maxQuoteUsd); workerMoney(value.maxFeeUsd); return value;
}
export async function registerPipelineValuationAuthorityWithClient(client: PoolClient, candidate: PipelineValuationAuthority) {
  const value = preparePipelineValuationAuthority(candidate);
  const approval = await requirePipelineApprovedPayload(client,'valuation-register',value.authorityId,value);
  pipelineRequire(new Date(value.validUntil) <= approval.expiresAt,'valuation authority exceeds protected approval');
  await requirePipelineWorkerRoutine(client,'authority');
  const result = await client.query('SELECT public.swat_pipeline_register_worker_valuation_authority($1::text,$2::jsonb) AS result',
    [value.authorityId,JSON.stringify(value)]);
  pipelineRequire(result.rows.length === 1 && pipelineSame(result.rows[0].result,value),'immutable SQL080 authority write/replay refused');
  return value;
}
export interface PipelineTrustedWorkerValuation {
  readonly valuationId: string; readonly authorityId: string; readonly originalEvidenceId: string;
  readonly executionId: string; readonly userId: string; readonly sourceEvidenceId: string;
  readonly lineageSourceTradeId: string; readonly lineageAcquisitionEvidenceId: string | null;
  readonly lineageMasterWalletAddress: string; readonly originalDigest: string; readonly providerId: string;
  readonly providerIdentityDigest: string; readonly verifierVersion: string; readonly revision: string;
  readonly quoteUsd: string | null; readonly feeUsd: string | null; readonly validUntil: string;
}
export function preparePipelineTrustedWorkerValuation(candidate: PipelineTrustedWorkerValuation) {
  const value = pipelinePayload(candidate);
  pipelineFields(value,['valuationId','authorityId','originalEvidenceId','executionId','userId','sourceEvidenceId',
    'lineageSourceTradeId','lineageAcquisitionEvidenceId','lineageMasterWalletAddress','originalDigest','providerId',
    'providerIdentityDigest','verifierVersion','revision','quoteUsd','feeUsd','validUntil']);
  for (const id of [value.originalEvidenceId,value.executionId,value.userId,value.lineageSourceTradeId]) pipelineUuid(id);
  if (value.lineageAcquisitionEvidenceId !== null) pipelineUuid(value.lineageAcquisitionEvidenceId);
  pipelineDigest(value.originalDigest); pipelineDigest(value.providerIdentityDigest); pipelineIso(value.validUntil);
  pipelineRequire([value.valuationId,value.authorityId,value.sourceEvidenceId,value.providerId,value.verifierVersion,
    value.lineageMasterWalletAddress].every(v => pipelineText(v)) && /^[1-9]\d{0,37}$/.test(value.revision)
    && (value.quoteUsd !== null || value.feeUsd !== null),'exact independent trusted valuation required');
  if (value.quoteUsd !== null) workerMoney(value.quoteUsd);
  if (value.feeUsd !== null) workerMoney(value.feeUsd);
  return value;
}
export async function recordPipelineTrustedWorkerValuationWithClient(client: PoolClient, candidate: PipelineTrustedWorkerValuation) {
  const value = preparePipelineTrustedWorkerValuation(candidate);
  const approval = await requirePipelineApprovedPayload(client,'valuation-write',value.valuationId,value);
  pipelineRequire(new Date(value.validUntil) <= approval.expiresAt,'trusted valuation exceeds protected approval');
  await requirePipelineWorkerRoutine(client,'valuation');
  const result = await client.query('SELECT public.swat_pipeline_record_trusted_worker_valuation($1::text,$2::jsonb) AS result',
    [value.valuationId,JSON.stringify(value)]);
  pipelineRequire(result.rows.length === 1 && pipelineSame(result.rows[0].result,value),'immutable SQL080 trusted valuation write/replay refused');
  return value;
}

/** Pre-fill evidence CANNOT be invented as trusted_worker_valuations: SQL080
 * requires an existing original fill FK. The fixed lookup needs separately
 * persisted immutable pre-fill evidence, linked to SQL077 current source binding
 * and enabled authority, exact asset/network/raw/scale/price/fee/model evidence.
 * Missing relation/protected lookup/ACL is explicitly a SOURCE prerequisite.
 * rawQuantity/quantityScale below describe the accepted SOURCE observation,
 * never a rounded/generated follower buy size. requestedBase MUST remain null
 * for a quote-budget follower buy; createExactPaperQuote derives its own size. */
export interface PipelinePaperValuationEvidence {
  readonly executionId: string; readonly userId: string; readonly chain: CopyExecutionRecord['chain'];
  readonly tokenMint: string; readonly targetAccount: string; readonly executionMode: 'paper';
  readonly direction: 'buy' | 'sell'; readonly requestedBase: string | null; readonly requestedQuote: string | null;
  readonly authorityId: string; readonly providerId: string; readonly providerIdentity: string;
  readonly verifierVersion: string; readonly network: string; readonly baseDecimals: number;
  readonly sourceTradeId: string; readonly sourceEvidenceId: string; readonly bindingDigest: string;
  readonly rawQuantity: string; readonly quantityScale: number; readonly priceUsd: string;
  readonly quoteCurrency: 'USD'; readonly evidenceId: string; readonly evidenceDigest: string;
  readonly observedAt: string; readonly expiresAt: string; readonly simulationModelId: string;
  readonly simulatedFeeBps: string; readonly simulatedFixedFeeUsd: string;
}
export function pipelinePaperEvidenceDigest(value: Omit<PipelinePaperValuationEvidence,'evidenceDigest'>): string {
  return createHash('sha256').update(JSON.stringify(pipelinePayload(value))).digest('hex');
}
export function preparePipelinePaperValuation(candidate: PipelinePaperValuationEvidence) {
  const value = pipelinePayload(candidate);
  pipelineFields(value,['executionId','userId','chain','tokenMint','targetAccount','executionMode','direction',
    'requestedBase','requestedQuote','authorityId','providerId','providerIdentity','verifierVersion','network','baseDecimals',
    'sourceTradeId','sourceEvidenceId','bindingDigest','rawQuantity','quantityScale','priceUsd','quoteCurrency','evidenceId',
    'evidenceDigest','observedAt','expiresAt','simulationModelId','simulatedFeeBps','simulatedFixedFeeUsd']);
  pipelineUuid(value.executionId); pipelineUuid(value.userId); pipelineUuid(value.sourceTradeId); pipelineScope(value);
  for (const digest of [value.providerIdentity,value.bindingDigest,value.evidenceDigest]) pipelineDigest(digest);
  pipelineIso(value.observedAt); pipelineIso(value.expiresAt);
  pipelineRequire(value.executionMode === 'paper' && value.quoteCurrency === 'USD'
    && ['buy','sell'].includes(value.direction) && /^[1-9]\d{0,77}$/.test(value.rawQuantity)
    && Number.isSafeInteger(value.quantityScale) && value.quantityScale >= 0 && value.quantityScale <= 255
    && Number.isSafeInteger(value.baseDecimals) && value.baseDecimals >= 0 && value.baseDecimals <= 36
    && [value.authorityId,value.providerId,value.verifierVersion,value.sourceEvidenceId,value.evidenceId,value.simulationModelId]
      .every(v => pipelineText(v)) && pipelineText(value.network,128) && value.observedAt < value.expiresAt,
  'exact protected paper observation/provider/raw-scale required');
  workerMoney(value.priceUsd); exactDecimal(value.priceUsd,true);
  workerMoney(value.simulatedFixedFeeUsd); workerMoney(value.simulatedFeeBps);
  pipelineRequire(compareExactDecimal(value.simulatedFeeBps,'10000') <= 0,'paper fee exceeds bounded model');
  if (value.requestedBase !== null) exactDecimal(value.requestedBase,true);
  if (value.requestedQuote !== null) workerMoney(value.requestedQuote);
  pipelineRequire(value.direction === 'buy' ? value.requestedBase === null && value.requestedQuote !== null
    && exactDecimal(value.requestedQuote,true) : value.requestedBase !== null && value.requestedQuote === null,
  'quote-sized follower buy requires requestedBase:null and exact budget; sell requires exact base');
  const { evidenceDigest: _digest,...body } = value;
  pipelineRequire(pipelinePaperEvidenceDigest(body) === value.evidenceDigest,'paper evidence digest mismatch');
  return value;
}
export function assertPipelinePaperExecution(value: PipelinePaperValuationEvidence, execution: CopyExecutionRecord): void {
  pipelineRequire(value.executionId === execution.id && value.userId === execution.userId
    && value.chain === execution.chain && value.tokenMint === execution.tokenMint && value.targetAccount === execution.targetAccount
    && value.executionMode === execution.executionMode && value.direction === execution.direction
    && value.requestedBase === execution.requestedBaseQuantity && value.requestedQuote === execution.requestedQuoteQuantity
    && (execution.sourceTradeId === null || value.sourceTradeId === execution.sourceTradeId),
  'paper provider exact persisted execution/sizing mismatch');
}
export async function readPipelinePaperValuationWithClient(client: PoolClient, execution: CopyExecutionRecord,
  now: Date, maximumAgeMs: number): Promise<PipelinePaperValuationEvidence> {
  pipelineUuid(execution.id);
  pipelineRequire(pipelineTime(now) && Number.isSafeInteger(maximumAgeMs) && maximumAgeMs > 0 && maximumAgeMs <= 60_000,
    'bounded paper valuation clock required');
  const approval = await requirePipelineApprovedPayloadSelector(client,execution.id);
  await requirePipelineWorkerRoutine(client,'paper');
  const result = await client.query('SELECT public.swat_pipeline_paper_valuation($1::uuid) AS result',[execution.id]);
  pipelineRequire(result.rows.length === 1 && result.rows[0].result,'protected persisted pre-fill paper evidence unavailable');
  const value = preparePipelinePaperValuation(result.rows[0].result);
  pipelineRequire(pipelineSame(approval.terms,value),'paper observation differs from independently approved evidence');
  assertPipelinePaperExecution(value,execution);
  const clock = await client.query('SELECT statement_timestamp() AS database_now');
  const databaseNow = clock.rows[0]?.database_now;
  pipelineRequire(clock.rows.length === 1 && pipelineTime(databaseNow) && [now,databaseNow].every(time =>
    Date.parse(value.observedAt) <= time.getTime() && Date.parse(value.expiresAt) > time.getTime()
    && time.getTime() - Date.parse(value.observedAt) <= maximumAgeMs) && new Date(value.expiresAt) <= approval.expiresAt,
  'protected paper evidence stale/expired/future');
  return value;
}
const requirePipelineApprovedPayloadSelector = (client: PoolClient, id: string) => readPipelineBackendApproval(client,'paper-valuation',id);
export function createProtectedPipelineValuationBacking(input: { acquire: () => Promise<PipelineClientLease>;
  now: () => Date; maximumAgeMs: number }) {
  pipelineRequire(typeof input.acquire === 'function' && typeof input.now === 'function'
    && Number.isSafeInteger(input.maximumAgeMs) && input.maximumAgeMs > 0 && input.maximumAgeMs <= 60_000,
  'valuation lease and bounded clock required');
  const { acquire,now,maximumAgeMs } = input;
  return {
    register(candidate: PipelineValuationAuthority) {
      const value = preparePipelineValuationAuthority(candidate);
      return pipelineWriterTransaction(acquire,'valuation-register',value.authorityId)(client => registerPipelineValuationAuthorityWithClient(client,value));
    },
    record(candidate: PipelineTrustedWorkerValuation) {
      const value = preparePipelineTrustedWorkerValuation(candidate);
      return pipelineWriterTransaction(acquire,'valuation-write',value.valuationId)(client => recordPipelineTrustedWorkerValuationWithClient(client,value));
    },
    read(execution: CopyExecutionRecord) {
      // Capture precisely the used comparison fields; lifecycle may contain Date values.
      const captured = { ...execution };
      return pipelineWriterTransaction(acquire,'paper-valuation',captured.id)(client =>
        readPipelinePaperValuationWithClient(client,captured,now(),maximumAgeMs));
    }
  };
}
