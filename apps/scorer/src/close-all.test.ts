import { describe, expect, it, vi } from 'vitest';
import { runCloseAllSweep } from './close-all.js';
import type { CloseAllLotJob, CopyExecutionRecord } from '@swat/db';

describe('runCloseAllSweep', () => {
  const dummyExecution = (id: string, state: CopyExecutionRecord['state'] = 'requested'): CopyExecutionRecord => ({
    id,
    signalId: 'sig-1',
    sourceTradeId: null,
    exitLotId: 'lot-1',
    exitTrigger: 'close-all',
    chain: 'solana',
    targetAccount: 'solana:target-1',
    userId: 'user-1',
    tokenMint: 'solana:token-1',
    direction: 'sell',
    executionMode: 'paper',
    clientOrderId: `swat-order-${id}`,
    state,
    requestedBaseQuantity: '10',
    requestedQuoteQuantity: null,
    confirmedBaseQuantity: '0',
    confirmedQuoteQuantity: null,
    quoteUnassessedFillCount: 0,
    reservedBaseQuantity: '10',
    submissionAttempts: 0,
    maxSubmissionAttempts: 3,
    simulationId: null,
    submissionType: null,
    submissionId: null,
    nextReconciliationAt: null,
    reconciliationClaimId: null,
    reconciliationAttempts: 0,
    maxReconciliationAttempts: 5,
    sourcePositionBeforeQuantity: null,
    sourceSellFraction: null
  });

  it('scans, claims, and enqueues exact sells for open lots, then ends completed subscriptions', async () => {
    const jobs: CloseAllLotJob[] = [
      {
        userId: 'user-1',
        walletAddress: 'solana:master-1',
        lotId: 'lot-1',
        signalId: 'sig-1',
        tokenMint: 'solana:token-1',
        chain: 'solana',
        sellTokenAmount: 10,
        jobId: 'close-all-user-1-lot-1'
      },
      {
        userId: 'user-2',
        walletAddress: 'polygon:master-2',
        lotId: 'lot-2',
        signalId: 'sig-2',
        tokenMint: 'polygon:token-2',
        chain: 'polygon',
        sellTokenAmount: 25,
        jobId: 'close-all-user-2-lot-2'
      }
    ];

    const claimExit = vi.fn()
      .mockResolvedValueOnce({ execution: dummyExecution('exec-1', 'requested'), created: true })
      .mockResolvedValueOnce({ execution: dummyExecution('exec-2', 'submitted'), created: false });

    const enqueueSell = vi.fn().mockResolvedValue(true);
    const endCompleted = vi.fn().mockResolvedValue(1);

    const result = await runCloseAllSweep({
      listJobs: async () => jobs,
      claimExit,
      enqueueSell,
      endCompleted
    });

    expect(result).toEqual({
      scanned: 2,
      claimed: 2,
      queued: 2,
      ended: 1,
      failed: 0
    });

    expect(claimExit).toHaveBeenCalledTimes(2);
    expect(claimExit).toHaveBeenNthCalledWith(1, {
      lotId: 'lot-1',
      userId: 'user-1',
      requestId: 'close-all-user-1-lot-1',
      trigger: 'close-all',
      requestedBaseQuantity: '10'
    });

    expect(enqueueSell).toHaveBeenCalledTimes(2);
    expect(enqueueSell).toHaveBeenNthCalledWith(1, {
      signalId: 'sig-1',
      tokenMint: 'solana:token-1',
      direction: 'sell',
      sellTokenAmount: 10,
      userId: 'user-1',
      closeAll: true,
      exitLotId: 'lot-1',
      copyExecutionId: 'exec-1',
      score: 100
    }, 'close-all-user-1-lot-1', 'solana');

    expect(endCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not re-enqueue if the execution is already confirmed', async () => {
    const jobs: CloseAllLotJob[] = [
      {
        userId: 'user-1',
        walletAddress: 'solana:master-1',
        lotId: 'lot-1',
        signalId: 'sig-1',
        tokenMint: 'solana:token-1',
        chain: 'solana',
        sellTokenAmount: 10,
        jobId: 'close-all-user-1-lot-1'
      }
    ];

    const claimExit = vi.fn().mockResolvedValueOnce({
      execution: dummyExecution('exec-1', 'confirmed'),
      created: false
    });

    const enqueueSell = vi.fn();
    const endCompleted = vi.fn().mockResolvedValue(0);

    const result = await runCloseAllSweep({
      listJobs: async () => jobs,
      claimExit,
      enqueueSell,
      endCompleted
    });

    expect(result.scanned).toBe(1);
    expect(result.claimed).toBe(1);
    expect(result.queued).toBe(0);
    expect(enqueueSell).not.toHaveBeenCalled();
  });

  it('records failures gracefully without aborting the rest of the sweep', async () => {
    const jobs: CloseAllLotJob[] = [
      {
        userId: 'user-1',
        walletAddress: 'solana:master-1',
        lotId: 'lot-1',
        signalId: 'sig-1',
        tokenMint: 'solana:token-1',
        chain: 'solana',
        sellTokenAmount: 10,
        jobId: 'close-all-user-1-lot-1'
      },
      {
        userId: 'user-2',
        walletAddress: 'solana:master-2',
        lotId: 'lot-2',
        signalId: 'sig-2',
        tokenMint: 'solana:token-2',
        chain: 'solana',
        sellTokenAmount: 5,
        jobId: 'close-all-user-2-lot-2'
      }
    ];

    const claimExit = vi.fn()
      .mockRejectedValueOnce(new Error('Lock contention'))
      .mockResolvedValueOnce({ execution: dummyExecution('exec-2', 'requested'), created: true });

    const enqueueSell = vi.fn().mockResolvedValue(true);
    const endCompleted = vi.fn().mockResolvedValue(0);

    const result = await runCloseAllSweep({
      listJobs: async () => jobs,
      claimExit,
      enqueueSell,
      endCompleted
    });

    expect(result).toEqual({
      scanned: 2,
      claimed: 1,
      queued: 1,
      ended: 0,
      failed: 1
    });
  });
});
