import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('./client.js', () => ({ query: mocks.query }));

import {
  BALANCE_MAX_STALENESS_MS,
  getUserBalance,
  isBalanceStale,
  listStaleUserBalances,
  listUserBalances,
  pruneUserBalances,
  resolveKnownBalanceUsd,
  upsertUserBalance,
  type UserBalance
} from './user-balances.js';
import { crossTenantScope, forUser } from './tenancy.js';

/**
 * Cached per-user balances (`S4-8`, migration `048`).
 *
 * The assertions worth having here are the *refusals*: unknown must not read as
 * zero, and stale must not read as fresh. Both failure modes size a real trade
 * against a number nobody computed, and both look like a working system.
 */

const scope = forUser('11111111-2222-3333-4444-555555555555');
const NOW = new Date('2026-08-18T12:00:00.000Z');

function balance(overrides: Partial<UserBalance> = {}): UserBalance {
  return {
    userId: scope.userId,
    chain: 'solana',
    asset: 'SOL',
    amount: 10,
    amountRaw: '10',
    decimals: 9,
    usd: 1000,
    usdPricedAt: NOW,
    fetchedAt: NOW,
    source: 'poller',
    ...overrides
  };
}

function balanceRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: scope.userId,
    chain: 'solana',
    asset: 'SOL',
    amount: 10,
    decimals: 9,
    usd: 1000,
    usd_priced_at: NOW,
    fetched_at: NOW,
    source: 'poller',
    ...overrides
  };
}

/** See execution-grants.test.ts — comments are stripped so `created_at` cannot match. */
function nonIdempotentStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.replace(/--[^\n]*/g, '').trim())
    .filter((statement) => /^(?:CREATE|ALTER|DROP)\s/i.test(statement))
    .filter((statement) => !/IF NOT EXISTS/i.test(statement))
    .map((statement) => statement.slice(0, 100));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([balanceRow()]);
});

describe('isBalanceStale', () => {
  it('matches the poller interval', () => {
    expect(BALANCE_MAX_STALENESS_MS).toBe(60_000);
  });

  it('accepts an observation inside the window', () => {
    const fetchedAt = new Date(NOW.getTime() - 59_999);
    expect(isBalanceStale(balance({ fetchedAt }), NOW)).toBe(false);
  });

  it('rejects an observation one millisecond past the window', () => {
    const fetchedAt = new Date(NOW.getTime() - 60_001);
    expect(isBalanceStale(balance({ fetchedAt }), NOW)).toBe(true);
  });

  it('treats a future timestamp as stale rather than as fresh', () => {
    // Clock skew, or a caller that set fetched_at itself. An unexplained
    // timestamp is not evidence of freshness, and the permissive reading here
    // would make a stale balance pass the gate forever.
    const fetchedAt = new Date(NOW.getTime() + 5_000);
    expect(isBalanceStale(balance({ fetchedAt }), NOW)).toBe(true);
  });
});

describe('resolveKnownBalanceUsd', () => {
  it('refuses an empty set rather than returning zero', () => {
    expect(resolveKnownBalanceUsd([], NOW)).toBeNull();
  });

  it('sums a fresh, fully priced set', () => {
    expect(
      resolveKnownBalanceUsd([balance({ usd: 100 }), balance({ asset: 'USDC', usd: 50 })], NOW)
    ).toBe(150);
  });

  it('refuses the whole total when one row is unpriced', () => {
    // A partial total is indistinguishable from a smaller balance, so it would
    // size a real trade against a number nobody computed.
    expect(
      resolveKnownBalanceUsd([balance({ usd: 100 }), balance({ asset: 'USDC', usd: null })], NOW)
    ).toBeNull();
  });

  it('refuses the whole total when one row is stale', () => {
    const stale = balance({ asset: 'USDC', fetchedAt: new Date(NOW.getTime() - 120_000) });
    expect(resolveKnownBalanceUsd([balance({ usd: 100 }), stale], NOW)).toBeNull();
  });
});

