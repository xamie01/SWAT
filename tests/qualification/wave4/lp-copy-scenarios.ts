import { createLpPaperService, type LpPaperServiceDeps } from '../../../packages/db/src/lp-paper-service.js';
import { createLpPaperSqlStore, type LpTenantTransaction } from '../../../packages/db/src/lp-paper-store.js';
import { lpAcquisitionHash, lpExactHash, lpSnapshot, type LpExactPosition, type LpExactSubscription,
  type LpMasterMintEvidence, type LpRawAmount } from '../../../packages/db/src/lp-exact.js';
import type { UserScope } from '../../../packages/db/src/tenancy.js';

export const lpCopyBoundary = Object.freeze({ sourceImplemented: true, runtimeAccepted: false,
  liveCapabilityAccepted: false, productionReady: false } as const);
export const lpCopyBlockers = Object.freeze([
  'protected subscription initialization and authenticated tenant composition not supplied by qualification CLI',
  'protected master-event and copy-risk capability provenance must be independently qualified',
  'actual SQL roles RLS receipt triggers commit concurrency and observer evidence not executed'
]);
export interface LpCopyExpectation {
  readonly subscription: LpExactSubscription;
  readonly event: LpMasterMintEvidence;
  readonly unitPriceUsd: LpRawAmount;
  readonly priorSpentMicroUsd: string;
  readonly assetScale: number;
  readonly protocolProviderId: string;
  readonly riskProviderId: string;
  readonly collectedFeesMicroUsd: string;
  readonly executionCostsMicroUsd: string;
}
export interface LpCopyObservation {
  readonly acquisition: LpExactPosition;
  readonly position: LpExactPosition;
  readonly receipts: readonly { operationId: string; hash: string; data: unknown }[];
}
export type LpCopyObserver = (scope: UserScope, positionId: string) => Promise<LpCopyObservation>;
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`LP copy qualification: ${reason}`);
}
function raw(text: string): bigint {
  check(/^(0|[1-9][0-9]*)$/.test(text), 'canonical nonnegative integer required');
  return BigInt(text);
}
function same(actual: unknown, expected: unknown, reason: string): void {
  check(lpExactHash(actual) === lpExactHash(expected), reason);
}
function expectedCapital(expected: LpCopyExpectation) {
  const sub = expected.subscription, event = expected.event;
  check(Number.isInteger(expected.assetScale) && expected.assetScale >= 0 && expected.assetScale <= 36,
    'bounded asset scale required');
  check(Number.isInteger(expected.unitPriceUsd.scale) && expected.unitPriceUsd.scale >= 0 && expected.unitPriceUsd.scale <= 36,
    'bounded price scale required');
  const remaining = raw(sub.budgetMicroUsd) - raw(expected.priorSpentMicroUsd);
  const budget = [remaining, raw(sub.capMicroUsd), raw(event.masterDepositMicroUsd)].reduce((a, b) => a < b ? a : b);
  check(budget >= 1_000_000n && raw(expected.unitPriceUsd.raw) > 0n, 'independent budget below minimum or invalid price');
  const depositRaw = budget * 10n ** BigInt(expected.assetScale + expected.unitPriceUsd.scale)
    / (raw(expected.unitPriceUsd.raw) * 1_000_000n);
  const value = depositRaw * raw(expected.unitPriceUsd.raw) * 1_000_000n
    / 10n ** BigInt(expected.assetScale + expected.unitPriceUsd.scale);
  check(value >= 1_000_000n && value <= budget, 'independent exact sizing outside budget');
  return { budget: budget.toString(), deposit: { raw: depositRaw.toString(), scale: expected.assetScale }, value: value.toString() };
}
function requireAcquisition(p: LpExactPosition, scope: UserScope, expected: LpCopyExpectation): void {
  const { subscription: sub, event } = expected, capital = expectedCapital(expected);
  check(scope.userId === sub.userId && event.masterWalletAddress === sub.masterWalletAddress
    && event.chain === sub.chain && event.protocol === sub.venue && sub.status === 'active'
    && event.action === 'mint' && event.finality === 'finalized' && event.provenance === 'injected-mint-event',
  'independent subscription and forward-only event scope');
  check(p.userId === scope.userId && p.chain === sub.chain && p.protocol === sub.venue
    && p.poolAddress === event.poolAddress && p.depositAsset === event.depositAsset && p.mode === 'paper'
    && p.state === 'active' && p.revision === '0' && !p.autoRebalance
    && p.depositMicroUsd === capital.value && p.cumulativeFeesMicroUsd === '0'
    && p.cumulativeCostsMicroUsd === '0' && p.realizedMicroUsd === null && p.lastReceiptKey === null,
  'exact initial copy identity and economics');
  same(p.deposit, capital.deposit, 'independent raw sizing'); same(p.currentAmount, capital.deposit, 'initial inventory');
  same(p.plan.strategy, event.strategy, 'master strategy binding');
  const origin = p.copyOrigin;
  check(origin && origin.subscriptionId === sub.id && origin.subscriptionRevision === sub.revision
    && origin.eventId === event.eventId && origin.masterWalletAddress === event.masterWalletAddress
    && origin.masterPositionId === event.masterPositionId && origin.masterEvidenceHash === lpExactHash(event)
    && origin.masterDepositMicroUsd === event.masterDepositMicroUsd && origin.budgetMicroUsd === capital.budget,
  'immutable subscription event and budget origin');
  const operationKey = `copy-${lpExactHash([scope.userId, sub.id, event.eventId])}`;
  const fingerprint = lpAcquisitionHash({ operationKey, chain: sub.chain, poolAddress: event.poolAddress,
    depositAsset: event.depositAsset, deposit: capital.deposit, strategy: event.strategy, autoRebalance: false },
  { subscriptionId: sub.id, subscriptionRevision: sub.revision, eventId: event.eventId,
    masterWalletAddress: event.masterWalletAddress, masterPositionId: event.masterPositionId,
    masterEvidenceHash: lpExactHash(event), masterDepositMicroUsd: event.masterDepositMicroUsd, budgetMicroUsd: capital.budget });
  check(p.acquisitionKey === operationKey && p.acquisitionFingerprint === fingerprint, 'independent copy intent');
  const q = p.acquisitionQuote;
  check(q.providerId === expected.protocolProviderId && q.userId === scope.userId && q.action === 'acquire'
    && q.mode === 'paper' && q.intentHash === fingerprint && q.pool.chain === sub.chain && q.pool.protocol === sub.venue
    && q.pool.networkId === event.networkId && q.pool.poolAddress === event.poolAddress
    && q.pool.depositAsset === event.depositAsset && q.pool.depositScale === expected.assetScale
    && q.valueMicroUsd === capital.value && q.proceedsMicroUsd === '0', 'independent acquisition quote binding');
  same(q.deposit, capital.deposit, 'quote inventory'); same(q.amountAfter, capital.deposit, 'acquisition after inventory');
  same(q.unitPriceUsd, expected.unitPriceUsd, 'independent price');
  const risk = origin.riskEvidence;
  check(risk && risk.providerId === expected.riskProviderId && risk.userId === scope.userId
    && risk.subscriptionId === sub.id && risk.subscriptionRevision === sub.revision
    && risk.masterEvidenceHash === lpExactHash(event) && risk.intentHash === fingerprint
    && risk.poolEvidenceId === q.pool.evidenceId && risk.approved === true, 'stored copy-risk binding');
}

