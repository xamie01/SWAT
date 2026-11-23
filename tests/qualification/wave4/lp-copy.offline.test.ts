import { describe, expect, it } from 'vitest';
import { createLpPaperService } from '../../../packages/db/src/lp-paper-service.js';
import { lpPaperFixture } from '../../../packages/db/src/lp-paper-fixture.js';
import { lpExactHash, lpSnapshot, type LpExactPlan } from '../../../packages/db/src/lp-exact.js';
import type { UserScope } from '../../../packages/db/src/tenancy.js';
import { lpCopySqlService, qualifyLpCopyLifecycle, qualifyLpCompleteLifecycle, requireLpCompleteEconomics,
  type LpCompleteEconomicsExpectation, type LpCopyExpectation, type LpCopyObserver } from './lp-copy-scenarios.js';
import type { LpDurableHistoryObserver } from './lp-durable-history-observer.js';

const scope = { userId: 'alice' } as UserScope;
const foreign = { userId: 'bob' } as UserScope;
const plan: Parameters<typeof lpPaperFixture>[0] = async (quote, strategy): Promise<LpExactPlan> => ({ version: 2,
  protocol: quote.pool.protocol, strategy, poolEvidenceId: quote.pool.evidenceId,
  rungs: Array.from({ length: strategy.rungCount }, (_, index) => {
    const total = BigInt(quote.amountAfter.raw), count = BigInt(strategy.rungCount);
    return { priceLower: strategy.rangeLower, priceUpper: strategy.rangeUpper,
      allocation: { raw: (total / count + (index === strategy.rungCount - 1 ? total % count : 0n)).toString(), scale: quote.amountAfter.scale },
      binLower: index + 1, binUpper: index + 2 };
  }) });
function fixture() {
  const f = lpPaperFixture(plan);
  const expected: LpCopyExpectation = { subscription: lpSnapshot(f.state.subscriptions.sub!), event: lpSnapshot(f.master.event),
    unitPriceUsd: { raw: '1234567', scale: 6 }, priorSpentMicroUsd: '0', assetScale: 18,
    protocolProviderId: 'paper-fixture', riskProviderId: 'risk-fixture', collectedFeesMicroUsd: '100000', executionCostsMicroUsd: '50000' };
  const observe: LpCopyObserver = async (s, id) => {
    const position = f.state.positions[id], acquisition = f.state.acquisitions[id];
    if (!position || !acquisition || position.userId !== s.userId) throw new Error('fixture observer tenant refused');
    const receipts = Object.values(f.state.operations).filter(op => op.userId === s.userId && op.positionId === id && op.receipt)
      .map(op => ({ operationId: op.id, hash: lpExactHash(op.receipt), data: op.receipt }));
    return lpSnapshot({ position, acquisition, receipts });
  };
  return { f, expected, observe };
}
const request = { subscriptionId: 'sub', eventId: 'mint-event', assetScale: 18 };