describe('upsertUserBalance validation', () => {
  it.each([
    ['a negative amount', { amount: -1 }, /non-negative finite number/],
    ['a non-finite amount', { amount: Number.POSITIVE_INFINITY }, /non-negative finite number/],
    ['fractional decimals', { decimals: 6.5 }, /integer in 0\.\.36/],
    ['decimals above 36', { decimals: 37 }, /integer in 0\.\.36/],
    ['a negative usd', { usd: -0.01 }, /null or a non-negative finite number/]
  ])('rejects %s before opening a connection', async (_label, override, message) => {
    await expect(
      upsertUserBalance(scope, {
        chain: 'solana',
        asset: 'SOL',
        amount: 1,
        decimals: 9,
        ...override
      })
    ).rejects.toThrow(message);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('lets the database stamp fetched_at so a skewed poller cannot fake freshness', async () => {
    await upsertUserBalance(scope, { chain: 'solana', asset: 'SOL', amount: 1, decimals: 9 });
    const [sql] = mocks.query.mock.calls[0] as [string];
    expect(sql).toContain('NOW()');
    expect(sql).toContain('ON CONFLICT (user_id, chain, asset) DO UPDATE');
  });

  it('stamps usd_priced_at when a price is supplied without one', async () => {
    // chk_ub_usd_priced_at requires it, and the price was fetched for this write.
    await upsertUserBalance(scope, {
      chain: 'solana',
      asset: 'SOL',
      amount: 1,
      decimals: 9,
      usd: 25
    });
    const [, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(values[6]).toBeInstanceOf(Date);
  });

  it('leaves usd_priced_at null when the price fetch failed', async () => {
    await upsertUserBalance(scope, {
      chain: 'solana',
      asset: 'SOL',
      amount: 1,
      decimals: 9,
      usd: null
    });
    const [, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(values[5]).toBeNull();
    expect(values[6]).toBeNull();
  });
});

describe('reading a row', () => {
  it('reports an unrepresentable amount as unknown and keeps the exact digits', async () => {
    // `parsePostgresNumeric` hands back text when a float64 would drift. Re-parsing
    // it here would reintroduce the drift that parser exists to prevent.
    mocks.query.mockResolvedValue([balanceRow({ amount: '123456789.123456789123456789' })]);
    const [row] = await listUserBalances(scope);
    expect(row?.amount).toBeNull();
    expect(row?.amountRaw).toBe('123456789.123456789123456789');
  });

  it('never coerces an unpriced row to zero', async () => {
    mocks.query.mockResolvedValue([balanceRow({ usd: null, usd_priced_at: null })]);
    const row = await getUserBalance(scope, 'solana', 'SOL');
    expect(row?.usd).toBeNull();
  });

  it('scopes reads by user_id', async () => {
    await listUserBalances(scope);
    await listUserBalances(scope, 'polygon');
    await getUserBalance(scope, 'solana', 'SOL');
    for (const [sql, values] of mocks.query.mock.calls as Array<[string, unknown[]]>) {
      expect(sql).toContain('user_id = $1');
      expect(values[0]).toBe(scope.userId);
    }
  });
});

describe('pruneUserBalances', () => {
  it('deletes only the assets absent from this poll', async () => {
    mocks.query.mockResolvedValue([{ asset: 'BONK' }]);
    await expect(pruneUserBalances(scope, 'solana', ['SOL', 'USDC'])).resolves.toBe(1);
    const [sql, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('NOT (asset = ANY($3::text[]))');
    expect(values[2]).toEqual(['SOL', 'USDC']);
  });

  it('deletes every asset on the chain when the poll observed none', async () => {
    // An upsert-only poller can never zero a position it stopped seeing, so an
    // empty observation set must mean "holds nothing here" rather than "skip".
    mocks.query.mockResolvedValue([]);
    await pruneUserBalances(scope, 'solana', []);
    const [, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(values[2]).toEqual([]);
  });
});

describe('listStaleUserBalances', () => {
  it('refuses a per-user scope', async () => {
    await expect(listStaleUserBalances(scope)).rejects.toThrow(/crossTenantScope/);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('converts the staleness window to seconds for make_interval', async () => {
    mocks.query.mockResolvedValue([]);
    await listStaleUserBalances(crossTenantScope('balance poller'), { olderThanMs: 90_000 });
    const [sql, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('make_interval(secs => $1::double precision)');
    expect(values[0]).toBe(90);
  });

  it('defaults to the staleness gate', async () => {
    mocks.query.mockResolvedValue([]);
    await listStaleUserBalances(crossTenantScope('balance poller'));
    const [, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(values[0]).toBe(BALANCE_MAX_STALENESS_MS / 1000);
  });
});

describe('048 DDL contract', () => {
  let sql = '';

  beforeEach(async () => {
    sql = await readFile(resolve(import.meta.dirname, '../sql/048_user_balances.sql'), 'utf8');
  });

  it('keys a balance by the triple that is the fact', () => {
    expect(sql).toContain('PRIMARY KEY (user_id, chain, asset)');
  });

  it('cascades, because the poller can rebuild every row from the chain', () => {
    expect(sql).toContain('REFERENCES users(id) ON DELETE CASCADE');
  });

  it('requires a priced row to say when it was priced', () => {
    expect(sql).toContain('CONSTRAINT chk_ub_usd_priced_at CHECK (usd IS NULL OR usd_priced_at IS NOT NULL)');
  });

  it('keeps usd nullable so unknown cannot be written as zero', () => {
    expect(sql).toMatch(/usd\s+NUMERIC\s+CHECK \(usd IS NULL OR usd >= 0\)/);
  });

  it('bounds amount and decimals', () => {
    expect(sql).toContain('CHECK (amount >= 0)');
    expect(sql).toContain('CHECK (decimals BETWEEN 0 AND 36)');
  });

  it('allows exactly the three write sources the module types', () => {
    expect(sql).toContain("CHECK (source IN ('poller','post-trade','manual-refresh'))");
  });

  it('indexes fetched_at for the poller scan and the staleness gate', () => {
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_user_balances_stale ON user_balances(fetched_at)'
    );
  });

  it('replays safely, because migrate.ts has no applied-migrations table', () => {
    expect(nonIdempotentStatements(sql)).toEqual([]);
  });
});
