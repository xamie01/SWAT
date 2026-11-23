import { readFile } from 'node:fs/promises';
import { PLATFORM_MAX_CONCURRENT_POSITIONS } from './position-cap.js';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RISK_CONFIG,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  USER_TIERS,
  effectiveTier,
  tierAtLeast,
  type UserTier
} from '@swat/shared';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  return {
    clientQuery,
    query: vi.fn(),
    // A real PoolClient is an EventEmitter and withTransaction attaches an
    // 'error' listener; transaction.test.ts covers that behaviour itself.
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
  DEFAULT_MAX_DAILY_WITHDRAWAL_USD,
  DEFAULT_MIN_SIGNAL_SCORE,
  DEFAULT_REBUY_COOLDOWN_SECONDS,
  DEFAULT_USER_EXECUTION_SETTINGS,
  InvalidExecutionSettingsError,
  LiveExecutionNotEntitledError,
  USER_CHAIN_MODES,
  assertValidExecutionSettingsPatch,
  getUserChainExecutionSettings,
  getUserExecutionSettings,
  listUserChainExecutionSettings,
  requestedUserChainMode,
  resolveUserSlippageBps,
  setUserKillSwitch,
  tierMayExecuteLive,
  upsertUserChainExecutionSettings,
  upsertUserExecutionSettings
} from './user-execution-settings.js';
import { forUser } from './tenancy.js';

/**
 * Per-user risk and execution settings (`S4-9`, migration `049`).
 *
 * The drift guard is the point of the DDL block at the bottom: the defaults exist
 * twice — as literals in `049`, which cannot import TypeScript, and as
 * `DEFAULT_USER_EXECUTION_SETTINGS`, which the resolver returns for a missing row.
 * Nothing but a test can keep the two honest, and if they part company a new tenant
 * silently gets different risk limits than the operator path and the docs claim.
 */

const scope = forUser('11111111-2222-3333-4444-555555555555');

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    auto_execute: false,
    min_signal_score: 80,
    max_position_pct: 5,
    max_daily_exposure_pct: 25,
    stop_loss_pct: 20,
    rebuy_cooldown_seconds: 3600,
    max_daily_withdrawal_usd: 1000,
    // S4-M4. NOT NULL DEFAULT 5 in 049, so a real row always carries it; the
    // fixture omitting it made `toSettings` yield undefined and the write-time
    // clamp throw, which is the right failure for a row that genuinely lacks the
    // column and the wrong one for a fixture that just had not been updated.
    max_concurrent_positions: 5,
    killed: false,
    updated_at: new Date('2026-08-18T12:00:00.000Z'),
    ...overrides
  };
}

function chainRow(overrides: Record<string, unknown> = {}) {
  return {
    chain: 'solana',
    mode: 'off',
    max_slippage_bps: null,
    updated_at: new Date('2026-08-18T12:00:00.000Z'),
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
  mocks.query.mockResolvedValue([settingsRow()]);
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], command: sql.trim().toUpperCase() };
    if (sql.includes('user_chain_execution_settings')) {
      return { rows: sql.includes('RETURNING') ? [chainRow()] : [] };
    }
    if (sql.includes('INSERT INTO user_execution_settings (user_id, killed)')) return { rows: [settingsRow({ killed: true })] };
    if (sql.includes('INSERT INTO user_execution_settings')) return { rows: [] };
    return { rows: [settingsRow()] };
  });
});

describe('defaults', () => {
  it('sources the three risk percentages from DEFAULT_RISK_CONFIG', () => {
    expect(DEFAULT_USER_EXECUTION_SETTINGS.maxPositionPct).toBe(DEFAULT_RISK_CONFIG.maxPositionPct);
    expect(DEFAULT_USER_EXECUTION_SETTINGS.maxDailyExposurePct).toBe(
      DEFAULT_RISK_CONFIG.maxDailyExposurePct
    );
    expect(DEFAULT_USER_EXECUTION_SETTINGS.stopLossPct).toBe(DEFAULT_RISK_CONFIG.stopLossPct);
  });

  it('starts a new user opted out of everything', () => {
    // A user who creates an account and deposits does not begin trading (D13).
    expect(DEFAULT_USER_EXECUTION_SETTINGS.autoExecute).toBe(false);
    expect(DEFAULT_USER_EXECUTION_SETTINGS.killed).toBe(false);
    expect(DEFAULT_USER_EXECUTION_SETTINGS.persisted).toBe(false);
    expect(DEFAULT_USER_EXECUTION_SETTINGS.updatedAt).toBeNull();
  });

  it('keeps the single-position cap inside the daily cap', () => {
    expect(DEFAULT_USER_EXECUTION_SETTINGS.maxPositionPct).toBeLessThanOrEqual(
      DEFAULT_USER_EXECUTION_SETTINGS.maxDailyExposurePct
    );
  });

  it('returns defaults, not null, for a user with no row', async () => {
    mocks.query.mockResolvedValue([]);
    await expect(getUserExecutionSettings(scope)).resolves.toEqual(
      DEFAULT_USER_EXECUTION_SETTINGS
    );
  });

  it('marks a stored row as persisted so an explicit opt-in stays evidence', async () => {
    const settings = await getUserExecutionSettings(scope);
    expect(settings.persisted).toBe(true);
    expect(settings.updatedAt).toBeInstanceOf(Date);
  });

  it('refuses a limit that a float64 cannot hold rather than rounding it', async () => {
    mocks.query.mockResolvedValue([
      settingsRow({ max_daily_withdrawal_usd: '123456789012345678.9' })
    ]);
    await expect(getUserExecutionSettings(scope)).rejects.toThrow(
      /max_daily_withdrawal_usd is not representable/
    );
  });
});

