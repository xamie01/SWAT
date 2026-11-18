import { createHash } from 'node:crypto';
import type { LpTenantTransaction } from '../../../packages/db/src/lp-paper-store.js';
import { canonicalSourceBinding, sourceBindingDigest, sourceEvidenceDigest, sourceTokenQuantity,
  type SourceVerificationBinding, type SourceVerificationEvidence, type TrustedSourceVerifier } from '../../../packages/db/src/source-verification.js';
import { workerMoney, workerQuantity, workerOriginalEvidenceDigest } from '../../../packages/db/src/worker-valuation-corrections.js';
import type { CanonicalFanoutPorts, createVerifiedFanoutAdmission } from '../../../apps/signal-engine/src/fanout-canonical.js';
import type { DurableFanoutCaller, FanoutJobPlan, FanoutTradeQueue } from '../../../apps/signal-engine/src/fanout-enqueue.js';
import type { CanonicalWorkerPorts } from '../../../apps/trade-executor/src/worker-policy.js';
import type { GateResult, SqlClient } from './core.js';

type PoolClient = Parameters<Parameters<LpTenantTransaction>[1]>[0];

/** A declaration of server requirements, NOT an executable capability factory.
 * In particular workerPorts must resolve a protected persisted obligation on
 * every transaction; neither this interface nor queue.userId grants authority. */
export interface PipelineComposition {
  readonly runId: string;
  readonly sourceTradeId: string;
  readonly binding: SourceVerificationBinding;
  readonly evidence: SourceVerificationEvidence;
  readonly verifier: TrustedSourceVerifier;
  readonly sourceClient: PoolClient;
  readonly fanoutTransaction: DurableFanoutCaller['transaction'];
  readonly fanoutPorts: CanonicalFanoutPorts;
  readonly currentAdmission: Parameters<typeof createVerifiedFanoutAdmission>[0]['current'];
  readonly enumerate: DurableFanoutCaller['enumerate'];
  readonly plan: FanoutJobPlan;
  readonly queueFor: (chain: FanoutJobPlan['chain']) => FanoutTradeQueue;
  readonly workerPorts: (job: unknown) => CanonicalWorkerPorts;
  readonly observe: <T>(action: (c: SqlClient) => Promise<T>) => Promise<T>;
}
export async function exercisePaperPipeline(_input: unknown): Promise<never> {
  throw new Error('Joined pipeline execution unavailable until protected server composition and ambient-pool import containment are qualified');
}

/** Static source contracts, not runtime imports, provision status or opt-ins. */
export const pipelineSourceBlockers = Object.freeze([
  'fanout-enqueue.ts runtime @swat/db import evaluates db/index.ts -> client.ts/transaction.ts; an owned transaction does not contain module evaluation',
  'worker-policy.ts runtime @swat/db import and worker-settlement.ts -> copy-trade-lifecycle.ts/trades.ts/risk-policy.ts -> client.ts reach the ambient pool',
  'obligation-runtime-capability.ts -> tenancy.ts/transaction.ts -> client.ts even with transaction supplied; require a pool-free mandatory-owned-transaction leaf preserving protected lookup on every transaction',
  'No reviewed protected source intake/provider registry, backend/obligation capability provision, exact follower sizing, independently owned paper receipt or trusted valuation writer is supplied by the CLI',
  'Operator obligation scope is unsupported; durable operator exclusion must be explicit; live/provider-unavailable execution remains refused',
  'Public joined execution remains unavailable pending separate composition, import containment and disposable execution review'
]);
export interface PipelinePreflightSnapshot {
  readonly authenticated_role: string;
  readonly runtime_role: string;
  readonly bypass: string | null;
  readonly tenant: string | null;
  readonly worker_execution: string | null;
  readonly lookup: boolean;
  readonly provider_write: boolean;
  readonly capability_write: boolean;
  readonly valuation_authority_write: boolean;
  readonly valuation_write: boolean;
}
function i3(assertions: GateResult['assertions'], evidence: GateResult['evidence']): GateResult {
  return { gate: 'I3', assertions, blocked: [...pipelineSourceBlockers], evidence };
}
/** Negative authority only. Even a privileged lookup grant cannot turn this
 * result into a passed gate or manufacture a worker/provider capability. */
