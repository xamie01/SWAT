import { describe, expect, it } from 'vitest';
import { createLpPaperService } from './lp-paper-service.js';
import { lpPaperFixture } from './lp-paper-fixture.js';
import { lpExactHash, type LpExactAcquisitionRequest, type LpExactPlan } from './lp-exact.js';
import type { UserScope } from './tenancy.js';
const alice = { userId: 'alice' } as UserScope;
const bob = { userId: 'bob' } as UserScope;
const request: LpExactAcquisitionRequest = { operationKey: 'acquire-one', chain: 'solana', poolAddress: 'solana:pool', depositAsset: 'solana:mint',
  deposit: { raw: '900719925474099312345', scale: 18 }, strategy: { distribution: 'spot', rangeLower: 90, rangeUpper: 110, rungCount: 1 }, autoRebalance: true };
const plan: Parameters<typeof lpPaperFixture>[0] = async (q, strategy): Promise<LpExactPlan> => ({ version: 2, protocol: q.pool.protocol, strategy,
  poolEvidenceId: q.pool.evidenceId, rungs: [{ priceLower: strategy.rangeLower, priceUpper: strategy.rangeUpper, allocation: q.amountAfter, binLower: 1, binUpper: 2 }] });

describe('invoked exact LP acquisition and durable receipt lifecycle', () => {
  it('commits valued fractional acquisition and stable replay without quote refresh', async () => {
    const f = lpPaperFixture(plan); const p = await f.service.acquire(alice, request);
    expect(p.deposit).toEqual(request.deposit); expect(p.depositMicroUsd).toBe('1111999096');
    expect(f.state.commits).toEqual(['acquisition']);
    f.time.now = new Date('2026-11-19T12:00:00.000Z');
    expect(await f.service.acquire(alice, request)).toEqual(p); expect(f.seen.quotes).toHaveLength(1);
    await expect(f.service.acquire(alice, { ...request, deposit: { ...request.deposit, raw: '900719925474099312346' } })).rejects.toThrow('replay conflict');
  });
  it.each(['off', 'live'] as const)('current %s mode refuses before quote or acquisition', async mode => {
    const f = lpPaperFixture(plan); f.mode.value = mode;
    await expect(f.service.acquire(alice, request)).rejects.toThrow('current mode');
    expect(f.seen.quotes).toHaveLength(0); expect(Object.keys(f.state.positions)).toHaveLength(0);
  });
  it('missing provider cannot be replaced by source labels or flags', async () => {
    const f = lpPaperFixture(plan); const service = createLpPaperService({ ...f.deps, protocol: undefined });
    await expect(service.acquire(alice, request)).rejects.toThrow('capability unavailable');
    expect(service.capabilities()).toMatchObject({ injectedPortsConfigured: false, runtimeAccepted: false, liveCapabilityAccepted: false });
  });
  it('constructor captures provider identity; mutable caller metadata cannot relabel trust', async () => {
    const f = lpPaperFixture(plan);
    (f.deps.protocol!.networks as any).solana = 'wrong'; (f.deps.protocol as any).providerId = 'changed';
    expect((await f.service.acquire(alice, request)).acquisitionQuote.providerId).toBe('paper-fixture');
  });
  it.each(['user', 'network', 'pool', 'asset', 'scale', 'provider', 'price', 'stale'] as const)('refuses substituted %s quote without mutation', async field => {
    const f = lpPaperFixture(plan);
    f.transforms.quote = q => field === 'user' ? { ...q, userId: 'bob' } : field === 'provider' ? { ...q, providerId: 'label-only' }
      : field === 'price' ? { ...q, valueMicroUsd: '1' } : field === 'stale' ? { ...q, observedAt: '2026-11-17T11:00:00.000Z' }
      : { ...q, pool: { ...q.pool, ...(field === 'network' ? { networkId: 'wrong' } : field === 'pool' ? { poolAddress: 'solana:other' }
        : field === 'asset' ? { depositAsset: 'solana:other' } : { depositScale: 9 }) } };
    await expect(f.service.acquire(alice, request)).rejects.toThrow(); expect(Object.keys(f.state.positions)).toHaveLength(0);
  });
  it('rechecks mode after quote/plan and exposure before same transaction commit', async () => {
    const f = lpPaperFixture(async (q, s) => { const value = await plan(q, s); f.mode.value = 'live'; return value; });
    await expect(f.service.acquire(alice, request)).rejects.toThrow('current mode'); expect(f.state.commits).toEqual([]);
    const g = lpPaperFixture(plan); g.policy.unassessedPositions = 1;
    await expect(g.service.acquire(alice, request)).rejects.toThrow('unassessed'); expect(g.state.commits).toEqual([]);
    const h = lpPaperFixture(plan); Object.assign(h.policy, { totalMicroUsd: '10000000', poolMicroUsd: '5000000', poolCapBps: 5000 });
    await expect(h.service.acquire(alice, request)).rejects.toThrow('exposure-cap');
  });
  it('mutable planner input cannot replace captured acquisition quote', async () => {
    const f = lpPaperFixture(async (q, s) => {
      const result = await plan(q, s); (q as any).valueMicroUsd = '1'; return result;
    });
    expect((await f.service.acquire(alice, request)).depositMicroUsd).toBe('1111999096');
  });
  it('close admission is pending and zero inventory only after bound receipt', async () => {
    const f = lpPaperFixture(plan); const p = await f.service.acquire(alice, request); f.fault.queue = true;
    const result = await f.service.requestOperation(alice, { positionId: p.id, operationKey: 'close-one', action: 'close' });
    expect(result.operation.status).toBe('pending'); expect(result.queued).toBe(false); expect(f.state.positions[p.id]!.state).toBe('active');
    expect((await f.service.process(alice, { operationId: result.operation.id, chain: 'solana' })).receiptPending).toBe(true);
    expect(f.state.positions[p.id]!.currentAmount).toEqual(request.deposit);
    f.fault.queue = false; expect(await f.service.recover(alice)).toEqual({ queued: 1, deferred: 0 });
    f.receipts.available = true;
    const done = await f.service.process(alice, { operationId: result.operation.id, chain: 'solana' });
    expect(done.operation.status).toBe('completed'); expect(f.state.positions[p.id]).toMatchObject({ state: 'closed', currentAmount: { raw: '0', scale: 18 }, realizedMicroUsd: '50000' });
    const before = lpExactHash(f.state); await f.service.process(alice, { operationId: result.operation.id, chain: 'solana' });
    expect(lpExactHash(f.state)).toBe(before);
  });
  it('historical committed plan/receipt recovers after quote expiry without new valuation', async () => {
    const f = lpPaperFixture(plan); const p = await f.service.acquire(alice, request);
    const r = await f.service.requestOperation(alice, { positionId: p.id, operationKey: 'rebalance', action: 'rebalance' });
    f.time.now = new Date('2026-11-19T12:00:00.000Z'); f.receipts.available = true;
    expect((await f.service.process(alice, { operationId: r.operation.id, chain: 'solana' })).operation.status).toBe('completed');
    expect(f.seen.quotes).toHaveLength(2); expect(f.state.positions[p.id]!.revision).toBe('1');
  });
  it.each(['owner', 'scale', 'quote', 'revision', 'receipt-key', 'remaining'] as const)('substituted %s receipt never closes inventory', async field => {
    const f = lpPaperFixture(plan); const p = await f.service.acquire(alice, request);
    const r = await f.service.requestOperation(alice, { positionId: p.id, operationKey: 'close', action: 'close' }); f.receipts.available = true;
    f.transforms.receipt = receipt => ({ ...receipt, ...(field === 'owner' ? { userId: 'bob' } : field === 'quote' ? { quoteHash: 'bad' }
      : field === 'revision' ? { positionRevision: '2' } : field === 'receipt-key' ? { receiptKey: 'other' }
      : { amountAfter: { raw: field === 'remaining' ? '1' : '0', scale: field === 'scale' ? 9 : 18 } }) });
    await expect(f.service.process(alice, { operationId: r.operation.id, chain: 'solana' })).rejects.toThrow('receipt binding');
    expect(f.state.positions[p.id]!.state).toBe('active'); expect(f.state.operations[r.operation.id]!.status).toBe('pending');
  });
  it('injected settlement failure rolls back receipt/position/completion; restart replays durable operation', async () => {
    const f = lpPaperFixture(plan); const p = await f.service.acquire(alice, request);
    const r = await f.service.requestOperation(alice, { positionId: p.id, operationKey: 'close', action: 'close' });
    f.receipts.available = true; f.fault.settle = true;
    await expect(f.service.process(alice, { operationId: r.operation.id, chain: 'solana' })).rejects.toThrow('transaction failure');
    expect(f.state.positions[p.id]!.state).toBe('active'); expect(f.state.operations[r.operation.id]!.receipt).toBe(null);
    f.fault.settle = false; const restarted = createLpPaperService(f.deps);
    expect((await restarted.process(alice, { operationId: r.operation.id, chain: 'solana' })).operation.status).toBe('completed');
    expect(f.state.commits.filter(value => value === 'receipt+position+operation')).toHaveLength(1);
  });
  it('canonical tenant/chain denial, pending fence and same key replay do not replan', async () => {
    const f = lpPaperFixture(plan); const p = await f.service.acquire(alice, request);
    const r = await f.service.requestOperation(alice, { positionId: p.id, operationKey: 'rebal', action: 'rebalance' });
    await expect(f.service.requestOperation(bob, { positionId: p.id, operationKey: 'stolen', action: 'close' })).rejects.toThrow('owned');
    await expect(f.service.process(alice, { operationId: r.operation.id, chain: 'base' })).rejects.toThrow('chain mismatch');
    await expect(f.service.process(bob, { operationId: r.operation.id, chain: 'solana' })).rejects.toThrow('canonical');
    expect((await f.service.requestOperation(alice, { positionId: p.id, operationKey: 'rebal', action: 'rebalance' })).operation.id).toBe(r.operation.id);
    expect(f.seen.quotes).toHaveLength(2);
    await expect(f.service.requestOperation(alice, { positionId: p.id, operationKey: 'other', action: 'close' })).rejects.toThrow('pending');
    await expect(f.service.recover({ userId: '*' } as UserScope)).rejects.toThrow('tenant');
  });
  it('acquisition retry returns the immutable initial result after close and mode/provider removal', async () => {
    const f = lpPaperFixture(plan); const p = await f.service.acquire(alice, request);
    const op = await f.service.requestOperation(alice, { positionId: p.id, operationKey: 'close-retry', action: 'close' });
    f.receipts.available = true; await f.service.process(alice, { operationId: op.operation.id, chain: 'solana' });
    f.mode.value = 'live';
    const restarted = createLpPaperService({ ...f.deps, protocol: undefined });
    expect(await restarted.acquire(alice, request)).toEqual(p);
    expect((await restarted.position(alice, p.id))?.state).toBe('closed');
    expect(f.seen.quotes).toHaveLength(2);
    await expect(restarted.acquire(alice, { ...request, deposit: { ...request.deposit, raw: '1' } })).rejects.toThrow('replay conflict');
  });
  it('rebalance recenters immutable quoted geometry without changing acquisition or exact inventory', async () => {
    const f = lpPaperFixture(plan); const p = await f.service.acquire(alice, request);
    f.transforms.quote = q => ({ ...q, pool: { ...q.pool, currentPrice: 200 } });
    const op = await f.service.requestOperation(alice, { positionId: p.id, operationKey: 'recenter', action: 'rebalance' });
    expect(op.operation.plan!.strategy.rangeLower).toBeGreaterThan(180);
    expect(op.operation.plan!.strategy.rangeUpper).toBeGreaterThan(220);
    expect(op.operation.plan!.rungs[0]!.allocation).toEqual(request.deposit);
    f.receipts.available = true; await f.service.process(alice, { operationId: op.operation.id, chain: 'solana' });
    expect(f.state.positions[p.id]!.plan).toEqual(op.operation.plan);
    expect(await f.service.acquire(alice, request)).toEqual(p);
  });
  it('operation retry in live mode returns committed intent without queueing or requoting', async () => {
    const f = lpPaperFixture(plan); const p = await f.service.acquire(alice, request);
    const input = { positionId: p.id, operationKey: 'stable-close', action: 'close' as const };
    const first = await f.service.requestOperation(alice, input); f.mode.value = 'live';
    const queueCount = f.seen.queue.length;
    const replay = await f.service.requestOperation(alice, input);
    expect(replay.operation).toEqual(first.operation); expect(replay.queued).toBe(false);
    expect(f.seen.queue).toHaveLength(queueCount); expect(f.seen.quotes).toHaveLength(2);
  });
  it('unknown/nonpositive economics and withdrawn automatic consent fail closed', async () => {
    const f = lpPaperFixture(plan); const p = await f.service.acquire(alice, request); f.econ.evidence = null;
    await expect(f.service.requestOperation(alice, { positionId: p.id, operationKey: 'no-econ', action: 'rebalance' })).rejects.toThrow('unassessed');
    f.econ.evidence = { basis: 'incremental-rebalance', windowStart: f.time.now.toISOString(), windowEnd: '2026-11-18T12:00:00.000Z',
      extraFeesMicroUsd: '1', inventoryChangeMicroUsd: '0', impermanentLossMicroUsd: '1', gasMicroUsd: '0', repositionMicroUsd: '0' };
    await expect(f.service.requestOperation(alice, { positionId: p.id, operationKey: 'not-positive', action: 'rebalance' })).rejects.toThrow('not-positive');
    f.state.positions[p.id] = { ...p, autoRebalance: false };
    await expect(f.service.requestOperation(alice, { positionId: p.id, operationKey: 'auto', action: 'rebalance', automatic: true })).rejects.toThrow('opted');
    expect(Object.keys(f.state.operations)).toHaveLength(0);
  });
});
