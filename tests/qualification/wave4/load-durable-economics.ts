import { sourceBindingDigest } from '../../../packages/db/src/source-verification.js';
import { captureLoadFixture, loadAmount, loadCheck, loadDecimal, loadDigest, loadEqual, loadJson, loadReceiptDigest,
  loadScope, loadTime, loadUnits, loadUuid, type LoadAdmission, type LoadDurableSnapshot, type LoadFixture,
  type LoadHttpAttempt, type LoadScope } from './load-durable-contract.js';

export interface LoadFinalAccounting {
  readonly scope: LoadScope;
  readonly fixtures: readonly LoadFixture[];
  readonly attempts: readonly LoadHttpAttempt[];
  readonly admissions: readonly LoadAdmission[];
  readonly durable: LoadDurableSnapshot;
}
function unique<T>(rows: readonly T[], key: (row: T) => string, reason: string): void {
  loadCheck(new Set(rows.map(key)).size === rows.length, reason);
}
function one<T>(rows: readonly T[], predicate: (row: T) => boolean, reason: string): T {
  const found = rows.filter(predicate); loadCheck(found.length === 1, reason); return found[0]!;
}
/** Acquisition-only contained load contract. Every declared HTTP attempt must
 * join exactly once to a protected outcome; every admitted fixture must join
 * actual canonical source, obligation, fence, original fill, receipt, trade,
 * application, risk, capacity, position and lot. Replay creates NO economic row.
 * No queue/HTTP counters, non-null fields or caller callback can close this gate.
 * Exact raw/scale economics come from the independently specified fixture plan,
 * not provider price recomputation nor the worker's SQL SUM function. */