export function pipelinePreflightContract(row: PipelinePreflightSnapshot | null): GateResult {
  return i3([
    { name: 'direct authenticated swat_app runtime identity', passed: row?.authenticated_role === 'swat_app' && row.runtime_role === 'swat_app' },
    { name: 'preflight has no tenant or worker impersonation scope', passed: row?.bypass === 'off'
      && (row.tenant === '' || row.tenant === null) && (row.worker_execution === '' || row.worker_execution === null) },
    { name: 'runtime cannot mint or mutate provider worker or valuation authority', passed: row?.provider_write === false
      && row.capability_write === false && row.valuation_authority_write === false && row.valuation_write === false },
    { name: 'protected lookup privilege is observed not presumed', passed: typeof row?.lookup === 'boolean' }
  ], { runtimeLookupExecutable: row?.lookup === true, runtimeAccepted: false, liveCapabilityAccepted: false,
    protectedCompositionAvailable: false, sourceOnly: true });
}
/** Caller supplies the already-owned, bounded transaction client. No pool,
 * BEGIN/COMMIT, capability lookup invocation, registry write, queue or provider. */
export async function pipelinePreflight(client: SqlClient): Promise<GateResult> {
  const rows = (await client.query(`SELECT session_user AS authenticated_role, current_user AS runtime_role,
    current_setting('app.bypass_rls',true) AS bypass, current_setting('app.current_user_id',true) AS tenant,
    current_setting('app.worker_execution_id',true) AS worker_execution,
    has_function_privilege(current_user,'public.swat_claim_runtime_capability(uuid)','EXECUTE') AS lookup,
    has_table_privilege(current_user,'public.source_provider_authorities','INSERT,UPDATE,DELETE') AS provider_write,
    has_table_privilege(current_user,'public.worker_runtime_capabilities','INSERT,UPDATE,DELETE') AS capability_write,
    has_table_privilege(current_user,'public.worker_valuation_authorities','INSERT,UPDATE,DELETE') AS valuation_authority_write,
    has_table_privilege(current_user,'public.trusted_worker_valuations','INSERT,UPDATE,DELETE') AS valuation_write`)).rows;
  return pipelinePreflightContract(rows.length === 1 ? rows[0] : null);
}