describe('LP copy production service contracts with inert fixture transactions only', () => {
  it('joins exact sizing, immutable origin, one close receipt and unchanged replay', async () => {
    const { f, expected, observe } = fixture(); f.receipts.available = true;
    const result = await qualifyLpCopyLifecycle(f.deps, observe, scope, expected, 'copy-close');
    const raw = 6_000_000n * 10n ** 24n / (1_234_567n * 1_000_000n);
    const value = raw * 1_234_567n * 1_000_000n / 10n ** 24n;
    expect(result.evidence.deposit).toEqual({ raw: raw.toString(), scale: 18 });
    expect(result.evidence.depositMicroUsd).toBe(value.toString());
    expect(result.evidence.realizedMicroUsd).toBe('50000');
    expect(result.boundary).toMatchObject({ runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false });
    expect(result.blocked).toHaveLength(3);
    expect(f.state.commits).toEqual(['acquisition+copy', 'operation', 'receipt+position+operation']);
  });
  it('cannot construct SQL composition without a mandatory owned transaction', () => {
    const { f } = fixture();
    expect(() => lpCopySqlService(undefined as any, f.deps)).toThrow('owned transaction required');
  });
  it('refuses absent receipt rather than accepting queue or processor return as settled', async () => {
    const { f, expected, observe } = fixture();
    await expect(qualifyLpCopyLifecycle(f.deps, observe, scope, expected, 'copy-close')).rejects.toThrow('bound receipt required');
    const p = Object.values(f.state.positions)[0]!;
    expect(p.revision).toBe('0'); expect(p.state).toBe('active'); expect(p.cumulativeFeesMicroUsd).toBe('0');
  });
  it.each(['master', 'copyRisk', 'protocol'] as const)('missing %s capability does not mutate capital', async name => {
    const { f } = fixture();
    const service = createLpPaperService({ ...f.deps, [name]: undefined });
    const before = lpExactHash(f.state);
    await expect(service.copyMint(scope, request)).rejects.toThrow(/unavailable/);
    expect(lpExactHash(f.state)).toBe(before);
  });
  it.each(['off', 'live'] as const)('%s mode refuses new copy without a provider call', async mode => {
    const { f } = fixture(); f.mode.value = mode;
    await expect(f.service.copyMint(scope, request)).rejects.toThrow('current mode');
    expect(f.seen.quotes).toEqual([]); expect(f.state.commits).toEqual([]);
  });
  it('foreign subscription and position stay unavailable before and after acquisition', async () => {
    const { f } = fixture(); const before = lpExactHash(f.state);
    await expect(f.service.copyMint(foreign, request)).rejects.toThrow('owned subscription');
    expect(lpExactHash(f.state)).toBe(before);
    const p = await f.service.copyMint(scope, request);
    expect(await f.service.position(foreign, p.id)).toBeNull();
    await expect(f.service.requestOperation(foreign, { positionId: p.id, operationKey: 'foreign-close', action: 'close' })).rejects.toThrow('owned');
  });
  it.each(['paused', 'cancelled'] as const)('inactive %s subscription never acquires', async status => {
    const { f } = fixture(); f.state.subscriptions.sub = { ...f.state.subscriptions.sub!, status: status as any };
    await expect(f.service.copyMint(scope, request)).rejects.toThrow('not active'); expect(f.state.commits).toEqual([]);
  });
  it.each(['provider', 'event', 'network', 'wallet', 'finality', 'opened-before-subscription'] as const)('rejects %s master evidence before capital commit', async field => {
    const { f } = fixture(); const event = f.master.event;
    f.master.event = { ...event, ...(field === 'provider' ? { providerId: 'other' }
      : field === 'event' ? { eventId: 'other' } : field === 'network' ? { networkId: 'solana:other' }
      : field === 'wallet' ? { masterWalletAddress: 'solana:other' } : field === 'finality' ? { finality: 'unconfirmed' as any }
      : { openedAt: '2026-11-17T10:00:00.000Z' }) };
    await expect(f.service.copyMint(scope, request)).rejects.toThrow('master evidence'); expect(f.state.commits).toEqual([]);
  });
  it.each(['approved', 'tenant', 'subscription', 'revision', 'event', 'intent', 'pool', 'provider'] as const)('rejects %s risk substitution with unchanged capital', async field => {
    const { f } = fixture(); const assess = f.deps.copyRisk!.assess;
    const service = createLpPaperService({ ...f.deps, copyRisk: { providerId: 'risk-fixture', assess: async input => {
      const risk = (await assess(input))!;
      return { ...risk, ...(field === 'approved' ? { approved: false } : field === 'tenant' ? { userId: 'bob' }
        : field === 'subscription' ? { subscriptionId: 'other' } : field === 'revision' ? { subscriptionRevision: 'other' }
        : field === 'event' ? { masterEvidenceHash: 'other' } : field === 'intent' ? { intentHash: 'other' }
        : field === 'pool' ? { poolEvidenceId: 'other' } : { providerId: 'other' }) };
    } } });
    await expect(service.copyMint(scope, request)).rejects.toThrow('risk binding'); expect(f.state.commits).toEqual([]);
  });
  it('caps every event against cumulative original capital rather than floating-point balances', async () => {
    const { f } = fixture(); const first = await f.service.copyMint(scope, request);
    f.master.event = { ...f.master.event, eventId: 'mint-second' };
    const second = await f.service.copyMint(scope, { ...request, eventId: 'mint-second' });
    const total = BigInt(first.depositMicroUsd) + BigInt(second.depositMicroUsd);
    expect(total <= 10_000_000n).toBe(true); expect(BigInt(second.depositMicroUsd) <= 4_000_001n).toBe(true);
    f.master.event = { ...f.master.event, eventId: 'mint-third' };
    await expect(f.service.copyMint(scope, { ...request, eventId: 'mint-third' })).rejects.toThrow('below minimum');
    expect(f.state.commits).toEqual(['acquisition+copy', 'acquisition+copy']);
  });
  it('subscription revision changed during assessment refuses the final transaction', async () => {
    const { f } = fixture(), assess = f.deps.copyRisk!.assess;
    const service = createLpPaperService({ ...f.deps, copyRisk: { providerId: 'risk-fixture', assess: async input => {
      const risk = await assess(input); f.state.subscriptions.sub = { ...f.state.subscriptions.sub!, revision: 'changed' }; return risk;
    } } });
    await expect(service.copyMint(scope, request)).rejects.toThrow('authority changed'); expect(f.state.commits).toEqual([]);
  });
  it('budget changed during assessment refuses the final transaction', async () => {
    const { f } = fixture(), assess = f.deps.copyRisk!.assess;
    const service = createLpPaperService({ ...f.deps, copyRisk: { providerId: 'risk-fixture', assess: async input => {
      const risk = await assess(input); f.state.subscriptions.sub = { ...f.state.subscriptions.sub!, budgetMicroUsd: '1000000' }; return risk;
    } } });
    await expect(service.copyMint(scope, request)).rejects.toThrow('budget reservation conflict'); expect(f.state.commits).toEqual([]);
  });
  it('unassessed exposure refuses copy after risk approval', async () => {
    const { f } = fixture(); f.policy.unassessedPositions = 1;
    await expect(f.service.copyMint(scope, request)).rejects.toThrow('unassessed'); expect(f.state.commits).toEqual([]);
  });
  it('a foreign immutable price expectation cannot pass even if fixture journals agree', async () => {
    const { f, expected, observe } = fixture(); f.receipts.available = true;
    await expect(qualifyLpCopyLifecycle(f.deps, observe, scope, { ...expected, unitPriceUsd: { raw: '1234568', scale: 6 } }, 'close')).rejects.toThrow(/sizing|economics/);
  });
  it('substituted observer receipt hash is refused', async () => {
    const { f, expected, observe } = fixture(); f.receipts.available = true;
    const hostile: LpCopyObserver = async (s, id) => {
      const row = await observe(s, id); return { ...row, receipts: row.receipts.map(r => ({ ...r, hash: 'wrong' })) };
    };
    await expect(qualifyLpCopyLifecycle(f.deps, hostile, scope, expected, 'close')).rejects.toThrow('stored hashed');
  });
  it('settlement failure preserves the pending copy inventory and allows one restart receipt', async () => {
    const { f } = fixture(), acquired = await f.service.copyMint(scope, request);
    const admission = await f.service.requestOperation(scope, { positionId: acquired.id, operationKey: 'copy-close', action: 'close' });
    f.receipts.available = true; f.fault.settle = true;
    const before = lpExactHash(f.state);
    await expect(f.service.process(scope, { operationId: admission.operation.id, chain: 'solana' })).rejects.toThrow('transaction failure');
    expect(lpExactHash(f.state)).toBe(before); f.fault.settle = false;
    await createLpPaperService(f.deps).process(scope, { operationId: admission.operation.id, chain: 'solana' });
    expect(f.state.commits.filter(c => c === 'receipt+position+operation')).toHaveLength(1);
  });
});

