import type { PipelineClientLease, PoolClient } from '@swat/db/dist/wave4-pipeline-source-owned.js';
import { createProtectedFanoutTransaction,requireProtectedFanoutClient } from '@swat/db/dist/wave4-pipeline-fanout-owned.js';
import { createProtectedExactFollowerEntryRequest,
  type PipelineFollowerAuthority } from '@swat/db/dist/wave4-pipeline-follower-owned.js';
import { claimSourceSignalForCopyExecutionWithClient } from '@swat/db/dist/copy-trade-lifecycle-owned.js';
import { readWorkerExecutionContextWithClient } from '@swat/db/dist/worker-execution.js';
import { readCapturedWorkerPolicyWithClient } from '@swat/db/dist/worker-policy.js';
import { createOwnedFanoutPolicy, type OwnedFanoutPolicyPorts, type FanoutPolicySource } from './fanout-policy-owned.js';
import { createCanonicalFanoutPreparation } from './fanout-canonical.js';
import { createDurableFanoutDelivery, enqueueFanoutTradeJobs, type FanoutJobPlan,
  type FanoutTradeQueue, type FanoutJobDescriptor } from './fanout-enqueue.js';
import type { SignalTradeEligibility } from './trade-eligibility.js';

export interface ProtectedPipelineFanoutPorts {
  readonly acquire: () => Promise<PipelineClientLease>;
  /** These mode/safety/capacity readers still require independently protected
   * backing and qualification. Supplying interfaces alone is NOT SOURCE closure.
   * Existing owned current policy remains canonical; no alternate business SQL. */
  readonly policy: Omit<OwnedFanoutPolicyPorts,'transaction'>;
  readonly followerAuthority: PipelineFollowerAuthority | null;
  readonly maximumFollowerBalanceAgeMs: number;
  readonly maximumPositionEvidenceAgeMs: number;
  readonly owner: string;
}
function capturePlan(input: FanoutJobPlan): FanoutJobPlan {
  const plan = JSON.parse(JSON.stringify(input)) as FanoutJobPlan;
  if (!plan?.operator?.data || !plan.operator.data.sourceTradeId || !plan.operator.data.signalId
    || plan.chain !== plan.operator.chain || !Array.isArray(plan.users) || plan.users.length > 1000
    || plan.operator.data.tokenMint === null || !['buy','sell'].includes(plan.operator.data.direction ?? '')) {
    throw new Error('Protected pipeline source plan unavailable');
  }
  return plan;
}
/** Pool-free explicit DB dist leaves only; production canonical policy,
 * same-client exact claim/captured policy, immutable cohort and COMMIT-before-
 * enqueue bodies are reused. No worker grant, receipt, operator capability,
 * public joined qualification or Package28 enablement is introduced. */
export function createProtectedPipelineFanout(input: ProtectedPipelineFanoutPorts) {
  if (typeof input.acquire !== 'function' || typeof input.owner !== 'string' || !input.owner
    || input.owner.trim() !== input.owner || input.owner.length > 128
    || !Number.isSafeInteger(input.maximumPositionEvidenceAgeMs) || input.maximumPositionEvidenceAgeMs <= 0
    || input.maximumPositionEvidenceAgeMs > 60_000) throw new Error('Protected fanout bounded ownership required');
  const transaction = createProtectedFanoutTransaction(input.acquire);
  const policyPorts = { ...input.policy,transaction };
  const now = policyPorts.now;
  const policy = createOwnedFanoutPolicy(policyPorts);
  const canonicalPrepare = createCanonicalFanoutPreparation({ claim: claimSourceSignalForCopyExecutionWithClient,
    context: readWorkerExecutionContextWithClient,capturedPolicy: readCapturedWorkerPolicyWithClient,
    exactEntryRequest: createProtectedExactFollowerEntryRequest({ authority: input.followerAuthority,now,
      maximumAgeMs: input.maximumFollowerBalanceAgeMs }),now,maxPositionEvidenceAgeMs: input.maximumPositionEvidenceAgeMs });
  const owner = input.owner;
  return {
    transaction,
    /** prepareEnumeration captures source and eligibility before acquisition;
     * durable adapter retains its seed on errors and uncertain snapshot COMMIT.
     * Retrying reuses immutable source/signal/job/cohort identities. */
    delivery(source: FanoutPolicySource, eligibility: SignalTradeEligibility, poolTvlUsd: number | null) {
      const enumerate = policy.prepareEnumeration(source,eligibility,poolTvlUsd);
      const delivery = createDurableFanoutDelivery({ transaction,owner,now,enumerate,
        admission: policy.admission,canonicalPrepare });
      return {
        prepare(inputPlan: FanoutJobPlan) { const plan = capturePlan(inputPlan); return delivery.prepare(plan); },
        queued(candidate: FanoutJobDescriptor) {
          const descriptor = JSON.parse(JSON.stringify(candidate)) as FanoutJobDescriptor;
          return delivery.queued(descriptor);
        },
        enqueue(queueFor: (chain: FanoutJobPlan['chain']) => FanoutTradeQueue, inputPlan: FanoutJobPlan) {
          const plan = capturePlan(inputPlan); return enqueueFanoutTradeJobs(queueFor,plan,delivery);
        }
      };
    },
    async admission(client: PoolClient, descriptor: FanoutJobDescriptor) {
      const captured = JSON.parse(JSON.stringify(descriptor)) as FanoutJobDescriptor;
      await requireProtectedFanoutClient(client); return policy.admission(client,captured);
    }
  };
}
