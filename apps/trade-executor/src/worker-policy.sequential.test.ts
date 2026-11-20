import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
const mocks = vi.hoisted(() => ({ read: vi.fn(), current: vi.fn(), captured: vi.fn(), claim: vi.fn(),
  prepare: vi.fn(), dispatch: vi.fn(), reserve: vi.fn(), update: vi.fn(), settle: vi.fn(), uncertain: vi.fn(), delivery: vi.fn(), descriptor: vi.fn() }));
vi.mock('@swat/db/dist/copy-trade-lifecycle-owned.js', async () => ({
  ...(await vi.importActual<typeof import('@swat/db/dist/copy-trade-lifecycle-owned.js')>('@swat/db/dist/copy-trade-lifecycle-owned.js')),
  claimLotExitExecutionWithClient: mocks.claim
}));
vi.mock('@swat/db/dist/worker-execution.js', () => ({ readWorkerExecutionContextWithClient: mocks.read,
  prepareWorkerAttemptWithClient: mocks.prepare, markWorkerAttemptDispatchedWithClient: mocks.dispatch }));
vi.mock('@swat/db/dist/worker-policy.js', () => ({ readCurrentWorkerPolicyWithClient: mocks.current,
  readCapturedWorkerPolicyWithClient: mocks.captured }));
vi.mock('@swat/db/dist/risk-spend-owned.js', () => ({ reserveRiskSpend: mocks.reserve, updateRiskSpendReservation: mocks.update }));
vi.mock('@swat/db/dist/worker-settlement.js', () => ({ settleWorkerFillWithClient: mocks.settle, retainWorkerUncertaintyWithClient: mocks.uncertain }));
vi.mock('@swat/db/dist/package13-fanout-delivery.js', async () => ({
  ...(await vi.importActual<typeof import('@swat/db/dist/package13-fanout-delivery.js')>('@swat/db/dist/package13-fanout-delivery.js')),
  claimFanoutDelivery: mocks.delivery
}));
vi.mock('@swat/db/dist/fanout-worker-descriptor.js', () => ({ assertCanonicalFanoutDescriptor: mocks.descriptor }));
import { runCanonicalWorkerJob, type CanonicalWorkerPorts } from './worker-policy.js';
import { createExactPaperExitQuote } from './worker-paper-quote.js';
import type { CopyExecutionRecord } from '@swat/db/dist/copy-trade-lifecycle-owned.js';
const userId = '11111111-1111-1111-1111-111111111111';
const execution: CopyExecutionRecord = { id: '22222222-2222-2222-2222-222222222222', userId,
  signalId: '33333333-3333-3333-3333-333333333333', sourceTradeId: null, exitLotId: '44444444-4444-4444-4444-444444444444', exitTrigger: 'close-all',
  chain: 'solana', targetAccount: 'solana:target', tokenMint: 'solana:token', direction: 'sell', executionMode: 'paper',
  clientOrderId: 'canonical-order', state: 'requested', requestedBaseQuantity: '9007199254740993.000000000000000001',
  requestedQuoteQuantity: null, confirmedBaseQuantity: '0', confirmedQuoteQuantity: '0', quoteUnassessedFillCount: 0,
  reservedBaseQuantity: '9007199254740993.000000000000000001', submissionAttempts: 0, maxSubmissionAttempts: 3,
  simulationId: null, submissionType: null, submissionId: null, nextReconciliationAt: null,
  reconciliationClaimId: null, reconciliationAttempts: 0, maxReconciliationAttempts: 10,
  sourcePositionBeforeQuantity: null, sourceSellFraction: null };
const scope = { account: userId, chain: 'solana' as const, tokenMint: execution.tokenMint, masterWalletAddress: 'solana:master' };
const snapshot = { scope, policyId: 'policy', revision: 'revision', mode: 'paper' as const,
  mirrors: 'sells-only' as const, autoExecute: true, killed: false, maxSlippageBps: 50 };
const job = { ...execution, copyExecutionId: execution.id, acquisitionExecutionMode: 'paper', masterWalletAddress: scope.masterWalletAddress,
  score: 'not-an-entry-score', closeAll: true, sellTokenAmount: 1 }; // display number ignored