describe('assertValidExecutionSettingsPatch', () => {
  it('accepts an empty patch', () => {
    expect(() => assertValidExecutionSettingsPatch({})).not.toThrow();
  });

  it.each([
    ['minSignalScore below 0', { minSignalScore: -1 }],
    ['minSignalScore above 100', { minSignalScore: 101 }],
    ['a fractional minSignalScore', { minSignalScore: 80.5 }],
    ['maxPositionPct of 0', { maxPositionPct: 0 }],
    ['maxPositionPct above 100', { maxPositionPct: 100.01 }],
    ['maxDailyExposurePct of 0', { maxDailyExposurePct: 0 }],
    ['stopLossPct above 100', { stopLossPct: 101 }],
    ['a negative rebuyCooldownSeconds', { rebuyCooldownSeconds: -1 }],
    ['a fractional rebuyCooldownSeconds', { rebuyCooldownSeconds: 1.5 }],
    ['a negative maxDailyWithdrawalUsd', { maxDailyWithdrawalUsd: -1 }],
    ['a non-finite maxDailyWithdrawalUsd', { maxDailyWithdrawalUsd: Number.NaN }]
  ])('rejects %s', (_label, patch) => {
    expect(() => assertValidExecutionSettingsPatch(patch)).toThrow(
      InvalidExecutionSettingsError
    );
  });

  it('accepts the boundary values the CHECKs allow', () => {
    expect(() =>
      assertValidExecutionSettingsPatch({
        minSignalScore: 0,
        maxPositionPct: 100,
        maxDailyExposurePct: 100,
        stopLossPct: 100,
        rebuyCooldownSeconds: 0,
        maxDailyWithdrawalUsd: 0
      })
    ).not.toThrow();
  });

  it('rejects a patch that names both caps out of order', () => {
    // Without the ordering rule one trade can exhaust and exceed the daily limit,
    // which makes the daily limit decorative.
    expect(() =>
      assertValidExecutionSettingsPatch({ maxPositionPct: 40, maxDailyExposurePct: 25 })
    ).toThrow(/may not exceed/);
  });
});

