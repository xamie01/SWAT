import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCloseAllSweep } from './close-all.js';
import { runStopLossSweep } from './stop-loss.js';
import type { CopyExecutionRecord } from '@swat/db';

const exact = '10.000000000000000001';
const execution = (overrides: Partial<CopyExecutionRecord> = {}): CopyExecutionRecord => ({
  id: 'exec-a', signalId: 'signal-a', sourceTradeId: null, exitLotId: 'lot-a',
  exitTrigger: 'close-all', chain: 'solana', targetAccount: 'solana:target-a',
  userId: 'user-a', tokenMint: 'solana:token-a', direction: 'sell', executionMode: 'live',
  clientOrderId: 'order-a', state: 'requested', requestedBaseQuantity: exact,
  requestedQuoteQuantity: null, confirmedBaseQuantity: '0', confirmedQuoteQuantity: null,
  quoteUnassessedFillCount: 0, reservedBaseQuantity: exact, submissionAttempts: 0,
  maxSubmissionAttempts: 3, simulationId: null, submissionType: null, submissionId: null,
  nextReconciliationAt: null, reconciliationClaimId: null, reconciliationAttempts: 0,
  maxReconciliationAttempts: 5, sourcePositionBeforeQuantity: null, sourceSellFraction: null,
  ...overrides
});
const job = () => ({
  userId: 'user-a', walletAddress: 'solana:master-a', masterWalletAddress: 'solana:master-a',
  lotId: 'lot-a', signalId: 'signal-a', tokenMint: 'solana:token-a', chain: 'solana' as const,
  sellTokenAmount: 10, requestedBaseQuantity: exact, targetAccount: 'solana:target-a',
  acquisitionExecutionMode: 'live' as const, jobId: 'close-all-user-a-lot-a'
});
const snapshot = () => ({
  signalId: 'signal-a', userId: 'user-a', positionKey: 'lot-a', tokenMint: 'solana:token-a',
  chain: 'solana' as const, openQuantity: 10, openQuantityExact: exact,
  masterWalletAddress: 'solana:master-a', targetAccount: 'solana:target-a',
  acquisitionExecutionMode: 'live' as const, openCostBasisUsd: 100,
  unrealizedPnlUsd: -25, currentPriceUsd: 7.5
});
const stopDeps = () => ({
  positions: [snapshot()], resolvePolicy: vi.fn().mockResolvedValue({ stopLossPct: 20 }),
  claim: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined),
  claimExit: vi.fn().mockResolvedValue({ execution: execution({ exitTrigger: 'stop-loss' }), created: true }),
  enqueueSell: vi.fn().mockResolvedValue(undefined), publishAlert: vi.fn().mockResolvedValue(undefined)
});

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));

describe('package14 exact canonical exit producers', () => {
  it('close-all preserves DB decimal, lot/master/account and live acquisition mode', async () => {
    const claimExit = vi.fn().mockResolvedValue({ execution: execution(), created: true });
    const enqueueSell = vi.fn();
    const result = await runCloseAllSweep({ listJobs: async () => [job()], claimExit, enqueueSell, endCompleted: async () => 0 });
    expect(result.queued).toBe(1);
    expect(claimExit.mock.calls[0][0].requestedBaseQuantity).toBe(exact);
    expect(enqueueSell.mock.calls[0][0]).toMatchObject({ requestedBaseQuantity: exact,
      masterWalletAddress: 'solana:master-a', targetAccount: 'solana:target-a',
      acquisitionExecutionMode: 'live', exitLotId: 'lot-a', copyExecutionId: 'exec-a' });
  });

  it.each([
    { userId: 'user-b' }, { exitLotId: 'lot-b' }, { executionMode: 'paper' as const },
    { tokenMint: 'solana:other' }, { sourceTradeId: 'source-a' },
    { requestedBaseQuantity: '10.000000000000000002' }, { exitTrigger: 'manual' as const }
  ])('rejects mismatched claim before enqueue: %j', async mismatch => {
    const enqueueSell = vi.fn();
    const result = await runCloseAllSweep({ listJobs: async () => [job()],
      claimExit: async () => ({ execution: execution(mismatch), created: true }),
      enqueueSell, endCompleted: async () => 0 });
    expect(result.failed).toBe(1);
    expect(enqueueSell).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'cancelled', 'failed', 'submitted', 'partially_filled'] as const)(
    'does not dispatch an exit already %s', async state => {
      const enqueueSell = vi.fn();
      await runCloseAllSweep({ listJobs: async () => [job()],
        claimExit: async () => ({ execution: execution({ state }), created: false }),
        enqueueSell, endCompleted: async () => 0 });
      expect(enqueueSell).not.toHaveBeenCalled();
    });

  it('stop-loss uses the lot-exit claim and carries source-less exact reserved origin', async () => {
    const deps = stopDeps();
    const result = await runStopLossSweep(deps);
    expect(result.queued).toBe(1);
    expect(deps.claimExit).toHaveBeenCalledWith({ lotId: 'lot-a', userId: 'user-a',
      requestId: 'stop-loss-user-a-signal-a-lot-a', trigger: 'stop-loss', requestedBaseQuantity: exact });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.enqueueSell.mock.calls[0][0]).toMatchObject({ requestedBaseQuantity: exact,
      positionKey: 'lot-a', exitLotId: 'lot-a', copyExecutionId: 'exec-a',
      masterWalletAddress: 'solana:master-a', targetAccount: 'solana:target-a', acquisitionExecutionMode: 'live' });
  });

  it('keeps canonical reservation on enqueue failure and retries same request identity', async () => {
    const deps = stopDeps();
    deps.enqueueSell.mockRejectedValueOnce(new Error('queue unavailable'));
    expect((await runStopLossSweep(deps)).failed).toBe(1);
    expect(deps.release).not.toHaveBeenCalled();
    expect((await runStopLossSweep(deps)).queued).toBe(1);
    expect(deps.claimExit.mock.calls[0][0]).toEqual(deps.claimExit.mock.calls[1][0]);
  });

  it.each(['openQuantityExact', 'masterWalletAddress', 'targetAccount', 'acquisitionExecutionMode', 'positionKey'])(
    'refuses a tenant snapshot missing %s without fallback', async field => {
      const deps = stopDeps();
      delete (deps.positions[0] as Record<string, unknown>)[field];
      const result = await runStopLossSweep(deps);
      expect(result.failed).toBe(1);
      expect(deps.claim).not.toHaveBeenCalled();
      expect(deps.claimExit).not.toHaveBeenCalled();
      expect(deps.enqueueSell).not.toHaveBeenCalled();
    });
});
