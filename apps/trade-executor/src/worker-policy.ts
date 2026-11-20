import type { PoolClient } from 'pg';
import type { Chain, ExecutionMode } from '@swat/shared';
import { claimLotExitExecutionWithClient, normalizeTenantId,
  type CopyExecutionRecord, type RecordCopyExecutionEvidenceInput } from '@swat/db/dist/copy-trade-lifecycle-owned.js';
import { assertLotExitExecutionMatches } from '@swat/db/dist/lot-allocation.js';
import { readWorkerExecutionContextWithClient, prepareWorkerAttemptWithClient, markWorkerAttemptDispatchedWithClient,
  type WorkerExecutionContext, type WorkerAttempt } from '@swat/db/dist/worker-execution.js';
import { readCapturedWorkerPolicyWithClient, readCurrentWorkerPolicyWithClient,
  type WorkerPolicySnapshot } from '@swat/db/dist/worker-policy.js';
import { settleWorkerFillWithClient, retainWorkerUncertaintyWithClient } from '@swat/db/dist/worker-settlement.js';
import { reserveRiskSpend, updateRiskSpendReservation, type RiskSpendScope } from '@swat/db/dist/risk-spend-owned.js';
import { claimFanoutDelivery, settleFanoutDelivery,
  type FanoutDeliveryClaim, type FanoutDeliveryRow } from '@swat/db/dist/package13-fanout-delivery.js';
import { assertCanonicalFanoutDescriptor } from '@swat/db/dist/fanout-worker-descriptor.js';
import { evaluateExecutionPolicy } from './policy.js';
import type { ExecutionAuthorityResolver, GrantedExecutionAuthority } from './execution-authority.js';
function authorityTerms(authority: GrantedExecutionAuthority): string {
  return JSON.stringify([authority.adapterId, authority.chain, authority.principal, authority.settlementAddress,
    authority.signingAddress, [...authority.capabilities].sort(), authority.expiresAt?.toISOString() ?? null]);
}
async function currentAuthority(ports: CanonicalWorkerPorts, execution: CopyExecutionRecord) {
  const verdict = await ports.authorize({ chain: execution.chain,
    principal: execution.userId ? { kind: 'user', userId: execution.userId } : { kind: 'operator' },
    action: 'venue-trade', direction: execution.direction, instrument: execution.tokenMint.slice(execution.chain.length + 1) });
  if (verdict.kind === 'denied') return { reason: `Execution authority denied [${verdict.code}]: ${verdict.reason}` };
  const grant = verdict.authority, settlement = grant.settlementAddress;
  if (grant.chain !== execution.chain || (execution.userId ? grant.principal.kind !== 'user'
    || grant.principal.userId !== execution.userId : grant.principal.kind !== 'operator')
    || (settlement.startsWith(`${execution.chain}:`) ? settlement : `${execution.chain}:${settlement}`) !== execution.targetAccount
    || (grant.expiresAt !== null && (!Number.isFinite(grant.expiresAt.getTime()) || grant.expiresAt.getTime() <= Date.now()))) {
    return { reason: 'execution-authority-identity-expired-or-mismatched' };
  }
  return { terms: authorityTerms(grant) };
}

export interface CanonicalWorkerJob {
  readonly copyExecutionId: string;
  readonly signalId: string;
  readonly userId: string | null;
  readonly chain: Chain;
  readonly tokenMint: string;
  readonly direction: 'buy' | 'sell';
  readonly targetAccount: string;
  readonly masterWalletAddress: string;
  readonly executionMode: CopyExecutionRecord['executionMode'];
  readonly requestedBaseQuantity: string | null;
  readonly requestedQuoteQuantity: string | null;
  readonly sourceTradeId: string | null;
  readonly exitLotId: string | null;
  readonly score: unknown;
}
export interface CanonicalWorkerIntent {
  readonly execution: CopyExecutionRecord;
  readonly attempt: WorkerAttempt;
  readonly maxSlippageBps: number;
  readonly risk: RiskSpendScope | null;
}
export type CanonicalWorkerOutcome =
  | { readonly kind: 'fill'; readonly executor: string; readonly evidence: RecordCopyExecutionEvidenceInput }
  | { readonly kind: 'unknown'; readonly reason: string };
