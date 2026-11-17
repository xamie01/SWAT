import type { PoolClient, CopyExecutionRecord, WorkerExecutionContext, WorkerPolicySnapshot, FanoutExclusion } from '@swat/db';
import type { FanoutJobDescriptor } from './fanout-enqueue.js';

/** Exact follower request terms are an approved sizing input, NOT the master's
 * fill or a floating-point balance/projection. Risk reservation stays at the
 * canonical worker's trusted quote/pre-effect boundary. */
export interface ExactFanoutRequest {
  readonly requestedBaseQuantity: string | null;
  readonly requestedQuoteQuantity: string | null;
}
export interface FanoutCanonicalPreparation {
  readonly descriptor: FanoutJobDescriptor | null;
  readonly reason?: string;
}
export interface CanonicalFanoutPorts {
  claim(client: PoolClient, input: {
    signalId: string; userId: string | null; targetAccount: string;
    executionMode: CopyExecutionRecord['executionMode'];
    requestedBaseQuantity: string | null; requestedQuoteQuantity: string | null;
    maxPositionEvidenceAgeMs: number; now: Date;
  }): Promise<{ execution: CopyExecutionRecord | null; created: boolean; claimed: boolean; reason?: string }>;
  context(client: PoolClient, executionId: string): Promise<WorkerExecutionContext | null>;
  capturedPolicy(client: PoolClient, execution: CopyExecutionRecord, master: string): Promise<WorkerPolicySnapshot | null>;
  exactEntryRequest(client: PoolClient, descriptor: FanoutJobDescriptor): Promise<ExactFanoutRequest | null>;
  now(): Date;
  readonly maxPositionEvidenceAgeMs: number;
}

function exact(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 256
    && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && /[1-9]/.test(value));
}

/** Runs only AFTER current recipient/source admission, on its SAME transaction
 * client. The execution/context/captured policy are authoritative, not queue
 * flags. Return complete comparison terms from the claim's persisted values. */
export function createCanonicalFanoutPreparation(ports: CanonicalFanoutPorts) {
  return async (client: PoolClient, descriptor: FanoutJobDescriptor): Promise<FanoutCanonicalPreparation> => {
    const data = descriptor.data;
    if (!Object.hasOwn(data, 'userId') || !data.targetAccount
      || !['paper', 'live', 'shadow'].includes(String(data.executionMode)) || !data.sourceTradeId
      || !['buy', 'sell'].includes(String(data.direction))) throw new Error('Canonical fanout candidate scope unavailable');
    const request = data.direction === 'sell'
      ? { requestedBaseQuantity: null, requestedQuoteQuantity: null }
      : await ports.exactEntryRequest(client, descriptor);
    if (!request) return { descriptor: null, reason: 'exact-follower-entry-sizing-unavailable' };
    if (!exact(request.requestedBaseQuantity) || !exact(request.requestedQuoteQuantity)
      || (data.direction === 'buy' && request.requestedBaseQuantity === null && request.requestedQuoteQuantity === null)) {
      throw new Error('Canonical fanout exact follower sizing unavailable');
    }
    const result = await ports.claim(client, { signalId: data.signalId, userId: data.userId as string | null,
      targetAccount: data.targetAccount, executionMode: data.executionMode as CopyExecutionRecord['executionMode'],
      ...request, maxPositionEvidenceAgeMs: ports.maxPositionEvidenceAgeMs, now: ports.now() });
    if (!result.execution) return { descriptor: null, reason: result.reason ?? 'canonical-source-claim-unavailable' };
    const execution = result.execution;
    const context = await ports.context(client, execution.id);
    if (!context || context.execution.id !== execution.id || execution.signalId !== data.signalId
      || execution.sourceTradeId !== data.sourceTradeId || execution.userId !== data.userId
      || execution.targetAccount !== data.targetAccount || execution.chain !== descriptor.chain
      || execution.tokenMint !== data.tokenMint || execution.direction !== data.direction
      || execution.executionMode !== data.executionMode
      || !exact(execution.requestedBaseQuantity) || !exact(execution.requestedQuoteQuantity)
      || (execution.requestedBaseQuantity === null && execution.requestedQuoteQuantity === null)) {
      throw new Error('Canonical fanout claim immutable scope mismatch');
    }
    const captured = await ports.capturedPolicy(client, execution, context.masterWalletAddress);
    if (!captured || captured.scope.account !== (execution.userId ?? 'operator')
      || captured.scope.chain !== execution.chain || captured.scope.tokenMint !== execution.tokenMint
      || captured.scope.masterWalletAddress !== context.masterWalletAddress) {
      throw new Error('Canonical fanout captured policy unavailable or mismatched');
    }
    return { descriptor: { ...descriptor, data: { ...data,
      copyExecutionId: execution.id, signalId: execution.signalId!, userId: execution.userId,
      chain: execution.chain, tokenMint: execution.tokenMint, direction: execution.direction,
      targetAccount: execution.targetAccount, masterWalletAddress: context.masterWalletAddress,
      executionMode: execution.executionMode, requestedBaseQuantity: execution.requestedBaseQuantity,
      requestedQuoteQuantity: execution.requestedQuoteQuantity, sourceTradeId: execution.sourceTradeId!,
      exitLotId: execution.exitLotId ?? null
    } } };
  };
}