export function requireLoadFinalAccounting(input: LoadFinalAccounting) {
  loadJson(input); const scope = loadScope(input.scope), d = input.durable;
  loadEqual(d.scope, scope, 'independent durable export run/namespace mismatch');
  loadCheck(input.fixtures.length > 0 && input.fixtures.length <= 10_000 && input.attempts.length > 0,
    'bounded nonempty independent fixtures and actual attempts required');
  const fixtures = input.fixtures.map(captureLoadFixture);
  unique(fixtures, f => f.fixtureId, 'duplicate fixture');
  unique(fixtures, f => f.binding.sourceEventId, 'aliased source identity');
  unique(fixtures, f => f.tokenMint, 'contained token namespaces must not alias');
  unique(input.attempts, a => a.attemptId, 'duplicate HTTP attempt');
  unique(input.admissions, a => a.attemptId, 'duplicate protected attempt outcome');
  loadCheck(input.admissions.length === input.attempts.length, 'every HTTP attempt requires independent protected outcome');
  const admitted: { fixture: LoadFixture; admission: LoadAdmission }[] = [];
  for (const fixture of fixtures) {
    loadEqual(fixture.scope, scope, 'foreign fixture run/backend');
    const attempts = input.attempts.filter(a => a.fixtureId === fixture.fixtureId);
    loadCheck(attempts.length > 0, 'unattempted fixture cannot be success');
    let original: LoadAdmission | undefined;
    for (const attempt of attempts) {
      loadUuid(attempt.attemptId); loadTime(attempt.startedAt); loadTime(attempt.finishedAt);
      loadCheck(Date.parse(attempt.finishedAt) >= Date.parse(attempt.startedAt) && Number.isSafeInteger(attempt.status)
        && attempt.status >= 100 && attempt.status <= 599 && attempt.runId === scope.runId
        && attempt.namespace === scope.namespace && attempt.userId === fixture.userId
        && attempt.requestDigest === fixture.requestDigest
        && attempt.route === (fixture.kind === 'wallet' ? '/v1/me/wallets' : '/v1/me/tokens/backfill'),
      'exact HTTP attempt tenant/request/route/time mismatch');
      const a = one(input.admissions, a => a.attemptId === attempt.attemptId, 'protected admission missing');
      loadTime(a.admittedAt);
      loadCheck(Date.parse(a.admittedAt) >= Date.parse(attempt.startedAt)
        && a.fixtureId === fixture.fixtureId && a.userId === fixture.userId && a.runId === scope.runId
        && a.namespace === scope.namespace && a.requestDigest === fixture.requestDigest,
      'protected admission does not exactly join authenticated HTTP attempt');
      if (a.outcome === 'refused') {
        loadCheck(typeof a.reason === 'string' && a.reason.length > 0 && a.sourceTradeId === null && a.signalId === null
          && a.executionId === null && a.jobId === null && ![200, 201].includes(attempt.status),
        'refusal cannot hide success or carry a financial obligation');
        continue;
      }
      loadCheck(['admitted', 'replay'].includes(a.outcome) && [200, 201].includes(attempt.status) && a.reason === null,
        'success HTTP code is comparison only, protected admitted/replay outcome required');
      loadUuid(a.sourceTradeId); loadUuid(a.signalId); loadUuid(a.executionId);
      loadCheck(a.jobId === `source-trade-${a.signalId}-u-${fixture.userId}`, 'exact production durable job identity required');
      if (a.outcome === 'admitted') {
        loadCheck(!original, 'multiple original admissions for one fixture'); original = a;
        admitted.push({ fixture, admission: a });
      } else {
        loadCheck(original && Date.parse(a.admittedAt) >= Date.parse(original.admittedAt), 'orphan/reordered replay admission');
        loadEqual([a.sourceTradeId, a.signalId, a.executionId, a.jobId],
          [original.sourceTradeId, original.signalId, original.executionId, original.jobId], 'replay changed original obligation');
      }
    }
  }
  loadCheck(input.attempts.every(a => fixtures.some(f => f.fixtureId === a.fixtureId)), 'unknown/orphan HTTP attempt');
  loadCheck(admitted.length > 0, 'count-only/all-refusal/queue-only success is insufficient');
  for (const key of ['sourceTradeId', 'signalId', 'executionId', 'jobId'] as const) {
    unique(admitted, a => a.admission[key]!, `aliased admitted ${key}`);
  }
  for (const rows of [d.sources, d.executions, d.deliveries, d.workerAttempts, d.evidence, d.trades,
    d.receipts, d.applications, d.lots, d.risk, d.capacity]) {
    loadCheck(rows.length === admitted.length, 'missing, extra, unknown or orphan durable economics');
  }
  loadCheck(d.corrections.length === 0 && d.reductions.length === 0,
    'unqualified correction/sell/reduction cannot close acquisition-only load');
  unique(d.positions, p => p.id, 'duplicate position');
  unique(d.evidence, e => e.id, 'duplicate original fill');
  unique(d.evidence, e => e.evidenceId, 'duplicate receipt evidence identity');
  unique(d.trades, t => t.id, 'duplicate trade'); unique(d.receipts, r => r.receiptId, 'duplicate financial receipt');
  unique(d.lots, l => l.id, 'duplicate acquisition lot');
  const positionTotals = new Map<string, { base: bigint; basis: bigint }>();
  let totalBase = 0n, totalQuote = 0n, totalFee = 0n;
  for (const { fixture: f, admission: a } of admitted) {
    const source = one(d.sources, s => s.id === a.sourceTradeId, 'one independent canonical source required');
    loadEqual(source.binding, f.binding, 'source immutable raw/scale/network/asset binding changed');
    loadCheck(source.bindingDigest === sourceBindingDigest(f.binding) && source.accepted === true
      && ['confirmed', 'finalized'].includes(source.finality) && source.applicationActive === true
      && typeof source.evidenceId === 'string' && source.evidenceId.length > 0, 'protected accepted source/application required');
    const execution = one(d.executions, e => e.id === a.executionId, 'one canonical obligation required');
    const base = loadAmount(f.base), quote = loadAmount(f.quote, true), fee = loadAmount(f.fee, true);
    const debit = loadDecimal(loadUnits(quote, true) + loadUnits(fee, true));
    loadEqual(execution, { id: a.executionId, signalId: a.signalId, sourceTradeId: a.sourceTradeId, userId: f.userId,
      targetAccount: f.targetAccount, chain: 'solana', tokenMint: f.tokenMint, direction: 'buy', executionMode: 'paper',
      state: 'confirmed', requestedBase: null, requestedQuote: loadAmount(f.quoteBudget, true), confirmedBase: base, confirmedQuote: quote,
      quoteUnknown: '0' }, 'durable confirmed obligation economics/tenant/scope changed');
    const delivery = one(d.deliveries, r => r.executionId === execution.id, 'one durable delivery required');
    loadCheck(delivery.signalId === execution.signalId && delivery.userId === f.userId && delivery.targetAccount === f.targetAccount
      && delivery.executionMode === 'paper' && delivery.jobId === a.jobId && delivery.state === 'completed'
      && /^[1-9]\d*$/.test(delivery.fence), 'completed durable delivery exact scope/fence mismatch');
    const descriptor = delivery.descriptor as { chain?: unknown; options?: { jobId?: unknown }; data?: Record<string, unknown> };
    loadCheck(descriptor && descriptor.chain === 'solana' && descriptor.options?.jobId === a.jobId && descriptor.data,
      'canonical persisted descriptor required');
    for (const [key, value] of Object.entries({ copyExecutionId: execution.id, signalId: execution.signalId,
      sourceTradeId: execution.sourceTradeId, userId: f.userId, chain: 'solana', tokenMint: f.tokenMint,
      targetAccount: f.targetAccount, masterWalletAddress: f.walletAddress, executionMode: 'paper', direction: 'buy',
      requestedBaseQuantity: null, requestedQuoteQuantity: loadAmount(f.quoteBudget, true), exitLotId: null })) {
      loadEqual(descriptor.data[key], value, `persisted descriptor ${key} mismatch`);
    }
    loadCheck(Number.isSafeInteger(descriptor.data.score) && Number(descriptor.data.score) >= 80
      && Number(descriptor.data.score) <= 100, 'persisted approved entry score required');
    const attempt = one(d.workerAttempts, r => r.executionId === execution.id, 'one settled worker fence required');
    loadCheck(attempt.userId === f.userId && attempt.fence === delivery.fence && attempt.state === 'settled'
      && typeof attempt.policyRevision === 'string' && attempt.policyRevision.length > 0
      && typeof attempt.riskEpoch === 'string' && /^[1-9]\d*$/.test(attempt.riskEpoch), 'worker fence/policy/risk mismatch');
    const evidence = one(d.evidence, r => r.executionId === execution.id, 'one original independent fill required');
    loadUuid(evidence.id);
    loadCheck(evidence.userId === f.userId && evidence.sourceTradeId === a.sourceTradeId && evidence.evidenceType === 'paper_simulation'
      && ['confirmed', 'finalized'].includes(evidence.confirmationState) && evidence.completes === true
      && evidence.applicationActive === true && evidence.correctionId === null && evidence.base === base
      && evidence.quote === quote && evidence.fee === fee && evidence.effectiveQuote === quote && evidence.effectiveFee === fee
      && evidence.quoteCurrency === 'USD' && evidence.nativeQuote === null && evidence.nativePrice === null,
    'original/effective fill unknown or non-exact economics');
    const trade = one(d.trades, r => r.executionId === execution.id, 'one independently persisted trade required');
    loadUuid(trade.id);
    loadEqual(trade, { id: trade.id, executionId: execution.id, userId: f.userId, signalId: a.signalId,
      sourceTradeId: a.sourceTradeId, tokenMint: f.tokenMint, chain: 'solana', direction: 'buy', executionMode: 'paper',
      base, quote, fee, status: 'filled' }, 'persisted trade exact economics mismatch');
    const receipt = one(d.receipts, r => r.snapshot.executionId === execution.id, 'one immutable economic receipt required');
    loadCheck(receipt.receiptId === loadReceiptDigest(receipt.snapshot), 'canonical financial snapshot hash mismatch');
    loadEqual(receipt.snapshot, { executionId: execution.id, userId: f.userId, tradeId: trade.id, fence: attempt.fence,
      totals: { base, quote, debit, fee, unknown: '0', quoteUnknown: '0', completes: true, evidenceCount: '1' },
      accountingComplete: true }, 'financial receipt cannot infer success from non-null fields');
    const application = one(d.applications, r => r.evidenceId === evidence.id, 'one original position application required');
    const position = one(d.positions, r => r.id === application.positionId, 'owned aggregate position required');
    loadEqual(application, { evidenceId: evidence.id, executionId: execution.id, positionId: position.id, userId: f.userId,
      targetAccount: f.targetAccount, tokenMint: f.tokenMint, chain: 'solana', active: true }, 'application exact ownership mismatch');
    loadCheck(position.userId === f.userId && position.targetAccount === f.targetAccount && position.tokenMint === f.tokenMint
      && position.chain === 'solana', 'owned position scope changed');
    const lot = one(d.lots, r => r.acquisitionExecutionId === execution.id, 'one exact owned acquisition lot required');
    loadEqual(lot, { id: lot.id, positionId: position.id, userId: f.userId, tokenMint: f.tokenMint, chain: 'solana',
      masterWalletAddress: f.walletAddress, acquisitionExecutionId: execution.id, acquisitionEvidenceId: evidence.id,
      acquisitionSourceTradeId: a.sourceTradeId, acquisitionMode: 'paper', acquiredBase: base, remainingBase: base,
      acquiredBasis: debit, remainingBasis: debit }, 'lot quantity and debit conservation mismatch');
    const risk = one(d.risk, r => r.executionId === execution.id, 'one independently confirmed risk debit required');
    loadEqual(risk, { executionId: execution.id, account: f.userId, epoch: attempt.riskEpoch, state: 'confirmed', debit,
      liability: debit, chain: 'solana', executionMode: 'paper' },
      'risk reservation exact fee-inclusive debit/liability/scope mismatch');
    const capacity = one(d.capacity, r => r.sourceTradeId === a.sourceTradeId, 'one capacity accounting cohort required');
    loadEqual(capacity, { sourceTradeId: a.sourceTradeId, executionMode: 'paper', notional: quote,
      chain: 'solana', tokenMint: f.tokenMint, masterWalletAddress: f.walletAddress }, 'capacity exact quote/scope mismatch');
    const previous = positionTotals.get(position.id) ?? { base: 0n, basis: 0n };
    positionTotals.set(position.id, { base: previous.base + loadUnits(base), basis: previous.basis + loadUnits(debit, true) });
    totalBase += loadUnits(base); totalQuote += loadUnits(quote, true); totalFee += loadUnits(fee, true);
  }
  loadCheck(d.positions.length === positionTotals.size, 'orphan aggregate position');
  for (const position of d.positions) {
    loadUuid(position.id); const total = positionTotals.get(position.id)!;
    loadEqual([position.base, position.basis], [loadDecimal(total.base), loadDecimal(total.basis)], 'independent final position conservation mismatch');
  }
  return Object.freeze({ sourceOnly: true as const, runtimeAccepted: false as const, liveCapabilityAccepted: false as const,
    protectedRuntimeAccepted: false as const, exactSourceContract: true as const, journalDigest: loadDigest(input),
    attempts: input.attempts.length, admitted: admitted.length, replays: input.admissions.filter(a => a.outcome === 'replay').length,
    totals: { base: loadDecimal(totalBase), quote: loadDecimal(totalQuote), fee: loadDecimal(totalFee), debit: loadDecimal(totalQuote + totalFee) } });
}

