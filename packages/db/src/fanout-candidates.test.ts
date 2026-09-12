import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('./client.js', () => ({ query: mocks.query }));

import { listFanoutCandidates } from './fanout-candidates.js';
import { planFanout, type FanoutPlatformInputs, type FanoutSignal } from './fanout-eligibility.js';
import { crossTenantScope, forUser } from './tenancy.js';
import { BALANCE_MAX_STALENESS_MS } from './user-balances.js';
import { DEFAULT_USER_EXECUTION_SETTINGS } from './user-execution-settings.js';

/**
 * The fetch half of `S4-13`.
 *
 * **What these tests can and cannot prove.** There is no database on this
 * branch, so nothing here executes SQL. `mocks.query` records the statement text
 * and the parameters, which pins the *contract* — the join shape, the predicates
 * that must be present, the parameter order — and pins all of the row-to-
 * candidate mapping, which is where the null-versus-zero and missing-row rules
 * live. It does **not** prove the statement parses, that the columns exist, or
 * that the planner uses `idx_uws_wallet_live`. Only
 * `tests/integration/` against Postgres can do that.
 *
 * The assertions worth having are therefore the refusals: an `ended`
 * subscription must not be enumerated, a `winding_down` one must, a user with no
 * settings row must still appear, and an unknown balance must not read as zero.
 */

const MASTER = 'solana:MasterWalletAddress1111111111111111111';
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const NOW = new Date('2026-09-04T12:00:00.000Z');

const sweep = () => crossTenantScope('fan-out enumeration');

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER_A,
    subscription_state: 'active',
    tier: 'ultra',
    tier_expires_at: null,
    auto_execute: true,
    killed: false,
    min_signal_score: 80,
    max_concurrent_positions: 5,
    open_position_count: '0',
    ...overrides
  };
}

function balanceRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER_A,
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

/** Candidate rows on the first call, balance rows on the second. */
function respondWith(candidates: unknown[], balances: unknown[] = []) {
  mocks.query.mockReset();
  mocks.query
    .mockResolvedValueOnce(candidates)
    .mockResolvedValueOnce(balances);
}

function candidateSql(): string {
  return (mocks.query.mock.calls[0] as [string, unknown[]])[0];
}

beforeEach(() => {
  mocks.query.mockReset();
});

