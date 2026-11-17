import type { UserScope } from './tenancy.js';
import type { LpChain } from '@swat/shared';
import {
  lpAcquisitionHash, lpAmountForBudget, lpAssertPlan, lpEconomics, lpExactHash, lpFresh, lpIdentity, lpKey, lpMicro,
  lpProtocol, lpRaw, lpRecenterStrategy, lpSameAmount, lpSnapshot, lpStrategy, lpTime, lpValueMicro,
  type LpCopyOrigin, type LpCopyRiskEvidence, type LpEconomicDecision, type LpExactAcquisitionRequest, type LpExactCapabilities,
  type LpExactOperation, type LpExactPlan, type LpExactPosition, type LpExactSubscription,
  type LpMasterMintEvidence, type LpPaperAction, type LpPaperQuote, type LpPaperReceipt, type LpRawAmount
} from './lp-exact.js';

export interface LpPaperPolicy {
  readonly totalMicroUsd: string;
  readonly poolMicroUsd: string;
  readonly unassessedPositions: number;
  readonly poolCapBps: number;
}
export interface LpPaperTransaction {
  acquisition(key: string): Promise<LpExactPosition | null>;
  position(id: string): Promise<LpExactPosition | null>;
  operation(id: string): Promise<LpExactOperation | null>;
  operationByKey(key: string): Promise<LpExactOperation | null>;
  pendingForPosition(id: string): Promise<LpExactOperation | null>;
  pending(limit: number): Promise<readonly LpExactOperation[]>;
  policy(chain: LpChain, poolAddress: string): Promise<LpPaperPolicy>;
  subscription(id: string): Promise<LpExactSubscription | null>;
  copyPosition(subscriptionId: string, eventId: string): Promise<LpExactPosition | null>;
  copySpentMicroUsd(subscriptionId: string): Promise<string>;
  insertAcquisition(input: LpAcquisitionCommit): Promise<LpExactPosition>;
  insertOperation(input: LpOperationCommit): Promise<LpExactOperation>;
  settle(operation: LpExactOperation, position: LpExactPosition, receipt: LpPaperReceipt): Promise<LpExactOperation>;
}
export interface LpPaperStore {
  /** Serializes all LP writers on tenant owner, then position/operation. Commits before returning. */
  transaction<T>(scope: UserScope, action: (tx: LpPaperTransaction) => Promise<T>): Promise<T>;
}
export interface LpAcquisitionCommit {
  readonly request: LpExactAcquisitionRequest;
  readonly fingerprint: string;
  readonly quote: LpPaperQuote;
  readonly plan: LpExactPlan;
  readonly origin: LpCopyOrigin | null;
}
export interface LpOperationCommit {
  readonly position: LpExactPosition;
  readonly operationKey: string;
  readonly fingerprint: string;
  readonly action: 'rebalance' | 'close';
  readonly quote: LpPaperQuote;
  readonly plan: LpExactPlan | null;
  readonly receiptKey: string;
}
export interface LpQuoteInput {
  readonly userId: string;
  readonly chain: LpChain;
  readonly poolAddress: string;
  readonly depositAsset: string;
  readonly deposit: LpRawAmount;
  readonly action: LpPaperAction;
  readonly intentHash: string;
  readonly positionId: string | null;
  readonly positionRevision: string | null;
}
/** Trusted server constructor input only. This port has no submit/sign/key/HTTP capability. */
export interface LpInjectedProtocolPort {
  readonly providerId: string;
  readonly networks: Readonly<Partial<Record<LpChain, string>>>;
  quote(input: LpQuoteInput): Promise<LpPaperQuote | null>;
  receipt(input: { readonly operation: LpExactOperation; readonly position: LpExactPosition }): Promise<LpPaperReceipt | null>;
}
export interface LpPaperServiceDeps {
  readonly store: LpPaperStore;
  readonly mode: (chain: LpChain) => Promise<'off' | 'paper' | 'live'>;
  readonly protocol?: LpInjectedProtocolPort;
  readonly plan: (quote: LpPaperQuote, strategy: LpExactAcquisitionRequest['strategy']) => Promise<LpExactPlan>;
  readonly enqueue?: (input: { userId: string; operationId: string; chain: LpChain }) => Promise<void>;
  readonly master?: { readonly providerId: string; read(eventId: string): Promise<LpMasterMintEvidence | null> };
  readonly copyRisk?: { readonly providerId: string; assess(input: {
    readonly userId: string; readonly subscription: LpExactSubscription; readonly event: LpMasterMintEvidence; readonly quote: LpPaperQuote
  }): Promise<LpCopyRiskEvidence | null> };
  readonly now?: () => Date;
}
function tenant(scope: UserScope): void {
  if (!scope || typeof scope.userId !== 'string' || !scope.userId.trim() || scope.userId === '*') throw new Error('LP tenant scope required');
}
function requestValid(request: LpExactAcquisitionRequest): void {
  lpKey(request.operationKey); lpIdentity(request.chain, request.poolAddress); lpIdentity(request.chain, request.depositAsset);
  lpRaw(request.deposit, true); lpStrategy(request.strategy);
  if (request.autoRebalance !== undefined && typeof request.autoRebalance !== 'boolean') throw new Error('LP autoRebalance boolean required');
}
export function lpValidateQuote(quote: LpPaperQuote, input: LpQuoteInput, provider: LpInjectedProtocolPort, now: Date, fresh = true): void {
  if (!quote || quote.version !== 1 || quote.providerId !== provider.providerId || !provider.providerId.trim()
      || !quote.quoteId?.trim() || quote.quoteId.length > 128 || quote.userId !== input.userId || quote.intentHash !== input.intentHash
      || quote.action !== input.action || quote.mode !== 'paper' || !quote.pool || quote.pool.chain !== input.chain
      || quote.pool.poolAddress !== input.poolAddress || quote.pool.depositAsset !== input.depositAsset
      || quote.pool.depositScale !== input.deposit.scale || !provider.networks[input.chain] || quote.pool.networkId !== provider.networks[input.chain]
      || !quote.pool.evidenceId?.trim() || !lpSameAmount(quote.deposit, input.deposit)) throw new Error('LP trusted quote binding refused');
  lpProtocol(input.chain, quote.pool.protocol); lpIdentity(input.chain, input.poolAddress); lpIdentity(input.chain, input.depositAsset);
  if (!Number.isFinite(quote.pool.currentPrice) || quote.pool.currentPrice <= 0) throw new Error('LP valid protocol price required');
  if (quote.pool.protocol === 'meteora-dlmm') {
    if (!Number.isSafeInteger(quote.pool.binStep) || quote.pool.binStep! <= 0 || quote.pool.tickSpacing !== null) throw new Error('LP trusted bin context required');
  } else if (!Number.isSafeInteger(quote.pool.tickSpacing) || quote.pool.tickSpacing! <= 0 || quote.pool.binStep !== null) throw new Error('LP trusted tick context required');
  lpTime(quote.observedAt); lpTime(quote.pool.observedAt);
  if (lpTime(quote.expiresAt) <= lpTime(quote.observedAt) || lpTime(quote.expiresAt) - lpTime(quote.observedAt) > 60_000) throw new Error('LP bounded quote expiry required');
  if (fresh) {
    lpFresh(quote.observedAt, now); lpFresh(quote.pool.observedAt, now);
    if (now.getTime() >= lpTime(quote.expiresAt)) throw new Error('LP quote expired');
  }
  if (lpValueMicro(input.deposit, quote.unitPriceUsd) !== quote.valueMicroUsd) throw new Error('LP exact valuation mismatch');
  lpRaw(quote.amountAfter); lpMicro(quote.proceedsMicroUsd);
  if (quote.amountAfter.scale !== input.deposit.scale) throw new Error('LP quote asset scale substitution');
  if (input.action === 'close') {
    if (lpRaw(quote.amountAfter) !== 0n) throw new Error('LP close quote must remove all inventory');
  } else if (!lpSameAmount(quote.amountAfter, input.deposit) || quote.proceedsMicroUsd !== '0') throw new Error('LP paper acquisition/rebalance inventory substitution');
  if (quote.economics !== null) {
    lpEconomics(quote.economics);
    if (lpTime(quote.economics.windowStart) < lpTime(quote.observedAt)
        || lpTime(quote.economics.windowEnd) - lpTime(quote.economics.windowStart) > 7 * 86400_000) throw new Error('LP economics horizon refused');
  }
}
export function lpOperationIntent(position: LpExactPosition, action: 'rebalance' | 'close'): string {
  return lpExactHash({ positionId: position.id, action, revision: position.revision, amountBefore: position.currentAmount,
    chain: position.chain, poolAddress: position.poolAddress, depositAsset: position.depositAsset });
}
function sameOperation(op: LpExactOperation, positionId: string, action: 'rebalance' | 'close'): void {
  if (op.positionId !== positionId || op.action !== action) throw new Error('LP operation replay conflict');
}
function ownedPosition(position: LpExactPosition | null, scope: UserScope): asserts position is LpExactPosition {
  if (!position || position.userId !== scope.userId || position.mode !== 'paper') throw new Error('LP owned exact paper position unavailable');
}
function quoteInput(scope: UserScope, position: LpExactPosition, action: 'rebalance' | 'close'): LpQuoteInput {
  return { userId: scope.userId, chain: position.chain, poolAddress: position.poolAddress, depositAsset: position.depositAsset,
    deposit: position.currentAmount, action, intentHash: lpOperationIntent(position, action), positionId: position.id, positionRevision: position.revision };
}
export function lpAssertPolicy(policy: LpPaperPolicy, valueMicroUsd: string): void {
  const total = lpMicro(policy.totalMicroUsd), pool = lpMicro(policy.poolMicroUsd), value = lpMicro(valueMicroUsd);
  if (value <= 0n || policy.unassessedPositions !== 0 || pool > total || !Number.isInteger(policy.poolCapBps)
      || policy.poolCapBps <= 0 || policy.poolCapBps > 10_000) throw new Error('LP exposure unassessed');
  // Inherited explicit first-allocation bootstrap; subsequent allocations obey configured portfolio concentration.
  if (total > 0n && (pool + value) * 10_000n > (total + value) * BigInt(policy.poolCapBps)) throw new Error('LP pool-exposure-cap');
}
export function lpValidateReceipt(receipt: LpPaperReceipt, op: LpExactOperation, position: LpExactPosition, provider: LpInjectedProtocolPort, now: Date): void {
  if (!receipt || receipt.version !== 1 || receipt.providerId !== provider.providerId || receipt.mode !== 'paper'
      || receipt.finality !== 'paper-settled' || !receipt.receiptId?.trim() || receipt.receiptId.length > 128
      || receipt.receiptKey !== op.receiptKey || receipt.userId !== op.userId || receipt.positionId !== op.positionId
      || receipt.positionRevision !== op.positionRevision || receipt.action !== op.action || receipt.chain !== position.chain
      || receipt.networkId !== provider.networks[position.chain] || receipt.networkId !== op.quote.pool.networkId
      || receipt.protocol !== position.protocol || receipt.poolAddress !== position.poolAddress || receipt.depositAsset !== position.depositAsset
      || receipt.quoteId !== op.quote.quoteId || receipt.quoteHash !== lpExactHash(op.quote)
      || !lpSameAmount(receipt.amountBefore, op.amountBefore) || !lpSameAmount(receipt.amountAfter, op.quote.amountAfter)
      || receipt.proceedsMicroUsd !== op.quote.proceedsMicroUsd) throw new Error('LP immutable receipt binding refused');
  lpRaw(receipt.amountBefore, true); lpRaw(receipt.amountAfter); lpMicro(receipt.proceedsMicroUsd);
  lpMicro(receipt.collectedFeesMicroUsd); lpMicro(receipt.executionCostsMicroUsd);
  const settled = lpTime(receipt.settledAt);
  // Historical receipts remain recoverable after quote expiry; freshness was checked at admission.
  if (settled < lpTime(op.quote.observedAt) || settled > now.getTime()) throw new Error('LP receipt settlement time refused');
  if (op.action === 'close' && lpRaw(receipt.amountAfter) !== 0n) throw new Error('LP receipt cannot falsely close remaining inventory');
}
export function lpResultAfterReceipt(position: LpExactPosition, op: LpExactOperation, receipt: LpPaperReceipt): LpExactPosition {
  if (op.positionRevision !== position.revision || !lpSameAmount(position.currentAmount, op.amountBefore)
      || position.state === 'closed') throw new Error('LP stale position revision refused');
  const fees = lpMicro(position.cumulativeFeesMicroUsd) + lpMicro(receipt.collectedFeesMicroUsd);
  const costs = lpMicro(position.cumulativeCostsMicroUsd) + lpMicro(receipt.executionCostsMicroUsd);
  lpMicro(fees.toString()); lpMicro(costs.toString());
  const realized = op.action === 'close' ? (lpMicro(receipt.proceedsMicroUsd) + fees - costs - lpMicro(position.depositMicroUsd)).toString() : null;
  if (realized !== null) lpMicro(realized, true);
  return { ...position, currentAmount: receipt.amountAfter, plan: op.plan ?? position.plan, revision: (lpMicro(position.revision) + 1n).toString(),
    state: op.action === 'close' ? 'closed' : 'active', cumulativeFeesMicroUsd: fees.toString(), cumulativeCostsMicroUsd: costs.toString(),
    realizedMicroUsd: realized, lastReceiptKey: receipt.receiptKey };
}

