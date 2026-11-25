import type { PoolClient } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import { recordSourceTradeEventWithClient, insertSourceTradeSignalWithClient,
  claimSourceSignalForCopyExecutionWithClient } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import { applyVerifiedSourceEvidenceWithClient } from '../../../packages/db/src/source-verification-store.js';
import { canonicalSourceEvidence, sourceBindingDigest, sourceTokenQuantity,
  type SourceVerificationEvidence, type TrustedSourceVerifier } from '../../../packages/db/src/source-verification.js';
import { readWorkerExecutionContextWithClient } from '../../../packages/db/src/worker-execution.js';
import { createExactFollowerEntryRequest, type ReviewedFollowerSizingProvider } from '../../../packages/db/src/exact-follower-sizing.js';
import { readCapturedWorkerPolicyWithClient } from '../../../packages/db/src/worker-policy.js';
import { listFanoutDeliveries } from '../../../packages/db/src/package13-fanout-delivery.js';
import { createOwnedObligationScopedTransaction, readOwnedWorkerRuntimeCapability } from '../../../packages/db/src/obligation-runtime-owned.js';
import { createCanonicalFanoutPreparation } from '../../../apps/signal-engine/src/fanout-canonical.js';
import { createDurableFanoutDelivery, planFanoutTradeJobs, type DurableFanoutCaller, type FanoutJobDescriptor,
  type FanoutJobPlan, type FanoutTradeQueue } from '../../../apps/signal-engine/src/fanout-enqueue.js';
import { createOwnedFanoutPolicy, type OwnedFanoutPolicyPorts } from '../../../apps/signal-engine/src/fanout-policy-owned.js';
import { runCanonicalWorkerJob, type CanonicalWorkerPorts } from '../../../apps/trade-executor/src/worker-policy.js';
import { createExactPaperQuote, type ReviewedPaperValuationProvider } from '../../../apps/trade-executor/src/worker-paper-quote.js';
import { captureLoadFixture, loadCheck, loadEqual, loadJson, loadScope, loadTime, loadUuid,
  type LoadFixture, type LoadHttpAttempt, type LoadScope } from './load-durable-contract.js';