describe('listFanoutCandidates — tenancy', () => {
  it('refuses a per-user scope so it cannot silently enumerate one subscriber', async () => {
    await expect(
      listFanoutCandidates(forUser(USER_A), { masterWalletAddress: MASTER, chain: 'solana' })
    ).rejects.toThrow(/crossTenantScope/);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('accepts a cross-tenant sweep scope', async () => {
    respondWith([]);
    await expect(
      listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana' })
    ).resolves.toEqual([]);
  });
});

describe('listFanoutCandidates — enumeration scope', () => {
  it('keys on the master wallet address, not on a cluster', async () => {
    respondWith([]);
    await listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana' });
    const [sql, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('subscription.wallet_address = $1');
    expect(sql).not.toMatch(/cluster/i);
    expect(values[0]).toBe(MASTER);
  });

  it('excludes ended subscriptions in the WHERE clause', async () => {
    // The predicate the partial index `idx_uws_wallet_live` was built for. An
    // ended row is retained forever for attribution, so without it every mirror
    // enumerates everyone who ever left this master.
    respondWith([]);
    await listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana' });
    expect(candidateSql()).toContain("subscription.state <> 'ended'");
  });

  it('does not filter on state = active, so winding_down is still enumerated', async () => {
    respondWith([]);
    await listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana' });
    expect(candidateSql()).not.toMatch(/subscription\.state\s*=\s*'active'/);
    expect(candidateSql()).not.toMatch(/state IN \('active'\)/);
  });

  it('never consults membership_slot, which a winding-down row does not hold', async () => {
    respondWith([]);
    await listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana' });
    expect(candidateSql()).not.toContain('membership_slot');
    expect(candidateSql()).not.toContain('membership_grandfathered');
  });

  it('enumerates a winding_down row and hands its raw state to the decision layer', async () => {
    respondWith([candidateRow({ subscription_state: 'winding_down' })], [balanceRow()]);
    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.subscriptionState).toBe('winding_down');
  });

  it('passes an unrecognised state through untouched rather than narrowing it', async () => {
    // `mirrorEligibilityForState` is the only reader and it fails closed. A cast
    // or a validation here would be a claim this module cannot make about a
    // column a future migration can widen.
    respondWith([candidateRow({ subscription_state: 'quarantined' })], [balanceRow()]);
    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidates[0]!.subscriptionState).toBe('quarantined');
  });

  it('restricts to active accounts, since a fan-out has no session to check status', async () => {
    respondWith([]);
    await listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana' });
    expect(candidateSql()).toContain("account.status = 'active'");
  });

  it('outer-joins the settings row so a user without one still appears', async () => {
    respondWith([]);
    await listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana' });
    const sql = candidateSql();
    expect(sql).toMatch(/LEFT JOIN user_execution_settings/);
    expect(sql).not.toMatch(/\n\s*JOIN user_execution_settings/);
  });
});

describe('listFanoutCandidates — missing settings row', () => {
  it('fills every setting from the shared defaults, not from a SQL COALESCE', async () => {
    respondWith([
      candidateRow({
        auto_execute: null,
        killed: null,
        min_signal_score: null,
        max_concurrent_positions: null
      })
    ], [balanceRow()]);

    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });

    expect(candidate).toMatchObject({
      autoExecute: DEFAULT_USER_EXECUTION_SETTINGS.autoExecute,
      killed: DEFAULT_USER_EXECUTION_SETTINGS.killed,
      minSignalScore: DEFAULT_USER_EXECUTION_SETTINGS.minSignalScore,
      maxConcurrentPositions: DEFAULT_USER_EXECUTION_SETTINGS.maxConcurrentPositions
    });
    // The defaults must not be restated in the statement text; the one copy is
    // `DEFAULT_USER_EXECUTION_SETTINGS`, which its own suite pins against `049`.
    expect(candidateSql()).not.toMatch(/COALESCE\s*\(\s*settings\./i);
  });

  it('appears in the candidate list rather than being dropped by the join', async () => {
    respondWith([candidateRow({ auto_execute: null })], [balanceRow()]);
    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidates.map((c) => c.userId)).toEqual([USER_A]);
  });

  it('is excluded as auto-execute-off, which is the true reason and not silence', async () => {
    // The whole point of the outer join: an inner join would report no exclusion
    // at all, which is indistinguishable from "never subscribed".
    respondWith([candidateRow({ auto_execute: null })], [balanceRow()]);
    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    const signal: FanoutSignal = {
      chain: 'solana',
      masterWalletAddress: MASTER,
      tokenMint: 'solana:Mint111',
      direction: 'buy',
      score: 90
    };
    const platform: FanoutPlatformInputs = {
      chainMode: { effectiveMode: 'paper' },
      minimumBalanceUsd: 0,
      capacity: { outcome: 'admit' }
    };
    const plan = planFanout(candidates, signal, platform);
    expect(plan.eligible).toHaveLength(0);
    expect(plan.exclusionCounts).toEqual({ 'auto-execute-off': 1 });
  });

  it('keeps a persisted false distinct from a missing row for auto_execute', async () => {
    // `??` and not `||`: a stored `false` is the user's own choice and must not
    // be overwritten by the default, which happens to be the same value today.
    respondWith([candidateRow({ auto_execute: false })], [balanceRow()]);
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.autoExecute).toBe(false);
  });

  it('keeps a persisted zero min_signal_score rather than defaulting it to 80', async () => {
    respondWith([candidateRow({ min_signal_score: 0 })], [balanceRow()]);
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.minSignalScore).toBe(0);
  });
});

describe('listFanoutCandidates — balances', () => {
  it('scopes the balance read to the signal chain so one feed outage cannot spread', async () => {
    respondWith([candidateRow()], [balanceRow({ chain: 'polygon' })]);
    await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'polygon',
      now: NOW
    });
    const [sql, values] = mocks.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('FROM user_balances');
    expect(sql).toContain('chain = $1');
    expect(values[0]).toBe('polygon');
    expect(values[1]).toEqual([USER_A]);
  });

  it('sums a fresh, priced balance set', async () => {
    respondWith(
      [candidateRow()],
      [balanceRow({ usd: 400 }), balanceRow({ asset: 'USDC', usd: 600 })]
    );
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.knownBalanceUsd).toBe(1000);
  });

  it('reports null, not zero, when a row is unpriced', async () => {
    respondWith(
      [candidateRow()],
      [balanceRow({ usd: 500 }), balanceRow({ asset: 'BONK', usd: null, usd_priced_at: null })]
    );
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.knownBalanceUsd).toBeNull();
  });

  it('reports null, not a partial sum, when a row is stale', async () => {
    const stale = new Date(NOW.getTime() - BALANCE_MAX_STALENESS_MS - 1);
    respondWith(
      [candidateRow()],
      [balanceRow({ usd: 500 }), balanceRow({ asset: 'USDC', usd: 500, fetched_at: stale })]
    );
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.knownBalanceUsd).toBeNull();
  });

  it('reports null when the user has no balance row on this chain', async () => {
    respondWith([candidateRow()], []);
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.knownBalanceUsd).toBeNull();
  });

  it('reports a genuine zero as zero, so the two directions both hold', async () => {
    respondWith([candidateRow()], [balanceRow({ amount: 0, usd: 0 })]);
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.knownBalanceUsd).toBe(0);
  });

  it('reports null when a NUMERIC usd value does not fit a float64', async () => {
    // The parser hands back the original text in that case; re-parsing it with
    // Number() would reintroduce the drift the parser exists to prevent.
    respondWith([candidateRow()], [balanceRow({ usd: '123456789012345678901.55' })]);
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.knownBalanceUsd).toBeNull();
  });

  it('keeps one user unknown balance from affecting another', async () => {
    respondWith(
      [candidateRow(), candidateRow({ user_id: USER_B })],
      [balanceRow({ usd: null, usd_priced_at: null }), balanceRow({ user_id: USER_B, usd: 250 })]
    );
    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidates.map((c) => [c.userId, c.knownBalanceUsd])).toEqual([
      [USER_A, null],
      [USER_B, 250]
    ]);
  });

  it('does not issue the balance query when nobody is subscribed', async () => {
    respondWith([]);
    await listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('defaults the staleness window to the shared gate', async () => {
    const stale = new Date(NOW.getTime() - BALANCE_MAX_STALENESS_MS - 1);
    respondWith([candidateRow()], [balanceRow({ fetched_at: stale })]);
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.knownBalanceUsd).toBeNull();
  });
});

