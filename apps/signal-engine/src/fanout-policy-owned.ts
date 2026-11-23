import type { PoolClient } from '@swat/db/dist/copy-trade-lifecycle-owned.js';
import { prepareListFanoutCandidates } from '@swat/db/dist/fanout-candidates-owned.js';
import { planFanout, type FanoutPlan, type FanoutPlatformInputs, type FanoutSignal }
  from '@swat/db/dist/fanout-eligibility.js';
import { readFanoutRecipientScopeWithClient, type FanoutRecipient, type FanoutExclusion }
  from '@swat/db/dist/package13-fanout-delivery.js';
import { hasAcceptedSourceVerificationWithClient } from '@swat/db/dist/source-verification-store.js';
import { resolveChainAddress, stripChainPrefix, type Chain, type ExecutionMode } from '@swat/shared';
import { projectCohortNotionalUsd } from './capacity-projection.js';
import type { ResolveFanoutCapacityInput, FanoutCapacityResolution } from './capacity-inputs.js';
import { evaluateSignalTradeEligibility, type SignalTradeEligibility } from './trade-eligibility.js';
import { createVerifiedFanoutAdmission, requireStableFanoutExclusions } from './fanout-canonical.js';
import { fanoutDescriptorIdentity, planFanoutTradeJobs, summariseFanout,
  type FanoutJobDescriptor, type FanoutJobPlan } from './fanout-enqueue.js';

export interface FanoutPolicySource {
  readonly sourceTradeId: string;
  readonly walletAddress: string;
  readonly tokenMint: string;
  readonly side: 'buy' | 'sell';
  readonly eventAt: Date;
}

/** Mandatory IO ports, never optional ambient fallbacks. Transaction resolution
 * must follow checked COMMIT. Neither this factory nor possession of a client
 * grants tenant/source/queue authority. SQL071/087 and current provisioning do
 * NOT establish the missing reviewed swat_fanout protected backing identity.
 * Capacity/mode/safety remain boot-injected readers, not new provisioning here.
 */
export interface OwnedFanoutPolicyPorts {
  transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T>;
  mode(chain: Chain): Promise<FanoutPlatformInputs['chainMode']>;
  safety(tokenMint: string): Promise<{ readonly isSafe: boolean }>;
  capacity(input: ResolveFanoutCapacityInput): Promise<FanoutCapacityResolution>;
  operatorAutoExecute(): boolean;
  paperTargetAccount(chain: Chain): string;
  now(): Date;
  readonly minimumBalanceUsd: number;
  readonly minimumSignalScore: number;
  readonly maximumSourceEventAgeMs: number;
  log(message: string): void;
  warn(message: string): void;
  error(message: string, error: unknown): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid fanout policy identity');
}
function captureSource(input: FanoutPolicySource): FanoutPolicySource {
  const { sourceTradeId, walletAddress, tokenMint, side } = input;
  uuid(sourceTradeId);
  const token = resolveChainAddress(tokenMint);
  if (token.prefixed !== tokenMint || resolveChainAddress(walletAddress, token.chain).prefixed !== walletAddress
    || !['buy', 'sell'].includes(side)) throw new Error('Fanout source scope mismatch');
  const eventAt = new Date(input.eventAt.getTime());
  if (!Number.isFinite(eventAt.getTime())) throw new Error('Invalid fanout source event time');
  return { sourceTradeId, walletAddress, tokenMint, side, eventAt };
}
function captureDescriptor(input: FanoutJobDescriptor): FanoutJobDescriptor {
  // Complete comparison payload, including nested options, captured before the
  // accepted-source read; a queued caller cannot mutate identity during awaits.
  const descriptor = JSON.parse(JSON.stringify(input)) as FanoutJobDescriptor;
  const identity = fanoutDescriptorIdentity(descriptor);
  uuid(identity.signalId); uuid(descriptor.data.sourceTradeId);
  if (identity.userId !== null) uuid(identity.userId);
  if (resolveChainAddress(identity.targetAccount, descriptor.chain).prefixed !== identity.targetAccount
    || resolveChainAddress(descriptor.data.tokenMint, descriptor.chain).prefixed !== descriptor.data.tokenMint
    || !['buy', 'sell'].includes(descriptor.data.direction ?? '')) throw new Error('Fanout descriptor scope mismatch');
  return descriptor;
}

/** The actual index-used current policy and cohort bodies. Shared canonical
 * SQL only: candidate and recipient-scope reads delegate to their owned leaves.
 * This composes discovery/admission, not canonical claims or queue publication;
 * the existing durable adapter retains position-first locking, admission before
 * claim, immutable replay, stable/unknown classification and COMMIT-before-queue.
 */
