import type { Chain } from '@swat/shared';
import type { OwnedObligationTransaction } from '@swat/db/dist/obligation-runtime-owned.js';
import { pipelineRequire, pipelineText, type PipelineClientLease } from '@swat/db/dist/wave4-pipeline-source-owned.js';
import { pipelinePayload, pipelineDigest, pipelineSame,
  createProtectedPipelineWorkerRegistry } from '@swat/db/dist/wave4-pipeline-capability-owned.js';
import { createProtectedPipelineRiskWriter } from '@swat/db/dist/wave4-pipeline-risk-owned.js';
import { createProtectedPipelineValuationBacking, type PipelinePaperValuationEvidence }
  from '@swat/db/dist/wave4-pipeline-valuation-owned.js';
import { createProtectedPipelinePaperReceiptWriter, pipelineWorkerReceiptDigest, pipelineReceiptEvidence,
  assertPipelineWorkerPaperReceiptWithClient, reconcilePipelineWorkerPaperFillWithClient,
  reconcilePipelineWorkerPaperValuationWithClient, readPipelineWorkerFinancialReceiptWithClient,
  type PipelineWorkerPaperReceipt, type PipelineWorkerRecoverySelector, type PipelineWorkerValuationRecoverySelector,
  preparePipelineWorkerRecoverySelector } from '@swat/db/dist/wave4-pipeline-receipt-owned.js';
import type { WorkerFillSettlement, WorkerValuationSettlement } from '@swat/db/dist/worker-settlement.js';
import { createOwnedExecutorRuntimePorts } from './worker-runtime-owned-adapters.js';
import { runCanonicalWorkerJob, parseCanonicalWorkerJob, type CanonicalWorkerPorts, type CanonicalWorkerQuote }
  from './worker-policy.js';
import { unavailableCanonicalQuote, type ReviewedPaperValuationProvider } from './worker-paper-quote.js';

/** Source-only canonical paper composition; no entrypoint/timers/queue/network or
 * hidden pools. Callers must supply the accepted checked runtime transaction and
 * independent approved physical writer leases. These ports do NOT grant authority;
 * shared backend approvals + guarded SQL088 routines + existing SQL079 lookup do.
 * No service/production/live acceptance follows from constructing this graph. */
export const PIPELINE_WORKER_SOURCE_STATUS = Object.freeze({ sourceVerified: false,runtimeAccepted: false,
  fullFanoutAccepted: false,liveAccepted: false,productionReady: false,frozen: true });