export interface PipelineScope {
  readonly runId: string; readonly network: string; readonly chain: 'solana'; readonly userId: string;
  readonly targetAccount: string; readonly masterWalletAddress: string; readonly tokenMint: string;
}
export interface PipelineSourceJournal {
  readonly sourceTradeId: string; readonly binding: SourceVerificationBinding; readonly bindingDigest: string;
  readonly evidence: readonly SourceVerificationEvidence[]; readonly evidenceDigests: readonly string[];
}
export interface PipelineOriginalFill {
  readonly id: string; readonly executionId: string; readonly userId: string; readonly sourceTradeId: string;
  readonly evidenceType: string; readonly evidenceId: string; readonly baseQuantity: string;
  readonly quoteQuantity: string | null; readonly quoteNativeQuantity: string | null; readonly quoteCurrency: string | null;
  readonly quoteNativeUsdPrice: string | null; readonly priceUsd: string | null; readonly feeUsd: string | null;
  readonly occurredAt: string; readonly completesExecution: boolean;
}
export interface PipelineExecution {
  readonly id: string; readonly signalId: string; readonly sourceTradeId: string; readonly userId: string;
  readonly chain: 'solana'; readonly tokenMint: string; readonly targetAccount: string; readonly masterWalletAddress: string;
  readonly executionMode: 'paper'; readonly direction: 'buy' | 'sell'; readonly state: 'confirmed';
  readonly requestedBaseQuantity: string; readonly requestedQuoteQuantity: string | null;
  readonly confirmedBaseQuantity: string; readonly confirmedQuoteQuantity: string;
}
export interface PipelineTotals {
  readonly base: string; readonly quote: string; readonly debit: string; readonly fee: string;
  readonly unknown: '0'; readonly quoteUnknown: '0'; readonly completes: true; readonly evidenceCount: '1';
}
export interface PipelineFinancialReceipt {
  readonly receiptId: string;
  readonly snapshot: { readonly executionId: string; readonly userId: string; readonly tradeId: string;
    readonly fence: string; readonly totals: PipelineTotals; readonly accountingComplete: true };
}
export interface PipelineCorrection {
  readonly correctionId: string; readonly valuationId: string; readonly originalEvidenceId: string;
  readonly executionId: string; readonly userId: string; readonly revision: string; readonly previousCorrectionId: string | null;
  readonly originalDigest: string; readonly originalSnapshot: PipelineOriginalFill;
  readonly lineageSourceTradeId: string; readonly lineageAcquisitionEvidenceId: string | null;
  readonly lineageMasterWalletAddress: string; readonly sourceEvidenceId: string;
  readonly effectiveQuoteUsd: string; readonly effectiveFeeUsd: string;
  readonly quoteOriginValuationId: string; readonly feeOriginValuationId: string;
  /** Observation of worker_correction_authorized in a durable export, never a grant. */
  readonly authorized: boolean;
}
export interface PipelineDescriptor {
  readonly copyExecutionId: string; readonly signalId: string; readonly sourceTradeId: string; readonly userId: string;
  readonly chain: 'solana'; readonly tokenMint: string; readonly targetAccount: string; readonly masterWalletAddress: string;
  readonly executionMode: 'paper'; readonly direction: 'buy' | 'sell'; readonly requestedBaseQuantity: string;
  readonly requestedQuoteQuantity: string | null; readonly exitLotId: null; readonly score: number;
}
export interface PipelineSnapshot {
  readonly stage: 'buy' | 'sell' | 'reversal' | 'correction' | 'replay';
  readonly sourceHeads: readonly { sourceTradeId: string; evidenceId: string; confirmationState: 'confirmed' | 'reversed'; applicationActive: boolean }[];
  readonly sourcePosition: { quantity: string; costBasisUsd: string; unmatchedReductionQuantity: string };
  readonly executions: readonly PipelineExecution[];
  readonly originalEvidence: readonly PipelineOriginalFill[];
  readonly effectiveEvidence: readonly { originalEvidenceId: string; executionId: string; baseQuantity: string;
    quoteUsd: string; feeUsd: string; correctionId: string | null; confirmationState: 'confirmed' }[];
  readonly applications: readonly { evidenceId: string; executionId: string; positionId: string; userId: string;
    targetAccount: string; chain: 'solana'; tokenMint: string; active: boolean }[];
  readonly deliveries: readonly { executionId: string; signalId: string; sourceTradeId: string; userId: string;
    targetAccount: string; executionMode: 'paper'; jobId: string; state: 'completed'; fence: string;
    descriptor: PipelineDescriptor }[];
  readonly attempts: readonly { executionId: string; userId: string; fence: string; policyRevision: string; riskEpoch: string | null; state: 'settled' }[];
  readonly trades: readonly { id: string; executionId: string; userId: string; direction: 'buy' | 'sell';
    executionMode: 'paper'; tokenAmount: string; amountUsd: string; feeUsd: string; status: 'filled' }[];
  readonly financialReceipts: readonly PipelineFinancialReceipt[];
  readonly risk: readonly { executionId: string; userId: string; policyEpoch: string; state: 'confirmed'; confirmedUsd: string }[];
  readonly capacity: readonly { sourceTradeId: string; executionMode: 'paper'; notionalUsd: string }[];
  readonly position: { id: string; userId: string; targetAccount: string; chain: 'solana'; tokenMint: string; quantity: string; costBasisUsd: string };
  readonly lots: readonly { id: string; positionId: string; userId: string; masterWalletAddress: string;
    acquisitionExecutionId: string; acquisitionEvidenceId: string; acquisitionSourceTradeId: string; acquisitionMode: 'paper';
    acquiredQuantity: string; remainingQuantity: string; acquiredCostBasisUsd: string; remainingCostBasisUsd: string }[];
  readonly allocations: readonly { executionId: string; lotId: string; userId: string; masterWalletAddress: string;
    acquisitionExecutionId: string; acquisitionEvidenceId: string; acquisitionSourceTradeId: string; requestedQuantity: string }[];
  readonly reductions: readonly { executionId: string; evidenceId: string; lotId: string; userId: string; quantity: string }[];
  readonly corrections: readonly PipelineCorrection[];
}
/** Normalized exact durable export. Must be obtained by a separately reviewed
 * owned observer before it can be called runtime evidence. Offline inputs are
 * inert fixtures only; there are deliberately no clients/callbacks/capabilities. */