export interface CanonicalWorkerQuote {
  /** Explicit adapter capability, never a queue boolean or environment opt-in. */
  readonly requestedDebitUsd: string | null;
  readonly execute: (intent: CanonicalWorkerIntent) => Promise<CanonicalWorkerOutcome>;
}
export interface CanonicalWorkerPorts {
  readonly transaction: <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
  readonly authorize: ExecutionAuthorityResolver;
  readonly platformMode: (chain: Chain) => Promise<ExecutionMode>;
  readonly quote: (execution: CopyExecutionRecord, maxSlippageBps: number) => Promise<CanonicalWorkerQuote | null>;
  readonly deliveryOwner?: string;
  readonly now?: () => Date;
  readonly deliveryLeaseMs?: number;
}
const blocked = (reason: string) => ({ status: 'skipped', reason });

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 256) throw new Error(`Canonical worker ${name} unavailable`);
  return value;
}

/** Queue terms are an immutable comparison target, NEVER inventory/policy proof. */
export function parseCanonicalWorkerJob(data: unknown): CanonicalWorkerJob {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Canonical worker job unavailable');
  const value = data as Record<string, unknown>;
  const tokenMint = text(value.tokenMint, 'tokenMint');
  const chain = tokenMint.split(':')[0] as Chain;
  const userId = value.userId === undefined || value.userId === null ? null : normalizeTenantId(text(value.userId, 'userId'));
  const executionMode = value.acquisitionExecutionMode ?? value.executionMode;
  if (!['paper','live','shadow'].includes(String(executionMode)) || !['buy','sell'].includes(String(value.direction))) {
    throw new Error('Canonical worker acquisition mode/direction unavailable');
  }
  const quantity = value.requestedBaseQuantity === undefined || value.requestedBaseQuantity === null
    ? null : text(value.requestedBaseQuantity, 'requestedBaseQuantity');
  const quote = value.requestedQuoteQuantity === undefined || value.requestedQuoteQuantity === null
    ? null : text(value.requestedQuoteQuantity, 'requestedQuoteQuantity');
  return { copyExecutionId: text(value.copyExecutionId, 'copyExecutionId'), signalId: text(value.signalId, 'signalId'),
    userId, chain, tokenMint, direction: value.direction as 'buy' | 'sell',
    targetAccount: text(value.targetAccount, 'targetAccount'), masterWalletAddress: text(value.masterWalletAddress, 'masterWalletAddress'),
    executionMode: executionMode as CopyExecutionRecord['executionMode'], requestedBaseQuantity: quantity, requestedQuoteQuantity: quote,
    sourceTradeId: value.sourceTradeId ? text(value.sourceTradeId, 'sourceTradeId') : null,
    exitLotId: value.exitLotId ? text(value.exitLotId, 'exitLotId') : null, score: value.score };
}

function assertJobMatches(job: CanonicalWorkerJob, context: WorkerExecutionContext): void {
  const execution = context.execution;
  if (job.copyExecutionId !== execution.id || job.userId !== execution.userId || job.signalId !== execution.signalId
    || job.chain !== execution.chain || job.tokenMint !== execution.tokenMint || job.direction !== execution.direction
    || job.targetAccount !== execution.targetAccount || job.masterWalletAddress !== context.masterWalletAddress
    || job.executionMode !== execution.executionMode || job.sourceTradeId !== execution.sourceTradeId
    || job.exitLotId !== (execution.exitLotId ?? null) || job.requestedQuoteQuantity !== execution.requestedQuoteQuantity) {
    throw new Error('Canonical worker job immutable execution scope mismatch');
  }
  if (execution.exitLotId && execution.exitTrigger) {
    assertLotExitExecutionMatches(execution, { ...job, exitLotId: execution.exitLotId,
      acquisitionExecutionMode: job.executionMode, requestedBaseQuantity: job.requestedBaseQuantity ?? '' }, execution.exitTrigger);
  } else if (job.requestedBaseQuantity !== execution.requestedBaseQuantity) throw new Error('Canonical worker exact quantity mismatch');
}
function verdict(context: WorkerExecutionContext, queued: WorkerPolicySnapshot | null, current: Awaited<ReturnType<typeof readCurrentWorkerPolicyWithClient>>,
  platformMode: ExecutionMode, score: unknown) {
  const scope = { account: context.execution.userId ?? 'operator', chain: context.execution.chain,
    tokenMint: context.execution.tokenMint, masterWalletAddress: context.masterWalletAddress };
  const dbMode = current?.platformMode;
  const permittedPlatformMode: ExecutionMode = dbMode === 'off' ? 'off'
    : dbMode === 'paper' || platformMode === 'paper' ? 'paper' : platformMode;
  const policyInput = { scope, direction: context.execution.direction, score,
    minimumScore: current?.minimumScore ?? 100, platformMode: permittedPlatformMode, queued, current: current?.snapshot ?? null };
  const proof = context.sourceSellLots;
  if (proof) {
    if (context.ownedExit || context.execution.direction !== 'sell' || proof.executionId !== context.execution.id
      || proof.userId !== context.execution.userId || proof.targetAccount !== context.execution.targetAccount
      || proof.chain !== context.execution.chain || proof.tokenMint !== context.execution.tokenMint
      || proof.masterWalletAddress !== context.masterWalletAddress || proof.requestedQuantity !== context.execution.requestedBaseQuantity
      || !proof.lots.length) return { allowed: false as const, reason: 'source-sell-lot-proof-scope-mismatch' };
    let maxSlippageBps = 5000;
    let executionMode: ExecutionMode | null = null;
    for (const lot of proof.lots) {
      const decision = evaluateExecutionPolicy({ ...policyInput, ownedExit: { scope, lotId: lot.lotId,
        availableQuantity: lot.availableQuantity, requestedQuantity: lot.quantity,
        acquisitionMode: lot.acquisitionMode, maxSlippageBps: lot.maxSlippageBps } });
      if (!decision.allowed) return decision;
      if (executionMode && executionMode !== decision.executionMode) return { allowed: false as const, reason: 'source-sell-lot-acquisition-mode-mixed' };
      executionMode = decision.executionMode; maxSlippageBps = Math.min(maxSlippageBps, decision.maxSlippageBps);
    }
    return { allowed: true as const, executionMode: executionMode!, maxSlippageBps, reducing: true };
  }
  return evaluateExecutionPolicy({ ...policyInput, ownedExit: context.ownedExit ? { ...context.ownedExit, scope } : null });
}