describe('upsertUserExecutionSettings', () => {
  it('never restates a default in the insert, so 049 stays the only source', async () => {
    await upsertUserExecutionSettings(scope, { autoExecute: true });
    const [insertSql] = mocks.clientQuery.mock.calls[1] as [string];
    expect(insertSql).toContain('INSERT INTO user_execution_settings (user_id) VALUES ($1)');
    expect(insertSql).toContain('ON CONFLICT (user_id) DO NOTHING');
    expect(insertSql).not.toMatch(/\b(80|3600|1000)\b/);
  });

  it('locks the row before merging so two concurrent patches cannot interleave', async () => {
    await upsertUserExecutionSettings(scope, { maxPositionPct: 10 });
    const [selectSql] = mocks.clientQuery.mock.calls[2] as [string];
    expect(selectSql).toContain('FOR UPDATE');
  });

  it('writes the merged row and leaves unnamed fields alone', async () => {
    await upsertUserExecutionSettings(scope, { maxPositionPct: 10 });
    const [, values] = mocks.clientQuery.mock.calls[3] as [string, unknown[]];
    // max_concurrent_positions sits at $9 (S4-M4), so `killed` moved to $10.
    expect(values).toEqual([scope.userId, false, 80, 10, 25, 20, 3600, 1000, 5, false]);
  });

  it('ignores explicitly undefined patch keys rather than nulling the column', async () => {
    await upsertUserExecutionSettings(scope, { killed: undefined, minSignalScore: 90 });
    const [, values] = mocks.clientQuery.mock.calls[3] as [string, unknown[]];
    expect(values[2]).toBe(90);
    expect(values[9]).toBe(false);
  });

  it('clamps the position cap on write, so the ceiling cannot be bypassed (S4-M4)', async () => {
    // The clamp is applied at the write, not only in the validator, so a caller
    // that reaches this function with an out-of-range integer still cannot store
    // it. 049 mirrors it with a CHECK, making two independent layers.
    await upsertUserExecutionSettings(scope, { maxConcurrentPositions: 500 });
    const [, values] = mocks.clientQuery.mock.calls[3] as [string, unknown[]];
    expect(values[8]).toBe(PLATFORM_MAX_CONCURRENT_POSITIONS);
  });

  it('refuses a non-integer position cap before opening a transaction (S4-M4)', async () => {
    await expect(
      upsertUserExecutionSettings(scope, { maxConcurrentPositions: 2.5 })
    ).rejects.toThrow(/must be an integer/);
  });

  it('leaves the stored position cap alone when the patch omits it', async () => {
    await upsertUserExecutionSettings(scope, { minSignalScore: 90 });
    const [, values] = mocks.clientQuery.mock.calls[3] as [string, unknown[]];
    expect(values[8]).toBe(5);
  });

  it('rejects a patch that lifts the position cap past the stored daily cap', async () => {
    // The single-field patch cannot be checked without the row, which is why this
    // check lives inside the transaction rather than in the pure validator.
    await expect(upsertUserExecutionSettings(scope, { maxPositionPct: 90 })).rejects.toThrow(
      /may not exceed maxDailyExposurePct \(25\)/
    );
  });

  it('validates before opening a transaction', async () => {
    await expect(
      upsertUserExecutionSettings(scope, { minSignalScore: 500 })
    ).rejects.toBeInstanceOf(InvalidExecutionSettingsError);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe('setUserKillSwitch', () => {
  it('creates the row and strictly audits in the same transaction', async () => {
    await setUserKillSwitch(scope, true);
    expect(mocks.query).not.toHaveBeenCalled();
    const [sql, values] = mocks.clientQuery.mock.calls[1] as [string, unknown[]];
    expect(mocks.clientQuery.mock.calls[2]![0]).toContain('INSERT INTO audit_log');
    expect(mocks.clientQuery.mock.calls[3]![0]).toBe('COMMIT');
    expect(sql).toContain('INSERT INTO user_execution_settings (user_id, killed)');
    expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(sql).not.toContain('mode');
    expect(values).toEqual([scope.userId, true]);
  });
});

describe('the operator+ live-execution gate', () => {
  it('refuses the free tier', () => {
    expect(tierMayExecuteLive('free', null, 'solana')).toBe(false);
  });

  it('allows operator and ultra', () => {
    expect(tierMayExecuteLive('operator', null, 'solana')).toBe(true);
    expect(tierMayExecuteLive('ultra', null, 'solana')).toBe(true);
  });

  it('treats a null expiry as lifetime, not as expired', () => {
    // Inverting this check would silently downgrade every USDC lifetime customer.
    expect(tierMayExecuteLive('operator', null, 'polygon')).toBe(true);
  });

  it('stops live execution when a paid tier has lapsed', () => {
    const expired = new Date('2026-08-01T00:00:00.000Z');
    const now = new Date('2026-08-18T00:00:00.000Z');
    expect(tierMayExecuteLive('operator', expired, 'solana', now)).toBe(false);
  });

  it('keeps live execution while the tier is still paid for', () => {
    const expires = new Date('2026-09-01T00:00:00.000Z');
    const now = new Date('2026-08-18T00:00:00.000Z');
    expect(tierMayExecuteLive('operator', expires, 'solana', now)).toBe(true);
  });

  it.each(USER_TIERS as UserTier[])(
    'agrees with tierAtLeast(effectiveTier, operator) for %s',
    (tier) => {
      // The gate is expressed through the capability matrix rather than a second
      // rank comparison. If someone flips a `liveExecution` flag without moving the
      // tier, this equivalence is where it shows up.
      const expected = tierAtLeast(effectiveTier(tier, null), 'operator');
      expect(tierMayExecuteLive(tier, null, 'solana')).toBe(expected);
    }
  );
});

describe('upsertUserChainExecutionSettings', () => {
  const entitled = { tier: 'operator' as UserTier, tierExpiresAt: null };

  it('stores live as a request and says so', async () => {
    await upsertUserChainExecutionSettings(scope, { chain: 'solana', mode: 'live', ...entitled });
    const [, values] = mocks.clientQuery.mock.calls[2] as [string, unknown[]];
    expect(values[2]).toBe('live');
  });

  it('refuses live for a tier that may not execute live', async () => {
    await expect(
      upsertUserChainExecutionSettings(scope, {
        chain: 'solana',
        mode: 'live',
        tier: 'free',
        tierExpiresAt: null
      })
    ).rejects.toBeInstanceOf(LiveExecutionNotEntitledError);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('allows paper on any tier — paper moves no funds', async () => {
    await expect(
      upsertUserChainExecutionSettings(scope, {
        chain: 'solana',
        mode: 'paper',
        tier: 'free',
        tierExpiresAt: null
      })
    ).resolves.toBeTruthy();
  });

  it('rejects a mode outside the three the column allows', async () => {
    await expect(
      upsertUserChainExecutionSettings(scope, {
        chain: 'solana',
        // `live+shadow` is a real ExecutionMode and deliberately not a user choice.
        mode: 'live+shadow' as never,
        ...entitled
      })
    ).rejects.toThrow(/must be one of off, paper, live/);
    expect(USER_CHAIN_MODES).toEqual(['off', 'paper', 'live']);
  });

  it.each([0, -1, MAX_SLIPPAGE_BPS + 1, 250.5])(
    'rejects an out-of-range slippage of %s before opening a transaction',
    async (maxSlippageBps) => {
      await expect(
        upsertUserChainExecutionSettings(scope, { chain: 'solana', maxSlippageBps, ...entitled })
      ).rejects.toBeInstanceOf(InvalidExecutionSettingsError);
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  );

  it.each([MIN_SLIPPAGE_BPS, 300, MAX_SLIPPAGE_BPS])(
    'accepts %s bps, matching the bounds in slippage.ts',
    async (maxSlippageBps) => {
      await upsertUserChainExecutionSettings(scope, {
        chain: 'solana',
        maxSlippageBps,
        ...entitled
      });
      const [, values] = mocks.clientQuery.mock.calls[2] as [string, unknown[]];
      expect(values[3]).toBe(true);
      expect(values[4]).toBe(maxSlippageBps);
    }
  );

  it('distinguishes clearing the override from leaving it alone', async () => {
    await upsertUserChainExecutionSettings(scope, {
      chain: 'solana',
      maxSlippageBps: null,
      ...entitled
    });
    const [, cleared] = mocks.clientQuery.mock.calls[2] as [string, unknown[]];
    expect(cleared[3]).toBe(true);
    expect(cleared[4]).toBeNull();

    vi.clearAllMocks();
    await upsertUserChainExecutionSettings(scope, { chain: 'solana', mode: 'paper', ...entitled });
    const [, untouched] = mocks.clientQuery.mock.calls[2] as [string, unknown[]];
    expect(untouched[3]).toBe(false);
  });

  it('scopes both statements by user_id and chain', async () => {
    await upsertUserChainExecutionSettings(scope, { chain: 'polygon', mode: 'paper', ...entitled });
    for (const call of mocks.clientQuery.mock.calls.slice(1, 3)) {
      const [sql, values] = call as [string, unknown[]];
      expect(sql).toContain('$1');
      expect(values?.[0]).toBe(scope.userId);
      expect(values?.[1]).toBe('polygon');
    }
  });
});

describe('reads of the per-chain table', () => {
  it('returns null for a chain the user has never configured', async () => {
    mocks.query.mockResolvedValue([]);
    await expect(getUserChainExecutionSettings(scope, 'polygon')).resolves.toBeNull();
  });

  it('scopes the listing by user_id', async () => {
    mocks.query.mockResolvedValue([chainRow()]);
    await listUserChainExecutionSettings(scope);
    const [sql, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('user_id = $1');
    expect(values[0]).toBe(scope.userId);
  });
});

describe('resolveUserSlippageBps', () => {
  it('falls back to the chain default when the user has no row', () => {
    expect(resolveUserSlippageBps('solana', null)).toBe(DEFAULT_SLIPPAGE_BPS.solana);
    expect(resolveUserSlippageBps('polygon', undefined)).toBe(DEFAULT_SLIPPAGE_BPS.polygon);
  });

  it('treats a null override as "use the chain default", not as zero', () => {
    expect(resolveUserSlippageBps('solana', { maxSlippageBps: null })).toBe(
      DEFAULT_SLIPPAGE_BPS.solana
    );
  });

  it('honours a tighter user value rather than treating the default as a floor', () => {
    expect(resolveUserSlippageBps('solana', { maxSlippageBps: 50 })).toBe(50);
  });
});

describe('requestedUserChainMode', () => {
  it('forces off when the user kill switch is set, whatever the chain says', () => {
    expect(requestedUserChainMode({ killed: true }, { mode: 'live' })).toBe('off');
  });

  it('is off for a chain the user has never configured', () => {
    expect(requestedUserChainMode({ killed: false }, null)).toBe('off');
  });

  it('passes a configured mode through', () => {
    expect(requestedUserChainMode({ killed: false }, { mode: 'paper' })).toBe('paper');
    expect(requestedUserChainMode({ killed: false }, { mode: 'live' })).toBe('live');
  });
});

describe('049 DDL contract', () => {
  let sql = '';

  function ddlDefault(column: string): string {
    const match = new RegExp(
      `^\\s*${column}\\s+[A-Za-z0-9(),]+\\s+(?:NULL\\s+)?NOT NULL\\s+DEFAULT\\s+(\\S+)`,
      'm'
    ).exec(sql);
    if (!match) throw new Error(`no NOT NULL DEFAULT found for ${column}`);
    return match[1]!.replace(/,$/, '').replace(/^'|'$/g, '');
  }

  beforeEach(async () => {
    sql = await readFile(
      resolve(import.meta.dirname, '../sql/049_user_execution_settings.sql'),
      'utf8'
    );
  });

  it('keeps the SQL defaults equal to DEFAULT_RISK_CONFIG', () => {
    expect(Number(ddlDefault('max_position_pct'))).toBe(DEFAULT_RISK_CONFIG.maxPositionPct);
    expect(Number(ddlDefault('max_daily_exposure_pct'))).toBe(
      DEFAULT_RISK_CONFIG.maxDailyExposurePct
    );
    expect(Number(ddlDefault('stop_loss_pct'))).toBe(DEFAULT_RISK_CONFIG.stopLossPct);
  });

  it('keeps the SQL defaults equal to the resolver defaults', () => {
    expect(Number(ddlDefault('min_signal_score'))).toBe(DEFAULT_MIN_SIGNAL_SCORE);
    expect(Number(ddlDefault('rebuy_cooldown_seconds'))).toBe(DEFAULT_REBUY_COOLDOWN_SECONDS);
    expect(Number(ddlDefault('max_daily_withdrawal_usd'))).toBe(
      DEFAULT_MAX_DAILY_WITHDRAWAL_USD
    );
    expect(ddlDefault('auto_execute')).toBe('FALSE');
    expect(ddlDefault('killed')).toBe('FALSE');
    expect(ddlDefault('mode')).toBe('off');
  });

  it('bounds max_slippage_bps exactly as slippage.ts does', () => {
    // S4-P4 depends on these agreeing: the API validates with isValidSlippageBps
    // and the column is the backstop, so a mismatch is either a write the API
    // accepts and the database rejects, or a value the executor clamps silently.
    expect(Number(/max_slippage_bps >= (\d+)/.exec(sql)?.[1])).toBe(MIN_SLIPPAGE_BPS);
    expect(Number(/max_slippage_bps <= (\d+)/.exec(sql)?.[1])).toBe(MAX_SLIPPAGE_BPS);
  });

  it('keeps NULL meaning "use the chain default"', () => {
    expect(sql).toContain('max_slippage_bps IS NULL');
    expect(sql).toMatch(/max_slippage_bps INTEGER\s+NULL/);
  });

  it('orders the single-position cap inside the daily cap', () => {
    expect(sql).toContain(
      'CONSTRAINT chk_ues_position_within_daily\n    CHECK (max_position_pct <= max_daily_exposure_pct)'
    );
  });

  it('allows exactly the three user-selectable modes', () => {
    expect(sql).toContain("CONSTRAINT chk_uces_mode CHECK (mode IN ('off','paper','live'))");
    expect(sql).not.toContain('live+shadow');
  });

  it('constrains chain to the three-value union used everywhere else', () => {
    expect(sql).toContain("chain IN ('solana','polygon','robinhood-chain')");
  });

  it('keys the per-chain row by the pair that is the fact', () => {
    expect(sql).toContain('PRIMARY KEY (user_id, chain)');
  });

  it('cascades from users, because settings are preferences', () => {
    expect(sql.match(/REFERENCES users\(id\) ON DELETE CASCADE/g)).toHaveLength(2);
  });

  it('replays safely, because migrate.ts has no applied-migrations table', () => {
    expect(nonIdempotentStatements(sql)).toEqual([]);
  });
});