export interface LoadFixtureInvocation {
  readonly attempt: LoadHttpAttempt;
  readonly fixture: LoadFixture;
  /** Actual already-authenticated server principal. No session token in exports. */
  readonly principal: { readonly kind: 'user'; readonly userId: string };
  readonly evidence: SourceVerificationEvidence;
}
import type { LoadProtectedCapturePort } from '../../../packages/db/src/wave4-load-contract.js';
export type { LoadProtectedCapturePort } from '../../../packages/db/src/wave4-load-contract.js';
export interface LoadFixtureConsumerPorts {
  readonly scope: LoadScope;
  /** Resolves only after COMMIT; owns every pending query and bounded cleanup. */
  readonly sourceTransaction: DurableFanoutCaller['transaction'];
  readonly protectedCapture: LoadProtectedCapturePort;
  readonly verifier: TrustedSourceVerifier;
  readonly policy: OwnedFanoutPolicyPorts;
  readonly fanoutOwner: string;
  readonly now: () => Date;
  readonly maximumAgeMs: number;
  readonly signalTerms: Omit<Parameters<typeof insertSourceTradeSignalWithClient>[1], 'sourceTradeId' | 'now'>;
  readonly clusterTier: FanoutJobDescriptor['data']['clusterTier'];
  /** Explicit already-owned worker backend; no ambient pool fallback. */
  readonly workerTransaction: CanonicalWorkerPorts['transaction'];
  readonly authorize: CanonicalWorkerPorts['authorize'];
  readonly platformMode: CanonicalWorkerPorts['platformMode'];
  readonly paperValuation: ReviewedPaperValuationProvider;
  readonly followerSizing: ReviewedFollowerSizingProvider;
  readonly workerOwner: string;
}
export interface LoadPreparedFixture {
  readonly invocation: LoadFixtureInvocation;
  readonly plan: FanoutJobPlan;
}
export const loadFixtureConsumerBlockers = Object.freeze([
  'Public HTTP routes do not persist run/namespace/attempt-to-protected-financial-admission joins',
  'Separately approved contained source verifier, follower sizing and paper valuation provider are mandatory external inputs',
  'Protected swat_fanout backing identity and protected capture implementation are not supplied by public load runtime',
  'Wallet backfill scoring imports ambient DB root; token-discovery processor has no import-safe contained owned leaf',
  'Independent observer coverage and actual approved server/queue/runtime containment remain separate runtime gates'
]);
function captureInvocation(input: LoadFixtureInvocation, scope: LoadScope): LoadFixtureInvocation {
  const fixture = captureLoadFixture(input.fixture);
  loadEqual(fixture.scope, scope, 'consumer run/namespace/backend mismatch');
  const attempt = JSON.parse(loadJson(input.attempt)) as LoadHttpAttempt;
  loadUuid(attempt.attemptId); loadTime(attempt.startedAt); loadTime(attempt.finishedAt);
  loadCheck(Date.parse(attempt.startedAt) <= Date.parse(attempt.finishedAt), 'HTTP attempt time reversed');
  loadCheck(attempt.runId === scope.runId && attempt.namespace === scope.namespace && attempt.fixtureId === fixture.fixtureId
    && attempt.userId === fixture.userId && attempt.requestDigest === fixture.requestDigest
    && attempt.route === (fixture.kind === 'wallet' ? '/v1/me/wallets' : '/v1/me/tokens/backfill')
    && [200, 201].includes(attempt.status), 'authenticated HTTP attempt comparison mismatch');
  loadCheck(input.principal?.kind === 'user' && input.principal.userId === fixture.userId, 'actual authenticated tenant mismatch');
  const evidence = canonicalSourceEvidence(input.evidence);
  loadCheck(sourceBindingDigest(evidence.binding) === sourceBindingDigest(fixture.binding)
    && ['confirmed', 'finalized'].includes(evidence.finality), 'independent bound accepted evidence required');
  return Object.freeze({ fixture, attempt: Object.freeze(attempt), principal: Object.freeze({ ...input.principal }), evidence });
}
function assertDescriptor(descriptor: FanoutJobDescriptor, fixture: LoadFixture, sourceTradeId: string, signalId: string): void {
  const data = descriptor.data;
  loadCheck(descriptor.chain === 'solana' && data.chain === 'solana' && data.userId === fixture.userId
    && data.signalId === signalId && data.sourceTradeId === sourceTradeId && data.targetAccount === fixture.targetAccount
    && data.tokenMint === fixture.tokenMint && data.masterWalletAddress === fixture.walletAddress
    && data.executionMode === 'paper' && data.direction === 'buy' && data.exitLotId === null
    && data.requestedBaseQuantity === null && typeof data.requestedQuoteQuantity === 'string'
    && descriptor.options.jobId === `source-trade-${signalId}-u-${fixture.userId}`, 'contained canonical descriptor changed');
  loadUuid(data.copyExecutionId);
}
/** Source-only adapters, not installed boot hooks and not an opt-in. Every effect
 * delegates to real canonical production leaves under mandatory external ports.
 * These methods return pending work only, NEVER economic/runtime acceptance. */