/** Joined canonical entrypoint, two short DB transactions around an inert quote
 * and an external effect. Durable fence/risk epoch commits BEFORE execute. A
 * failed final transaction throws before the BullMQ processor can acknowledge. */
export async function runCanonicalWorkerJob(data: unknown, ports: CanonicalWorkerPorts): Promise<{
  status: string; reason?: string; state?: string; signalId?: string;
}> {
  const job = parseCanonicalWorkerJob(data);
  async function persistedEntryScore(client: PoolClient, execution: CopyExecutionRecord): Promise<unknown> {
    if (execution.direction !== 'buy') return job.score;
    const result = await client.query<FanoutDeliveryRow>(`SELECT *,fence::text AS fence FROM source_fanout_deliveries
      WHERE execution_id = $1 AND signal_id = $2 AND user_id IS NOT DISTINCT FROM $3
        AND execution_mode = $4 AND target_account = $5 FOR SHARE`,
    [execution.id, execution.signalId, execution.userId, execution.executionMode, execution.targetAccount]);
    const row = result.rows[0], score = (row?.descriptor?.data as Record<string, unknown> | undefined)?.score;
    if (result.rows.length !== 1 || !row || !execution.signalId || !execution.sourceTradeId
      || assertCanonicalFanoutDescriptor(row.descriptor, { signalId: execution.signalId, userId: execution.userId,
        executionMode: execution.executionMode, targetAccount: execution.targetAccount,
        sourceTradeId: execution.sourceTradeId, chain: execution.chain, jobId: row.job_id }) !== execution.id
      || (typeof score !== 'number' && typeof score !== 'string') || score !== job.score) {
      throw new Error('Canonical worker persisted entry score/obligation mismatch');
    }
    return score;
  }
  const platformMode = await ports.platformMode(job.chain);
  const admitted = await ports.transaction(async client => {
    const context = await readWorkerExecutionContextWithClient(client, job.copyExecutionId);
    if (!context) return { reason: 'owned-execution-context-unavailable' } as const;
    assertJobMatches(job, context);
    const execution = context.execution;
    if (execution.state === 'confirmed') {
      const accounting = await client.query<{ complete: boolean }>(`SELECT
        EXISTS (SELECT 1 FROM copy_execution_evidence WHERE execution_id = $1
          AND confirmation_state IN ('confirmed','finalized') AND completes_execution)
        AND NOT EXISTS (SELECT 1 FROM copy_execution_evidence WHERE execution_id = $1
          AND confirmation_state IN ('confirmed','finalized') AND (quote_quantity IS NULL OR fee_usd IS NULL)) AS complete`, [execution.id]);
      if (accounting.rows[0]?.complete !== true) return { pending: 'reconciliation_required' } as const;
      return { terminal: execution.state } as const;
    }
    if (['failed','cancelled'].includes(execution.state)) return { terminal: execution.state } as const;
    if (!['requested','simulated'].includes(execution.state)) return { pending: execution.state } as const;
    // Rejoin the scorer's deterministic canonical claim. No new request identity
    // is accepted from queued booleans, so a foreign claim cannot be substituted.
    if (execution.exitLotId && execution.exitTrigger) {
      const requestId = execution.exitTrigger === 'close-all'
        ? `close-all-${execution.userId}-${execution.exitLotId}`
        : execution.exitTrigger === 'stop-loss'
          ? `stop-loss-${execution.userId ?? 'operator'}-${execution.signalId}-${execution.exitLotId}` : null;
      if (!requestId) return { reason: 'lot-exit-trigger-contract-unavailable' } as const;
      const claim = await claimLotExitExecutionWithClient(client, { lotId: execution.exitLotId,
        userId: execution.userId, requestId, trigger: execution.exitTrigger,
        requestedBaseQuantity: execution.requestedBaseQuantity ?? undefined });
      if (claim.execution.id !== execution.id || claim.created) throw new Error('Canonical worker exit does not match scorer claim');
    }
    const queued = await readCapturedWorkerPolicyWithClient(client, execution, context.masterWalletAddress);
    const current = await readCurrentWorkerPolicyWithClient(client, { ...execution, masterWalletAddress: context.masterWalletAddress });
    const score = await persistedEntryScore(client, execution);
    const decision = verdict(context, queued, current, platformMode, score);
    if (!decision.allowed) return { reason: decision.reason } as const;
    if (decision.executionMode !== execution.executionMode) return { reason: 'immutable-execution-mode-not-permitted' } as const;
    return { context, queued, revision: current!.snapshot.revision, maxSlippageBps: decision.maxSlippageBps } as const;
  });
  if ('reason' in admitted) return blocked(admitted.reason!);
  if ('terminal' in admitted && admitted.terminal) return { status: admitted.terminal === 'confirmed' ? 'already-executed' : admitted.terminal };
  if ('pending' in admitted && admitted.pending) return { status: 'submitted', state: admitted.pending };
  if (!admitted.context) return blocked('owned-execution-context-unavailable');
  const execution = admitted.context.execution;
  let authorizedTerms: string | null = null;
  if (execution.executionMode === 'live') {
    const authority = await currentAuthority(ports, execution);
    if ('reason' in authority) return blocked(authority.reason!);
    authorizedTerms = authority.terms!;
  }
  const quote = await ports.quote(execution, admitted.maxSlippageBps);
  if (!quote) return blocked(execution.executionMode === 'live' ? 'canonical-live-receipt-adapter-unavailable' : 'trusted-paper-valuation-unavailable');
  const preEffect = await ports.transaction(async client => {
    const context = await readWorkerExecutionContextWithClient(client, execution.id);
    if (!context) throw new Error('Canonical pre-effect ownership unavailable');
    assertJobMatches(job, context);
    const current = await readCurrentWorkerPolicyWithClient(client, { ...execution, masterWalletAddress: context.masterWalletAddress });
    const freshPlatform = await ports.platformMode(execution.chain);
    const score = await persistedEntryScore(client, execution);
    const decision = verdict(context, admitted.queued, current, freshPlatform, score);
    if (!decision.allowed || current?.snapshot.revision !== admitted.revision
      || decision.executionMode !== execution.executionMode || decision.maxSlippageBps !== admitted.maxSlippageBps) {
      return { reason: decision.allowed ? 'pre-effect-policy-changed' : decision.reason } as const;
    }
    if (execution.executionMode === 'live') {
      const freshAuthority = await currentAuthority(ports, execution);
      if ('reason' in freshAuthority || freshAuthority.terms !== authorizedTerms) return { reason: 'pre-effect-authority-changed-or-unavailable' } as const;
    }
    let delivery: { claim: FanoutDeliveryClaim; now: Date } | undefined;
    let risk: RiskSpendScope | null = null;
    if (execution.direction === 'buy' && !quote.requestedDebitUsd) return { reason: 'trusted-risk-valuation-unavailable' } as const;
    if (execution.sourceTradeId) {
      if (!ports.deliveryOwner || !ports.now || !ports.deliveryLeaseMs || !execution.signalId) {
        return { reason: 'durable-fanout-worker-claim-capability-unavailable' } as const;
      }
      const identity = { signalId: execution.signalId, userId: execution.userId,
        executionMode: execution.executionMode, targetAccount: execution.targetAccount };
      const rows = await client.query<FanoutDeliveryRow>(`SELECT *,fence::text AS fence FROM source_fanout_deliveries
        WHERE signal_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND execution_mode = $3 AND target_account = $4 FOR UPDATE`,
      [identity.signalId, identity.userId, identity.executionMode, identity.targetAccount]);
      const row = rows.rows[0];
      if (!row || row.execution_id !== execution.id || assertCanonicalFanoutDescriptor(row.descriptor,
        { ...identity, sourceTradeId: execution.sourceTradeId, chain: execution.chain, jobId: row.job_id }) !== execution.id) {
        throw new Error('Persisted fanout worker obligation execution mismatch');
      }
      const now = ports.now();
      const claim = await claimFanoutDelivery(client, identity, { owner: ports.deliveryOwner, now, leaseMs: ports.deliveryLeaseMs,
        admission: async sameClient => {
          if (sameClient !== client) throw new Error('Fanout pre-effect admission must use same client');
          const freshContext = await readWorkerExecutionContextWithClient(sameClient, execution.id);
          if (!freshContext) return { allowed: false, reason: 'fanout-pre-effect-source-context-unavailable' };
          assertJobMatches(job, freshContext);
          return verdict(freshContext, admitted.queued, current, freshPlatform, score);
        } });
      if (!claim) return { reason: 'fanout-delivery-already-claimed-or-reconciliation-required' } as const;
      delivery = { claim, now };
    }
    if (execution.direction === 'buy') {
      const control = await client.query<{ epoch: string }>(`SELECT epoch::text FROM risk_policy_control
        WHERE account = $1 AND chain = $2 AND execution_mode = $3 FOR UPDATE`,
      [execution.userId ?? 'operator', execution.chain, execution.executionMode]);
      if (!control.rows[0]) throw new Error('Durable risk control unavailable after fanout claim');
      risk = { account: execution.userId ?? 'operator', chain: execution.chain, executionMode: execution.executionMode,
        executionId: execution.id, policyEpoch: control.rows[0].epoch };
    }
    if (risk) await reserveRiskSpend(client, { ...risk, requestedUsd: quote.requestedDebitUsd! });
    const attempt = await prepareWorkerAttemptWithClient(client, context.execution, admitted.revision, risk?.policyEpoch ?? null);
    if (!attempt) {
      if (delivery && !await settleFanoutDelivery(client, delivery.claim, { outcome: 'reconciliation_required',
        executionId: execution.id, reason: 'canonical-attempt-exists-reconcile-without-new-effect', now: ports.now!() })) {
        throw new Error('Fanout attempt uncertainty commit fence unavailable');
      }
      return { reason: 'canonical-attempt-exists-reconcile-without-new-effect' } as const;
    }
    await markWorkerAttemptDispatchedWithClient(client, attempt);
    if (risk) await updateRiskSpendReservation(client, { ...risk, state: 'submitted', confirmedUsd: null });
    return { attempt, risk, delivery } as const;
  });
  if ('reason' in preEffect) return blocked(preEffect.reason!);
  const intent: CanonicalWorkerIntent = { execution, ...preEffect, maxSlippageBps: admitted.maxSlippageBps };
  let outcome: CanonicalWorkerOutcome;
  if (execution.executionMode === 'live') {
    const finalAuthority = await currentAuthority(ports, execution);
    if ('reason' in finalAuthority || finalAuthority.terms !== authorizedTerms) {
      await ports.transaction(client => retainWorkerUncertaintyWithClient(client, { ...intent,
        delivery: preEffect.delivery ? { ...preEffect.delivery, now: ports.now!() } : undefined,
        reason: 'authority changed after durable prepare; no effect attempted' }));
      return { status: 'submitted', state: 'reconciliation_required', reason: 'pre-effect-authority-changed-or-unavailable' };
    }
  }
  try { outcome = await quote.execute(intent); }
  catch (error) { outcome = { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) }; }
  if (outcome.kind === 'unknown') {
    await ports.transaction(client => retainWorkerUncertaintyWithClient(client, { ...intent, reason: outcome.reason,
      delivery: preEffect.delivery ? { ...preEffect.delivery, now: ports.now!() } : undefined }));
    return { status: 'submitted', state: 'reconciliation_required', reason: outcome.reason };
  }
  const fill = outcome;
  const settled = await ports.transaction(client => settleWorkerFillWithClient(client, { ...intent, evidence: fill.evidence,
    delivery: preEffect.delivery ? { ...preEffect.delivery, now: ports.now!() } : undefined,
    executor: fill.executor, slippageBps: intent.maxSlippageBps }));
  if (!settled.accountingComplete || settled.execution.state !== 'confirmed') {
    return { status: 'submitted', state: settled.execution.state, reason: 'canonical-accounting-reconciliation-required' };
  }
  return { status: execution.executionMode === 'paper' ? 'paper-filled' : 'live-executed', signalId: execution.signalId ?? undefined };
}