export type LoadCaptureKind = 'resources' | 'server' | 'slow-log' | 'limiter' | 'pooling' | 'phase';
export interface LoadCapture {
  readonly scope: LoadScope;
  readonly kind: LoadCaptureKind;
  readonly phase: string;
  readonly capturedAt: string;
  /** Exact inert capture from independently owned port, never a passed boolean. */
  readonly records: readonly Record<string, unknown>[];
}
export interface LoadBoundedRead { readonly scope: LoadScope; readonly deadline: number; readonly signal: AbortSignal }
export interface LoadDrainPorts {
  readonly now: () => number;
  /** All readers must own/await cancellation and pending work before resolving.
   * No detached Promise.race, retry, connection factory or cleanup is hidden here. */
  stopAdmission(input: LoadBoundedRead): Promise<void>;
  accounting(input: LoadBoundedRead): Promise<LoadFinalAccounting>;
  capture(input: LoadBoundedRead & { readonly kind: LoadCaptureKind; readonly phase: string }): Promise<LoadCapture>;
  wait(input: LoadBoundedRead & { readonly milliseconds: number }): Promise<void>;
}
export const loadCaptureKinds: readonly LoadCaptureKind[] = Object.freeze(['resources', 'server', 'slow-log', 'limiter', 'pooling', 'phase']);
/** Explicit finite drain. Application/load deadline is fixed externally, NEVER
 * extended on queue emptiness, retries, progress or callback status. Runtime
 * acceptance stays false even after exact synthetic source reconciliation. */