/** Expected quotes/receipts are captured on a separate inert oracle fixture before the
 * actual scenario. No scenario result is used to manufacture the expected economics. */
async function completeFixture(kind: 'copy' | 'acquisition') {
  const oracle = fixture(), actual = fixture();
  oracle.f.receipts.available = true; actual.f.receipts.available = true;
  const direct = { operationKey: 'direct-complete', chain: 'solana' as const, poolAddress: 'solana:pool',
    depositAsset: 'solana:mint', deposit: { raw: '900719925474099312345', scale: 18 },
    strategy: oracle.expected.event.strategy, autoRebalance: false };
  const acquired = kind === 'copy' ? await oracle.f.service.copyMint(scope, request) : await oracle.f.service.acquire(scope, direct);
  const rebalance = await oracle.f.service.requestOperation(scope, { positionId: acquired.id, operationKey: 'rebalance-complete', action: 'rebalance' });
  const rebalanced = await oracle.f.service.process(scope, { operationId: rebalance.operation.id, chain: 'solana' });
  const close = await oracle.f.service.requestOperation(scope, { positionId: acquired.id, operationKey: 'close-complete', action: 'close' });
  const closed = await oracle.f.service.process(scope, { operationId: close.operation.id, chain: 'solana' });
  const expected: LpCompleteEconomicsExpectation = { rebalance: { operationKey: 'rebalance-complete', quote: lpSnapshot(rebalance.operation.quote),
    plan: lpSnapshot(rebalance.operation.plan!), receipt: lpSnapshot(rebalanced.operation.receipt!) }, close: { operationKey: 'close-complete',
    quote: lpSnapshot(close.operation.quote), receipt: lpSnapshot(closed.operation.receipt!) } };
  const observe: LpDurableHistoryObserver = async (s, id) => {
    const p = actual.f.state.positions[id], acquisition = actual.f.state.acquisitions[id];
    if (!p || !acquisition || p.userId !== s.userId) throw new Error('foreign fixture history');
    const operations = Object.values(actual.f.state.operations).filter(o => o.positionId === id && o.userId === s.userId);
    return lpSnapshot({ acquisition, position: p, observedAt: actual.f.time.now.toISOString(),
      operations: operations.map(data => ({ data, createdAt: actual.f.time.now.toISOString(),
        completedAt: data.status === 'completed' ? actual.f.time.now.toISOString() : null })),
      receipts: operations.filter(o => o.receipt).map(o => ({ operationId: o.id, data: o.receipt!, hash: lpExactHash(o.receipt), acceptedAt: actual.f.time.now.toISOString() })),
      history: [{ id: '1', fromState: null, toState: 'building' as const, reason: 'acquisition', changedAt: actual.f.time.now.toISOString() },
        { id: '2', fromState: 'building' as const, toState: 'active' as const, reason: 'plan', changedAt: actual.f.time.now.toISOString() },
        ...operations.filter(o => o.receipt).map((o, i) => ({ id: String(i + 3), fromState: 'active' as const,
          toState: o.action === 'close' ? 'closed' as const : 'active' as const, reason: `receipt ${o.receiptKey}: exact`, changedAt: actual.f.time.now.toISOString() }))],
      copies: acquisition.copyOrigin ? [{ id: 'copy-fixture', subscriptionId: acquisition.copyOrigin.subscriptionId,
        masterPositionId: acquisition.copyOrigin.masterPositionId, chain: acquisition.chain, action: 'mint', status: 'executed',
        masterMicroUsd: acquisition.copyOrigin.masterDepositMicroUsd, followerMicroUsd: acquisition.depositMicroUsd }] : [] });
  };
  const acquisition = kind === 'copy' ? { kind: 'copy' as const, expected: actual.expected }
    : { kind: 'acquisition' as const, request: direct, quote: acquired.acquisitionQuote, plan: acquired.plan };
  return { ...actual, expectedComplete: expected, acquisition, observeComplete: observe };
}

