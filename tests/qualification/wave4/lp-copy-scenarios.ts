import { createLpPaperService, type LpPaperServiceDeps } from '../../../packages/db/src/lp-paper-service.js';
import { createLpPaperSqlStore, type LpTenantTransaction } from '../../../packages/db/src/lp-paper-store.js';
import { lpAcquisitionHash, lpExactHash, lpSnapshot, type LpExactPosition, type LpExactSubscription,
  type LpMasterMintEvidence, type LpRawAmount, type LpExactAcquisitionRequest, type LpExactPlan,
  type LpPaperQuote, type LpPaperReceipt } from '../../../packages/db/src/lp-exact.js';
import type { LpDurableHistoryObserver, LpDurableHistoryObservation } from './lp-durable-history-observer.js';
import type { LpPaperService } from '../../../packages/db/src/lp-paper-service.js';
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

export interface LpCompleteEconomicsExpectation {
  readonly rebalance: { readonly operationKey: string; readonly quote: LpPaperQuote;
    readonly plan: LpExactPlan; readonly receipt: LpPaperReceipt };
  readonly close: { readonly operationKey: string; readonly quote: LpPaperQuote; readonly receipt: LpPaperReceipt };
}
export type LpCompleteService = Pick<LpPaperService, 'acquire' | 'copyMint' | 'requestOperation' | 'process' | 'recover' | 'position' | 'operation'>;
function journalContent(observation: LpDurableHistoryObservation) {
  const { observedAt: _clock, ...content } = observation; return content;
}
/** Independent exact receipt folding: deliberately does not call production lpResultAfterReceipt,
 * lpEconomics, lpValueMicro or lpRecenterStrategy to certify the production answer. */
