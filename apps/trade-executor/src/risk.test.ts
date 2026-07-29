import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.TROJAN_WEBHOOK_URL = 'http://mock-trojan.local';
process.env.USE_DYNAMIC_BALANCE_SIZING = 'true';
process.env.PAPER_BANKROLL_USD = '10000';
process.env.DAILY_EXPOSURE_CAP_USD = '50000';

vi.mock('@swat/db', () => ({
  claimCircuitBreakerProbe: vi.fn(),
  resolveChainMode: vi.fn(),
  hasRecentBuy: vi.fn().mockResolvedValue(false),
  getRollingExposureUsd: vi.fn().mockResolvedValue(0),
  claimSignalForExecution: vi.fn().mockResolvedValue(true),
  releaseSignalClaim: vi.fn().mockResolvedValue(undefined),
  insertTrade: vi.fn().mockResolvedValue({ id: 'pending-trade-123' }),
  insertTradeAndMarkSignalExecuted: vi.fn().mockResolvedValue('live-trade-123'),
  insertTradeAndReleaseSignalClaim: vi.fn().mockResolvedValue({ id: 'skipped-trade-123' }),
  getTokenDecimals: vi.fn().mockResolvedValue(6),
  readCircuitBreakerState: vi.fn(),
  recordCircuitBreakerFailure: vi.fn(),
  recordCircuitBreakerSuccess: vi.fn(),
}));

vi.mock('@swat/shared', async () => {
  const actual = await vi.importActual('@swat/shared');
  return {
    ...actual,
    fetchTokenPriceUsd: vi.fn().mockResolvedValue(150),
  };
});

vi.mock('ioredis', () => {
  return {
    Redis: vi.fn().mockImplementation(() => ({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      publish: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      pexpire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    }))
  };
});

import { handleJob } from './index.js';
import * as db from '@swat/db';

describe('Risk Controls & Enforcement (G5-R7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should skip execution if global kill switch is active (G5-R5)', async () => {
    vi.mocked(db.resolveChainMode).mockResolvedValueOnce({
      requestedMode: 'off',
      effectiveMode: 'off',
      certified: false,
      reason: 'Global kill switch active (*)'
    });

    const result = await handleJob({ data: { signalId: 'sig-1', score: 95, tokenMint: 'solana:tokenA' } });
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('Execution disabled (off)');
  });

  it('should block execution if 24h rolling exposure cap is exceeded (G5-R2)', async () => {
    vi.mocked(db.resolveChainMode).mockResolvedValueOnce({
      requestedMode: 'paper',
      effectiveMode: 'paper',
      certified: true
    });
    // Set current exposure to 49,990 (Cap is 50,000)
    // A normal size of $10,000 against paper bankroll will push this over.
    vi.mocked(db.getRollingExposureUsd).mockResolvedValueOnce(49990);

    const result = await handleJob({ data: { signalId: 'sig-2', score: 95, tokenMint: 'solana:tokenA', manual: true } });
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('24h exposure cap exceeded on solana');
  });
});
