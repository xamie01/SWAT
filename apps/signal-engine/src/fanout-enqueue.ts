import type { Chain, ExecutionMode } from '@swat/shared';
import { tradeQueueForChain, chainFromTokenMint } from '@swat/shared';
import type { FanoutExclusionCode, FanoutPlan, MirrorEligibility } from '@swat/db';

/**
 * One BullMQ trade job per `(signal, user)` — `S4-14`.
 *
 * **Pure planner, thin enqueuer**, following `stop-loss.ts` and
 * `fanout-eligibility.ts`. `planFanoutTradeJobs` computes every job descriptor
 * from explicit inputs and touches nothing; `enqueueFanoutTradeJobs` does
 * nothing but hand those descriptors to a queue. The reason is not tidiness:
 * there is no Redis available on this branch, so anything expressed inside the
 * `.add()` call could not be tested at all — and the thing most worth testing
 * here is the `jobId`, because a wrong one opens a second position for a real
 * user.
 *
 * ── The jobId is the whole item ────────────────────────────────────────────
 *
 * Before fan-out there was one job per signal, keyed `source-trade-<signalId>`.
 * That key is now the **operator** job's key and nothing else, and each user
 * gets `source-trade-<signalId>-u-<userId>`.
 *
 * Two properties, and both directions matter:
 *
 *   * **It cannot collide across users.** The key ends in the user's id, which
 *     is a `users.id` UUID, and `assertJobIdComponent` refuses an empty
 *     component or one containing the separator — so two distinct users cannot
 *     produce one string, and a user key cannot be forged into the operator key.
 *     The operator key is a strict *prefix* of a user key, never equal to one.
 *   * **It cannot fail to collide for the same user retried.** The key is
 *     derived from `(signalId, userId)` and nothing else — no clock, no random
 *     component, no attempt counter, no index in the eligible list. In
 *     particular it deliberately excludes `executionMode` and `mirrors`: a
 *     certification lapsing between the first enqueue and a retry changes the
 *     mode from `live` to `paper`, and a mode-bearing key would mint a second
 *     job and open a second position for one user out of one signal.
 *
 * That retry path is real rather than hypothetical. `enqueueSignal` only calls
 * `markSourceTradeSignalDispatched` **after** the enqueue, and
 * `listSourceTradeSignalCandidates` re-selects any signal with
 * `source_dispatched_at IS NULL`. So a fan-out that fails on user #30 of 50 is
 * re-run whole on the next tick, and the first 29 jobs must be recognised as the
 * jobs they already are.
 *
 * **The jobId is the first line of defence, not the only one.** BullMQ drops a
 * duplicate id only while the job still exists, and these carry
 * `removeOnComplete: true` — so a signal re-dispatched long after completion
 * would pass this guard. The durable guard is the pair of unique indexes
 * migration `050` re-keyed by tenant: `unq_trades_source_trade_mode` on
 * `(source_trade_id, execution_mode, user_id)` and
 * `unq_copy_executions_signal_target_mode` on
 * `(signal_id, target_account, execution_mode, user_id)`, both
 * `NULLS NOT DISTINCT` so the operator's own rows still collide with each other.
 * Per-user jobs are only safe *because* those keys already carry `user_id`.
 */

/** The job name every trade producer uses. Unchanged by fan-out. */
export const TRADE_JOB_NAME = 'signal-trade';

/**
 * Separates the signal id from the user id in a fan-out job id.
 *
 * Contains a letter that is not a hex digit, so it cannot occur inside either
 * UUID it joins. That makes the boundary unambiguous even though nothing parses
 * the key — ids are only ever compared for equality, and an ambiguous boundary
 * would still be a latent collision the day one component changes shape.
 */
export const FANOUT_JOB_ID_SEPARATOR = '-u-';

export type ClusterTier = 'elite' | 'pro' | 'promising' | 'speculative';

/**
 * The payload the executor reads.
 *
 * `userId` is already part of the executor's declared contract
 * (`apps/trade-executor/src/index.ts` — "Absent on every job the current
 * producers enqueue, which resolves to the operator principal. Present under
 * fan-out"), so this adds a value to a field that exists rather than a field.
 *
 * `executionMode` and `mirrors` are **carried, never recomputed**. `planFanout`
 * already clamped the mode by the platform gates (`S4-17`); deriving it again
 * downstream is how a `paper` verdict gets re-widened to `live`. They are
 * informational today — the executor re-resolves the chain mode itself and
 * nothing reads `mirrors` yet — so they are a record of what was decided, not an
 * instruction the executor obeys.
 */
export interface FanoutTradeJobData {
  readonly signalId: string;
  readonly score: number;
  readonly tokenMint: string;
  readonly clusterTier: ClusterTier;
  readonly sourceTradeId?: string;
  readonly direction?: 'buy' | 'sell';
  /** Absent on the legacy operator job, which is what makes it the operator's. */
  readonly userId?: string;
  /** The already-clamped mode from the verdict. Absent on the operator job. */
  readonly executionMode?: ExecutionMode;
  /** What this user's subscription state permits. Absent on the operator job. */
  readonly mirrors?: MirrorEligibility;
}

