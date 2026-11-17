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
  getRollingExposureUsd,
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
      if (sql === 'COMMIT') return { command: 'COMMIT', rowCount: 0, rows: [] };
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


describe('getRollingExposureUsd (S4-M47)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue([{ total_usd: '0' }]);
  });

  it('scopes the sum to one tenant, so one user’s spending is not charged to another’s allowance', async () => {
    // Before this parameter existed the WHERE clause was `chain = $1` alone, so the sum
    // was every trade on the chain. Under fan-out the first user to trade hard silently
    // consumed the whole cohort's daily allowance.
    mocks.query.mockResolvedValueOnce([{ total_usd: '1234.5' }]);

    await expect(
      getRollingExposureUsd('11111111-1111-4111-8111-111111111111', 'solana')
    ).resolves.toBe(1234.5);

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('user_id IS NOT DISTINCT FROM $1');
    expect(sql).toContain('chain = $2');
    expect(params).toEqual(['11111111-1111-4111-8111-111111111111', 'solana']);
  });

  it('matches the operator’s legacy NULL rows with IS NOT DISTINCT FROM, not `=`', async () => {
    // `user_id = NULL` is never true in SQL, so an `=` predicate would report the
    // operator's rolling exposure as 0 forever -- uncapping the operator path entirely
    // while looking like a working cap.
    mocks.query.mockResolvedValueOnce([{ total_usd: '900' }]);

    await expect(getRollingExposureUsd(null, 'polygon')).resolves.toBe(900);

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('user_id IS NOT DISTINCT FROM $1');
    expect(sql).not.toContain('user_id = $1');
    expect(params).toEqual([null, 'polygon']);
  });

  it('still excludes shadow, unfilled and sell rows', async () => {
    await getRollingExposureUsd(null, 'solana');

    const [sql] = mocks.query.mock.calls[0] as [string];
    expect(sql).toContain("direction = 'buy'");
    expect(sql).toContain("status IN ('filled', 'partial')");
    expect(sql).toContain("execution_mode != 'shadow'");
    expect(sql).toContain("executed_at > NOW() - INTERVAL '24 hours'");
  });

  it('reads a tenant with no trades as 0 spent, which is a real answer', async () => {
    mocks.query.mockResolvedValueOnce([{ total_usd: null }]);
    await expect(
      getRollingExposureUsd('11111111-1111-4111-8111-111111111111', 'solana')
    ).resolves.toBe(0);
  });

  it('rejects a blank user id rather than answering with the operator’s ledger', async () => {
    // `normalizeTenantId('')` returns null, i.e. the operator -- correct for an optional
    // column on a write path, wrong for a risk query. A blank id means the caller thought
    // it had a user, and sizing that user's trade against the operator's spend is worse
    // than refusing.
    await expect(getRollingExposureUsd('', 'solana')).rejects.toThrow(/non-empty user id/);
    await expect(getRollingExposureUsd('   ', 'solana')).rejects.toThrow(/non-empty user id/);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects an account label where a tenancy uuid belongs', async () => {
    // `trades.user_id` is a `users(id)` foreign key, so the caller passes the raw userId
    // and NOT `riskPolicyAccountForUser(userId)` -- which returns the literal 'operator'
    // for the operator path and would match zero rows, reading as "spent nothing today".
    await expect(getRollingExposureUsd('operator', 'solana')).rejects.toThrow(/must be a UUID/);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