const client = { query: vi.fn().mockResolvedValue({ rows: [{ epoch: '7' }] }) } as unknown as PoolClient;
let events: string[];
let execute: ReturnType<typeof vi.fn>;
let ports: CanonicalWorkerPorts;
beforeEach(() => {
  vi.clearAllMocks(); events = [];
  mocks.read.mockResolvedValue({ execution, masterWalletAddress: scope.masterWalletAddress,
    ownedExit: { lotId: execution.exitLotId, availableQuantity: execution.requestedBaseQuantity,
      requestedQuantity: execution.requestedBaseQuantity, acquisitionMode: 'paper', maxSlippageBps: 40 } });
  mocks.current.mockResolvedValue({ snapshot, minimumScore: 80, platformMode: 'paper' });
  mocks.captured.mockResolvedValue(snapshot); mocks.claim.mockResolvedValue({ execution, created: false });
  mocks.prepare.mockResolvedValue({ executionId: execution.id, userId, policyRevision: 'revision', riskEpoch: null, fence: '1' });
  execute = vi.fn(async () => { events.push('effect'); return { kind: 'fill', executor: 'paper-exact', evidence: {
    executionId: execution.id, evidenceId: 'fill', evidenceType: 'paper_simulation', baseQuantity: execution.requestedBaseQuantity,
    feeUsd: '0', quoteLeg: { amount: '12', currency: 'USD' }, confirmationState: 'confirmed', completesExecution: true, occurredAt: new Date() } }; });
  ports = { transaction: async fn => { events.push('begin'); const value = await fn(client); events.push('commit'); return value; },
    authorize: vi.fn(), platformMode: vi.fn().mockResolvedValue('paper'),
    quote: vi.fn().mockResolvedValue({ requestedDebitUsd: null, execute }) };
  mocks.dispatch.mockImplementation(async () => { events.push('durable-dispatch'); });
  mocks.settle.mockImplementation(async () => { events.push('settle'); return { tradeId: 'trade', execution: { ...execution, state: 'confirmed' }, accountingComplete: true }; });
});
describe('real canonical worker orchestration', () => {
  function sourceSetup() {
    const sourceExecution = { ...execution, sourceTradeId: '66666666-6666-6666-6666-666666666666',exitLotId:null,exitTrigger:null,
      sourceSellFraction:'0.1',sourcePositionBeforeQuantity:'100' };
    const sourceJob = {...job,...sourceExecution,copyExecutionId:execution.id,exitLotId:null};
    const proof = {executionId:execution.id,userId,targetAccount:execution.targetAccount,chain:execution.chain,
      tokenMint:execution.tokenMint,masterWalletAddress:scope.masterWalletAddress,requestedQuantity:execution.requestedBaseQuantity,
      lots:[{lotId:'lot-owned',quantity:execution.requestedBaseQuantity,availableQuantity:execution.requestedBaseQuantity,
        acquisitionMode:'paper',maxSlippageBps:40,acquisitionExecutionId:'buy',acquisitionEvidenceId:'evidence',acquisitionSourceTradeId:'source-buy'}]};
    mocks.read.mockResolvedValue({execution:sourceExecution,masterWalletAddress:scope.masterWalletAddress,ownedExit:null,sourceSellLots:proof});
    mocks.descriptor.mockReturnValue(execution.id);
    client.query = vi.fn().mockResolvedValue({rows:[{execution_id:execution.id,descriptor:{data:{}},job_id:'persisted-job'}]});
    const claim = {signalId:execution.signalId,userId,executionMode:'paper',targetAccount:execution.targetAccount,owner:'runtime-owner',fence:'2'};
    mocks.delivery.mockImplementation(async (sameClient,_identity,input) => {
      expect(sameClient).toBe(client); expect(await input.admission(sameClient)).toMatchObject({allowed:true});
      events.push('delivery-claim'); return claim;
    });
    const sourcePorts={...ports,deliveryOwner:'runtime-owner',now:()=>new Date('2026-11-17T00:00:00Z'),deliveryLeaseMs:240_000};
    return {sourceExecution,sourceJob,sourcePorts,claim,proof};
  }
  it('source sell real owned per-lot proof and delivery claim compose pre-effect/financial commit before queue acknowledgement', async () => {
    const s=sourceSetup(); const result=await runCanonicalWorkerJob(s.sourceJob,s.sourcePorts); events.push('queue-ack');
    expect(result).toMatchObject({status:'paper-filled'});
    expect(mocks.settle).toHaveBeenCalledWith(client,expect.objectContaining({delivery:{claim:s.claim,now:s.sourcePorts.now()}}));
    expect(events).toEqual(['begin','commit','begin','delivery-claim','durable-dispatch','commit','effect','begin','settle','commit','queue-ack']);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('duplicate fanout queue cannot create second submission and financial failure forbids ack', async () => {
    const s=sourceSetup(); mocks.delivery.mockResolvedValue(null);
    expect(await runCanonicalWorkerJob(s.sourceJob,s.sourcePorts)).toMatchObject({status:'skipped'});
    expect(execute).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
    mocks.delivery.mockResolvedValue(s.claim); mocks.settle.mockRejectedValue(new Error('fanout economic commit lost'));
    await expect(runCanonicalWorkerJob(s.sourceJob,s.sourcePorts)).rejects.toThrow('economic commit');
    expect(events.at(-1)).toBe('begin');
  });
  it('source reorg/current stop after quote prevents owned per-lot effect', async () => {
    const s=sourceSetup(); mocks.read.mockResolvedValueOnce({execution:s.sourceExecution,masterWalletAddress:scope.masterWalletAddress,
      ownedExit:null,sourceSellLots:s.proof}).mockResolvedValueOnce(null);
    await expect(runCanonicalWorkerJob(s.sourceJob,s.sourcePorts)).rejects.toThrow('pre-effect ownership'); expect(execute).not.toHaveBeenCalled();
  });
  it('source paper acquired lot is never reassigned live and foreign proof never admits', async () => {
    const s=sourceSetup(); mocks.read.mockResolvedValue({execution:s.sourceExecution,masterWalletAddress:scope.masterWalletAddress,
      ownedExit:null,sourceSellLots:{...s.proof,lots:[{...s.proof.lots[0],acquisitionMode:'live'}]}});
    expect(await runCanonicalWorkerJob(s.sourceJob,s.sourcePorts)).toMatchObject({status:'skipped',reason:'acquisition-mode-not-permitted'});
    expect(execute).not.toHaveBeenCalled();
    mocks.read.mockResolvedValue({execution:s.sourceExecution,masterWalletAddress:scope.masterWalletAddress,
      ownedExit:null,sourceSellLots:{...s.proof,userId:'foreign'}});
    expect(await runCanonicalWorkerJob(s.sourceJob,s.sourcePorts)).toMatchObject({reason:'source-sell-lot-proof-scope-mismatch'});
  });
  it('queue buy score cannot override persisted immutable descriptor entry admission', async () => {
    const buy={...execution,direction:'buy' as const,sourceTradeId:'66666666-6666-6666-6666-666666666666',exitLotId:null,exitTrigger:null,
      requestedBaseQuantity:null,requestedQuoteQuantity:'0.3',reservedBaseQuantity:'0'};
    mocks.read.mockResolvedValue({execution:buy,masterWalletAddress:scope.masterWalletAddress,ownedExit:null});
    mocks.current.mockResolvedValue({snapshot:{...snapshot,mirrors:'buys-and-sells'},minimumScore:80,platformMode:'paper'});
    mocks.captured.mockResolvedValue({...snapshot,mirrors:'buys-and-sells'});
    mocks.descriptor.mockReturnValue(execution.id);
    client.query=vi.fn().mockResolvedValue({rows:[{descriptor:{data:{score:79}},job_id:'persisted-job'}]});
    await expect(runCanonicalWorkerJob({...job,...buy,copyExecutionId:execution.id,score:100},ports)).rejects.toThrow('persisted entry score');
    expect(ports.quote).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
  });
  it('joins scorer claim, exact DB exit/current policy and commits before effect and acknowledgement', async () => {
    expect(await runCanonicalWorkerJob(job, ports)).toMatchObject({ status: 'paper-filled' });
    expect(mocks.claim).toHaveBeenCalledWith(client, expect.objectContaining({ requestedBaseQuantity: execution.requestedBaseQuantity,
      requestId: `close-all-${userId}-${execution.exitLotId}` }));
    expect(mocks.settle).toHaveBeenCalledWith(client, expect.objectContaining({ slippageBps: 40,
      evidence: expect.objectContaining({ baseQuantity: execution.requestedBaseQuantity }) }));
    expect(events).toEqual(['begin','commit','begin','durable-dispatch','commit','effect','begin','settle','commit']);
    expect(ports.authorize).not.toHaveBeenCalled();
  });
  it.each(['targetAccount','masterWalletAddress','userId','signalId','tokenMint','requestedBaseQuantity'])('rejects changed immutable %s before effect', async field => {
    const changed = field === 'userId' ? '55555555-5555-5555-5555-555555555555' : field === 'requestedBaseQuantity' ? '1' : 'solana:foreign';
    await expect(runCanonicalWorkerJob({ ...job, [field]: changed }, ports)).rejects.toThrow(/immutable|match/);
    expect(execute).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled();
  });
  it('cannot assign a live acquisition to current paper mode', async () => {
    const live = { ...execution, executionMode: 'live' as const };
    mocks.read.mockResolvedValue({ execution: live, masterWalletAddress: scope.masterWalletAddress,
      ownedExit: { lotId: live.exitLotId, availableQuantity: live.requestedBaseQuantity,
        requestedQuantity: live.requestedBaseQuantity, acquisitionMode: 'live', maxSlippageBps: 40 } });
    mocks.claim.mockResolvedValue({ execution: live, created: false });
    expect(await runCanonicalWorkerJob({ ...job, acquisitionExecutionMode: 'live' }, ports)).toMatchObject({ status: 'skipped', reason: 'acquisition-mode-not-permitted' });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([null, { ...snapshot, killed: true }, { ...snapshot, autoExecute: false }, { ...snapshot, mirrors: 'none' }])('refuses missing/stopped current policy even with closeAll=true', async current => {
    mocks.current.mockResolvedValue(current ? { snapshot: current, minimumScore: 80 } : null);
    expect(await runCanonicalWorkerJob(job, ports)).toMatchObject({ status: 'skipped' }); expect(execute).not.toHaveBeenCalled();
  });
  it('rechecks policy after quote before external effect', async () => {
    mocks.current.mockResolvedValueOnce({ snapshot, minimumScore: 80 }).mockResolvedValueOnce({ snapshot: { ...snapshot, killed: true }, minimumScore: 80 });
    expect(await runCanonicalWorkerJob(job, ports)).toMatchObject({ reason: 'execution-stopped' }); expect(execute).not.toHaveBeenCalled();
  });
  it.each(['confirmed','failed','cancelled','submitted','partially_filled','reconciliation_required'])('never requotes terminal/pending %s', async state => {
    mocks.read.mockResolvedValue({ execution: { ...execution, state }, masterWalletAddress: scope.masterWalletAddress, ownedExit: null });
    await runCanonicalWorkerJob(job, ports); expect(ports.quote).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('retains uncertainty when execute throws and commits before returning submitted', async () => {
    execute.mockRejectedValue(new Error('transport outcome unknown'));
    expect(await runCanonicalWorkerJob(job, ports)).toMatchObject({ status: 'submitted', state: 'reconciliation_required' });
    expect(mocks.uncertain).toHaveBeenCalledWith(client, expect.objectContaining({ reason: 'transport outcome unknown' }));
    expect(events.at(-1)).toBe('commit'); expect(mocks.settle).not.toHaveBeenCalled();
  });
  it.each(['partially_filled','reconciliation_required'])('never reports %s settlement as filled', async state => {
    mocks.settle.mockResolvedValue({ tradeId: 'trade', execution: { ...execution, state }, accountingComplete: false });
    expect(await runCanonicalWorkerJob(job, ports)).toMatchObject({ status: 'submitted', state });
  });
  it('revoked authority during quote blocks before durable dispatch', async () => {
    const live = { ...execution, executionMode: 'live' as const };
    mocks.read.mockResolvedValue({ execution: live, masterWalletAddress: scope.masterWalletAddress,
      ownedExit: { lotId: live.exitLotId, availableQuantity: live.requestedBaseQuantity,
        requestedQuantity: live.requestedBaseQuantity, acquisitionMode: 'live', maxSlippageBps: 40 } });
    mocks.claim.mockResolvedValue({ execution: live, created: false });
    mocks.captured.mockResolvedValue({ ...snapshot, mode: 'live' });
    mocks.current.mockResolvedValue({ snapshot: { ...snapshot, mode: 'live' }, minimumScore: 80, platformMode: 'live' });
    vi.mocked(ports.platformMode).mockResolvedValue('live');
    vi.mocked(ports.authorize).mockResolvedValueOnce({ kind: 'granted', authority: { adapterId: 'version-1',
      chain: 'solana', principal: { kind: 'user', userId }, settlementAddress: 'target', signingAddress: 'signer',
      capabilities: ['sign-chain-transaction'], expiresAt: null, sign: vi.fn() } })
      .mockResolvedValueOnce({ kind: 'denied', code: 'authority-grant-expired', reason: 'revoked during quote' });
    expect(await runCanonicalWorkerJob({ ...job, acquisitionExecutionMode: 'live' }, ports)).toMatchObject({ reason: 'pre-effect-authority-changed-or-unavailable' });
    expect(execute).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('propagates accounting failure rather than acknowledging/skipping a fill', async () => {
    mocks.settle.mockRejectedValue(new Error('capacity commit failure'));
    await expect(runCanonicalWorkerJob(job, ports)).rejects.toThrow('capacity commit failure');
    expect(execute).toHaveBeenCalledOnce(); expect(events.at(-1)).toBe('begin');
  });
  it('refuses unavailable quote capability before creating durable attempt', async () => {
    vi.mocked(ports.quote).mockResolvedValue(null);
    expect(await runCanonicalWorkerJob(job, ports)).toMatchObject({ reason: 'trusted-paper-valuation-unavailable' });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('existing attempt is uncertainty, never redispatched', async () => {
    mocks.prepare.mockResolvedValue(null);
    expect(await runCanonicalWorkerJob(job, ports)).toMatchObject({ reason: 'canonical-attempt-exists-reconcile-without-new-effect' });
    expect(execute).not.toHaveBeenCalled();
  });
});
describe('real exact paper quote seam', () => {
  it('keeps ledger precision through exact valuation and evidence without float quantity', async () => {
    const now = new Date('2026-11-16T00:00:00Z');
    const quote = await createExactPaperExitQuote({ now: () => now, maximumAgeMs: 1000,
      readValuation: async () => ({ priceUsd: '2', observedAt: now, evidenceId: 'reviewed-price' }) })(execution);
    const result = await quote!.execute({ execution, attempt: {} as never, risk: null, maxSlippageBps: 40 });
    expect(result.kind).toBe('fill');
    if (result.kind !== 'fill') throw new Error('missing exact paper fill');
    expect(result.evidence.baseQuantity).toBe(execution.requestedBaseQuantity);
    expect(result.evidence.quoteLeg?.amount).toBe('18014398509481986.000000000000000002');
  });
  it('refuses stale/future/missing valuation instead of price defaults', async () => {
    const now = new Date('2026-11-16T00:00:00Z');
    for (const observedAt of [new Date(now.getTime()-1001), new Date(now.getTime()+1)]) {
      expect(await createExactPaperExitQuote({ now: () => now, maximumAgeMs: 1000,
        readValuation: async () => ({ priceUsd: '2', observedAt, evidenceId: 'price' }) })(execution)).toBeNull();
    }
  });
});