export function createOwnedFanoutPolicy(ports: OwnedFanoutPolicyPorts) {
  const minimumBalanceUsd = ports.minimumBalanceUsd;
  const minimumSignalScore = ports.minimumSignalScore;
  const maximumSourceEventAgeMs = ports.maximumSourceEventAgeMs;
  for (const value of [minimumBalanceUsd, minimumSignalScore, maximumSourceEventAgeMs]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid fanout policy limit');
  }

  async function currentAdmission(client: PoolClient, descriptor: FanoutJobDescriptor): Promise<{ allowed: boolean; reason?: string }> {
    const identity = fanoutDescriptorIdentity(descriptor);
    const source = await client.query<{ wallet_address: string; direction: 'buy' | 'sell'; token_mint: string;
      chain: Chain; event_at: Date; confirmation_state: string }>(
      `SELECT source.wallet_address, source.direction, source.token_mint, source.chain, source.event_at, source.confirmation_state
     FROM signals signal JOIN source_trades source ON source.id = signal.source_trade_id
     WHERE signal.id = $1 AND source.id = $2 FOR SHARE OF source`,
      [identity.signalId, descriptor.data.sourceTradeId]
    );
    const row = source.rows[0];
    if (!row || row.chain !== descriptor.chain || row.token_mint !== descriptor.data.tokenMint
      || row.direction !== descriptor.data.direction || !['confirmed', 'finalized'].includes(row.confirmation_state)
      || !(row.event_at instanceof Date) || !Number.isFinite(row.event_at.getTime())
      || row.event_at.getTime() > ports.now().getTime()
      || ports.now().getTime() - row.event_at.getTime() > maximumSourceEventAgeMs) {
      return { allowed: false, reason: 'source-identity-confirmation-or-freshness-unavailable' };
    }
    // Explicit stop state remains mandatory for reducing sells as well.
    const blacklist = await client.query<{ value: unknown }>(`SELECT value FROM config WHERE key = 'blacklist'`);
    const value = blacklist.rows[0]?.value;
    if (value !== undefined && (!Array.isArray(value) || value.some(entry => typeof entry !== 'string'))) {
      return { allowed: false, reason: 'blacklist-unreadable' };
    }
    if (Array.isArray(value) && value.some(entry => stripChainPrefix(entry) === stripChainPrefix(row.token_mint))) {
      return { allowed: false, reason: 'token-blacklisted' };
    }
    if (identity.userId === null && !ports.operatorAutoExecute()) return { allowed: false, reason: 'operator-auto-execute-off' };
    const mode = await ports.mode(descriptor.chain);
    if (!mode) return { allowed: false, reason: 'chain-mode-unknown' };
    const scope = await readFanoutRecipientScopeWithClient(client, {
      userId: identity.userId, chain: descriptor.chain, tokenMint: row.token_mint,
      masterWalletAddress: row.wallet_address, direction: row.direction,
      platformMode: mode.effectiveMode, paperTargetAccount: ports.paperTargetAccount(descriptor.chain), now: ports.now()
    });
    if (scope.reason || scope.executionMode !== identity.executionMode || scope.targetAccount !== identity.targetAccount) {
      return { allowed: false, reason: scope.reason ?? 'immutable-recipient-scope-changed' };
    }
    if (row.direction === 'buy') {
      const safety = await ports.safety(row.token_mint);
      const verdict = evaluateSignalTradeEligibility('source_trade', { direction: 'buy', score: descriptor.data.score,
        minimumScore: Math.max(80, minimumSignalScore), safety, suppressTrade: false });
      if (!verdict.allowed) return verdict;
    }
    return { allowed: true };
  }
  const verifiedAdmission = createVerifiedFanoutAdmission({
    accepted: hasAcceptedSourceVerificationWithClient, current: currentAdmission, now: ports.now
  });

  async function planSignalFanout(sourceTrade: FanoutPolicySource, chain: Chain, tokenMint: string,
    score: number, poolTvlUsd: number | null): Promise<{ plan: FanoutPlan; effectiveMode: ExecutionMode } | null> {
    try {
      const read = prepareListFanoutCandidates({ masterWalletAddress: sourceTrade.walletAddress, chain, now: ports.now() });
      const [candidates, chainMode] = await Promise.all([ports.transaction(read), ports.mode(chain)]);
      const signal: FanoutSignal = { chain, masterWalletAddress: sourceTrade.walletAddress, tokenMint,
        direction: sourceTrade.side, score, eventAt: sourceTrade.eventAt };
      const platformWithoutCapacity = { chainMode, minimumBalanceUsd };
      const projection = projectCohortNotionalUsd(candidates, signal, platformWithoutCapacity);
      let capacity: FanoutPlatformInputs['capacity'];
      if (sourceTrade.side === 'sell') {
        capacity = { outcome: 'admit' };
        ports.log(`[signal-engine] capacity not assessed for a sell mirror on ${chain} `
          + `(${sourceTrade.walletAddress}): the cap is buy-side, and the cohort's sells are `
          + 'bounded by buys it already gated');
      } else {
        const resolved = await ports.capacity({ masterWalletAddress: sourceTrade.walletAddress, chain, tokenMint,
          poolTvlUsd, projection, cohortDirection: 'buy', now: ports.now() });
        capacity = resolved.capacity;
        ports.log(`[signal-engine] ${resolved.logLine}`);
      }
      return { plan: planFanout(candidates, signal, { ...platformWithoutCapacity, capacity }),
        effectiveMode: chainMode?.effectiveMode ?? 'off' };
    } catch (error) {
      ports.error(`[signal-engine] fan-out enumeration failed for ${sourceTrade.walletAddress}; `
        + 'no user jobs will be queued for this signal:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  return {
    async admission(client: PoolClient, input: FanoutJobDescriptor) {
      const descriptor = captureDescriptor(input);
      return verifiedAdmission(client, descriptor);
    },
    /** Source/eligibility captured at delivery construction; job comparison terms
     * captured and validated before the first transaction acquisition. */
    prepareEnumeration(input: FanoutPolicySource, eligibilityInput: SignalTradeEligibility, poolTvlUsd: number | null) {
      const source = captureSource(input);
      const eligibility = { ...eligibilityInput };
      return async (inputPlan: FanoutJobPlan): Promise<{ recipients: FanoutRecipient[]; exclusions: FanoutExclusion[] }> => {
        const jobPlan = JSON.parse(JSON.stringify(inputPlan)) as FanoutJobPlan;
        uuid(jobPlan.operator.data.signalId);
        if (jobPlan.operator.data.sourceTradeId !== source.sourceTradeId || jobPlan.operator.data.tokenMint !== source.tokenMint
          || jobPlan.operator.data.direction !== source.side || resolveChainAddress(source.tokenMint).chain !== jobPlan.chain
          || jobPlan.operator.chain !== jobPlan.chain) throw new Error('Fanout enumeration source/job scope mismatch');
        const accepted = await ports.transaction(client => hasAcceptedSourceVerificationWithClient(client,
          source.sourceTradeId, ports.now()));
        if (!accepted) throw new Error('accepted-source-verification-unavailable');
        const fanout = await planSignalFanout(source, jobPlan.chain, jobPlan.operator.data.tokenMint,
          jobPlan.operator.data.score, poolTvlUsd);
        if (!fanout) throw new Error('Fanout recipient enumeration unavailable');
        if (fanout.plan.eligible.length + fanout.plan.excluded.length > 1000) throw new Error('Fanout cohort exceeds bounded snapshot');
        const summary = summariseFanout(fanout.plan);
        ports.log(`[signal-engine] fan-out ${jobPlan.operator.data.signalId}: ${summary.line}`);
        if (summary.warning) ports.warn(`[signal-engine] ${summary.warning}`);
        const descriptors = planFanoutTradeJobs({ ...jobPlan.operator.data, tokenMint: source.tokenMint,
          sourceTrade: { sourceTradeId: source.sourceTradeId, direction: source.side }, plan: fanout.plan });
        const recipients: FanoutRecipient[] = [];
        const exclusions: FanoutExclusion[] = [...fanout.plan.excluded.map(row => ({ userId: row.userId, code: row.code }))];
        requireStableFanoutExclusions(exclusions);
        for (const descriptor of [descriptors.operator, ...descriptors.users]) {
          const userId = descriptor.data.userId ?? null;
          if (!eligibility.allowed) { exclusions.push({ userId, code: eligibility.reason }); continue; }
          if (userId === null && !ports.operatorAutoExecute()) {
            exclusions.push({ userId, code: 'operator-auto-execute-off' }); continue;
          }
          const scope = await ports.transaction(client => readFanoutRecipientScopeWithClient(client, {
            userId, chain: jobPlan.chain, tokenMint: source.tokenMint, masterWalletAddress: source.walletAddress,
            direction: source.side, platformMode: fanout.effectiveMode, paperTargetAccount: ports.paperTargetAccount(jobPlan.chain), now: ports.now()
          }));
          if (scope.reason || !scope.executionMode || !scope.targetAccount) {
            exclusions.push({ userId, code: (scope.reason ?? 'recipient-scope-unavailable').slice(0, 128) }); continue;
          }
          const scoped: FanoutJobDescriptor = { ...descriptor, data: { ...descriptor.data,
            userId, executionMode: scope.executionMode, targetAccount: scope.targetAccount } };
          recipients.push({ ...fanoutDescriptorIdentity(scoped), jobId: scoped.options.jobId!,
            descriptor: scoped as unknown as Record<string, unknown> });
        }
        requireStableFanoutExclusions(exclusions);
        return { recipients, exclusions };
      };
    }
  };
}