export function createLoadFixtureConsumers(ports: LoadFixtureConsumerPorts) {
  const scope = loadScope(ports.scope);
  loadCheck(ports.protectedCapture && typeof ports.protectedCapture.assertInvocationWithClient === 'function'
    && typeof ports.protectedCapture.bindCanonicalWithClient === 'function' && ports.verifier
    && typeof ports.sourceTransaction === 'function' && typeof ports.workerTransaction === 'function'
    && typeof ports.authorize === 'function' && typeof ports.platformMode === 'function'
    && ports.paperValuation && ports.followerSizing && typeof ports.followerSizing.readBalance === 'function'
    && typeof ports.followerSizing.networkForChain === 'function' && ['elite', 'pro', 'promising', 'speculative'].includes(ports.clusterTier)
    && typeof ports.now === 'function' && typeof ports.fanoutOwner === 'string' && ports.fanoutOwner.trim() === ports.fanoutOwner
    && ports.fanoutOwner.length > 0 && ports.fanoutOwner.length <= 128
    && typeof ports.workerOwner === 'string' && ports.workerOwner.trim() === ports.workerOwner
    && ports.workerOwner.length > 0 && ports.workerOwner.length <= 128 && Number.isSafeInteger(ports.maximumAgeMs)
    && ports.maximumAgeMs >= 1 && ports.maximumAgeMs <= 60_000, 'precise approved external runtime ports required');
  loadCheck(ports.policy.operatorAutoExecute() === false, 'operator obligation runtime is unsupported');
  const canonicalPaper = createExactPaperQuote({ provider: ports.paperValuation, now: ports.now, maximumAgeMs: ports.maximumAgeMs });

  async function prepare(input: LoadFixtureInvocation): Promise<LoadPreparedFixture> {
    const invocation = captureInvocation(input, scope), { fixture, attempt, principal, evidence } = invocation;
    const authorize = async (client: PoolClient, stage: 'source' | 'fanout' | 'worker') => {
      await ports.protectedCapture.assertInvocationWithClient(client, { scope, fixture, attempt, principal, stage });
    };
    const sourceTrade = await ports.sourceTransaction(async client => {
      await authorize(client, 'source');
      const observed = await recordSourceTradeEventWithClient(client, {
        chain: 'solana', sourceEventType: fixture.binding.sourceEventType, sourceEventId: fixture.binding.sourceEventId,
        sourceEventIndex: fixture.binding.sourceEventIndex, transactionHash: fixture.binding.transactionHash,
        walletAddress: fixture.walletAddress, tokenMint: fixture.tokenMint, side: 'buy',
        quantity: sourceTokenQuantity(fixture.binding.rawQuantity, fixture.binding.quantityScale),
        amountUsd: fixture.binding.amountUsd, priceUsd: fixture.binding.priceUsd, feeUsd: fixture.binding.feeUsd,
        eventAt: new Date(fixture.binding.eventAt), observedAt: ports.now(), confirmationState: 'observed',
        confirmationEvidenceId: `observation:${fixture.fixtureId}`, verificationBinding: fixture.binding });
      await applyVerifiedSourceEvidenceWithClient(client, { sourceTradeId: observed.event.id,
        evidence, verifier: ports.verifier, now: ports.now() });
      const signal = await insertSourceTradeSignalWithClient(client, { ...ports.signalTerms,
        sourceTradeId: observed.event.id, now: ports.now() });
      loadUuid(observed.event.id); loadUuid(signal.id);
      loadCheck(signal.sourceTradeId === observed.event.id && signal.chain === 'solana' && signal.tokenMint === fixture.tokenMint
        && signal.direction === 'buy', 'canonical source/signal scope mismatch');
      return { sourceTradeId: observed.event.id, signalId: signal.id };
    });
    const transaction: DurableFanoutCaller['transaction'] = action => ports.policy.transaction(async client => {
      await authorize(client, 'fanout'); return action(client);
    });
    const policy = createOwnedFanoutPolicy({ ...ports.policy, transaction, operatorAutoExecute: () => false });
    // Caller-approved signal score remains production policy input, not fixture authority.
    const plan = planFanoutTradeJobs({ signalId: sourceTrade.signalId, tokenMint: fixture.tokenMint,
      score: ports.signalTerms.signalScore, clusterTier: ports.clusterTier,
      sourceTrade: { sourceTradeId: sourceTrade.sourceTradeId, direction: 'buy' },
      plan: { eligible: [], excluded: [], exclusionCounts: {} } });
    const enumerate = policy.prepareEnumeration({ sourceTradeId: sourceTrade.sourceTradeId, walletAddress: fixture.walletAddress,
      tokenMint: fixture.tokenMint, side: 'buy', eventAt: new Date(fixture.binding.eventAt) },
    { allowed: true, requiresOwnedExit: false }, null);
    const trustedSizing = createExactFollowerEntryRequest({ provider: ports.followerSizing,
      now: ports.now, maximumAgeMs: ports.maximumAgeMs });
    const canonical = createCanonicalFanoutPreparation({ claim: claimSourceSignalForCopyExecutionWithClient,
      context: readWorkerExecutionContextWithClient, capturedPolicy: readCapturedWorkerPolicyWithClient,
      exactEntryRequest: async (client, descriptor) => {
        loadCheck(descriptor.data.userId === fixture.userId && descriptor.data.targetAccount === fixture.targetAccount
          && descriptor.data.sourceTradeId === sourceTrade.sourceTradeId
          && ports.followerSizing.networkForChain('solana') === scope.network, 'protected follower sizing scope/network mismatch');
        return trustedSizing(client, descriptor);
      }, now: ports.now, maxPositionEvidenceAgeMs: ports.maximumAgeMs });
    const durable = createDurableFanoutDelivery({ transaction, owner: ports.fanoutOwner, now: ports.now,
      admission: policy.admission, enumerate: async p => {
        const cohort = await enumerate(p);
        loadCheck(cohort.recipients.length === 1 && cohort.recipients[0]!.userId === fixture.userId
          && cohort.exclusions.length === 1 && cohort.exclusions[0]!.userId === null
          && cohort.exclusions[0]!.code === 'operator-auto-execute-off', 'contained one-tenant cohort and explicit operator exclusion required');
        return cohort;
      }, canonicalPrepare: async (client, descriptor) => {
        const prepared = await canonical(client, descriptor);
        if (prepared.descriptor) {
          assertDescriptor(prepared.descriptor, fixture, sourceTrade.sourceTradeId, sourceTrade.signalId);
          await ports.protectedCapture.bindCanonicalWithClient(client, { scope, fixtureId: fixture.fixtureId,
            attemptId: attempt.attemptId, userId: fixture.userId, ...sourceTrade,
            executionId: prepared.descriptor.data.copyExecutionId!, jobId: prepared.descriptor.options.jobId! });
        }
        return prepared;
      } });
    // Holds no callbacks in the inert prepared payload. Durable is private to this invocation.
    const descriptors = await durable.prepare(plan);
    for (const descriptor of descriptors) assertDescriptor(descriptor, fixture, sourceTrade.sourceTradeId, sourceTrade.signalId);
    loadCheck(descriptors.length <= 1, 'duplicate contained obligation');
    // A completed replay skips canonicalPrepare in production. Bind this HTTP
    // attempt to the ORIGINAL independently persisted delivery on the owned client.
    await transaction(async client => {
      const rows = await listFanoutDeliveries(client, sourceTrade.signalId);
      loadCheck(rows.length === 1 && rows[0]!.user_id === fixture.userId, 'original protected durable replay scope required');
      const original = rows[0]!.descriptor as unknown as FanoutJobDescriptor;
      assertDescriptor(original, fixture, sourceTrade.sourceTradeId, sourceTrade.signalId);
      await ports.protectedCapture.bindCanonicalWithClient(client, { scope, fixtureId: fixture.fixtureId,
        attemptId: attempt.attemptId, userId: fixture.userId, ...sourceTrade,
        executionId: original.data.copyExecutionId!, jobId: original.options.jobId! });
    });
    // Replay of completed canonical work returns no descriptor and remains unaccepted.
    const freeze = <T>(value: T): T => {
      if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
      return value;
    };
    const preparedPlan = freeze(JSON.parse(loadJson({ ...plan, users: descriptors })) as FanoutJobPlan);
    preparedDeliveries.set(preparedPlan, { durable, invocation, sourceTrade });
    return Object.freeze({ invocation, plan: preparedPlan });
  }
  const preparedDeliveries = new WeakMap<FanoutJobPlan, { durable: ReturnType<typeof createDurableFanoutDelivery>;
    invocation: LoadFixtureInvocation; sourceTrade: { sourceTradeId: string; signalId: string } }>();
  return {
    wallet(input: LoadFixtureInvocation) { loadCheck(input.fixture.kind === 'wallet', 'wallet consumer kind mismatch'); return prepare(input); },
    token(input: LoadFixtureInvocation) { loadCheck(input.fixture.kind === 'token', 'token consumer kind mismatch'); return prepare(input); },
    /** Queue acceptance is transport only; descriptors stay durable on error. */
    async enqueue(prepared: LoadPreparedFixture, queue: FanoutTradeQueue) {
      const saved = preparedDeliveries.get(prepared.plan);
      loadCheck(saved && queue && typeof queue.add === 'function', 'original prepared obligation and explicit owned queue required');
      for (const descriptor of prepared.plan.users) {
        assertDescriptor(descriptor, saved.invocation.fixture, saved.sourceTrade.sourceTradeId, saved.sourceTrade.signalId);
        await queue.add(descriptor.name, descriptor.data, descriptor.options);
        await saved.durable.queued(descriptor);
      }
      return { sourceOnly: true as const, runtimeAccepted: false as const, economicSuccess: false as const };
    },
    async execute(prepared: LoadPreparedFixture, descriptor: FanoutJobDescriptor) {
      const saved = preparedDeliveries.get(prepared.plan);
      loadCheck(saved, 'original prepared invocation required');
      const { fixture, attempt, principal } = saved.invocation;
      assertDescriptor(descriptor, fixture, saved.sourceTrade.sourceTradeId, saved.sourceTrade.signalId);
      const data = JSON.parse(loadJson(descriptor.data));
      const scopedWorker = createOwnedObligationScopedTransaction({ transaction: action => ports.workerTransaction(async client => {
        const capability = await readOwnedWorkerRuntimeCapability(client, data.copyExecutionId, ports.now(), ports.maximumAgeMs);
        loadCheck(capability && capability.backendIdentity === scope.backendIdentity && capability.userId === fixture.userId
          && capability.executionMode === 'paper' && capability.chain === 'solana' && capability.tokenMint === fixture.tokenMint
          && capability.targetAccount === fixture.targetAccount && capability.obligationKind === 'fanout',
        'approved protected immutable backend/tenant/obligation mismatch');
        return action(client);
      }), now: ports.now, maximumAgeMs: ports.maximumAgeMs });
      const transaction = scopedWorker(data);
      loadCheck(transaction, 'canonical obligation selector required');
      await runCanonicalWorkerJob(data, { transaction: action => transaction(async client => {
        await ports.protectedCapture.assertInvocationWithClient(client, { scope, fixture, attempt, principal, stage: 'worker' });
        // Owned canonical lookup validates identity independently; queue labels never scope tenant.
        return action(client);
      }), authorize: ports.authorize, platformMode: ports.platformMode, quote: async execution => {
        loadCheck(execution.executionMode === 'paper' && execution.userId === fixture.userId
          && execution.id === data.copyExecutionId && execution.tokenMint === fixture.tokenMint
          && execution.targetAccount === fixture.targetAccount, 'live/cross-tenant fixture execution refused');
        loadCheck(ports.paperValuation.networkForChain('solana') === scope.network, 'approved valuation network mismatch');
        return canonicalPaper(execution);
      }, now: ports.now, deliveryOwner: ports.workerOwner, deliveryLeaseMs: 240_000 });
      return { sourceOnly: true as const, runtimeAccepted: false as const, economicSuccess: false as const };
    }
  };
}