export function requireLpCompleteEconomics(observation: LpDurableHistoryObservation, acquired: LpExactPosition,
  expectedInput: LpCompleteEconomicsExpectation, completed: 0 | 1 | 2, pending = false): void {
  const expected = lpSnapshot(expectedInput);
  same(observation.acquisition, acquired, 'complete immutable acquisition');
  check(observation.operations.length === completed + (pending ? 1 : 0)
    && observation.receipts.length === completed && observation.history.length === 2 + completed,
    'complete operation/receipt cardinality');
  check(new Set(observation.operations.map(o => o.data.id)).size === observation.operations.length
    && new Set(observation.receipts.map(r => r.operationId)).size === observation.receipts.length,
  'complete unique operation and receipt identities');
  let position = lpSnapshot(acquired), fees = 0n, costs = 0n;
  const steps = [expected.rebalance, expected.close] as const;
  for (let i = 0; i < completed + (pending ? 1 : 0); i++) {
    const step = steps[i]!, operation = observation.operations[i]!.data;
    const action = i === 0 ? 'rebalance' : 'close';
    check(operation.userId === acquired.userId && operation.positionId === acquired.id && operation.action === action
      && operation.operationKey === step.operationKey && operation.positionRevision === i.toString(), 'complete operation scope/revision');
    const intent = lpExactHash({ positionId: acquired.id, action, revision: i.toString(), amountBefore: position.currentAmount,
      chain: acquired.chain, poolAddress: acquired.poolAddress, depositAsset: acquired.depositAsset });
    check(operation.fingerprint === intent && operation.receiptKey === `lp-receipt-${lpExactHash([acquired.userId, step.operationKey, intent])}`,
      'complete operation/receipt intent');
    same(operation.quote, step.quote, 'independently expected full operation quote');
    same(operation.plan, i === 0 ? expected.rebalance.plan : null, 'independently expected replacement plan');
    same(operation.amountBefore, position.currentAmount, 'complete operation inventory');
    const chronology = observation.operations[i]!;
    const timestamp = (text: string) => {
      const value = Date.parse(text); check(Number.isFinite(value) && new Date(value).toISOString() === text,
        'complete canonical chronology required'); return value;
    };
    check(timestamp(chronology.createdAt) >= timestamp(step.quote.observedAt)
      && timestamp(chronology.createdAt) < timestamp(step.quote.expiresAt)
      && timestamp(chronology.createdAt) <= timestamp(observation.observedAt), 'complete operation admission chronology');
    const q = step.quote;
    const valuation = raw(position.currentAmount.raw) * raw(q.unitPriceUsd.raw) * 1_000_000n
      / 10n ** BigInt(position.currentAmount.scale + q.unitPriceUsd.scale);
    check(q.userId === acquired.userId && q.action === action && q.intentHash === intent && q.mode === 'paper'
      && q.providerId === acquired.acquisitionQuote.providerId && q.pool.chain === acquired.chain
      && q.pool.networkId === acquired.acquisitionQuote.pool.networkId && q.pool.protocol === acquired.protocol
      && q.pool.poolAddress === acquired.poolAddress && q.pool.depositAsset === acquired.depositAsset
      && q.valueMicroUsd === valuation.toString(), 'complete independent quote scope/value');
    same(q.deposit, position.currentAmount, 'complete quoted before inventory');
    if (i === 0) {
      const e = q.economics;
      check(e && e.basis === 'incremental-rebalance', 'complete incremental economics required');
      const net = raw(e.extraFeesMicroUsd) + BigInt(e.inventoryChangeMicroUsd) - raw(e.impermanentLossMicroUsd)
        - raw(e.gasMicroUsd) - raw(e.repositionMicroUsd);
      check(net > 0n, 'independently positive rebalance economics required');
      same(q.amountAfter, position.currentAmount, 'rebalance cannot substitute inventory');
      check(q.proceedsMicroUsd === '0', 'rebalance cannot realize quoted fees');
      const allocations = expected.rebalance.plan.rungs.reduce((sum, rung) => sum + raw(rung.allocation.raw), 0n);
      check(allocations === raw(position.currentAmount.raw)
        && expected.rebalance.plan.rungs.every(rung => rung.allocation.scale === position.currentAmount.scale), 'replacement plan exact conservation');
      const beforeStrategy = position.plan.strategy, afterStrategy = expected.rebalance.plan.strategy;
      const relative = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * 1e-12;
      check(afterStrategy.distribution === beforeStrategy.distribution && afterStrategy.rungCount === beforeStrategy.rungCount
        && relative(afterStrategy.rangeUpper / afterStrategy.rangeLower, beforeStrategy.rangeUpper / beforeStrategy.rangeLower)
        && relative(Math.sqrt(afterStrategy.rangeUpper * afterStrategy.rangeLower), q.pool.currentPrice),
      'independent geometric recenter preserves strategy width');
    } else {
      same(q.amountAfter, { raw: '0', scale: acquired.deposit.scale }, 'complete close zero inventory');
      check(q.proceedsMicroUsd === valuation.toString(), 'independent close proceeds value');
    }
    if (i >= completed) {
      check(operation.status === 'pending' && operation.receipt === null && observation.operations[i]!.completedAt === null,
        'pending admission is not completion'); continue;
    }
    const receipt = step.receipt, stored = observation.receipts.find(r => r.operationId === operation.id);
    check(operation.status === 'completed' && stored && stored.hash === lpExactHash(receipt), 'complete independently hashed receipt');
    same(operation.receipt, receipt, 'complete operation receipt'); same(stored.data, receipt, 'complete stored receipt body');
    check(chronology.completedAt !== null && timestamp(receipt.settledAt) >= timestamp(chronology.createdAt)
      && timestamp(stored.acceptedAt) >= timestamp(receipt.settledAt)
      && timestamp(chronology.completedAt) >= timestamp(stored.acceptedAt)
      && timestamp(chronology.completedAt) <= timestamp(observation.observedAt), 'complete receipt/completion chronology');
    check(receipt.providerId === q.providerId && receipt.userId === acquired.userId && receipt.positionId === acquired.id
      && receipt.positionRevision === i.toString() && receipt.action === action && receipt.mode === 'paper'
      && receipt.finality === 'paper-settled' && receipt.networkId === q.pool.networkId && receipt.chain === acquired.chain
      && receipt.protocol === acquired.protocol && receipt.poolAddress === acquired.poolAddress && receipt.depositAsset === acquired.depositAsset
      && receipt.receiptKey === operation.receiptKey && receipt.quoteId === q.quoteId && receipt.quoteHash === lpExactHash(q)
      && receipt.proceedsMicroUsd === q.proceedsMicroUsd, 'complete receipt context and actual economics');
    same(receipt.amountBefore, position.currentAmount, 'complete receipt before inventory');
    same(receipt.amountAfter, q.amountAfter, 'complete receipt after inventory');
    fees += raw(receipt.collectedFeesMicroUsd); costs += raw(receipt.executionCostsMicroUsd);
    position = { ...position, currentAmount: receipt.amountAfter, plan: i === 0 ? expected.rebalance.plan : position.plan,
      revision: (i + 1).toString(), state: i === 0 ? 'active' : 'closed', cumulativeFeesMicroUsd: fees.toString(),
      cumulativeCostsMicroUsd: costs.toString(), realizedMicroUsd: i === 0 ? null
        : (raw(receipt.proceedsMicroUsd) + fees - costs - raw(acquired.depositMicroUsd)).toString(), lastReceiptKey: receipt.receiptKey };
    check(observation.history.filter(h => h.reason.includes(receipt.receiptKey)).length === 1,
      'one economic state history entry per exact receipt');
  }
  same(observation.position, position, 'complete independent position economic fold');
  check(observation.history.filter(h => h.fromState === null && h.toState === 'building').length === 1
    && observation.history.filter(h => h.fromState === 'building' && h.toState === 'active').length === 1,
  'complete acquisition state history');
  check(observation.copies.length === (acquired.copyOrigin ? 1 : 0), 'complete copy execution linkage');
  if (acquired.copyOrigin) {
    const copy = observation.copies[0]!, origin = acquired.copyOrigin;
    check(copy.subscriptionId === origin.subscriptionId && copy.masterPositionId === origin.masterPositionId
      && copy.chain === acquired.chain && copy.action === 'mint' && copy.status === 'executed'
      && copy.masterMicroUsd === origin.masterDepositMicroUsd && copy.followerMicroUsd === acquired.depositMicroUsd,
    'complete independently observed copy linkage economics');
  }
}

