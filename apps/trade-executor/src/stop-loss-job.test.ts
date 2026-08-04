import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.TROJAN_WEBHOOK_URL = 'http://mock-trojan.local';
process.env.PAPER_BANKROLL_USD = '10000';
process.env.AUTO_EXECUTE = 'false';

vi.mock('@swat/db', () => ({
  claimCircuitBreakerProbe: vi.fn(),
  resolveChainMode: vi.fn().mockResolvedValue({
    requestedMode: 'paper',
    effectiveMode: 'paper',
    certified: true
  }),
  hasRecentBuy: vi.fn().mockResolvedValue(false),
  getRollingExposureUsd: vi.fn().mockResolvedValue(0),
  claimSignalForExecution: vi.fn().mockResolvedValue(false),
  releaseSignalClaim: vi.fn().mockResolvedValue(undefined),
  insertTrade: vi.fn().mockResolvedValue({ id: 'pending-trade-123' }),
  insertTradeAndMarkSignalExecuted: vi.fn().mockResolvedValue('paper-trade-123'),
  insertTradeAndReleaseSignalClaim: vi.fn().mockResolvedValue({ id: 'skipped-trade-123' }),
  getTokenDecimals: vi.fn().mockResolvedValue(6),
  resolveRiskPolicy: vi.fn().mockResolvedValue({
    maxPositionPct: 5,
    maxDailyExposurePct: 25,
    stopLossPct: 20,
    maxConsecutiveFailures: 3,
    minLiquidityUsd: 50000
  }),
  readCircuitBreakerState: vi.fn(),
  recordCircuitBreakerFailure: vi.fn(),
  recordCircuitBreakerSuccess: vi.fn()
}));

vi.mock('@swat/shared', async () => {
  const actual = await vi.importActual('@swat/shared');
  return {
    ...actual,
    fetchTokenPriceUsd: vi.fn().mockResolvedValue(7.5)
  };
});

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    publish: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    pexpire: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1)
  }))
}));

import { handleJob } from './index.js';
import * as db from '@swat/db';

const stopLossJob = {
  signalId: 'sig-stop-1',
  tokenMint: 'solana:tokenA',
  score: 100,
  direction: 'sell' as const,
  stopLoss: true as const,
  sellTokenAmount: 42.5
};

describe('stop-loss jobs in the executor (B3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sells the exact ledger quantity without re-claiming the signal', async () => {
    // claimSignalForExecution is mocked to fail: the entry signal is already
    // 'executed', so a stop-loss that went through the pending claim would be
    // skipped and the position would never be closed.
    const result = await handleJob({ data: stopLossJob });

    expect(result.status).toBe('paper-filled');
    expect(db.claimSignalForExecution).not.toHaveBeenCalled();

    const trade = vi.mocked(db.insertTradeAndMarkSignalExecuted).mock.calls[0]?.[0] as {
      direction: string;
      tokenAmount: number;
      amountUsd: number;
    };
    expect(trade.direction).toBe('sell');
    expect(trade.tokenAmount).toBe(42.5);
    expect(trade.amountUsd).toBeCloseTo(42.5 * 7.5, 6);
  });

  it('runs even though AUTO_EXECUTE is off, because it only reduces exposure', async () => {
    const result = await handleJob({ data: stopLossJob });
    expect(result.status).toBe('paper-filled');
  });

  it('still obeys the chain kill switch', async () => {
    vi.mocked(db.resolveChainMode).mockResolvedValueOnce({
      requestedMode: 'off',
      effectiveMode: 'off',
      certified: false,
      reason: 'Global kill switch active (*)'
    });

    const result = await handleJob({ data: stopLossJob });
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('Execution disabled (off)');
    expect(db.insertTradeAndMarkSignalExecuted).not.toHaveBeenCalled();
  });

  it('rejects a stop-loss without a usable quantity instead of guessing one', async () => {
    await expect(
      handleJob({ data: { ...stopLossJob, sellTokenAmount: 0 } })
    ).rejects.toThrow(/positive sellTokenAmount/);

    await expect(
      handleJob({ data: { ...stopLossJob, sellTokenAmount: undefined } })
    ).rejects.toThrow(/positive sellTokenAmount/);

    expect(db.insertTradeAndMarkSignalExecuted).not.toHaveBeenCalled();
  });

  it('rejects a stop-loss that is not a sell', async () => {
    await expect(
      handleJob({ data: { ...stopLossJob, direction: 'buy' } })
    ).rejects.toThrow(/must be a sell/);
  });
});