/** Deliberately no env opt-in and no master-fill/float fallback. Wave2 must
 * supply an approved exact follower sizing capability before default buys work. */
export const unavailableExactFanoutEntryRequest = async (): Promise<ExactFanoutRequest | null> => null;

/** Only explicitly proven policy refusals become immutable exclusions. Unknown
 * reason codes default to retryable; labels/regex never manufacture certainty. */
const STABLE_EXCLUSIONS = new Set([
  'subscription-not-mirroring', 'winding-down-buy-refused', 'auto-execute-off', 'user-killed',
  'below-user-min-score', 'tier-excludes-chain', 'chain-execution-off', 'balance-below-minimum',
  'position-cap-reached', 'capacity-exhausted', 'source-event-precedes-active-since',
  'account-not-active', 'user-chain-execution-off', 'operator-auto-execute-off', 'token-blacklisted',
  'immutable-recipient-scope-changed', 'discovery-only', 'trade-suppressed', 'entry-score-refused',
  'Source execution is confirmed', 'Source execution is failed', 'Source execution is cancelled',
  'Source signal expired before execution claim', 'Source position evidence is stale',
  'Source position evidence changed after signal eligibility'
]);
export function classifyFanoutRefusal(reason: string | undefined): 'excluded' | 'retryable' {
  return reason !== undefined && STABLE_EXCLUSIONS.has(reason) ? 'excluded' : 'retryable';
}
export function requireStableFanoutExclusions(exclusions: readonly FanoutExclusion[]): void {
  for (const exclusion of exclusions) if (classifyFanoutRefusal(exclusion.code) !== 'excluded') {
    throw new Error(exclusion.code || 'fanout-outcome-unavailable');
  }
}

/** Used by the actual index boot: only THIS source's protected accepted row is
 * verifier authority. Missing registry/evidence refuses without global/env flags. */
export function createVerifiedFanoutAdmission(ports: {
  accepted(client: PoolClient, sourceTradeId: string, now: Date): Promise<boolean>;
  current(client: PoolClient, descriptor: FanoutJobDescriptor): Promise<{ allowed: boolean; reason?: string }>;
  now(): Date;
}) {
  return async (client: PoolClient, descriptor: FanoutJobDescriptor) => {
    if (!descriptor.data.sourceTradeId || !await ports.accepted(client, descriptor.data.sourceTradeId, ports.now())) {
      return { allowed: false, reason: 'accepted-source-verification-unavailable' };
    }
    return ports.current(client, descriptor);
  };
}

