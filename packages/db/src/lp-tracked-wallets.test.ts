import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  return {
    clientQuery,
    query: vi.fn(),
    connect: vi.fn(async () => ({
      query: clientQuery,
      release: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    }))
  };
});

vi.mock('./client.js', () => ({
  query: mocks.query,
  pool: { connect: mocks.connect }
}));

import {
  queryLpWalletLeaderboard,
  recordLpWalletIndexPass,
  trackLpWallet,
  untrackLpWallet,
  upsertLpWalletPositionResult
} from './lp-tracked-wallets.js';

function statementLog(): string[] {
  return mocks.clientQuery.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.clientQuery.mockReset();
});

describe('lp-tracked-wallets', () => {
  it('refuses an unprefixed wallet address', async () => {
    await expect(
      trackLpWallet({ chain: 'solana', walletAddress: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' })
    ).rejects.toThrow('chain-prefixed');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects a polling cadence outside 30..86400 seconds', async () => {
    await expect(
      trackLpWallet({ chain: 'solana', walletAddress: 'solana:9xQe', pollingCadenceSeconds: 10 })
    ).rejects.toThrow('30..86400');
  });

  it('records an index pass atomically: snapshots then the freshness stamp', async () => {
    mocks.clientQuery.mockResolvedValue({ rows: [] });

    await recordLpWalletIndexPass('wallet-1', [
      {
        positionAddress: 'solana:posA',
        poolAddress: 'solana:poolA',
        capturedAt: new Date('2026-10-04T00:05:00Z'),
        positionValueUsd: 1200,
        uncollectedFeesUsd: 4.5,
        inRange: true
      },
      {
        positionAddress: 'solana:posB',
        poolAddress: 'solana:poolB',
        capturedAt: new Date('2026-10-04T00:05:00Z'),
        positionValueUsd: 0,
        uncollectedFeesUsd: 0,
        inRange: false
      }
    ]);

    const log = statementLog();
    expect(log[0]).toBe('BEGIN');
    expect(log.filter((statement) => statement.includes('INSERT INTO lp_wallet_snapshots'))).toHaveLength(2);
    expect(log.some((statement) => statement.includes('ON CONFLICT') && statement.includes('DO NOTHING'))).toBe(true);
    expect(log.some((statement) => statement.includes('UPDATE lp_tracked_wallets'))).toBe(true);
    expect(log.at(-1)).toBe('COMMIT');
  });

  it('rejects a negative observation value before writing anything', async () => {
    await expect(
      recordLpWalletIndexPass('wallet-1', [
        {
          positionAddress: 'solana:posA',
          poolAddress: 'solana:poolA',
          capturedAt: new Date(),
          positionValueUsd: -1,
          uncollectedFeesUsd: 0,
          inRange: true
        }
      ])
    ).rejects.toThrow('non-negative');
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it('rejects a non-finite net result', async () => {
    await expect(
      upsertLpWalletPositionResult('wallet-1', {
        positionAddress: 'solana:posA',
        poolAddress: 'solana:poolA',
        chain: 'solana',
        strategyType: 'spot',
        netResultUsd: Number.NaN,
        firstObservedAt: new Date(),
        lastObservedAt: new Date(),
        closed: true
      })
    ).rejects.toThrow('finite');
  });

  it('untracks and reports whether a row was removed', async () => {
    mocks.query.mockResolvedValueOnce([{ id: 'wallet-1' }]);
    await expect(untrackLpWallet('solana', 'solana:9xQe')).resolves.toBe(true);

    mocks.query.mockResolvedValueOnce([]);
    await expect(untrackLpWallet('solana', 'solana:9xQe')).resolves.toBe(false);
  });

  it('aggregates the leaderboard from results only, win rate over closed positions', async () => {
    mocks.query.mockResolvedValueOnce([
      {
        tracked_wallet_id: 'wallet-1',
        chain: 'solana',
        wallet_address: 'solana:9xQe',
        label: 'alpha',
        realized_pnl_usd: '1250.5',
        win_rate: '0.75',
        closed_position_count: 4,
        dominant_strategy_type: 'bidask'
      }
    ]);

    const [entry] = await queryLpWalletLeaderboard({ chain: 'solana', sort: 'pnl', limit: 10 });

    expect(entry?.realizedPnlUsd).toBe(1250.5);
    expect(entry?.winRate).toBe(0.75);
    expect(entry?.closedPositionCount).toBe(4);
    expect(entry?.dominantStrategyType).toBe('bidask');
    const [sql] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain('FILTER (WHERE r.closed)');
    expect(String(sql)).toContain('MODE() WITHIN GROUP (ORDER BY r.strategy_type)');
  });

  it('a wallet with no closed positions has a null win rate, not zero', async () => {
    mocks.query.mockResolvedValueOnce([
      {
        tracked_wallet_id: 'wallet-1',
        chain: 'solana',
        wallet_address: 'solana:9xQe',
        label: null,
        realized_pnl_usd: 0,
        win_rate: null,
        closed_position_count: 0,
        dominant_strategy_type: null
      }
    ]);

    const [entry] = await queryLpWalletLeaderboard({ sort: 'winRate' });
    expect(entry?.winRate).toBeNull();
    const [sql] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain('win_rate DESC NULLS LAST');
  });

  it('rejects an out-of-range leaderboard limit', async () => {
    await expect(queryLpWalletLeaderboard({ limit: 0 })).rejects.toThrow('limit');
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