/** Complete production acquisition/copy + rebalance + close + restart recovery. Recovery is a
 * queue hint only, processing may remain pending. No callback return grants completion and
 * the independently observed journals must remain unchanged on every replay. */
export async function qualifyLpCompleteLifecycle(service: LpCompleteService, observe: LpDurableHistoryObserver,
  scope: UserScope, acquisitionInput: { kind: 'copy'; expected: LpCopyExpectation }
    | { kind: 'acquisition'; request: LpExactAcquisitionRequest; quote: LpPaperQuote; plan: LpExactPlan },
  expectedInput: LpCompleteEconomicsExpectation) {
  const acquisition = lpSnapshot(acquisitionInput), expected = lpSnapshot(expectedInput);
  const acquire = () => acquisition.kind === 'copy'
    ? service.copyMint(scope, { subscriptionId: acquisition.expected.subscription.id, eventId: acquisition.expected.event.eventId,
      assetScale: acquisition.expected.assetScale }) : service.acquire(scope, acquisition.request);
  const acquired = await acquire();
  if (acquisition.kind === 'copy') requireAcquisition(acquired, scope, acquisition.expected);
  else {
    const r = acquisition.request, q = acquisition.quote;
    same(acquired.acquisitionQuote, q, 'independent direct acquisition quote'); same(acquired.plan, acquisition.plan, 'direct acquisition plan');
    same(acquired.deposit, r.deposit, 'direct raw acquisition'); same(acquired.currentAmount, r.deposit, 'direct initial inventory');
    same(q.deposit, r.deposit, 'direct acquisition quoted inventory'); same(q.amountAfter, r.deposit, 'direct acquisition quoted result');
    same(acquisition.plan.strategy, r.strategy, 'direct acquisition strategy');
    check(acquisition.plan.rungs.reduce((sum, rung) => sum + raw(rung.allocation.raw), 0n) === raw(r.deposit.raw)
      && acquisition.plan.rungs.every(rung => rung.allocation.scale === r.deposit.scale), 'direct plan independent raw conservation');
    const value = raw(r.deposit.raw) * raw(q.unitPriceUsd.raw) * 1_000_000n / 10n ** BigInt(r.deposit.scale + q.unitPriceUsd.scale);
    check(acquired.userId === scope.userId && acquired.chain === r.chain && acquired.poolAddress === r.poolAddress
      && acquired.depositAsset === r.depositAsset && acquired.acquisitionKey === r.operationKey
      && acquired.acquisitionFingerprint === lpAcquisitionHash(r) && acquired.depositMicroUsd === value.toString()
      && acquired.protocol === q.pool.protocol && acquired.mode === 'paper' && acquired.autoRebalance === (r.autoRebalance === true)
      && q.userId === scope.userId && q.intentHash === acquired.acquisitionFingerprint && q.action === 'acquire' && q.mode === 'paper'
      && q.pool.chain === r.chain && q.pool.poolAddress === r.poolAddress && q.pool.depositAsset === r.depositAsset
      && q.pool.depositScale === r.deposit.scale && q.valueMicroUsd === value.toString() && q.proceedsMicroUsd === '0'
      && acquired.copyOrigin === null && acquired.state === 'active' && acquired.revision === '0'
      && acquired.cumulativeFeesMicroUsd === '0' && acquired.cumulativeCostsMicroUsd === '0'
      && acquired.lastReceiptKey === null && acquired.realizedMicroUsd === null, 'complete direct acquisition identity/economics');
  }
  const initial = await observe(scope, acquired.id); requireLpCompleteEconomics(initial, acquired, expected, 0);
  same(await acquire(), acquired, 'complete immutable acquisition replay');
  same(journalContent(await observe(scope, acquired.id)), journalContent(initial), 'complete acquisition journal replay');
  const steps = [expected.rebalance, expected.close] as const;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!, action = i === 0 ? 'rebalance' : 'close';
    const admitted = await service.requestOperation(scope, { positionId: acquired.id, operationKey: step.operationKey, action });
    check(!admitted.broadcast && admitted.operation.status === 'pending' && admitted.operation.receipt === null, 'complete receiptless admission');
    const before = await observe(scope, acquired.id); requireLpCompleteEconomics(before, acquired, expected, i as 0 | 1, true);
    const recovery = await service.recover(scope, 100);
    check(Number.isInteger(recovery.queued) && Number.isInteger(recovery.deferred) && recovery.queued + recovery.deferred >= 1,
      'complete pending operation recovery observation');
    same(journalContent(await observe(scope, acquired.id)), journalContent(before), 'recovery cannot mutate economic journals');
    const done = await service.process(scope, { operationId: admitted.operation.id, chain: acquired.chain });
    check(done.operation.status === 'completed' && !done.receiptPending && !done.broadcast, 'complete independent receipt required');
    const after = await observe(scope, acquired.id); requireLpCompleteEconomics(after, acquired, expected, (i + 1) as 1 | 2);
    await service.process(scope, { operationId: admitted.operation.id, chain: acquired.chain });
    await service.requestOperation(scope, { positionId: acquired.id, operationKey: step.operationKey, action });
    same(journalContent(await observe(scope, acquired.id)), journalContent(after), 'complete durable operation replay');
  }
  const final = await observe(scope, acquired.id);
  same(await acquire(), acquired, 'complete replay cannot reopen capital');
  same(journalContent(await observe(scope, acquired.id)), journalContent(final), 'complete closed acquisition replay journal');
  return { scenario: acquisition.kind === 'copy' ? 'lp-copy-complete-durable-lifecycle' : 'lp-acquisition-complete-durable-lifecycle',
    boundary: lpCopyBoundary, blocked: [...lpCopyBlockers], evidence: { positionId: acquired.id,
      deposit: acquired.deposit, depositMicroUsd: acquired.depositMicroUsd, revision: final.position.revision,
      cumulativeFeesMicroUsd: final.position.cumulativeFeesMicroUsd, cumulativeCostsMicroUsd: final.position.cumulativeCostsMicroUsd,
      realizedMicroUsd: final.position.realizedMicroUsd, operations: final.operations.length,
      receipts: final.receipts.length, historyHash: lpExactHash(journalContent(final)) } };
}