export function createLpPaperService(deps: LpPaperServiceDeps) {
  // Capture injected trust identity at server construction; later caller mutation cannot change accepted network/provider.
  deps = { ...deps,
    ...(deps.protocol ? { protocol: { providerId: deps.protocol.providerId, networks: lpSnapshot(deps.protocol.networks),
      quote: deps.protocol.quote.bind(deps.protocol), receipt: deps.protocol.receipt.bind(deps.protocol) } } : {}),
    ...(deps.master ? { master: { providerId: deps.master.providerId, read: deps.master.read.bind(deps.master) } } : {}),
    ...(deps.copyRisk ? { copyRisk: { providerId: deps.copyRisk.providerId, assess: deps.copyRisk.assess.bind(deps.copyRisk) } } : {}) };
  const clock = deps.now ?? (() => new Date());
  async function paper(chain: LpChain): Promise<void> {
    if (await deps.mode(chain) !== 'paper') throw new Error('LP current mode refuses paper mutation; live protocol unavailable');
  }
  function provider(): LpInjectedProtocolPort {
    if (!deps.protocol) throw new Error('LP injected quote/receipt capability unavailable');
    return deps.protocol;
  }
  async function hint(scope: UserScope, op: LpExactOperation, chain: LpChain): Promise<boolean> {
    if (op.userId !== scope.userId || op.status !== 'pending' || !deps.enqueue) return false;
    try {
      if (await deps.mode(chain) !== 'paper') return false;
      await deps.enqueue({ userId: scope.userId, operationId: op.id, chain }); return true;
    } catch { return false; }
  }
  async function acquire(scope: UserScope, input: LpExactAcquisitionRequest): Promise<LpExactPosition> {
    tenant(scope); const request = lpSnapshot(input); requestValid(request);
    const fingerprint = lpAcquisitionHash(request);
    const replay = await deps.store.transaction(scope, tx => tx.acquisition(request.operationKey));
    if (replay) {
      ownedPosition(replay, scope);
      if (replay.acquisitionFingerprint !== fingerprint) throw new Error('LP acquisition replay conflict');
      return replay;
    }
    await paper(request.chain);
    const port = provider();
    const qInput: LpQuoteInput = { userId: scope.userId, chain: request.chain, poolAddress: request.poolAddress, depositAsset: request.depositAsset,
      deposit: request.deposit, action: 'acquire', intentHash: fingerprint, positionId: null, positionRevision: null };
    const output = await port.quote(lpSnapshot(qInput));
    if (!output) throw new Error('LP trusted quote unavailable');
    const quote = lpSnapshot(output); lpValidateQuote(quote, qInput, port, clock());
    const plan = lpSnapshot(await deps.plan(lpSnapshot(quote), lpSnapshot(request.strategy)));
    lpAssertPlan(plan, request.deposit, quote.pool.protocol, quote.pool.evidenceId);
    if (lpExactHash(plan.strategy) !== lpExactHash(request.strategy)) throw new Error('LP strategy substitution');
    return deps.store.transaction(scope, async tx => {
      const prior = await tx.acquisition(request.operationKey);
      if (prior) { ownedPosition(prior, scope); if (prior.acquisitionFingerprint !== fingerprint) throw new Error('LP acquisition replay conflict'); return prior; }
      await paper(request.chain); lpValidateQuote(quote, qInput, port, clock());
      lpAssertPolicy(await tx.policy(request.chain, request.poolAddress), quote.valueMicroUsd);
      return tx.insertAcquisition({ request, fingerprint, quote, plan, origin: null });
    });
  }
  async function requestOperation(scope: UserScope, input: { positionId: string; operationKey: string; action: 'rebalance' | 'close'; automatic?: boolean }) {
    tenant(scope); const request = lpSnapshot(input); lpKey(request.operationKey);
    if (!['rebalance', 'close'].includes(request.action)) throw new Error('LP action required');
    if (request.automatic !== undefined && typeof request.automatic !== 'boolean') throw new Error('LP automatic boolean required');
    const initial = await deps.store.transaction(scope, async tx => ({ position: await tx.position(request.positionId), replay: await tx.operationByKey(request.operationKey) }));
    ownedPosition(initial.position, scope); const position = initial.position;
    if (initial.replay) {
      sameOperation(initial.replay, position.id, request.action);
      return { operation: initial.replay, queued: await hint(scope, initial.replay, position.chain), broadcast: false as const };
    }
    await paper(position.chain);
    if (position.state === 'closed' || position.state === 'building' || position.state === 'rebalancing') throw new Error('LP position unavailable for admission');
    if (request.automatic && (request.action !== 'rebalance' || !position.autoRebalance)) throw new Error('LP automatic rebalance not opted in');
    const port = provider(); const qInput = quoteInput(scope, position, request.action);
    const output = await port.quote(lpSnapshot(qInput)); if (!output) throw new Error('LP operation quote unavailable');
    const quote = lpSnapshot(output); lpValidateQuote(quote, qInput, port, clock());
    if (quote.pool.protocol !== position.protocol) throw new Error('LP protocol substitution');
    const economics = lpEconomics(quote.economics);
    if (request.action === 'rebalance' && (!economics.assessed || !economics.shouldRebalance)) throw new Error(`LP rebalance ${economics.reason}`);
    const strategy = request.action === 'rebalance' ? lpRecenterStrategy(position.plan.strategy, quote.pool.currentPrice) : null;
    const plan = strategy ? lpSnapshot(await deps.plan(lpSnapshot(quote), lpSnapshot(strategy))) : null;
    if (plan) {
      lpAssertPlan(plan, position.currentAmount, position.protocol, quote.pool.evidenceId);
      if (lpExactHash(plan.strategy) !== lpExactHash(strategy)) throw new Error('LP rebalance strategy substitution');
    }
    const op = await deps.store.transaction(scope, async tx => {
      const prior = await tx.operationByKey(request.operationKey);
      if (prior) { sameOperation(prior, position.id, request.action); return prior; }
      const current = await tx.position(position.id); ownedPosition(current, scope);
      if (current.revision !== position.revision || current.state === 'closed' || !lpSameAmount(current.currentAmount, position.currentAmount)) throw new Error('LP stale operation admission');
      if (request.automatic && !current.autoRebalance) throw new Error('LP automatic consent changed');
      if (await tx.pendingForPosition(position.id)) throw new Error('LP pending operation fence');
      await paper(position.chain); lpValidateQuote(quote, qInput, port, clock());
      return tx.insertOperation({ position: current, operationKey: request.operationKey, fingerprint: qInput.intentHash,
        action: request.action, quote, plan, receiptKey: `lp-receipt-${lpExactHash([scope.userId, request.operationKey, qInput.intentHash])}` });
    });
    return { operation: op, queued: await hint(scope, op, position.chain), broadcast: false as const, economics };
  }
  async function process(scope: UserScope, input: { operationId: string; chain: LpChain }) {
    tenant(scope); const request = lpSnapshot(input);
    const initial = await deps.store.transaction(scope, tx => tx.operation(request.operationId));
    if (!initial || initial.userId !== scope.userId) throw new Error('LP canonical operation unavailable');
    const op = initial;
    const position = await deps.store.transaction(scope, tx => tx.position(op.positionId)); ownedPosition(position, scope);
    if (position.chain !== request.chain) throw new Error('LP canonical queue chain mismatch');
    if (op.status === 'completed') return { operation: op, receiptPending: false, broadcast: false as const };
    await paper(position.chain); const port = provider();
    const output = await port.receipt(lpSnapshot({ operation: op, position }));
    if (!output) return { operation: op, receiptPending: true, broadcast: false as const };
    const receipt = lpSnapshot(output); lpValidateReceipt(receipt, op, position, port, clock());
    const settled = await deps.store.transaction(scope, async tx => {
      const current = await tx.position(op.positionId); ownedPosition(current, scope);
      const saved = await tx.operation(op.id);
      if (!saved || saved.userId !== scope.userId) throw new Error('LP durable operation disappeared');
      if (saved.status === 'completed') {
        if (!saved.receipt || lpExactHash(saved.receipt) !== lpExactHash(receipt)) throw new Error('LP receipt replay conflict');
        return saved;
      }
      await paper(current.chain); lpValidateReceipt(receipt, saved, current, port, clock());
      lpResultAfterReceipt(current, saved, receipt);
      return tx.settle(saved, current, receipt);
    });
    return { operation: settled, receiptPending: false, broadcast: false as const };
  }
  async function recover(scope: UserScope, limit = 100): Promise<{ queued: number; deferred: number }> {
    tenant(scope); if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('LP bounded recovery required');
    const ops = await deps.store.transaction(scope, tx => tx.pending(limit));
    let queued = 0, deferred = 0;
    for (const op of ops) {
      const position = await deps.store.transaction(scope, tx => tx.position(op.positionId));
      if (!position || position.userId !== scope.userId || await deps.mode(position.chain) !== 'paper' || !await hint(scope, op, position.chain)) deferred++; else queued++;
    }
    return { queued, deferred };
  }
  async function copyMint(scope: UserScope, input: { subscriptionId: string; eventId: string; assetScale: number }): Promise<LpExactPosition> {
    tenant(scope); const request = lpSnapshot(input); lpKey(request.eventId); lpRaw({ raw: '0', scale: request.assetScale });
    const initial = await deps.store.transaction(scope, async tx => ({ sub: await tx.subscription(request.subscriptionId), prior: await tx.copyPosition(request.subscriptionId, request.eventId) }));
    const sub = initial.sub;
    if (!sub || sub.userId !== scope.userId) throw new Error('LP owned subscription unavailable');
    if (initial.prior) {
      ownedPosition(initial.prior, scope);
      if (initial.prior.deposit.scale !== request.assetScale) throw new Error('LP copy acquisition replay conflict');
      return initial.prior;
    }
    if (sub.status !== 'active') throw new Error('LP subscription not active');
    await paper(sub.chain); const port = provider();
    if (!deps.master) throw new Error('LP verified master mint evidence unavailable');
    const riskPort = deps.copyRisk;
    if (!riskPort || !riskPort.providerId.trim()) throw new Error('LP trusted copy risk capability unavailable');
    const output = await deps.master.read(request.eventId);
    if (!output) throw new Error('LP master evidence unavailable'); const event = lpSnapshot(output);
    if (event.providerId !== deps.master.providerId || !event.providerId.trim() || event.eventId !== request.eventId
        || event.action !== 'mint' || event.finality !== 'finalized' || event.provenance !== 'injected-mint-event'
        || event.chain !== sub.chain || event.protocol !== sub.venue || event.networkId !== port.networks[sub.chain]
        || event.masterWalletAddress !== sub.masterWalletAddress || !event.masterPositionId?.trim()
        || lpTime(event.openedAt) < lpTime(sub.createdAt) || lpTime(event.openedAt) > lpTime(event.observedAt)) throw new Error('LP canonical forward-only master evidence refused');
    lpFresh(event.observedAt, clock()); lpIdentity(event.chain, event.poolAddress); lpIdentity(event.chain, event.depositAsset); lpStrategy(event.strategy);
    const remaining = lpMicro(sub.budgetMicroUsd) - lpMicro(await deps.store.transaction(scope, tx => tx.copySpentMicroUsd(sub.id)));
    const budget = [remaining, lpMicro(sub.capMicroUsd), lpMicro(event.masterDepositMicroUsd)].reduce((a, b) => a < b ? a : b);
    if (budget < 1_000_000n) throw new Error('LP remaining copy budget below minimum');
    const operationKey = `copy-${lpExactHash([scope.userId, sub.id, event.eventId])}`;
    // Unit price is obtained for one exact whole unit; this discovery quote never acquires capital.
    const probe: LpRawAmount = { raw: (10n ** BigInt(request.assetScale)).toString(), scale: request.assetScale };
    const probeInput: LpQuoteInput = { userId: scope.userId, chain: sub.chain, poolAddress: event.poolAddress, depositAsset: event.depositAsset,
      deposit: probe, action: 'acquire', intentHash: lpExactHash(['copy-price', sub.id, event.eventId]), positionId: null, positionRevision: null };
    const probeOutput = await port.quote(lpSnapshot(probeInput)); if (!probeOutput) throw new Error('LP copy asset valuation unavailable');
    const priceQuote = lpSnapshot(probeOutput); lpValidateQuote(priceQuote, probeInput, port, clock());
    if (priceQuote.pool.protocol !== sub.venue) throw new Error('LP copy protocol mismatch');
    const deposit = lpAmountForBudget(budget.toString(), priceQuote.unitPriceUsd, request.assetScale);
    const acquisition: LpExactAcquisitionRequest = { operationKey, chain: sub.chain, poolAddress: event.poolAddress, depositAsset: event.depositAsset,
      deposit, strategy: event.strategy, autoRebalance: false };
    const origin: LpCopyOrigin = { subscriptionId: sub.id, subscriptionRevision: sub.revision, eventId: event.eventId,
      masterWalletAddress: event.masterWalletAddress, masterPositionId: event.masterPositionId, masterEvidenceHash: lpExactHash(event),
      masterDepositMicroUsd: event.masterDepositMicroUsd, budgetMicroUsd: budget.toString() };
    const fingerprint = lpAcquisitionHash(acquisition, origin);
    const qInput = { ...probeInput, deposit, intentHash: fingerprint };
    const quoteOutput = await port.quote(lpSnapshot(qInput)); if (!quoteOutput) throw new Error('LP follower acquisition quote unavailable');
    const quote = lpSnapshot(quoteOutput); lpValidateQuote(quote, qInput, port, clock());
    if (quote.pool.protocol !== sub.venue || lpMicro(quote.valueMicroUsd) > budget || lpMicro(quote.valueMicroUsd) < 1_000_000n) throw new Error('LP follower valuation exceeds exact sizing');
    const riskOutput = await riskPort.assess(lpSnapshot({ userId: scope.userId, subscription: sub, event, quote }));
    if (!riskOutput) throw new Error('LP trusted copy risk unavailable');
    const riskEvidence = lpSnapshot(riskOutput);
    if (riskEvidence.providerId !== riskPort.providerId || riskEvidence.userId !== scope.userId || riskEvidence.subscriptionId !== sub.id
        || riskEvidence.subscriptionRevision !== sub.revision || riskEvidence.masterEvidenceHash !== origin.masterEvidenceHash
        || riskEvidence.intentHash !== fingerprint || riskEvidence.poolEvidenceId !== quote.pool.evidenceId || riskEvidence.approved !== true) throw new Error('LP trusted copy risk binding refused');
    lpFresh(riskEvidence.observedAt, clock());
    if (lpTime(riskEvidence.observedAt) < lpTime(quote.observedAt)) throw new Error('LP copy risk predates quote');
    const assessedOrigin: LpCopyOrigin = { ...origin, riskEvidence };
    const plan = lpSnapshot(await deps.plan(lpSnapshot(quote), lpSnapshot(event.strategy))); lpAssertPlan(plan, deposit, sub.venue, quote.pool.evidenceId);
    if (lpExactHash(plan.strategy) !== lpExactHash(event.strategy)) throw new Error('LP copy strategy substitution');
    return deps.store.transaction(scope, async tx => {
      const prior = await tx.copyPosition(sub.id, event.eventId);
      if (prior) { ownedPosition(prior, scope); if (prior.deposit.scale !== request.assetScale) throw new Error('LP copy acquisition replay conflict'); return prior; }
      const current = await tx.subscription(sub.id);
      if (!current || current.userId !== scope.userId || current.status !== 'active' || current.revision !== sub.revision
          || current.chain !== sub.chain || current.venue !== sub.venue || current.masterWalletAddress !== sub.masterWalletAddress) throw new Error('LP subscription authority changed');
      const spent = lpMicro(await tx.copySpentMicroUsd(sub.id));
      if (spent + lpMicro(quote.valueMicroUsd) > lpMicro(current.budgetMicroUsd) || lpMicro(quote.valueMicroUsd) > lpMicro(current.capMicroUsd)) throw new Error('LP copy budget reservation conflict');
      await paper(sub.chain); lpFresh(event.observedAt, clock()); lpFresh(riskEvidence.observedAt, clock()); lpValidateQuote(quote, qInput, port, clock());
      lpAssertPolicy(await tx.policy(sub.chain, event.poolAddress), quote.valueMicroUsd);
      return tx.insertAcquisition({ request: acquisition, fingerprint, quote, plan, origin: assessedOrigin });
    });
  }
  return {
    acquire, requestOperation, process, recover, copyMint,
    position: async (scope: UserScope, id: string) => {
      tenant(scope); const value = await deps.store.transaction(scope, tx => tx.position(id));
      if (value) ownedPosition(value, scope); return value;
    },
    operation: async (scope: UserScope, id: string) => {
      tenant(scope); const value = await deps.store.transaction(scope, tx => tx.operation(id));
      if (value && value.userId !== scope.userId) throw new Error('LP owned operation unavailable'); return value;
    },
    capabilities: (): LpExactCapabilities => ({ sourceImplemented: true, injectedPortsConfigured: !!deps.protocol,
      runtimeAccepted: false, liveCapabilityAccepted: false, fractionalRawscaleDto: true, legacyNumericDtoFractionalCapability: false,
      reason: deps.protocol ? 'keyless injected-data contract only; no runtime/provider/live acceptance' : 'trusted quote/receipt protocol provider unavailable' })
  };
}
export type LpPaperService = ReturnType<typeof createLpPaperService>;
export type { LpEconomicDecision };