/** No ambient transaction fallback: callers must supply their already-owned transaction and protected ports. */
export function lpCopySqlService(transaction: LpTenantTransaction, ports: Omit<LpPaperServiceDeps, 'store'>) {
  check(typeof transaction === 'function', 'owned transaction required');
  return createLpPaperService({ ...ports, store: createLpPaperSqlStore(transaction) });
}

/** Invokes production services; an injected observer or fixture cannot grant runtime acceptance. */
export async function qualifyLpCopyLifecycle(deps: LpPaperServiceDeps, observe: LpCopyObserver,
  scope: UserScope, expectedInput: LpCopyExpectation, closeKey: string) {
  const expected = lpSnapshot(expectedInput), service = createLpPaperService(deps);
  const request = { subscriptionId: expected.subscription.id, eventId: expected.event.eventId, assetScale: expected.assetScale };
  const acquired = await service.copyMint(scope, request);
  requireAcquisition(acquired, scope, expected);
  const before = await observe(scope, acquired.id);
  same(before.acquisition, acquired, 'observer acquisition differs'); same(before.position, acquired, 'observer initial position differs');
  check(before.receipts.length === 0, 'acquisition must not create close receipts');
  same(await service.copyMint(scope, request), acquired, 'duplicate event changes immutable acquisition');
  same(await observe(scope, acquired.id), before, 'duplicate event changes inventory or journal');
  const admission = await service.requestOperation(scope, { positionId: acquired.id, operationKey: closeKey, action: 'close' });
  check(admission.operation.status === 'pending' && admission.operation.receipt === null && !admission.broadcast,
    'close admission must remain receiptless pending');
  same((await observe(scope, acquired.id)).position, acquired, 'close admission changes inventory before receipt');
  const result = await service.process(scope, { operationId: admission.operation.id, chain: acquired.chain });
  check(result.operation.status === 'completed' && !result.receiptPending && !result.broadcast, 'bound receipt required before completion');
  const after = await observe(scope, acquired.id), receipt = result.operation.receipt;
  check(receipt && after.receipts.length === 1 && after.receipts[0]!.operationId === result.operation.id
    && after.receipts[0]!.hash === lpExactHash(receipt), 'one stored hashed operation receipt');
  same(after.receipts[0]!.data, receipt, 'stored receipt body'); same(after.acquisition, acquired, 'acquisition snapshot mutated by close');
  const quote = admission.operation.quote;
  check(receipt.userId === scope.userId && receipt.positionId === acquired.id && receipt.positionRevision === '0'
    && receipt.providerId === expected.protocolProviderId && receipt.mode === 'paper' && receipt.finality === 'paper-settled'
    && receipt.action === 'close' && receipt.receiptKey === admission.operation.receiptKey
    && receipt.networkId === expected.event.networkId && receipt.chain === acquired.chain && receipt.protocol === acquired.protocol
    && receipt.poolAddress === acquired.poolAddress && receipt.depositAsset === acquired.depositAsset
    && receipt.quoteId === quote.quoteId && receipt.quoteHash === lpExactHash(quote)
    && receipt.proceedsMicroUsd === acquired.depositMicroUsd
    && receipt.collectedFeesMicroUsd === expected.collectedFeesMicroUsd
    && receipt.executionCostsMicroUsd === expected.executionCostsMicroUsd, 'exact close receipt provenance and economics');
  same(receipt.amountBefore, acquired.deposit, 'receipt original inventory');
  same(receipt.amountAfter, { raw: '0', scale: expected.assetScale }, 'receipt zero inventory');
  const realized = (raw(receipt.proceedsMicroUsd) + raw(expected.collectedFeesMicroUsd)
    - raw(expected.executionCostsMicroUsd) - raw(acquired.depositMicroUsd)).toString();
  same(after.position, { ...acquired, currentAmount: receipt.amountAfter, revision: '1', state: 'closed',
    cumulativeFeesMicroUsd: expected.collectedFeesMicroUsd, cumulativeCostsMicroUsd: expected.executionCostsMicroUsd,
    realizedMicroUsd: realized, lastReceiptKey: receipt.receiptKey }, 'complete exact closed position');
  await service.process(scope, { operationId: admission.operation.id, chain: acquired.chain });
  same(await service.copyMint(scope, request), acquired, 'event retry after close reopens capital');
  same(await observe(scope, acquired.id), after, 'receipt or master replay duplicates economics');
  return { scenario: 'lp-copy-exact-lifecycle', boundary: lpCopyBoundary, blocked: [...lpCopyBlockers],
    evidence: { positionId: acquired.id, operationId: admission.operation.id, deposit: acquired.deposit,
      depositMicroUsd: acquired.depositMicroUsd, realizedMicroUsd: realized, journalHash: lpExactHash(after) } };
}