export async function drainLoadAccounting(input: {
  readonly scope: LoadScope; readonly loadDeadline: number; readonly drainDeadline: number;
  readonly maximumPolls: number; readonly pollIntervalMs: number; readonly phases: readonly string[];
}, ports: LoadDrainPorts) {
  const scope = loadScope(input.scope);
  loadCheck(Number.isSafeInteger(input.loadDeadline) && Number.isSafeInteger(input.drainDeadline)
    && input.drainDeadline > input.loadDeadline && input.drainDeadline - input.loadDeadline <= 240_000
    && Number.isSafeInteger(input.maximumPolls) && input.maximumPolls >= 1 && input.maximumPolls <= 1000
    && Number.isSafeInteger(input.pollIntervalMs) && input.pollIntervalMs >= 1 && input.pollIntervalMs <= 10_000
    && input.phases.length > 0 && new Set(input.phases).size === input.phases.length, 'bounded fixed application/load drain required');
  let lastClock = ports.now();
  const now = () => { const next = ports.now(); loadCheck(Number.isSafeInteger(next) && next >= lastClock, 'monotonic drain clock required');
    lastClock = next; return next; };
  loadCheck(now() >= input.loadDeadline && now() < input.drainDeadline, 'drain must start after fixed load deadline and before fixed drain deadline');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('fixed load-drain deadline exceeded')), input.drainDeadline - now());
  const bounded = { scope, deadline: input.drainDeadline, signal: controller.signal };
  const checkDeadline = () => loadCheck(!controller.signal.aborted && now() < input.drainDeadline, 'fixed load-drain deadline exceeded');
  try {
    await ports.stopAdmission(bounded); checkDeadline();
    const captures: LoadCapture[] = [];
    for (const phase of input.phases) for (const kind of loadCaptureKinds) {
      checkDeadline(); const capture = await ports.capture({ ...bounded, phase, kind }); checkDeadline();
      loadJson(capture); loadEqual(capture.scope, scope, 'capture run/backend mismatch'); loadTime(capture.capturedAt);
      loadCheck(capture.kind === kind && capture.phase === phase && Array.isArray(capture.records)
        && capture.records.length > 0, 'explicit independent phase/resource/server/slow-log/limiter/pooling coverage required');
      captures.push(capture);
    }
    let lastError: unknown;
    for (let poll = 0; poll < input.maximumPolls; poll++) {
      checkDeadline(); const accounting = await ports.accounting(bounded); checkDeadline();
      try { return { accounting: requireLoadFinalAccounting(accounting), captures, sourceOnly: true as const, runtimeAccepted: false as const }; }
      catch (error) { lastError = error; }
      if (poll + 1 < input.maximumPolls) {
        const milliseconds = Math.min(input.pollIntervalMs, input.drainDeadline - now() - 1);
        loadCheck(milliseconds > 0, 'fixed drain exhausted with unresolved obligations');
        await ports.wait({ ...bounded, milliseconds }); checkDeadline();
      }
    }
    throw new Error(`Load durable drain unresolved; no queue/count acceptance: ${lastError instanceof Error ? lastError.message : 'missing exact accounting'}`);
  } finally { clearTimeout(timer); controller.abort(); }
}
