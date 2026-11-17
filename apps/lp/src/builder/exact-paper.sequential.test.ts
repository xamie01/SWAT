import { describe, expect, it, vi } from 'vitest';
vi.mock('@swat/db', () => ({ forUser: (userId: string) => ({ userId }), resolveChainMode: vi.fn() }));
import { lpPaperFixture } from '@swat/db/dist/lp-paper-fixture.js';
import { createLpPaperService } from '@swat/db/dist/lp-paper-service.js';
import { buildExactPaperPlan, createExactLpDomain } from './exact-paper.js';
import { buildExactPosition, buildPosition } from './build-position.js';
import { requestLpOperation, processLpOperationJob, recoverLpOperations } from '../operations.js';
import { processLpCopyJob } from '../copy/copy-worker.js';
import { runMonitorPass } from '../monitor/monitor-job.js';
import { lpMicro, lpRaw, type LpExactAcquisitionRequest } from '@swat/db/dist/lp-exact.js';
const scope = { userId: 'alice' } as any;
const request: LpExactAcquisitionRequest = { operationKey: 'acq', chain: 'solana', poolAddress: 'solana:pool', depositAsset: 'solana:mint',
  deposit: { raw: '900719925474099312345', scale: 18 }, strategy: { distribution: 'spot', rangeLower: 90, rangeUpper: 110, rungCount: 2 } };

