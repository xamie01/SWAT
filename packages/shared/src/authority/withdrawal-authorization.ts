import { assertResourceWrapContext, type ResourceWrapContext } from './key-wrapper.js';

/** Retained input type for explicit legacy refusal, never executable authorization. */
export interface WithdrawalAuthorizationPayload {
  readonly chain: 'solana' | 'robinhood-chain' | 'polygon';
  readonly ownerPubkey: string;
  readonly recipientPubkey: string;
  readonly amountLamports: bigint;
  readonly timestampMs: number;
  readonly nonce: string;
}
export interface VerificationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly code?: 'intent-state-unavailable' | 'invalid-amount' | 'timestamp-expired' | 'timestamp-future' | 'invalid-owner' | 'invalid-signature';
}

/** Legacy signatures cannot prove domain binding or durable single-use consumption. */
export function buildWithdrawalAuthorizationMessage(_payload: WithdrawalAuthorizationPayload): string {
  throw new Error('legacy withdrawal message unavailable; negotiate resource-bound intent v2');
}
/** Fail closed before cryptographic work. There is no durable issued-intent consumer. */
export function verifySolanaWithdrawalAuthorization(_opts: {
  readonly payload: WithdrawalAuthorizationPayload; readonly signatureHex: string;
  readonly nowMs?: number; readonly maxAgeMs?: number;
}): VerificationResult {
  return { valid: false, code: 'intent-state-unavailable', reason: 'Durable resource-bound intent issuance/consumption and withdrawal persistence are unavailable' };
}

export interface WithdrawalIntent {
  readonly version: 2;
  readonly resource: ResourceWrapContext;
  readonly programId: string;
  readonly vaultAddress: string;
  readonly assetId: string;
  /** Exact integer base units, never a display quantity or implicit lamports for tokens. */
  readonly units: 'base-units';
  readonly ownerAddress: string;
  readonly recipientAddress: string;
  readonly amount: bigint;
  readonly intentId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}
function validateIntent(intent: WithdrawalIntent): void {
  assertResourceWrapContext(intent.resource);
  if (intent.version !== 2 || intent.resource.purpose !== 'withdrawal-intent' || intent.units !== 'base-units') throw new Error('invalid withdrawal intent domain');
  for (const field of ['programId', 'vaultAddress', 'assetId', 'ownerAddress', 'recipientAddress', 'intentId'] as const) {
    const value = intent[field];
    if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) throw new Error(`invalid intent ${field}`);
  }
  if (typeof intent.amount !== 'bigint' || intent.amount <= 0n || intent.amount >= 1n << 256n) throw new Error('invalid intent amount');
  if (!Number.isSafeInteger(intent.issuedAtMs) || !Number.isSafeInteger(intent.expiresAtMs) || intent.issuedAtMs < 0 || intent.expiresAtMs <= intent.issuedAtMs) throw new Error('invalid intent lifetime');
}
/** Pure message construction is not signing, issuance, verification or withdrawal approval. */
export function buildWithdrawalIntentMessage(intent: WithdrawalIntent): string {
  validateIntent(intent);
  const r = intent.resource;
  return JSON.stringify(['SWAT-WITHDRAWAL-INTENT', 2, r.deploymentId, r.userId, r.chainKind, r.chainId,
    r.accountAddress, r.grantId, r.grantKind, r.purpose, r.keyVersion,
    intent.programId, intent.vaultAddress, intent.assetId, intent.units, intent.ownerAddress,
    intent.recipientAddress, intent.amount.toString(), intent.intentId, intent.issuedAtMs, intent.expiresAtMs]);
}

/** Persist issuedMessage exactly; do not reconstruct issued challenges from a caller's payload. */
export interface WithdrawalIntentRecord {
  readonly issuedMessage: string;
  readonly state: 'issued' | 'consumed';
  readonly withdrawalId: string | null;
}
export type WithdrawalIntentConsumptionPlan =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'reuse'; readonly withdrawalId: string; readonly authorizeExecution: false }
  | { readonly kind: 'consume-required'; readonly expected: WithdrawalIntentRecord; readonly next: WithdrawalIntentRecord; readonly authorizeExecution: false };

/**
 * Pure storage contract only, not an atomic consumer or verifier. A real consumer must
 * verify the exact issued message, lock/CAS it, create the withdrawal and commit together.
 * Even a planned first consumption never grants execution authority here.
 */
export function planWithdrawalIntentConsumption(input: {
  intent: WithdrawalIntent; record: WithdrawalIntentRecord | null;
  nowMs: number; withdrawalId: string;
}): WithdrawalIntentConsumptionPlan {
  let message: string;
  try { message = buildWithdrawalIntentMessage(input.intent); }
  catch { return { kind: 'refused', reason: 'invalid resource-bound intent' }; }
  if (!input.record) return { kind: 'unavailable', reason: 'issued intent record required' };
  if (input.record.issuedMessage !== message) return { kind: 'refused', reason: 'intent differs from exact issued resource/message' };
  if (input.record.state === 'consumed') {
    return input.record.withdrawalId
      ? { kind: 'reuse', withdrawalId: input.record.withdrawalId, authorizeExecution: false }
      : { kind: 'refused', reason: 'consumed record lacks durable withdrawal' };
  }
  if (input.record.state !== 'issued' || input.record.withdrawalId !== null ||
      !Number.isSafeInteger(input.nowMs) || input.nowMs < input.intent.issuedAtMs || input.nowMs >= input.intent.expiresAtMs ||
      typeof input.withdrawalId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.withdrawalId)) {
    return { kind: 'refused', reason: 'invalid issued state, withdrawal identity or intent lifetime' };
  }
  return { kind: 'consume-required', expected: input.record,
    next: { issuedMessage: message, state: 'consumed', withdrawalId: input.withdrawalId }, authorizeExecution: false };
}
