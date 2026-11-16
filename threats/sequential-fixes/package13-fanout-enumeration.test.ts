import { describe, expect, it, vi } from 'vitest';
import { enqueueFanoutTradeJobs, planFanoutTradeJobs } from '../../apps/signal-engine/src/fanout-enqueue.js';

const sourceInput = {
  signalId: 'signal-package13',
  tokenMint: 'solana:MintPackage13',
  score: 91,
  clusterTier: 'elite' as const,
  sourceTrade: { sourceTradeId: 'source-package13', direction: 'buy' as const },
  plan: null
};

describe('package13 enumeration failure cannot acknowledge operator-only dispatch', () => {
  it('rejects an unknown source cohort before creating an operator job', () => {
    expect(() => planFanoutTradeJobs(sourceInput)).toThrow(/enumeration.*incomplete/i);
  });

  it('never reaches the queue when a source enumeration failed', async () => {
    const add = vi.fn().mockResolvedValue({ id: 'operator' });
    const queueFor = vi.fn(() => ({ add }));
    const attempt = async () => enqueueFanoutTradeJobs(queueFor, planFanoutTradeJobs(sourceInput));
    await expect(attempt()).rejects.toThrow(/enumeration.*incomplete/i);
    expect(queueFor).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('distinguishes a successfully enumerated empty cohort from an unknown cohort', () => {
    const jobs = planFanoutTradeJobs({
      ...sourceInput,
      plan: { eligible: [], excluded: [], exclusionCounts: {} }
    });
    expect(jobs.users).toEqual([]);
    expect(jobs.operator.options.jobId).toBe('source-trade-signal-package13');
  });

  it('does not require a source cohort for a discovery pattern', () => {
    const jobs = planFanoutTradeJobs({ ...sourceInput, sourceTrade: null });
    expect(jobs.operator.options.jobId).toBeUndefined();
  });
});

describe('package13 commit-before-enqueue source obligations', () => {
  const jobs = () => planFanoutTradeJobs({
    ...sourceInput,
    plan: { eligible: [], excluded: [], exclusionCounts: {} }
  });

  it('refuses source enqueue when no durable store contract is supplied', async () => {
    const add = vi.fn().mockResolvedValue({});
    await expect(enqueueFanoutTradeJobs(() => ({ add }), jobs())).rejects.toThrow(/durable/i);
    expect(add).not.toHaveBeenCalled();
  });

  it('does not enqueue when preparation fails or the schema is absent', async () => {
    const add = vi.fn().mockResolvedValue({});
    const durable = {
      prepare: vi.fn().mockRejectedValue(new Error('delivery schema unavailable')),
      queued: vi.fn()
    };
    await expect(enqueueFanoutTradeJobs(() => ({ add }), jobs(), durable)).rejects.toThrow(/schema unavailable/);
    expect(add).not.toHaveBeenCalled();
    expect(durable.queued).not.toHaveBeenCalled();
  });

  it('waits for the caller transaction commit and persists queue acknowledgement afterwards', async () => {
    const order: string[] = [];
    const durable = {
      prepare: vi.fn(async () => { order.push('commit'); return [jobs().operator]; }),
      queued: vi.fn(async () => { order.push('queued'); })
    };
    const add = vi.fn(async () => { order.push('add'); });
    await expect(enqueueFanoutTradeJobs(() => ({ add }), jobs(), durable)).resolves.toBe(1);
    expect(order).toEqual(['commit', 'add', 'queued']);
    expect(durable.prepare).toHaveBeenCalledWith(jobs());
  });
});