describe('existing LP builder worker operations and copy consume exact domain', () => {
  it.each(['spot', 'curve', 'bidask'] as const)('allocates %s fractional ladder raw exactly', async distribution => {
    const f = lpPaperFixture(buildExactPaperPlan);
    const p = await buildExactPosition({ exactPaper: f.service }, scope, { ...request, strategy: { ...request.strategy, rungCount: 7, distribution } });
    expect(p.plan.rungs.reduce((sum, rung) => sum + lpRaw(rung.allocation), 0n)).toBe(lpRaw(request.deposit));
    expect(p.plan.rungs.every(rung => lpRaw(rung.allocation) > 0n)).toBe(true); expect(p.mode).toBe('paper');
  });
  it('CLMM context produces exact tick geometry and rejects dust per rung', async () => {
    const f = lpPaperFixture(buildExactPaperPlan);
    const p = await f.service.acquire(scope, { ...request, chain: 'base', poolAddress: 'base:pool', depositAsset: 'base:token' });
    expect(p.plan.rungs.every(rung => Number.isSafeInteger(rung.tickLower) && rung.tickUpper! > rung.tickLower!)).toBe(true);
    await expect(f.service.acquire(scope, { ...request, operationKey: 'dust', deposit: { raw: '1', scale: 0 } })).rejects.toThrow('positive raw');
  });
  it('legacy numeric builder refuses without running valuation/persist callbacks', async () => {
    const persist = vi.fn(), valuation = vi.fn();
    await expect(buildPosition({ persistPosition: persist, valuation: { value: valuation } } as any, scope, {} as any)).rejects.toThrow('legacy numeric');
    expect(persist).not.toHaveBeenCalled(); expect(valuation).not.toHaveBeenCalled();
    await expect(buildExactPosition({}, scope, request)).rejects.toThrow('unavailable');
  });
  it('existing operation admission/worker/recovery drive real receipt domain and never immediate close', async () => {
    const f = lpPaperFixture(buildExactPaperPlan); const p = await f.service.acquire(scope, request);
    const deps = { exactPaper: f.service, executionMode: { resolveMode: async () => 'paper' }, recoveryScopes: async () => [scope] } as any;
    const result = await requestLpOperation(deps, scope, { positionId: p.id, operationKey: 'close', kind: 'close' });
    expect(result.operation.status).toBe('pending'); expect(f.state.positions[p.id]!.state).toBe('active');
    expect(await recoverLpOperations(deps)).toEqual({ queued: 1, deferred: 0 });
    f.receipts.available = true;
    expect((await processLpOperationJob(deps, { operationId: result.operation.id, userId: 'alice', chain: 'solana' })).operation.status).toBe('completed');
    expect(f.state.positions[p.id]!.state).toBe('closed');
    expect(await recoverLpOperations({ ...deps, recoveryScopes: undefined })).toMatchObject({ capabilityUnavailable: true });
  });
  it('copy worker ignores forged USD hints and commits sized follower acquisition + linkage', async () => {
    const f = lpPaperFixture(buildExactPaperPlan);
    const job = { data: { userId: 'alice', subscriptionId: 'sub', eventId: 'mint-event', assetScale: 18, chain: 'solana', action: 'mint',
      venue: 'meteora-dlmm', masterPositionId: 'forged', poolAddress: 'solana:forged', followerDepositUsd: 9999999, masterDepositUsd: 0, scaleRatio: 99 } } as any;
    const result = await processLpCopyJob(job, { executionMode: { resolveMode: async () => 'paper' }, exactPaper: f.service });
    expect(result.status).toBe('executed');
    const p = f.state.positions[result.followerPositionId!]!;
    expect(p.poolAddress).toBe('solana:pool'); expect(p.copyOrigin?.masterPositionId).toBe('solana:nft');
    expect(lpMicro(p.depositMicroUsd)).toBeLessThanOrEqual(6000000n);
    expect(p.plan.rungs.reduce((sum, r) => sum + lpRaw(r.allocation), 0n)).toBe(lpRaw(p.deposit));
    expect(f.state.commits).toEqual(['acquisition+copy']); expect(f.seen.quotes).toHaveLength(2);
    expect((await processLpCopyJob(job, { executionMode: { resolveMode: async () => 'paper' }, exactPaper: f.service })).followerPositionId).toBe(p.id);
    expect(f.seen.quotes).toHaveLength(2); expect(f.state.commits).toEqual(['acquisition+copy']);
  });
  it.each(['paused', 'tenant', 'old', 'network', 'snapshot'] as const)('copy %s evidence/subscription denial never acquires', async reason => {
    const f = lpPaperFixture(buildExactPaperPlan);
    if (reason === 'paused') f.state.subscriptions.sub = { ...f.state.subscriptions.sub!, status: 'paused' };
    if (reason === 'tenant') f.state.subscriptions.sub = { ...f.state.subscriptions.sub!, userId: 'bob' };
    if (reason === 'old') f.master.event.openedAt = '2026-11-17T10:00:00.000Z';
    if (reason === 'network') f.master.event.networkId = 'wrong';
    if (reason === 'snapshot') (f.master.event as any).provenance = 'wallet-snapshot-diff';
    await expect(f.service.copyMint(scope, { subscriptionId: 'sub', eventId: 'mint-event', assetScale: 18 })).rejects.toThrow();
    expect(f.state.commits).toEqual([]);
  });
  it.each(['missing', 'rejected', 'tenant', 'intent', 'stale'] as const)('copy %s trusted risk assessment cannot acquire', async reason => {
    const f = lpPaperFixture(buildExactPaperPlan); const base = f.deps.copyRisk!;
    const service = createLpPaperService({ ...f.deps, copyRisk: reason === 'missing' ? undefined : {
      providerId: base.providerId, assess: async input => {
        const risk = (await base.assess(input))!;
        return { ...risk, ...(reason === 'rejected' ? { approved: false } : reason === 'tenant' ? { userId: 'bob' }
          : reason === 'intent' ? { intentHash: 'forged' } : { observedAt: '2026-11-17T11:00:00.000Z' }) };
      }
    } });
    await expect(service.copyMint(scope, { subscriptionId: 'sub', eventId: 'mint-event', assetScale: 18 })).rejects.toThrow();
    expect(f.state.commits).toEqual([]);
  });
  it('copy retry preserves committed acquisition after close and refuses changed raw scale', async () => {
    const f = lpPaperFixture(buildExactPaperPlan);
    const input = { subscriptionId: 'sub', eventId: 'mint-event', assetScale: 18 };
    const p = await f.service.copyMint(scope, input);
    expect(p.copyOrigin?.riskEvidence).toMatchObject({ approved: true, providerId: 'risk-fixture' });
    const op = await f.service.requestOperation(scope, { positionId: p.id, operationKey: 'copy-close', action: 'close' });
    f.receipts.available = true; await f.service.process(scope, { operationId: op.operation.id, chain: 'solana' });
    f.mode.value = 'off'; f.state.subscriptions.sub = { ...f.state.subscriptions.sub!, status: 'paused' };
    expect(await f.service.copyMint(scope, input)).toEqual(p);
    await expect(f.service.copyMint(scope, { ...input, assetScale: 6 })).rejects.toThrow('replay conflict');
  });
  it('multiple master events cannot spend full subscription budget repeatedly', async () => {
    const f = lpPaperFixture(buildExactPaperPlan);
    await f.service.copyMint(scope, { subscriptionId: 'sub', eventId: 'mint-event', assetScale: 18 });
    f.master.event.eventId = 'mint-two'; await f.service.copyMint(scope, { subscriptionId: 'sub', eventId: 'mint-two', assetScale: 18 });
    const sum = Object.values(f.state.positions).reduce((n, p) => n + lpMicro(p.depositMicroUsd), 0n);
    expect(sum).toBeLessThanOrEqual(10000000n);
    f.master.event.eventId = 'mint-three';
    await expect(f.service.copyMint(scope, { subscriptionId: 'sub', eventId: 'mint-three', assetScale: 18 })).rejects.toThrow('below minimum');
  });
  it.each(['off', 'live'] as const)('copy %s and unsupported burn are refusals not fake records', async mode => {
    const f = lpPaperFixture(buildExactPaperPlan); const createExecution = vi.fn(), updateExecutionStatus = vi.fn();
    const data = { userId: 'alice', subscriptionId: 'sub', chain: 'solana', action: 'mint', eventId: 'mint-event', assetScale: 18 } as any;
    expect((await processLpCopyJob({ data } as any, { executionMode: { resolveMode: async () => mode }, exactPaper: f.service,
      dbStore: { createExecution, updateExecutionStatus } })).status).toBe('rejected');
    expect((await processLpCopyJob({ data: { ...data, action: 'burn' } } as any, { executionMode: { resolveMode: async () => 'paper' }, exactPaper: f.service })).status).toBe('rejected');
    expect(createExecution).not.toHaveBeenCalled(); expect(f.state.commits).toEqual([]);
  });
  it('default injected factory has truthful providerless capabilities', () => {
    const f = lpPaperFixture(buildExactPaperPlan); const domain = createExactLpDomain({ store: f.deps.store, mode: f.deps.mode });
    expect(domain.capabilities()).toMatchObject({ injectedPortsConfigured: false, runtimeAccepted: false, liveCapabilityAccepted: false, fractionalRawscaleDto: true });
  });
  it('monitor ignores numeric positive fake economics and schedules exact hint only', async () => {
    const queue = vi.fn(), exactQueue = vi.fn();
    const ports = { listPositions: async () => [{ id: 'p', chain: 'solana', poolAddress: 'solana:pool', state: 'out_of_range',
      rangeLower: 90, rangeUpper: 110, strategyType: 'spot', autoRebalance: true, onChainPositionAddress: null }],
      pricePoller: { currentPrice: async () => 200 }, transition: vi.fn(), queueRebalance: queue, queueExactRebalance: exactQueue,
      economics: { estimate: async () => ({ expectedExtraFeesUsd: 100, gasCostUsd: 0, rebalanceCostUsd: 0, inventoryChangeUsd: 0, impermanentLossUsd: 0 }) } } as any;
    expect((await runMonitorPass(ports, 'solana')).rebalancesDeclined).toContainEqual({ positionId: 'p', reason: 'economics-unassessed' });
    expect(queue).not.toHaveBeenCalled(); expect(exactQueue).not.toHaveBeenCalled();
    const f = lpPaperFixture(buildExactPaperPlan); ports.economics.exactEstimate = async () => f.econ.evidence;
    expect((await runMonitorPass(ports, 'solana')).rebalancesQueued).toBe(1); expect(exactQueue).toHaveBeenCalledWith(expect.objectContaining({ netBenefitMicroUsd: '7800000' }));
  });
});
