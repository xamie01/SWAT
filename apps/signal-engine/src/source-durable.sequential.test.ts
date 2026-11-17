import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ ensure: vi.fn(),batch: vi.fn(),claim: vi.fn(),fail: vi.fn(),complete: vi.fn(),list: vi.fn(),prepare: vi.fn(),queued: vi.fn() }));
vi.mock('@swat/db', () => ({ ensureFanoutEnumeration: db.ensure,getFanoutBatch: db.batch,claimFanoutEnumeration: db.claim,
  failFanoutEnumeration: db.fail,completeFanoutEnumeration: db.complete,listFanoutDeliveries: db.list,
  prepareFanoutDeliveryQueueWithClient: db.prepare,markFanoutDeliveryQueued: db.queued }));
import { createDurableFanoutDelivery, enqueueFanoutTradeJobs, planFanoutTradeJobs, type DurableFanoutCaller } from './fanout-enqueue.js';
import { evaluateSignalTradeEligibility } from './trade-eligibility.js';
let events: string[];
const plan = planFanoutTradeJobs({ signalId: 'signal',tokenMint: 'solana:token',score: 10,clusterTier: 'speculative',
  sourceTrade: { sourceTradeId: 'source',direction: 'sell' },plan: { eligible: [],excluded: [],exclusionCounts: {} } });
const descriptor = { ...plan.operator,data: { ...plan.operator.data,userId: null,executionMode: 'paper' as const,targetAccount: 'solana:paper',
  copyExecutionId: 'execution', masterWalletAddress: 'solana:master', requestedBaseQuantity: '1.000000000000000001',
  requestedQuoteQuantity: null, exitLotId: null } };
function caller(): DurableFanoutCaller { return { owner: 'fixture',now: () => new Date('2026-11-16T00:00:00Z'),
  transaction: async operation => { const result = await operation({} as never); events.push('COMMIT'); return result; },
  enumerate: vi.fn(async () => { events.push('enumerate'); return { recipients: [],exclusions: [] }; }),
  admission: vi.fn(async () => ({ allowed: false,reason: 'source-confirmation-verifier-unavailable' })),
  canonicalPrepare: vi.fn(async (_client, candidate) => ({ descriptor: candidate })) }; }
beforeEach(() => { vi.clearAllMocks(); events = [];
  db.batch.mockResolvedValue({ source_trade_id: 'source',state: 'complete' }); db.claim.mockResolvedValue({ signalId: 'signal' });
  db.list.mockResolvedValue([{ signal_id: 'signal',user_id: null,execution_mode: 'paper',target_account: 'solana:paper',
    job_id: descriptor.options.jobId,descriptor, execution_id: descriptor.data.copyExecutionId }]);
  db.prepare.mockImplementation(async (_client,_identity,input) => { const verdict = await input.admission({} as never);
    events.push('admission'); return verdict.allowed ? { descriptor } : null; });
  db.queued.mockImplementation(async () => { events.push('queue-marker'); });
});
describe('invoked durable source fanout recovery without verifier readiness', () => {
  it('committed recipient snapshot is reused; current no-verifier admission cannot queue', async () => {
    const c = caller(); const queue = { add: vi.fn() };
    expect(await enqueueFanoutTradeJobs(() => queue,plan,createDurableFanoutDelivery(c))).toBe(0);
    expect(c.enumerate).not.toHaveBeenCalled(); expect(c.admission).toHaveBeenCalled(); expect(queue.add).not.toHaveBeenCalled();
  });
  it('failed enumeration commits durable failure and never degrades to operator-only queue success', async () => {
    db.batch.mockResolvedValue({ source_trade_id: 'source',state: 'pending' }); const c = caller();
    c.enumerate = vi.fn(async () => { throw new Error('enumeration unavailable'); }); const queue = { add: vi.fn() };
    await expect(enqueueFanoutTradeJobs(() => queue,plan,createDurableFanoutDelivery(c))).rejects.toThrow('enumeration unavailable');
    expect(db.fail).toHaveBeenCalled(); expect(queue.add).not.toHaveBeenCalled(); expect(events.at(-1)).toBe('COMMIT');
  });
  it('prepared original descriptor commit precedes queue; queue-ack failure retains replay identity', async () => {
    const c = caller(); c.admission = vi.fn(async () => ({ allowed: true }));
    const queue = { add: vi.fn(async () => { expect(events.at(-1)).toBe('COMMIT'); events.push('queue'); }) };
    db.queued.mockRejectedValueOnce(new Error('ack write lost'));
    const delivery = createDurableFanoutDelivery(c);
    await expect(enqueueFanoutTradeJobs(() => queue,plan,delivery)).rejects.toThrow('ack write lost');
    expect(await enqueueFanoutTradeJobs(() => queue,plan,delivery)).toBe(1);
    expect(queue.add.mock.calls[0]).toEqual(queue.add.mock.calls[1]); expect(c.enumerate).not.toHaveBeenCalled();
  });
  it('reducing eligibility reaches owned-exit candidate stage, never restores source authority', () => {
    expect(evaluateSignalTradeEligibility('source_trade',{ direction: 'sell',score: 0,minimumScore: 80,suppressTrade: false,safety: { isSafe: false } }))
      .toEqual({ allowed: true,requiresOwnedExit: true });
    expect(evaluateSignalTradeEligibility('source_trade',{ direction: 'sell',score: 0,minimumScore: 80,suppressTrade: true,safety: { isSafe: false } }).allowed).toBe(false);
  });
});
