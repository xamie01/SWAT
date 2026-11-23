import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ ensure: vi.fn(), batch: vi.fn(), claim: vi.fn(), fail: vi.fn(), complete: vi.fn(),
  list: vi.fn(), prepare: vi.fn(), queued: vi.fn(), context: vi.fn(), captured: vi.fn(), current: vi.fn() }));
vi.mock('@swat/db/dist/package13-fanout-delivery.js', () => ({
  ensureFanoutEnumeration: db.ensure, getFanoutBatch: db.batch, claimFanoutEnumeration: db.claim,
  failFanoutEnumeration: db.fail, completeFanoutEnumeration: db.complete, listFanoutDeliveries: db.list,
  prepareFanoutDeliveryQueueWithClient: db.prepare, markFanoutDeliveryQueued: db.queued,
  claimFanoutDelivery: vi.fn(), settleFanoutDelivery: vi.fn()
}));
vi.mock('@swat/db/dist/copy-trade-lifecycle-owned.js', () => ({ normalizeTenantId: (id: string) => id,
  claimLotExitExecutionWithClient: vi.fn() }));
vi.mock('@swat/db/dist/lot-allocation.js', () => ({ assertLotExitExecutionMatches: vi.fn() }));
vi.mock('@swat/db/dist/worker-execution.js', () => ({ readWorkerExecutionContextWithClient: db.context,
  prepareWorkerAttemptWithClient: vi.fn(), markWorkerAttemptDispatchedWithClient: vi.fn() }));
vi.mock('@swat/db/dist/worker-policy.js', () => ({ readCapturedWorkerPolicyWithClient: db.captured,
  readCurrentWorkerPolicyWithClient: db.current }));
vi.mock('@swat/db/dist/risk-spend-owned.js', () => ({ reserveRiskSpend: vi.fn(), updateRiskSpendReservation: vi.fn() }));
vi.mock('@swat/db/dist/worker-settlement.js', () => ({ settleWorkerFillWithClient: vi.fn(), retainWorkerUncertaintyWithClient: vi.fn() }));
import { createDurableFanoutDelivery, enqueueFanoutTradeJobs, fanoutDescriptorIdentity, planFanoutTradeJobs,
  type DurableFanoutCaller, type FanoutJobDescriptor } from './fanout-enqueue.js';
import { createCanonicalFanoutPreparation, unavailableExactFanoutEntryRequest, createVerifiedFanoutAdmission,
  classifyFanoutRefusal, requireStableFanoutExclusions, type CanonicalFanoutPorts } from './fanout-canonical.js';