describe('complete production LP durable operation lifecycle with inert IO only', () => {
  it.each(['copy', 'acquisition'] as const)('%s independently joins acquisition rebalance close history and recovery replay', async kind => {
    const t = await completeFixture(kind);
    const result = await qualifyLpCompleteLifecycle(t.f.service, t.observeComplete, scope, t.acquisition, t.expectedComplete);
    expect(result.evidence).toMatchObject({ revision: '2', operations: 2, receipts: 2,
      cumulativeFeesMicroUsd: '200000', cumulativeCostsMicroUsd: '100000', realizedMicroUsd: '100000' });
    expect(result.boundary.runtimeAccepted).toBe(false);
    expect(t.f.state.commits).toEqual([kind === 'copy' ? 'acquisition+copy' : 'acquisition',
      'operation', 'receipt+position+operation', 'operation', 'receipt+position+operation']);
    expect(t.f.seen.queue.length).toBeGreaterThanOrEqual(4);
  });
  it('missing provider receipt refuses full lifecycle without accepting recovery/processor success', async () => {
    const t = await completeFixture('copy'); t.f.receipts.available = false;
    await expect(qualifyLpCompleteLifecycle(t.f.service, t.observeComplete, scope, t.acquisition, t.expectedComplete)).rejects.toThrow('independent receipt required');
    const p = Object.values(t.f.state.positions)[0]!;
    expect(p.revision).toBe('0'); expect(p.cumulativeCostsMicroUsd).toBe('0');
  });
  it.each(['fees', 'costs', 'price', 'net', 'inventory'] as const)('independent %s expectations cannot be laundered by matching fixture snapshots', async field => {
    const t = await completeFixture('copy'), original = t.expectedComplete;
    const e: LpCompleteEconomicsExpectation = {
      rebalance: { ...original.rebalance, ...(field === 'fees' ? { receipt: { ...original.rebalance.receipt, collectedFeesMicroUsd: '999999' } }
        : field === 'net' ? { quote: { ...original.rebalance.quote, economics: { ...original.rebalance.quote.economics!, gasMicroUsd: '99999999999' } } } : {}) },
      close: { ...original.close, ...(field === 'costs' ? { receipt: { ...original.close.receipt, executionCostsMicroUsd: '0' } }
        : field === 'price' ? { quote: { ...original.close.quote, unitPriceUsd: { raw: '1234568', scale: 6 } } }
        : field === 'inventory' ? { receipt: { ...original.close.receipt, amountAfter: { raw: '1', scale: 18 } } } : {}) }
    };
    await expect(qualifyLpCompleteLifecycle(t.f.service, t.observeComplete, scope, t.acquisition, e)).rejects.toThrow();
  });
  it('additional observed operation/history economics refuse despite exact one-close fixtures staying accepted', async () => {
    const t = await completeFixture('copy');
    const hostile: LpDurableHistoryObserver = async (s, id) => {
      const row = await t.observeComplete(s, id);
      return row.operations.length ? { ...row, operations: [...row.operations, row.operations[0]!] } : row;
    };
    await expect(qualifyLpCompleteLifecycle(t.f.service, hostile, scope, t.acquisition, t.expectedComplete)).rejects.toThrow('cardinality');
  });
  it('failed settlement then a restarted canonical service commits exactly one complete economic receipt', async () => {
    const t = await completeFixture('copy'); const acquired = await t.f.service.copyMint(scope, request);
    const op = await t.f.service.requestOperation(scope, { positionId: acquired.id, operationKey: 'rebalance-complete', action: 'rebalance' });
    t.f.fault.settle = true; const before = lpExactHash(t.f.state);
    await expect(t.f.service.process(scope, { operationId: op.operation.id, chain: 'solana' })).rejects.toThrow('transaction failure');
    expect(lpExactHash(t.f.state)).toBe(before); t.f.fault.settle = false;
    const restart = createLpPaperService(t.f.deps); await restart.recover(scope);
    await restart.process(scope, { operationId: op.operation.id, chain: 'solana' });
    requireLpCompleteEconomics(await t.observeComplete(scope, acquired.id), acquired, t.expectedComplete, 1);
    expect(t.f.state.commits.filter(c => c === 'receipt+position+operation')).toHaveLength(1);
  });
});