export interface PipelinePaperProviderComparison {
  readonly authorityId: string; readonly providerId: string; readonly providerIdentity: string;
  readonly networks: Readonly<Partial<Record<Chain,string>>>;
}
export interface ProtectedPipelineWorkerInput {
  readonly transaction: OwnedObligationTransaction;
  readonly capabilityAcquire: () => Promise<PipelineClientLease>;
  readonly riskAcquire: () => Promise<PipelineClientLease>;
  readonly valuationAcquire: () => Promise<PipelineClientLease>;
  readonly receiptAcquire: () => Promise<PipelineClientLease>;
  readonly provider: PipelinePaperProviderComparison;
  readonly now: () => Date;
  /** Cancellation is forwarded to independent writer leases. The caller-owned
   * runtime transaction must separately destroy its physical backend on abort;
   * a promise race around a callback is NOT a checked runtime COMMIT boundary. */
  readonly signal?: AbortSignal;
  readonly maximumAgeMs: number;
}
export function createProtectedPipelineWorkerComposition(input: ProtectedPipelineWorkerInput) {
  pipelineRequire(input && [input.transaction,input.capabilityAcquire,input.riskAcquire,input.valuationAcquire,
    input.receiptAcquire,input.now].every(v => typeof v === 'function') && Number.isSafeInteger(input.maximumAgeMs)
    && input.maximumAgeMs > 0 && input.maximumAgeMs <= 60_000,'mandatory owned worker/writer ports and bounded clock required');
  const providerComparison = pipelinePayload(input.provider);
  pipelineRequire(providerComparison && pipelineText(providerComparison.authorityId) && pipelineText(providerComparison.providerId)
    && providerComparison.networks && Object.entries(providerComparison.networks).every(([chain,network]) =>
      ['solana','polygon','robinhood-chain'].includes(chain) && pipelineText(network,128)),'provider comparison terms required');
  pipelineDigest(providerComparison.providerIdentity);
  const { transaction,capabilityAcquire,riskAcquire,valuationAcquire,receiptAcquire,now,maximumAgeMs,signal } = input;
  const checkCancellation = () => pipelineRequire(!signal?.aborted,'worker composition cancelled; recover without resend');
  const registry = createProtectedPipelineWorkerRegistry({ acquire: capabilityAcquire,signal });
  const risk = createProtectedPipelineRiskWriter({ acquire: riskAcquire,signal });
  const valuations = createProtectedPipelineValuationBacking({ acquire: valuationAcquire,now,maximumAgeMs,signal });
  const receipts = createProtectedPipelinePaperReceiptWriter({ acquire: receiptAcquire,signal });
  const runtimeTransaction: OwnedObligationTransaction = async operation => {
    checkCancellation();
    const result = await transaction(async client => {
      checkCancellation();
      const value = await operation(client);
      checkCancellation();
      return value;
    });
    checkCancellation();
    return result;
  };
  function runtime(data: unknown) {
    checkCancellation();
    const observations = new Map<string,PipelinePaperValuationEvidence>();
    const provider: ReviewedPaperValuationProvider = {
      providerId: providerComparison.providerId,providerIdentity: providerComparison.providerIdentity,
      networkForChain: chain => providerComparison.networks[chain] ?? null,
      readValuation: async execution => {
        const value = await valuations.read(execution);
        pipelineRequire(value.authorityId === providerComparison.authorityId && value.providerId === providerComparison.providerId
          && value.providerIdentity === providerComparison.providerIdentity
          && value.network === providerComparison.networks[value.chain],'protected provider differs from comparison scope');
        const previous = observations.get(execution.id);
        pipelineRequire(!previous || pipelineSame(previous,value),'immutable per-run paper observation changed');
        observations.set(execution.id,value);
        return { priceUsd: value.priceUsd,observedAt: new Date(value.observedAt),evidenceId: value.evidenceId,
          providerId: value.providerId,providerIdentity: value.providerIdentity,chain: value.chain,network: value.network,
          tokenMint: value.tokenMint,baseDecimals: value.baseDecimals,quoteCurrency: value.quoteCurrency,
          expiresAt: new Date(value.expiresAt),simulationModelId: value.simulationModelId,
          simulatedFeeBps: value.simulatedFeeBps,simulatedFixedFeeUsd: value.simulatedFixedFeeUsd };
      }
    };
    const owned = createOwnedExecutorRuntimePorts({ transaction: runtimeTransaction,paperValuation: provider,now,maximumAgeMs },unavailableCanonicalQuote);
    const scoped = owned.canonicalTransaction(data);
    pipelineRequire(scoped,'canonical worker queue UUID unavailable');
    const job = parseCanonicalWorkerJob(data);
    pipelineRequire(job.executionMode === 'paper' && job.userId !== null,'composition refuses live/shadow/operator fallback');
    const checkedTransaction: OwnedObligationTransaction = operation => scoped(async client => {
      const rows = await client.query(`SELECT id FROM public.copy_executions
        WHERE id=$1 AND user_id=$2 AND execution_mode='paper'`,[job.copyExecutionId,job.userId]);
      pipelineRequire(rows.rows.length === 1,'protected runtime is not the exact paper user execution');
      return operation(client);
    });
    const quote: CanonicalWorkerPorts['quote'] = async (execution,slippage) => {
      if (execution.executionMode !== 'paper' || execution.userId === null) return null;
      const paper = await owned.canonicalQuote(execution,slippage);
      if (!paper) return null;
      const observed = observations.get(execution.id);
      pipelineRequire(observed,'protected paper observation missing');
      const captured = { ...execution };
      return { requestedDebitUsd: paper.requestedDebitUsd,execute: async intent => {
        // createExactPaperQuote checks intent/sizing/clock BEFORE generating evidence.
        checkCancellation();
        const outcome = await paper.execute(intent);
        if (outcome.kind !== 'fill') return outcome;
        pipelineRequire(outcome.executor === 'paper-exact-simulated' && intent.execution.id === captured.id
          && intent.attempt.executionId === captured.id && intent.attempt.userId === captured.userId,
        'independent receipt exact generated paper intent mismatch');
        const body: Omit<PipelineWorkerPaperReceipt,'receiptId'> = {
          executionId: captured.id,userId: captured.userId!,chain: captured.chain,tokenMint: captured.tokenMint,
          targetAccount: captured.targetAccount,executionMode: 'paper',workerFence: intent.attempt.fence,
          policyRevision: intent.attempt.policyRevision,riskEpoch: intent.attempt.riskEpoch,
          paperValuationEvidenceId: observed.evidenceId,paperValuationDigest: observed.evidenceDigest,
          executor: 'paper-exact-simulated',evidence: pipelineReceiptEvidence(outcome.evidence)
        };
        // record returns only AFTER the existing checked writer COMMIT. Neither
        // an INSERT result nor a callback-shaped receipt can reach settlement.
        await receipts.record({ ...body,receiptId: pipelineWorkerReceiptDigest(body) });
        checkCancellation();
        // The writer callback is NOT receipt ownership. Read exact independently
        // persisted receipt on the canonical runtime client before normal settlement.
        await checkedTransaction(client => assertPipelineWorkerPaperReceiptWithClient(client,intent.attempt,outcome.evidence));
        return outcome;
      } } satisfies CanonicalWorkerQuote;
    };
    const ports: CanonicalWorkerPorts = { transaction: checkedTransaction,quote,
      authorize: async () => ({ kind: 'denied',code: 'authority-adapter-missing',reason: 'FROZEN paper composition has no signing/live capability' }),
      // This is a restrictive upper bound, not policy authority. Canonical current
      // DB mode, user/subscription policy, risk epoch and captures still decide.
      platformMode: async () => 'paper',deliveryOwner: owned.deliveryOwner,now,deliveryLeaseMs: owned.deliveryLeaseMs };
    return { ports,transaction: checkedTransaction,job };
  }
  return Object.freeze({ status: PIPELINE_WORKER_SOURCE_STATUS,registry,risk,valuations,receipts,
    run(data: unknown) {
      const captured = pipelinePayload(data),owned = runtime(captured);
      return runCanonicalWorkerJob(captured,owned.ports);
    },
    financialReceipt(data: unknown) {
      const captured = pipelinePayload(data),owned = runtime(captured);
      return owned.transaction(client => readPipelineWorkerFinancialReceiptWithClient(client,owned.job.copyExecutionId));
    },
    reconcileFill(data: unknown, candidate: WorkerFillSettlement | PipelineWorkerRecoverySelector) {
      const captured = pipelinePayload(data),owned = runtime(captured);
      if ('execution' in candidate) {
        const supplied = captureRecovery(candidate);
        pipelineRequire(supplied.execution.id === owned.job.copyExecutionId,'recovery queue/canonical execution mismatch');
        return owned.transaction(client => reconcilePipelineWorkerPaperFillWithClient(client,supplied,now()));
      }
      const supplied = preparePipelineWorkerRecoverySelector(candidate);
      pipelineRequire(supplied.executionId === owned.job.copyExecutionId,'recovery queue/canonical execution mismatch');
      return owned.transaction(client => reconcilePipelineWorkerPaperFillWithClient(client,supplied,now()));
    },
    reconcileValuation(data: unknown, candidate: WorkerValuationSettlement | PipelineWorkerValuationRecoverySelector) {
      const captured = pipelinePayload(data),owned = runtime(captured);
      const correction = pipelinePayload({ originalEvidenceId: candidate.correction.originalEvidenceId,
        correctionId: candidate.correction.correctionId,valuationId: candidate.correction.valuationId,
        previousCorrectionId: candidate.correction.previousCorrectionId });
      const supplied = 'execution' in candidate ? { ...captureRecovery(candidate),correction: { ...correction,now: now() } }
        : { ...preparePipelineWorkerRecoverySelector({ executionId: candidate.executionId,
          workerFence: candidate.workerFence,evidenceId: candidate.evidenceId }),correction };
      const executionId = 'execution' in supplied ? supplied.execution.id : supplied.executionId;
      pipelineRequire(executionId === owned.job.copyExecutionId,'recovery queue/canonical execution mismatch');
      return owned.transaction(client => reconcilePipelineWorkerPaperValuationWithClient(client,supplied,now()));
    }
  });
}
export const createProtectedPipelineWorker = createProtectedPipelineWorkerComposition;

function captureRecovery(candidate: WorkerFillSettlement): WorkerFillSettlement {
  pipelineRequire(candidate && candidate.execution && candidate.attempt && candidate.evidence,'recovery input required');
  return { ...candidate,execution: { ...candidate.execution },attempt: { ...candidate.attempt },
    risk: candidate.risk ? { ...candidate.risk } : null,
    evidence: { ...candidate.evidence,quoteLeg: candidate.evidence.quoteLeg ? { ...candidate.evidence.quoteLeg } : null,
      occurredAt: new Date(candidate.evidence.occurredAt) },
    delivery: candidate.delivery ? { claim: { ...candidate.delivery.claim },now: new Date(candidate.delivery.now) } : undefined };
}