// Explicit actual worker module, imported without making application rootDir
// compilation pull another app's source into this package's production program.
const workerModule = '../../trade-executor/src/worker-policy.js';
const { parseCanonicalWorkerJob, runCanonicalWorkerJob } = await import(workerModule);
import type { PoolClient } from '@swat/db/dist/copy-trade-lifecycle-owned.js';
import type { CopyExecutionRecord } from '@swat/db/dist/copy-trade-lifecycle-owned.js';
import type { FanoutRecipient, FanoutExclusion } from '@swat/db/dist/package13-fanout-delivery.js';
const SIGNAL = '11111111-1111-4111-8111-111111111111', SOURCE = '22222222-2222-4222-8222-222222222222';
const USERS = [null, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const TARGET = 'solana:11111111111111111111111111111111', MASTER = 'solana:11111111111111111111111111111112';
const QUANTITY = '9007199254740993.000000000000000001';
const plan = planFanoutTradeJobs({ signalId: SIGNAL, tokenMint: TARGET, score: 90, clusterTier: 'elite',
  sourceTrade: { sourceTradeId: SOURCE, direction: 'buy' }, plan: { eligible: [], excluded: [], exclusionCounts: {} } });
let events: string[];
function candidate(userId: string | null): FanoutJobDescriptor {
  return { ...plan.operator, options: { ...plan.operator.options, jobId: `source-${SIGNAL}-${userId ?? 'operator'}` },
    data: { ...plan.operator.data, userId, targetAccount: TARGET, executionMode: 'paper' } };
}
function execution(descriptor: FanoutJobDescriptor): CopyExecutionRecord {
  return { id: `55555555-5555-4555-8555-${descriptor.data.userId === null ? '555555555555'
    : descriptor.data.userId === USERS[1] ? '555555555556' : '555555555557'}`,
    signalId: SIGNAL, sourceTradeId: SOURCE, userId: descriptor.data.userId ?? null, targetAccount: TARGET,
    chain: 'solana', tokenMint: TARGET, direction: descriptor.data.direction!, executionMode: 'paper', state: 'requested',
    requestedBaseQuantity: QUANTITY, requestedQuoteQuantity: '100.000000000000000001',
    confirmedBaseQuantity: '0', confirmedQuoteQuantity: '0', submissionId: null, submissionAttempts: 0,
    reservedBaseQuantity: '0', clientOrderId: 'fixture', maxSubmissionAttempts: 3, simulationId: null,
    submissionType: null, nextReconciliationAt: null, reconciliationClaimId: null, reconciliationAttempts: 0,
    maxReconciliationAttempts: 10, sourcePositionBeforeQuantity: null, sourceSellFraction: null, quoteUnassessedFillCount: 0 };
}
function fixture() {
  let complete = false;
  let stored: FanoutRecipient[] = [];
  let exclusions: FanoutExclusion[] = [];
  let failCommit = false;
  const client = { query: vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes('SELECT *,fence::text AS fence FROM source_fanout_deliveries')) {
      return { rows: stored.filter(recipient => {
        const data = recipient.descriptor.data as Record<string, unknown>;
        return data.copyExecutionId === values[0] && recipient.signalId === values[1]
          && recipient.userId === values[2] && recipient.executionMode === values[3]
          && recipient.targetAccount === values[4];
      }).map(recipient => ({ descriptor: recipient.descriptor, job_id: recipient.jobId })) };
    }
    return { rows: [{ chain: 'solana', token_mint: TARGET }] };
  }) };
  const executions = new Map<string, CopyExecutionRecord>();
  const ports: CanonicalFanoutPorts = {
    claim: vi.fn(async (locked, input) => { expect(locked).toBe(client); events.push(`claim-${input.userId ?? 'operator'}`);
      const row = execution(candidate(input.userId)); executions.set(row.id, row); return { execution: row, created: true, claimed: true }; }),
    context: vi.fn(async (locked, id) => { expect(locked).toBe(client); return { execution: executions.get(id)!, masterWalletAddress: MASTER, ownedExit: null }; }),
    capturedPolicy: vi.fn(async (locked, row) => { expect(locked).toBe(client); events.push('captured-policy'); return {
      scope: { account: row.userId ?? 'operator', chain: 'solana', tokenMint: TARGET, masterWalletAddress: MASTER },
      policyId: 'captured', revision: 'original', mode: 'paper', mirrors: 'buys-and-sells', autoExecute: true, killed: false, maxSlippageBps: 50 } as const; }),
    exactEntryRequest: vi.fn(async locked => { expect(locked).toBe(client); return { requestedBaseQuantity: QUANTITY, requestedQuoteQuantity: '100.000000000000000001' }; }),
    now: () => new Date('2026-11-17T00:00:00Z'), maxPositionEvidenceAgeMs: 1000
  };
  const caller: DurableFanoutCaller = {
    owner: 'fixture', now: ports.now,
    transaction: async operation => { const oldStored = stored, oldComplete = complete, oldExecutions = new Map(executions);
      try { const result = await operation(client as never); if (failCommit && events.includes('persist')) throw new Error('commit lost');
        events.push('COMMIT'); return result; }
      catch (error) { stored = oldStored; complete = oldComplete; executions.clear(); for (const [id, row] of oldExecutions) executions.set(id, row);
        events.push('ROLLBACK'); throw error; } },
    enumerate: vi.fn(async () => ({ recipients: USERS.map(userId => { const descriptor = candidate(userId);
      return { ...fanoutDescriptorIdentity(descriptor), jobId: descriptor.options.jobId!, descriptor: descriptor as unknown as Record<string, unknown> }; }), exclusions: [] })),
    admission: vi.fn(async (locked, descriptor) => { expect(locked).toBe(client); events.push(`admit-${descriptor.data.userId ?? 'operator'}`); return { allowed: true }; }),
    canonicalPrepare: createCanonicalFanoutPreparation(ports)
  };
  db.batch.mockImplementation(async () => ({ source_trade_id: SOURCE, state: complete ? 'complete' : 'pending' }));
  db.claim.mockResolvedValue({ signalId: SIGNAL, sourceTradeId: SOURCE, owner: 'fixture', fence: '1' });
  db.complete.mockImplementation(async (locked, _claim, snapshot) => { expect(locked).toBe(client); events.push('persist'); stored = snapshot.recipients; exclusions = snapshot.exclusions; complete = true; });
  db.list.mockImplementation(async () => stored.map(recipient => ({ signal_id: SIGNAL, user_id: recipient.userId,
    execution_mode: recipient.executionMode, target_account: recipient.targetAccount, job_id: recipient.jobId,
    descriptor: recipient.descriptor, execution_id: (recipient.descriptor.data as Record<string, unknown>).copyExecutionId })));
  db.prepare.mockImplementation(async (locked, identity, input) => (await input.admission(locked)).allowed
    ? { descriptor: stored.find(row => row.userId === identity.userId)!.descriptor } : null);
  db.queued.mockImplementation(async () => { events.push('queued'); });
  const queue = { add: vi.fn(async () => { expect(events.at(-1)).toBe('COMMIT'); events.push('queue'); }) };
  return { caller, ports, queue, executions, client, delivery: createDurableFanoutDelivery(caller),
    stored: () => stored, exclusions: () => exclusions, failCommit: () => { failCommit = true; } };
}
beforeEach(() => { vi.clearAllMocks(); events = []; });
describe('actual index-used verified admission and explicit outcomes', () => {
  it('accepted per-source row permits current admission on the same client without global readiness', async () => {
    const client = {} as never, current = vi.fn(async () => ({ allowed: true }));
    const accepted = vi.fn(async (locked: PoolClient, id: string) => { expect(locked).toBe(client); expect(id).toBe(SOURCE); return true; });
    const admission = createVerifiedFanoutAdmission({ accepted, current, now: () => new Date('2026-11-17T00:00:00Z') });
    expect(await admission(client, candidate(null))).toEqual({ allowed: true });
    expect(current).toHaveBeenCalledWith(client, candidate(null));
  });
  it('absent protected registry/evidence refuses before current policy regardless of labels', async () => {
    const current = vi.fn(); const admission = createVerifiedFanoutAdmission({ accepted: async () => false,
      current, now: () => new Date('2026-11-17T00:00:00Z') });
    expect(await admission({} as never, candidate(null))).toEqual({ allowed: false, reason: 'accepted-source-verification-unavailable' });
    expect(current).not.toHaveBeenCalled();
  });
  it.each(['balance-unknown','capacity-unknown','chain-mode-unknown','subscription-window-unknown',
    'source-event-time-unknown','user-killed-or-unreadable','owned-exit-scope-missing-or-mixed',
    'new-unrecognized-code','entry-safety-refused'])('technical initial outcome %s retains pending seed', async code => {
    const f = fixture(); f.caller.enumerate = vi.fn(async () => ({ recipients: [], exclusions: [{ userId: null, code }] }));
    await expect(enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).rejects.toThrow(code);
    expect(db.complete).not.toHaveBeenCalled(); expect(db.fail).toHaveBeenCalled(); expect(f.ports.claim).not.toHaveBeenCalled();
    expect(f.queue.add).not.toHaveBeenCalled(); expect(classifyFanoutRefusal(code)).toBe('retryable');
  });
  it('proven policy exclusions alone can be persisted, without regex inference', () => {
    expect(classifyFanoutRefusal('auto-execute-off')).toBe('excluded');
    expect(() => requireStableFanoutExclusions([{ userId: null, code: 'token-blacklisted' }])).not.toThrow();
  });
  it('unknown admission code without technical keywords retains seed rather than freezing exclusion', async () => {
    const f = fixture(); f.caller.admission = vi.fn(async () => ({ allowed: false, reason: 'provider-pending' }));
    await expect(enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).rejects.toThrow('provider-pending');
    expect(db.complete).not.toHaveBeenCalled(); expect(f.queue.add).not.toHaveBeenCalled();
  });
  it('legacy row does not prevent healthy peer delivery and completed legacy row needs no validation', async () => {
    const f = fixture(); await enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery); f.queue.add.mockClear();
    const originalList = db.list.getMockImplementation()!;
    db.list.mockImplementation(async () => [{ signal_id: SIGNAL, user_id: null, execution_mode: 'paper', target_account: TARGET,
      state: 'completed', descriptor: {} }, { signal_id: SIGNAL, user_id: USERS[1], execution_mode: 'paper', target_account: TARGET,
      state: 'pending', descriptor: {} }, ...(await originalList()).filter((row: { user_id: string | null }) => row.user_id === USERS[2])]);
    db.prepare.mockImplementation(async (_client, identity) => identity.userId === USERS[2]
      ? { descriptor: f.stored().find(row => row.userId === USERS[2])!.descriptor } : null);
    expect(await enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).toBe(1);
    expect(db.prepare).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ userId: USERS[2] }), expect.anything());
    expect(f.queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('atomic admitted canonical fanout to actual worker comparison seam', () => {
  it('prelocks all sorted operator/two-tenant position scopes before any shared row lock with a fake waiting worker', async () => {
    const f = fixture(); const keys = USERS.map(user => JSON.stringify([TARGET, 'solana', TARGET, user])).sort();
    const acquired: string[] = []; let sharedSignalLocked = false, workerFinished = false;
    // Protocol schedule only: a worker already owns the final tenant position
    // key and needs source-signal SHARE. It can finish before producer owns any
    // signal/policy row; acquiring a later key after first claim would deadlock.
    const workerKey = JSON.stringify([TARGET, 'solana', TARGET, USERS[2]]);
    f.client.query.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT source.chain')) {
        expect(sql).not.toMatch(/FOR SHARE|FOR UPDATE/); return { rows: [{ chain: 'solana', token_mint: TARGET }] };
      }
      expect(sql).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
      expect(sharedSignalLocked).toBe(false);
      if (values[0] === workerKey) { expect(sharedSignalLocked).toBe(false); workerFinished = true; }
      acquired.push(String(values[0])); events.push('position-lock'); return { rows: [{ chain: 'solana', token_mint: TARGET }] };
    });
    f.caller.admission = vi.fn(async () => {
      expect(acquired).toEqual(keys); expect(workerFinished).toBe(true); sharedSignalLocked = true; return { allowed: true };
    });
    const originalClaim = f.ports.claim;
    f.ports.claim = vi.fn(async (client, input) => { expect(acquired).toEqual(keys); expect(workerFinished).toBe(true);
      return originalClaim(client, input); });
    f.caller.canonicalPrepare = createCanonicalFanoutPreparation(f.ports);
    expect(await enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).toBe(3);
    expect(f.client.query).toHaveBeenCalledTimes(4); expect(f.ports.claim).toHaveBeenCalledTimes(3);
  });
  it('does not prelock proven excluded recipients and validates every discovered scope before any key or admission', async () => {
    const f = fixture(); f.caller.enumerate = vi.fn(async () => { const descriptor = candidate(null);
      return { recipients: [{ ...fanoutDescriptorIdentity(descriptor), jobId: descriptor.options.jobId!,
        descriptor: descriptor as unknown as Record<string, unknown> }], exclusions: [{ userId: USERS[1], code: 'auto-execute-off' }] }; });
    expect(await enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).toBe(1);
    expect(f.client.query.mock.calls.slice(1).map(call => call[1])).toEqual([[JSON.stringify([TARGET, 'solana', TARGET, null])]]);
    const bad = fixture(); bad.caller.enumerate = vi.fn(async () => { const descriptor = candidate(USERS[1]);
      const invalid = { ...descriptor, data: { ...descriptor.data, targetAccount: 'solana:invalid' } };
      return { recipients: [{ signalId: SIGNAL, userId: USERS[1], executionMode: 'paper' as const, targetAccount: 'solana:invalid',
        jobId: descriptor.options.jobId!, descriptor: invalid as unknown as Record<string, unknown> }], exclusions: [] }; });
    await expect(enqueueFanoutTradeJobs(() => bad.queue, plan, bad.delivery)).rejects.toThrow(/address|scope/);
    expect(bad.client.query).toHaveBeenCalledTimes(1); expect(bad.caller.admission).not.toHaveBeenCalled();
    expect(bad.ports.claim).not.toHaveBeenCalled();
  });
  it('operator and two tenants persist distinct executions and complete parseable exact worker jobs before queue', async () => {
    const f = fixture(); expect(await enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).toBe(3);
    expect(new Set(f.stored().map(row => (row.descriptor.data as Record<string, unknown>).copyExecutionId)).size).toBe(3);
    for (const recipient of f.stored()) {
      const parsed = parseCanonicalWorkerJob(recipient.descriptor.data);
      expect(parsed).toMatchObject({ userId: recipient.userId, masterWalletAddress: MASTER, requestedBaseQuantity: QUANTITY,
        requestedQuoteQuantity: '100.000000000000000001', sourceTradeId: SOURCE, exitLotId: null, executionMode: 'paper' });
      const row = f.executions.get(parsed.copyExecutionId)!;
      db.context.mockResolvedValue({ execution: row, masterWalletAddress: MASTER, ownedExit: null });
      const quote = vi.fn(), authorize = vi.fn();
      // The injected context alone grants no policy authority. This worker seam
      // checks durable identity/score, then refuses the absent policy before effects.
      expect(await runCanonicalWorkerJob(parsed, { transaction: f.caller.transaction, quote,
        platformMode: async () => 'paper', authorize })).toMatchObject({ status: 'skipped', reason: 'execution-policy-unavailable' });
      expect(quote).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
    }
    expect(events.indexOf('persist')).toBeGreaterThan(events.indexOf('captured-policy'));
  });
  it('current denial excludes a tenant without calling claim or exact sizing for it', async () => {
    const f = fixture(); f.caller.admission = vi.fn(async (_client, descriptor) => descriptor.data.userId === USERS[2]
      ? { allowed: false, reason: 'auto-execute-off' } : { allowed: true });
    expect(await enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).toBe(2);
    expect(f.ports.claim).toHaveBeenCalledTimes(2); expect(f.ports.exactEntryRequest).toHaveBeenCalledTimes(2);
    expect(f.exclusions()).toEqual([{ userId: USERS[2], code: 'auto-execute-off' }]);
  });
  it('rollback of descriptor commit rolls back claims and cannot queue', async () => {
    const f = fixture(); f.failCommit(); await expect(enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).rejects.toThrow('commit lost');
    expect(f.executions.size).toBe(0); expect(f.stored()).toEqual([]); expect(f.queue.add).not.toHaveBeenCalled(); expect(events).toContain('ROLLBACK');
  });
  it('queue loss, removal, changed policy/mode and retry retain original descriptors/executions without replanning', async () => {
    const f = fixture(); f.queue.add.mockRejectedValueOnce(new Error('queue lost'));
    await expect(enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).rejects.toThrow('queue lost');
    const original = JSON.stringify(f.stored()); const claims = vi.mocked(f.ports.claim).mock.calls.length;
    f.caller.enumerate = vi.fn(async () => { throw new Error('recipients removed'); });
    f.ports.exactEntryRequest = vi.fn(async () => { throw new Error('sizing changed'); });
    expect(await enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).toBe(3);
    expect(JSON.stringify(f.stored())).toBe(original); expect(f.ports.claim).toHaveBeenCalledTimes(claims); expect(f.caller.enumerate).not.toHaveBeenCalled();
    f.caller.admission = vi.fn(async () => ({ allowed: false, reason: 'immutable-recipient-scope-changed' }));
    expect(await enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).toBe(0); expect(JSON.stringify(f.stored())).toBe(original);
  });
  it('lost queue ack requeues byte-identical persisted descriptor after queue removal', async () => {
    const f = fixture(); db.queued.mockRejectedValueOnce(new Error('ack lost'));
    await expect(enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).rejects.toThrow('ack lost');
    expect(await enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).toBe(3);
    expect(f.queue.add.mock.calls[0]).toEqual(f.queue.add.mock.calls[1]); expect(f.ports.claim).toHaveBeenCalledTimes(3);
  });
  it('unavailable source admission leaves pending seed, no claims and no false empty completion', async () => {
    const f = fixture(); f.caller.admission = vi.fn(async () => ({ allowed: false, reason: 'source-verifier-unavailable' }));
    await expect(enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).rejects.toThrow('source-verifier-unavailable');
    expect(f.ports.claim).not.toHaveBeenCalled(); expect(db.complete).not.toHaveBeenCalled(); expect(db.fail).toHaveBeenCalled(); expect(f.queue.add).not.toHaveBeenCalled();
  });
  it('default exact follower sizing is unavailable without master quantity/float/env fallback', async () => {
    const f = fixture(); f.ports.exactEntryRequest = unavailableExactFanoutEntryRequest;
    f.caller.canonicalPrepare = createCanonicalFanoutPreparation(f.ports);
    await expect(enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).rejects.toThrow('exact-follower-entry-sizing-unavailable');
    expect(f.ports.claim).not.toHaveBeenCalled(); expect(db.complete).not.toHaveBeenCalled(); expect(f.queue.add).not.toHaveBeenCalled();
  });
  it('floating exact sizing cannot reach canonical claim', async () => {
    const f = fixture(); f.ports.exactEntryRequest = vi.fn(async () => ({ requestedBaseQuantity: Number(QUANTITY), requestedQuoteQuantity: null }) as never);
    f.caller.canonicalPrepare = createCanonicalFanoutPreparation(f.ports);
    await expect(enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).rejects.toThrow(/exact follower sizing/);
    expect(f.ports.claim).not.toHaveBeenCalled(); expect(f.queue.add).not.toHaveBeenCalled();
  });
  it('captured policy mismatch rolls back source claim before descriptor/queue', async () => {
    const f = fixture(); f.ports.capturedPolicy = vi.fn(async () => null);
    f.caller.canonicalPrepare = createCanonicalFanoutPreparation(f.ports);
    await expect(enqueueFanoutTradeJobs(() => f.queue, plan, f.delivery)).rejects.toThrow(/captured policy/);
    expect(f.executions.size).toBe(0); expect(db.complete).not.toHaveBeenCalled(); expect(f.queue.add).not.toHaveBeenCalled();
  });
});
