import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  return {
    clientQuery,
    release,
    // `on`/`off`: a real PoolClient is an EventEmitter, and withTransaction
    // attaches an 'error' listener so a mid-transaction socket failure cannot
    // crash the process. transaction.test.ts covers that behaviour itself.
    connect: vi.fn(async () => ({ query: clientQuery, release, on: vi.fn(), off: vi.fn() })),
    query: vi.fn()
  };
});

vi.mock('./client.js', () => ({
  pool: { connect: mocks.connect },
  query: mocks.query
}));

import {
  insertTradeAndMarkSignalExecuted,
  insertTradeAndReleaseSignalClaim
} from './trades.js';

const baseTrade = {
  signalId: 'signal-1',
  tokenMint: 'polygon:token-1',
  chain: 'polygon' as const,
  direction: 'buy' as const,
  amountUsd: 10,
  executionMode: 'live'
};

describe('transactional trade state persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM signals')) return { rowCount: 1, rows: [{ id: 'signal-1' }] };
      if (sql.includes('FROM trades')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO trades')) return { rowCount: 1, rows: [{ id: 'trade-1' }] };
      return { rowCount: 0, rows: [] };
    });
  });

  it('rejects non-fill and shadow attempts before opening a transaction', async () => {
    await expect(insertTradeAndMarkSignalExecuted({
      ...baseTrade,
      status: 'pending_confirmation'
    })).rejects.toThrow('Cannot mark signal executed from unconfirmed trade status');
    await expect(insertTradeAndMarkSignalExecuted({
      ...baseTrade,
      status: 'filled',
      executionMode: 'shadow'
    })).rejects.toThrow('Shadow trades cannot mark signals executed');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('persists a fill and marks its signal executed in one transaction', async () => {
    await expect(insertTradeAndMarkSignalExecuted({
      ...baseTrade,
      status: 'filled'
    })).resolves.toEqual({ id: 'trade-1' });

    const calls = mocks.clientQuery.mock.calls;
    const insertCall = calls.find(([sql]) => String(sql).includes('INSERT INTO trades'));
    expect(insertCall?.[1][14]).toBe('filled');
    expect(calls.some(([sql]) => String(sql).includes("SET status = 'executed'"))).toBe(true);
    expect(calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('persists a confirmed partial quantity and marks its signal executed', async () => {
    await expect(insertTradeAndMarkSignalExecuted({
      ...baseTrade,
      status: 'partial',
      tokenAmount: 4,
      amountUsd: 2
    })).resolves.toEqual({ id: 'trade-1' });

    const insertCall = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO trades')
    );
    expect(insertCall?.[1][14]).toBe('partial');
    expect(mocks.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("SET status = 'executed'")
    )).toBe(true);
  });

  it('persists a terminal non-fill and releases only an executing signal', async () => {
    await expect(insertTradeAndReleaseSignalClaim({
      ...baseTrade,
      status: 'skipped',
      errorMessage: 'no route'
    })).resolves.toEqual({ id: 'trade-1' });

    const calls = mocks.clientQuery.mock.calls;
    const insertCall = calls.find(([sql]) => String(sql).includes('INSERT INTO trades'));
    expect(insertCall?.[1][14]).toBe('skipped');
    expect(insertCall?.[1][15]).toBe('no route');
    const releaseCall = calls.find(([sql]) => String(sql).includes("SET status = 'pending'"));
    expect(releaseCall?.[0]).toContain("status = 'executing'");
    expect(calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('carries venue-derived fees through the trade insert contract', async () => {
    await expect(insertTradeAndMarkSignalExecuted({
      ...baseTrade,
      status: 'filled',
      feeUsd: 0.03125
    })).resolves.toEqual({ id: 'trade-1' });

    const insertCall = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO trades')
    );
    expect(insertCall?.[0]).toContain('fee_usd');
    expect(insertCall?.[1][9]).toBe(0.03125);
  });

  it('stores requested notional separately from confirmed fill notional', async () => {
    await expect(insertTradeAndMarkSignalExecuted({
      ...baseTrade,
      status: 'partial',
      amountUsd: 4.5,
      targetAmountUsd: 10
    })).resolves.toEqual({ id: 'trade-1' });

    const insertCall = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO trades')
    );
    expect(insertCall?.[0]).toContain('target_amount_usd');
    expect(insertCall?.[1][6]).toBe(4.5);
    expect(insertCall?.[1][29]).toBe(10);
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid venue fee before opening a transaction: %s',
    async (feeUsd) => {
      await expect(insertTradeAndMarkSignalExecuted({
        ...baseTrade,
        status: 'filled',
        feeUsd
      })).rejects.toThrow('feeUsd must be a finite non-negative number');
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  );
});