export interface PipelineJournal {
  readonly scope: PipelineScope;
  readonly sources: readonly PipelineSourceJournal[];
  readonly snapshots: readonly PipelineSnapshot[];
  readonly operatorExclusion: { readonly userId: null; readonly code: 'operator-obligation-domain-unsupported' };
}
function requireExact(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Pipeline journal: ${reason}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  requireExact(record(value), 'only inert JSON values are allowed');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function equal(actual: unknown, expected: unknown, reason: string): void {
  requireExact(canonicalJson(actual) === canonicalJson(expected), reason);
}
const UNIT = 10n ** 18n;
function units(value: string): bigint {
  const text = workerQuantity(value);
  const [whole = '', fraction = ''] = text.split('.');
  requireExact(fraction.length <= 18 && text === value, 'canonical exact decimal with at most 18 places required');
  return BigInt(whole) * UNIT + BigInt(fraction.padEnd(18, '0'));
}
function decimal(value: bigint): string {
  requireExact(value >= 0n, 'negative projection');
  return workerQuantity(`${value / UNIT}.${(value % UNIT).toString().padStart(18, '0')}`);
}
function money(value: string): bigint {
  requireExact(workerMoney(value) === value, 'canonical exact money required');
  return units(value);
}
function remainingBasis(basis: bigint, remaining: bigint, acquired: bigint): bigint {
  requireExact(acquired > 0n && basis * remaining % acquired === 0n, 'scoped scenario requires exactly representable basis, not rounded floats');
  return basis * remaining / acquired;
}
function one<T>(rows: readonly T[], predicate: (row: T) => boolean, reason: string): T {
  const found = rows.filter(predicate);
  requireExact(found.length === 1, reason);
  return found[0]!;
}
function fillDigest(fill: PipelineOriginalFill): string {
  // Production snapshot order is significant to its SHA-256 digest.
  return workerOriginalEvidenceDigest({ id: fill.id, executionId: fill.executionId, userId: fill.userId,
    sourceTradeId: fill.sourceTradeId, evidenceType: fill.evidenceType, evidenceId: fill.evidenceId,
    baseQuantity: fill.baseQuantity, quoteQuantity: fill.quoteQuantity, quoteNativeQuantity: fill.quoteNativeQuantity,
    quoteCurrency: fill.quoteCurrency, quoteNativeUsdPrice: fill.quoteNativeUsdPrice, priceUsd: fill.priceUsd,
    feeUsd: fill.feeUsd, occurredAt: fill.occurredAt, completesExecution: fill.completesExecution });
}
function financialDigest(receipt: PipelineFinancialReceipt): string {
  const s = receipt.snapshot, t = s.totals;
  return createHash('sha256').update(JSON.stringify({ executionId: s.executionId, userId: s.userId, tradeId: s.tradeId,
    fence: s.fence, totals: { base: t.base, quote: t.quote, debit: t.debit, fee: t.fee, unknown: t.unknown,
      quoteUnknown: t.quoteUnknown, completes: t.completes, evidenceCount: t.evidenceCount }, accountingComplete: s.accountingComplete })).digest('hex');
}

/** INTERNAL qualification reconciliation, not a protected execution API.
 * Compares every declared row/identity/economic field against an independently
 * specified exact journal, then cross-reconciles durable links and projections.
 * Cardinality is only a uniqueness guard, never evidence of financial success.
 * Deliberately scoped to one owned lot, one buy/sell fill and one full correction;
 * arbitrary partial fills/unknown economics/correction chains are not qualified. */
export function requireExactPipelineJournal(actual: PipelineJournal, expected: PipelineJournal) {
  equal(actual, expected, 'exact durable scenario differs (identity, receipt, economics, history or extra row)');
  const scope = actual.scope;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  requireExact(uuid.test(scope.runId) && uuid.test(scope.userId) && scope.chain === 'solana'
    && scope.network === `solana:wave4-${scope.runId}` && [scope.targetAccount, scope.masterWalletAddress, scope.tokenMint]
      .every(value => value.startsWith('solana:') && value.length > 'solana:'.length && value.trim() === value), 'run-bound owned paper scope required');
  equal(actual.operatorExclusion, { userId: null, code: 'operator-obligation-domain-unsupported' }, 'explicit unsupported operator exclusion required');
  equal(actual.snapshots.map(s => s.stage), ['buy', 'sell', 'reversal', 'correction', 'replay'], 'complete ordered scoped scenario required');
  const buySource = one(actual.sources, s => s.binding.side === 'buy', 'one exact buy source required');
  const sellSource = one(actual.sources, s => s.binding.side === 'sell', 'one exact sell source required');
  requireExact(actual.sources.length === 2 && buySource.sourceTradeId !== sellSource.sourceTradeId, 'distinct source identities required');
  for (const source of actual.sources) {
    const binding = canonicalSourceBinding(source.binding);
    requireExact(binding.network === scope.network && binding.chain === scope.chain && binding.walletAddress === scope.masterWalletAddress
      && binding.tokenMint === scope.tokenMint && sourceBindingDigest(binding) === source.bindingDigest, 'immutable source scope/digest mismatch');
    equal(source.binding, binding, 'stored source binding must be canonical, not normalized into authority');
    equal(source.evidenceDigests, source.evidence.map(sourceEvidenceDigest), 'exact source evidence digests required');
    for (const evidence of source.evidence) {
      requireExact(sourceBindingDigest(evidence.binding) === source.bindingDigest, 'source evidence binding changed');
    }
    requireExact(source.evidence[0]?.finality === 'confirmed', 'source starts with accepted confirmation snapshot');
  }
  requireExact(buySource.evidence.length === 1 && sellSource.evidence.length === 2, 'scoped accepted/reversal history required');
  const reversal = sellSource.evidence[1]!;
  requireExact(reversal.finality === 'reversed' && reversal.reversesEvidenceId === sellSource.evidence[0]!.evidenceId
    && BigInt(reversal.revision) > BigInt(sellSource.evidence[0]!.revision), 'exact current-head reversal required');
  let previous: PipelineSnapshot | undefined;
  for (const snapshot of actual.snapshots) {
    const initial = snapshot.stage === 'buy', reversed = ['reversal', 'correction', 'replay'].includes(snapshot.stage);
    const corrected = snapshot.stage === 'correction' || snapshot.stage === 'replay';
    equal(snapshot.sourceHeads, [
      { sourceTradeId: buySource.sourceTradeId, evidenceId: buySource.evidence[0]!.evidenceId, confirmationState: 'confirmed', applicationActive: true },
      ...initial ? [] : [{ sourceTradeId: sellSource.sourceTradeId, evidenceId: sellSource.evidence[reversed ? 1 : 0]!.evidenceId,
        confirmationState: reversed ? 'reversed' : 'confirmed', applicationActive: !reversed }]
    ], 'source head/application reversal does not match evidence');
    const sourceBuy = units(sourceTokenQuantity(buySource.binding.rawQuantity, buySource.binding.quantityScale));
    const sourceSell = initial || reversed ? 0n : units(sourceTokenQuantity(sellSource.binding.rawQuantity, sellSource.binding.quantityScale));
    requireExact(buySource.binding.amountUsd !== null, 'offline scenario needs complete source basis');
    const sourceRemaining = sourceBuy > sourceSell ? sourceBuy - sourceSell : 0n;
    equal(snapshot.sourcePosition, { quantity: decimal(sourceRemaining), costBasisUsd: decimal(remainingBasis(money(buySource.binding.amountUsd), sourceRemaining, sourceBuy)),
      unmatchedReductionQuantity: decimal(sourceSell > sourceBuy ? sourceSell - sourceBuy : 0n) }, 'exact source projection required');
    requireExact(snapshot.executions.length === (initial ? 1 : 2) && snapshot.originalEvidence.length === snapshot.executions.length
      && snapshot.effectiveEvidence.length === snapshot.executions.length && snapshot.applications.length === snapshot.executions.length
      && snapshot.deliveries.length === snapshot.executions.length && snapshot.attempts.length === snapshot.executions.length
      && snapshot.trades.length === snapshot.executions.length && snapshot.capacity.length === snapshot.executions.length, 'unexpected or missing scoped durable row');
    equal(snapshot.executions.map(e => e.sourceTradeId), initial ? [buySource.sourceTradeId]
      : [buySource.sourceTradeId, sellSource.sourceTradeId], 'one buy and one sell obligation required');
    requireExact(new Set(snapshot.executions.map(e => e.id)).size === snapshot.executions.length
      && new Set(snapshot.executions.map(e => e.signalId)).size === snapshot.executions.length
      && new Set(snapshot.originalEvidence.map(e => e.id)).size === snapshot.originalEvidence.length
      && new Set(snapshot.originalEvidence.map(e => e.evidenceId)).size === snapshot.originalEvidence.length
      && new Set(snapshot.trades.map(t => t.id)).size === snapshot.trades.length, 'durable identities must not alias');
    requireExact(snapshot.position.userId === scope.userId && snapshot.position.targetAccount === scope.targetAccount
      && snapshot.position.chain === scope.chain && snapshot.position.tokenMint === scope.tokenMint, 'owned position scope mismatch');
    let quantity = 0n, basis = 0n;
    for (const execution of snapshot.executions) {
      requireExact(execution.userId === scope.userId && execution.targetAccount === scope.targetAccount && execution.tokenMint === scope.tokenMint
        && execution.chain === scope.chain && execution.masterWalletAddress === scope.masterWalletAddress
        && execution.executionMode === 'paper' && execution.state === 'confirmed', 'owned paper execution required');
      requireExact(execution.sourceTradeId === (execution.direction === 'buy' ? buySource : sellSource).sourceTradeId, 'execution source lineage mismatch');
      const original = one(snapshot.originalEvidence, e => e.executionId === execution.id, 'exact original evidence required');
      requireExact(original.userId === scope.userId && original.sourceTradeId === execution.sourceTradeId && original.completesExecution
        && original.baseQuantity === execution.confirmedBaseQuantity && original.baseQuantity === execution.requestedBaseQuantity
        && new Date(original.occurredAt).toISOString() === original.occurredAt, 'original receipt immutable scope/quantity mismatch');
      const effective = one(snapshot.effectiveEvidence, e => e.originalEvidenceId === original.id, 'effective receipt required');
      requireExact(effective.executionId === execution.id && effective.baseQuantity === original.baseQuantity
        && effective.confirmationState === 'confirmed' && effective.quoteUsd === execution.confirmedQuoteQuantity, 'effective evidence cannot change inventory or execution scope');
      const correction = snapshot.corrections.find(c => c.originalEvidenceId === original.id);
      if (correction) {
        requireExact(corrected && execution.direction === 'buy' && correction.authorized === true && correction.userId === scope.userId
          && correction.executionId === execution.id && correction.previousCorrectionId === null && /^[1-9]\d*$/.test(correction.revision)
          && correction.lineageSourceTradeId === buySource.sourceTradeId && correction.lineageAcquisitionEvidenceId === null
          && correction.lineageMasterWalletAddress === scope.masterWalletAddress && correction.sourceEvidenceId === buySource.evidence[0]!.evidenceId
          && correction.quoteOriginValuationId === correction.valuationId && correction.feeOriginValuationId === correction.valuationId
          && correction.originalDigest === fillDigest(original), 'persisted correction original/valuation/source lineage mismatch');
        equal(correction.originalSnapshot, original, 'correction mutated original receipt');
        equal([effective.correctionId, effective.quoteUsd, effective.feeUsd], [correction.correctionId, correction.effectiveQuoteUsd, correction.effectiveFeeUsd], 'effective correction terms mismatch');
      } else equal([effective.correctionId, effective.quoteUsd, effective.feeUsd], [null, original.quoteQuantity, original.feeUsd], 'uncorrected receipt economics changed');
      const application = one(snapshot.applications, a => a.evidenceId === original.id, 'one exact application required');
      equal(application, { evidenceId: original.id, executionId: execution.id, positionId: snapshot.position.id, userId: scope.userId,
        targetAccount: scope.targetAccount, chain: scope.chain, tokenMint: scope.tokenMint, active: true }, 'follower application scope changed or falsely undone by source reversal');
      const delivery = one(snapshot.deliveries, d => d.executionId === execution.id, 'durable delivery required');
      equal(delivery.descriptor, { copyExecutionId: execution.id, signalId: execution.signalId, sourceTradeId: execution.sourceTradeId,
        userId: scope.userId, chain: scope.chain, tokenMint: scope.tokenMint, targetAccount: scope.targetAccount,
        masterWalletAddress: scope.masterWalletAddress, executionMode: 'paper', direction: execution.direction,
        requestedBaseQuantity: execution.requestedBaseQuantity, requestedQuoteQuantity: execution.requestedQuoteQuantity,
        exitLotId: null, score: delivery.descriptor.score }, 'persisted descriptor terms mismatch');
      requireExact(Number.isSafeInteger(delivery.descriptor.score) && delivery.descriptor.score >= 0
        && delivery.descriptor.score <= 100, 'persisted entry score required');
      requireExact(delivery.signalId === execution.signalId && delivery.sourceTradeId === execution.sourceTradeId && delivery.userId === scope.userId
        && delivery.targetAccount === scope.targetAccount && delivery.executionMode === 'paper' && delivery.state === 'completed'
        && delivery.jobId === `source-trade-${execution.signalId}-u-${scope.userId}`, 'durable delivery identity mismatch');
      const attempt = one(snapshot.attempts, a => a.executionId === execution.id, 'worker attempt required');
      requireExact(attempt.userId === scope.userId && attempt.state === 'settled' && /^[1-9]\d*$/.test(attempt.fence)
        && attempt.fence === delivery.fence && attempt.policyRevision.length > 0, 'worker fence/policy mismatch');
      const trade = one(snapshot.trades, t => t.executionId === execution.id, 'durable trade required');
      equal(trade, { id: trade.id, executionId: execution.id, userId: scope.userId, direction: execution.direction, executionMode: 'paper',
        tokenAmount: original.baseQuantity, amountUsd: effective.quoteUsd, feeUsd: effective.feeUsd, status: 'filled' }, 'trade economics mismatch');
      const receipts = snapshot.financialReceipts.filter(r => r.snapshot.executionId === execution.id);
      const receipt = receipts[receipts.length - 1];
      requireExact(receipt && receipt.receiptId === financialDigest(receipt), 'exact latest financial receipt hash required');
      equal(receipt.snapshot, { executionId: execution.id, userId: scope.userId, tradeId: trade.id, fence: attempt.fence,
        totals: { base: original.baseQuantity, quote: effective.quoteUsd, debit: decimal(money(effective.quoteUsd) + money(effective.feeUsd)),
          fee: effective.feeUsd, unknown: '0', quoteUnknown: '0', completes: true, evidenceCount: '1' }, accountingComplete: true }, 'receipt totals/fence/ownership mismatch');
      const capacity = one(snapshot.capacity, c => c.sourceTradeId === execution.sourceTradeId, 'exact capacity cohort required');
      equal(capacity, { sourceTradeId: execution.sourceTradeId, executionMode: 'paper', notionalUsd: effective.quoteUsd }, 'capacity notional mismatch');
      const base = units(original.baseQuantity);
      requireExact(base > 0n && original.evidenceType === 'paper_simulation' && original.quoteCurrency === 'USD'
        && original.quoteNativeQuantity === null && original.quoteNativeUsdPrice === null && original.priceUsd === null,
        'scoped USD paper receipt requires positive exact base and no inferred native conversion');
      if (original.quoteQuantity !== null) money(original.quoteQuantity);
      if (original.feeUsd !== null) money(original.feeUsd);
      if (execution.requestedQuoteQuantity !== null) requireExact(money(execution.requestedQuoteQuantity) > 0n, 'positive exact requested quote required');
      if (execution.direction === 'buy') {
        const risk = one(snapshot.risk, r => r.executionId === execution.id, 'buy durable risk required');
        equal(risk, { executionId: execution.id, userId: scope.userId, policyEpoch: attempt.riskEpoch, state: 'confirmed', confirmedUsd: receipt.snapshot.totals.debit }, 'buy risk debit/epoch mismatch');
        quantity += base; basis += money(effective.quoteUsd) + money(effective.feeUsd);
      } else {
        requireExact(base <= quantity && attempt.riskEpoch === null, 'sell cannot invent inventory/risk scope');
        basis = remainingBasis(basis, quantity - base, quantity); quantity -= base;
      }
    }
    requireExact(snapshot.executions[0]?.direction === 'buy' && (initial || snapshot.executions[1]?.direction === 'sell')
      && snapshot.risk.length === 1 && snapshot.corrections.length === (corrected ? 1 : 0), 'scoped buy/sell/correction order required');
    equal([snapshot.position.quantity, snapshot.position.costBasisUsd], [decimal(quantity), decimal(basis)], 'exact follower quantity/basis mismatch');
    const buy = snapshot.executions[0]!, originalBuy = snapshot.originalEvidence[0]!;
    requireExact(snapshot.lots.length === 1, 'one owned acquisition lot required');
    const lot = snapshot.lots[0]!;
    equal(lot, { id: lot.id, positionId: snapshot.position.id, userId: scope.userId, masterWalletAddress: scope.masterWalletAddress,
      acquisitionExecutionId: buy.id, acquisitionEvidenceId: originalBuy.id, acquisitionSourceTradeId: buySource.sourceTradeId, acquisitionMode: 'paper',
      acquiredQuantity: originalBuy.baseQuantity, remainingQuantity: decimal(quantity),
      acquiredCostBasisUsd: decimal(money(snapshot.effectiveEvidence[0]!.quoteUsd) + money(snapshot.effectiveEvidence[0]!.feeUsd)), remainingCostBasisUsd: decimal(basis) }, 'owned lot exact acquisition/basis mismatch');
    if (initial) equal([snapshot.allocations, snapshot.reductions], [[], []], 'buy cannot contain sell consumption');
    else {
      const sell = snapshot.executions[1]!, originalSell = snapshot.originalEvidence[1]!;
      equal(snapshot.allocations, [{ executionId: sell.id, lotId: lot.id, userId: scope.userId, masterWalletAddress: scope.masterWalletAddress,
        acquisitionExecutionId: buy.id, acquisitionEvidenceId: originalBuy.id, acquisitionSourceTradeId: buySource.sourceTradeId,
        requestedQuantity: sell.requestedBaseQuantity }], 'sell exact owned acquisition allocation mismatch');
      equal(snapshot.reductions, [{ executionId: sell.id, evidenceId: originalSell.id, lotId: lot.id, userId: scope.userId,
        quantity: originalSell.baseQuantity }], 'sell exact lot consumption mismatch');
    }
    for (const receipt of snapshot.financialReceipts) requireExact(receipt.receiptId === financialDigest(receipt)
      && snapshot.executions.some(e => e.id === receipt.snapshot.executionId && e.userId === receipt.snapshot.userId), 'historical receipt identity/hash mismatch');
    requireExact(new Set(snapshot.financialReceipts.map(r => r.receiptId)).size === snapshot.financialReceipts.length, 'duplicate financial receipt');
    if (previous) {
      equal(snapshot.originalEvidence.slice(0, previous.originalEvidence.length), previous.originalEvidence, 'original fills mutated across stages');
      equal(snapshot.financialReceipts.slice(0, previous.financialReceipts.length), previous.financialReceipts, 'financial receipt history mutated');
      if (reversed) equal([snapshot.applications, snapshot.attempts, snapshot.allocations, snapshot.reductions],
        [previous.applications, previous.attempts, previous.allocations, previous.reductions], 'reversal/correction/replay changed inventory, ownership or worker fence');
      if (snapshot.stage === 'reversal') equal({ ...snapshot, stage: previous.stage,
        sourceHeads: previous.sourceHeads, sourcePosition: previous.sourcePosition }, previous,
        'source reversal cannot erase or rewrite an independently settled follower effect');
      if (snapshot.stage === 'correction') {
        equal(snapshot.deliveries, previous.deliveries, 'economic correction changed committed queue comparison terms');
        equal(snapshot.executions.map(e => ({ ...e, confirmedQuoteQuantity: '' })),
          previous.executions.map(e => ({ ...e, confirmedQuoteQuantity: '' })), 'economic correction changed immutable execution scope');
      }
      if (snapshot.stage === 'replay') equal({ ...snapshot, stage: previous.stage }, previous, 'replay must have no durable changes');
    }
    requireExact(snapshot.financialReceipts.length === (initial ? 1 : corrected ? 3 : 2), 'exact append-only scoped financial history required');
    previous = snapshot;
  }
  return { sourceOnly: true as const, runtimeAccepted: false as const, liveCapabilityAccepted: false as const,
    stages: actual.snapshots.map(s => s.stage), exactJournalDigest: createHash('sha256').update(canonicalJson(actual)).digest('hex'),
    finalSourcePosition: actual.snapshots[4]!.sourcePosition, finalFollowerPosition: actual.snapshots[4]!.position };
}