export interface FanoutJobOptions {
  readonly jobId?: string;
  readonly removeOnComplete: boolean;
  readonly attempts: number;
  readonly backoff: { readonly type: 'exponential'; readonly delay: number };
}

export interface FanoutJobDescriptor {
  readonly name: typeof TRADE_JOB_NAME;
  /** Resolved with `tradeQueueForChain`; never a literal. */
  readonly queue: string;
  readonly chain: Chain;
  readonly data: FanoutTradeJobData;
  readonly options: FanoutJobOptions;
}

/** Retry policy, unchanged from the pre-fan-out single job. */
const TRADE_JOB_ATTEMPTS = 4;
const TRADE_JOB_BACKOFF_MS = 5_000;

/**
 * Refuses a component that would make the key ambiguous.
 *
 * Throws rather than sanitising, and throws on the money path on purpose: the
 * same reasoning as `chainFromTokenMint` refusing an unknown prefix instead of
 * defaulting. A mangled id is a duplicate position, and there is no safe value
 * to substitute.
 */
function assertJobIdComponent(kind: string, value: string): string {
  if (!value) throw new Error(`Fan-out job id needs a non-empty ${kind}`);
  if (value.includes(FANOUT_JOB_ID_SEPARATOR)) {
    throw new Error(
      `Fan-out job id ${kind} may not contain ${FANOUT_JOB_ID_SEPARATOR}: ${value}`
    );
  }
  return value;
}

/**
 * The legacy operator job id, byte-identical to the pre-fan-out one.
 *
 * Unchanged deliberately: a job already sitting in Redis under this key at
 * deploy time must still be recognised as the same job, and the operator path is
 * the one that has been moving real money.
 */
export function operatorTradeJobId(signalId: string): string {
  return `source-trade-${assertJobIdComponent('signalId', signalId)}`;
}

/** One user's job id for one signal. Stable under retry, distinct per user. */
export function userTradeJobId(signalId: string, userId: string): string {
  return [
    operatorTradeJobId(signalId),
    assertJobIdComponent('userId', userId)
  ].join(FANOUT_JOB_ID_SEPARATOR);
}

export interface FanoutSourceTrade {
  readonly sourceTradeId: string;
  readonly direction: 'buy' | 'sell';
}

export interface PlanFanoutTradeJobsInput {
  readonly signalId: string;
  /** Chain-prefixed. The single input the queue is derived from. */
  readonly tokenMint: string;
  readonly score: number;
  readonly clusterTier: ClusterTier;
  /**
   * Present only for a `source_trade` signal. `null` for a pattern signal, which
   * has no master wallet and therefore no fan-out — and which also gets **no**
   * `jobId`, exactly as before, because pattern signals dedupe on the signal row
   * instead.
   */
  readonly sourceTrade: FanoutSourceTrade | null;
  /**
   * The fan-out verdict, or `null` when no enumeration ran or it failed.
   *
   * `null` yields the operator job alone, which is today's behaviour. That is
   * the fallback an enumeration error lands in: nobody copies, the operator
   * still trades, and nothing about the legacy path changed.
   */
  readonly plan: FanoutPlan | null;
}

export interface FanoutJobPlan {
  readonly chain: Chain;
  readonly queue: string;
  /** Always present. The legacy path does not depend on there being subscribers. */
  readonly operator: FanoutJobDescriptor;
  readonly users: readonly FanoutJobDescriptor[];
}

/**
 * Turns a fan-out verdict into the jobs it implies. Pure.
 *
 * **The queue is resolved once, from the token mint, for every job.**
 * `chainFromTokenMint` is the single definition of a trade job's chain and the
 * executor picks its venue adapter, breaker and risk policy with the same
 * function. Deriving it a second way here is how a producer and its worker end
 * up on queues serving different venues.
 *
 * **The operator job is emitted unconditionally**, whether there are fifty
 * subscribers or none, with the identical id and payload it has always had. The
 * operator is the pre-multi-tenant account (ADR-0001, `user_id NULL`); its
 * trading has never depended on whether anyone subscribed, and making it
 * conditional on an empty fan-out would silently stop it the first time a
 * platform gate excluded everybody.
 */