describe('listFanoutCandidates — open positions', () => {
  it('counts positions with a confirmed quantity, across every chain', async () => {
    // The cap is per user, not per chain: `max_concurrent_positions` is a single
    // column on the user row, so scoping the count by chain would let a user
    // hold the cap independently on each of three venues.
    respondWith([]);
    await listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana' });
    const sql = candidateSql();
    expect(sql).toContain('FROM copy_positions position');
    expect(sql).toContain('position.confirmed_quantity > 0');
    expect(sql).toContain('position.user_id = subscription.user_id');
    expect(sql).not.toMatch(/position\.chain\s*=/);
  });

  it('reads the count as a number', async () => {
    respondWith([candidateRow({ open_position_count: '7' })], [balanceRow()]);
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.openPositionCount).toBe(7);
  });

  it('throws rather than admitting when the count cannot be read', async () => {
    // `openPositionCount >= cap` is false for NaN, so a silent fallback would
    // open a position past the cap. Failing the fan-out closed is correct.
    respondWith([candidateRow({ open_position_count: 'not-a-number' })], [balanceRow()]);
    await expect(
      listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana', now: NOW })
    ).rejects.toThrow(/not a non-negative integer/);
  });
});

describe('listFanoutCandidates — tier', () => {
  it('carries the stored tier and expiry through untouched', async () => {
    const expires = new Date('2026-12-01T00:00:00.000Z');
    respondWith(
      [candidateRow({ tier: 'operator', tier_expires_at: expires })],
      [balanceRow()]
    );
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.tier).toBe('operator');
    expect(candidate!.tierExpiresAt).toBe(expires);
  });

  it('degrades an unrecognised tier to free instead of crashing the fan-out', async () => {
    // `capabilitiesFor` indexes the matrix directly, so an out-of-CHECK value
    // would throw inside `tierAllowsChain` and take down every other
    // subscriber on this signal. `free` is the floor `effectiveTier` already
    // uses for an expired tier, so this adds no new policy.
    respondWith([candidateRow({ tier: 'platinum' })], [balanceRow()]);
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.tier).toBe('free');
  });

  it('keeps a null expiry as null, which means lifetime and not expired', async () => {
    respondWith([candidateRow({ tier: 'ultra', tier_expires_at: null })], [balanceRow()]);
    const [candidate] = await listFanoutCandidates(sweep(), {
      masterWalletAddress: MASTER,
      chain: 'solana',
      now: NOW
    });
    expect(candidate!.tierExpiresAt).toBeNull();
  });
});

describe('listFanoutCandidates — decisions stay in planFanout', () => {
  it('encodes no eligibility condition in the SQL beyond the enumeration scope', async () => {
    respondWith([]);
    await listFanoutCandidates(sweep(), { masterWalletAddress: MASTER, chain: 'solana' });
    const sql = candidateSql();
    // Each of these is a `planFanout` verdict, and each would become an
    // untestable silent filter if it moved into the WHERE clause.
    expect(sql).not.toMatch(/auto_execute\s*=\s*(TRUE|true)/);
    expect(sql).not.toMatch(/killed\s*=\s*(FALSE|false)/);
    expect(sql).not.toMatch(/min_signal_score\s*(<=|>=|<|>)/);
    expect(sql).not.toMatch(/max_concurrent_positions\s*(<=|>=|<|>)/);
    expect(sql).not.toMatch(/usd\s*>=/);
  });
});
