import {
  type FinancialRecord, type FinancialAttempt, type FinancialReceipt, type FinancialEffectPorts,
  type WithdrawalSqlClient, type FinancialAuthorization, financialText, requireFinancial,
  financialTime, validateFinancialAuthorization, validateNoFutureAcceptance
} from '@swat/db';
import { rawToDecimal, reducingRemainder, type ReducingIntent } from '@swat/db';

export interface ReduceOnlyProviderExposure {
  readonly userId: string; readonly chain: string; readonly network: string; readonly venue: string;
  readonly positionId: string; readonly accountId: string; readonly assetId: string; readonly assetScale: number;
  readonly mode: string; readonly positionSide: 'LONG' | 'SHORT'; readonly heldRaw: string;
  readonly observedAt: string; readonly validUntil: string; readonly proof: string;
}
/** Injected deployed provider must enforce deadlines/tombstones at atomic acceptance, not caller labels/preflight. */
export interface ReduceOnlyProvider {
  readonly identity: string; readonly network: string; readonly reduceOnlySupported: boolean;
  readonly atomicDeadlineSupported: boolean; readonly permanentTombstoneSupported: boolean;
  /** Trusted provider clock, called AFTER every async exposure/scope acquisition. */
  now(): Promise<string>;
  lockScope(record: FinancialRecord<ReducingIntent>, attempt: FinancialAttempt): Promise<FinancialAuthorization>;
  currentExposure(record: FinancialRecord<ReducingIntent>, authorization: FinancialAuthorization): Promise<ReduceOnlyProviderExposure>;
  placeReduceOnly(order: {
    intentId: string; intentHash: string; attemptId: string; userId: string; chain: string; network: string; mode: string;
    positionId: string; accountId: string; assetId: string; assetScale: number; clientOrderId: string; side: 'BUY' | 'SELL'; quantity: string;
    feeAssetId: string; feeAssetScale: number; feeFundingAccountId: string; maxFeeRaw: string;
    limitPriceExact: string; reduceOnly: true; timeInForce: 'IOC'; deadline: string;
    exposureObservedAt: string; exposureValidUntil: string; scopeProof: string;
  }, authorization: FinancialAuthorization): Promise<unknown>;
  reconcile(clientOrderId: string, accountId: string, assetId: string): Promise<unknown>;
  verifyReceipt(record: FinancialRecord<ReducingIntent>, attempt: FinancialAttempt, observation: unknown): Promise<FinancialReceipt | null>;
  /** Must authenticate provider's permanent tombstone making any delayed submit of fixed clientOrderId unacceptible forever. */
  verifyNoFutureAcceptance(record: FinancialRecord<ReducingIntent>, attempt: FinancialAttempt, receipt: FinancialReceipt): Promise<boolean>;
  admitReceipt(receipt: FinancialReceipt): Promise<void>;
}
export function createReduceOnlyEffectPorts(provider: ReduceOnlyProvider): FinancialEffectPorts<ReducingIntent> {
  financialText(provider.identity); financialText(provider.network);
  requireFinancial(provider.reduceOnlySupported === true, 'provider-atomic-reduce-only-unavailable');
  requireFinancial(provider.atomicDeadlineSupported === true, 'provider-atomic-deadline-unavailable');
  async function verify(record: FinancialRecord<ReducingIntent>, attempt: FinancialAttempt, observation: unknown) {
    const receipt = await provider.verifyReceipt(record, attempt, observation);
    if (!receipt) return null;
    requireFinancial(receipt.providerIdentity === provider.identity && provider.network === record.intent.network, 'provider-receipt-identity-mismatch');
    if (receipt.terminal && receipt.cumulativeRaw === '0') {
      // Plain 404/absence, local lease expiry, or a caller-supplied label can NEVER release reservations.
      if (!provider.permanentTombstoneSupported) return null;
      try { validateNoFutureAcceptance(record, attempt, receipt); } catch { return null; }
      if (!await provider.verifyNoFutureAcceptance(record, attempt, receipt)) return null;
    }
    await provider.admitReceipt(receipt);
    return receipt;
  }
  return {
    async authorize(record, attempt) {
      requireFinancial(record.intent.network === provider.network, 'provider-network-mismatch');
      const authorization = await provider.lockScope(record, attempt);
      validateFinancialAuthorization(record, attempt, authorization, await provider.now());
      requireFinancial(authorization.providerIdentity === provider.identity, 'provider-authorization-identity-mismatch');
      return authorization;
    },
    async submit(record, attempt, authorization) {
      const exposure = await provider.currentExposure(record, authorization);
      const now = await provider.now();
      validateFinancialAuthorization(record, attempt, authorization, now);
      requireFinancial(authorization.providerIdentity === provider.identity && exposure.userId === record.userId
        && exposure.chain === record.intent.chain && exposure.network === provider.network && exposure.venue === record.intent.venue
        && exposure.positionId === record.intent.positionId && exposure.accountId === record.intent.accountId
        && exposure.assetId === record.intent.assetId && exposure.assetScale === record.intent.assetScale
        && exposure.mode === record.intent.mode && exposure.positionSide === record.intent.positionSide, 'provider-exposure-scope-mismatch');
      const observed = Date.parse(financialTime(exposure.observedAt)), time = Date.parse(financialTime(now));
      requireFinancial(observed <= time && time - observed <= 30_000 && Date.parse(financialTime(exposure.validUntil)) > time,
        'provider-exposure-stale');
      financialText(exposure.proof);
      reducingRemainder(exposure.positionSide, record.intent.side, exposure.heldRaw, record.intent.quantityRaw);
      // Provider must atomically compare deadline/tombstone and reject expired scope after ANY network or local pause.
      return provider.placeReduceOnly({ intentId: record.id, intentHash: record.intentHash, attemptId: attempt.id,
        userId: record.userId, chain: record.intent.chain, network: record.intent.network, mode: record.intent.mode,
        positionId: record.intent.positionId, accountId: record.intent.accountId, assetId: record.intent.assetId, assetScale: record.intent.assetScale,
        clientOrderId: attempt.clientOrderId, side: record.intent.side,
        quantity: rawToDecimal(record.intent.quantityRaw, record.intent.assetScale), limitPriceExact: record.intent.limitPriceExact,
        feeAssetId: record.intent.feeAssetId, feeAssetScale: record.intent.feeAssetScale, feeFundingAccountId: record.intent.feeFundingAccountId,
        maxFeeRaw: record.intent.maxFeeRaw, reduceOnly: true, timeInForce: 'IOC', deadline: authorization.deadline,
        exposureObservedAt: exposure.observedAt, exposureValidUntil: exposure.validUntil, scopeProof: authorization.scopeProof }, authorization);
    },
    reconcile(record, attempt) { return provider.reconcile(attempt.clientOrderId, record.intent.accountId, record.intent.assetId); },
    verify
  };
}
export type ReducingReceiptAdmissionClient = WithdrawalSqlClient;