export function planFanoutTradeJobs(input: PlanFanoutTradeJobsInput): FanoutJobPlan {
  const chain = chainFromTokenMint(input.tokenMint);
  const queue = tradeQueueForChain(chain);

  const base = {
    signalId: input.signalId,
    score: input.score,
    tokenMint: input.tokenMint,
    clusterTier: input.clusterTier,
    ...(input.sourceTrade
      ? { sourceTradeId: input.sourceTrade.sourceTradeId, direction: input.sourceTrade.direction }
      : {})
  } satisfies FanoutTradeJobData;

  const options = (jobId: string | null): FanoutJobOptions => ({
    ...(jobId ? { jobId } : {}),
    removeOnComplete: true,
    attempts: TRADE_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: TRADE_JOB_BACKOFF_MS }
  });

  const operator: FanoutJobDescriptor = {
    name: TRADE_JOB_NAME,
    queue,
    chain,
    data: base,
    // A pattern signal carries no jobId, unchanged. Only a source trade has an
    // identity stable enough to dedupe on.
    options: options(input.sourceTrade ? operatorTradeJobId(input.signalId) : null)
  };

  const users = (input.plan?.eligible ?? []).map((verdict): FanoutJobDescriptor => ({
    name: TRADE_JOB_NAME,
    queue,
    chain,
    data: {
      ...base,
      userId: verdict.userId,
      // Straight off the verdict. `planFanout` already applied the platform
      // clamp; recomputing here would re-widen a downgraded user to live.
      executionMode: verdict.executionMode,
      mirrors: verdict.mirrors
    },
    options: options(userTradeJobId(input.signalId, verdict.userId))
  }));

  return { chain, queue, operator, users };
}

/**
 * The fail-closed exclusion codes — the ones that mean *we could not tell*.
 *
 * Split out because they diagnose a **platform** fault, while every other code
 * describes a user's own settings or state. A fan-out where these dominate is
 * not a quiet market; it is something broken upstream.
 */
const UNKNOWN_EXCLUSION_CODES: readonly FanoutExclusionCode[] = [
  'balance-unknown',
  'capacity-unknown',
  'chain-mode-unknown'
];

export interface FanoutLogSummary {
  readonly eligibleCount: number;
  readonly excludedCount: number;
  /** One line, always. Carries every exclusion code with a non-zero count. */
  readonly line: string;
  /**
   * Set when a fail-closed *unknown* accounts for at least half the exclusions.
   *
   * The half is a judgement, stated as one rather than dressed up. What it is
   * trying to separate is "users declined to copy" from "we could not evaluate
   * them", because those two produce the same empty eligible list and lead an
   * operator to opposite places.
   */
  readonly warning: string | null;
}

/**
 * One line summarising a fan-out, plus a warning when the reason is ours.
 *
 * `planFanout` returns `exclusionCounts` precisely so this can exist: an empty
 * `eligible` array cannot distinguish "nobody was subscribed" from "everybody
 * was excluded", and that difference is the whole of an operator's diagnosis.
 * Nothing else consumes the counts yet, so if they are not logged they are not
 * observed at all.
 */
export function summariseFanout(plan: FanoutPlan): FanoutLogSummary {
  const entries = Object.entries(plan.exclusionCounts)
    .filter((entry): entry is [FanoutExclusionCode, number] => (entry[1] ?? 0) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const excludedCount = entries.reduce((total, [, count]) => total + count, 0);
  const eligibleCount = plan.eligible.length;

  const breakdown = entries.length > 0
    ? entries.map(([code, count]) => `${code}=${count}`).join(', ')
    : 'none';
  const line = `${eligibleCount} eligible, ${excludedCount} excluded (${breakdown})`;

  const dominant = entries[0];
  const dominantIsUnknown = dominant !== undefined
    && UNKNOWN_EXCLUSION_CODES.includes(dominant[0])
    && dominant[1] * 2 >= excludedCount;

  if (!dominantIsUnknown) return { eligibleCount, excludedCount, line, warning: null };

  const [code, count] = dominant;
  const warning = code === 'balance-unknown'
    // Distinct wording because the cause is almost always a stale or unpriced
    // balance feed, not user behaviour: `resolveKnownBalanceUsd` returns null on
    // any stale or unpriced row, so a poller that stopped writing takes every
    // subscriber out at once. An operator reading "balance too low" for fifty
    // users would go looking at fifty accounts.
    ? `balance feed outage suspected — ${count} of ${excludedCount} exclusions are `
      + 'balance-unknown; check the balance poller and the price feed, not user accounts'
    : `${count} of ${excludedCount} exclusions are ${code}, a platform fault rather `
      + 'than a user setting';

  return { eligibleCount, excludedCount, line, warning };
}

/** The narrow slice of a BullMQ queue this module uses. */
export interface FanoutTradeQueue {
  add(name: string, data: FanoutTradeJobData, options: FanoutJobOptions): Promise<unknown>;
}

/**
 * Adds every planned job. Operator first, then one per user, in plan order.
 *
 * Sequential rather than concurrent so a failure names the job it happened on
 * and so ordering is deterministic in a log; the per-chain worker is
 * concurrency-1 anyway, so nothing downstream benefits from racing the adds.
 *
 * Operator first because that job is the one that has always existed: if the
 * process dies mid-fan-out, the pre-existing behaviour has already happened and
 * the retry adds the remaining user jobs under their stable ids.
 */
export async function enqueueFanoutTradeJobs(
  queueFor: (chain: Chain) => FanoutTradeQueue,
  jobPlan: FanoutJobPlan
): Promise<number> {
  const queue = queueFor(jobPlan.chain);
  let added = 0;
  for (const descriptor of [jobPlan.operator, ...jobPlan.users]) {
    await queue.add(descriptor.name, descriptor.data, descriptor.options);
    added += 1;
  }
  return added;
}
