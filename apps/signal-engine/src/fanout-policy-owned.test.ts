import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '@swat/db/dist/copy-trade-lifecycle-owned.js';
import { createOwnedFanoutPolicy, type FanoutPolicySource, type OwnedFanoutPolicyPorts } from './fanout-policy-owned.js';
import { planFanoutTradeJobs, type FanoutJobDescriptor } from './fanout-enqueue.js';
import { classifyFanoutRefusal } from './fanout-canonical.js';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const SIGNAL = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const TARGET = 'solana:11111111111111111111111111111111';
const MASTER = 'solana:11111111111111111111111111111112';
const TOKEN = 'solana:11111111111111111111111111111113';
const NOW = new Date('2026-11-23T00:00:01.000Z');
const sourceInput = (side: 'buy' | 'sell' = 'buy'): FanoutPolicySource => ({
  sourceTradeId: SOURCE, walletAddress: MASTER, tokenMint: TOKEN, side, eventAt: new Date(NOW.getTime() - 1000)
});
const job = (side: 'buy' | 'sell' = 'buy') => planFanoutTradeJobs({ signalId: SIGNAL, tokenMint: TOKEN,
  score: 90, clusterTier: 'elite', sourceTrade: { sourceTradeId: SOURCE, direction: side },
  plan: { eligible: [], excluded: [], exclusionCounts: {} } });
const descriptor = (side: 'buy' | 'sell' = 'buy', userId: string | null = USER): FanoutJobDescriptor => {
  const operator = job(side).operator;
  return { ...operator, data: { ...operator.data, userId, executionMode: 'paper', targetAccount: TARGET } };
};
const candidate = (userId = USER) => ({ user_id: userId, active_since: new Date(NOW.getTime() - 2000),
  subscription_state: 'active', tier: 'ultra', tier_expires_at: null, auto_execute: true,
  killed: false, min_signal_score: 80, max_concurrent_positions: 5, open_position_count: '0' });
const balance = (userId = USER) => ({ user_id: userId, chain: 'solana', asset: 'SOL', amount: 1, decimals: 9,
  usd: 100, usd_priced_at: NOW, fetched_at: NOW, source: 'poller' });

/** Actual shared production bodies and actual candidate/scope/verifier leaves;
 * only external IO replies are inert. Not PG/RLS/protected-provider acceptance. */
function fixture(side: 'buy' | 'sell' = 'buy') {
  const state = { accepted: true, blacklist: [] as unknown, candidates: [candidate()], balances: [balance()],
    policy: { status: 'active', auto_execute: true, killed: false, mode: 'paper', state: 'active' },
    source: { wallet_address: MASTER, direction: side, token_mint: TOKEN, chain: 'solana',
      event_at: new Date(NOW.getTime() - 1000), confirmation_state: 'confirmed' },
    lots: [{ target_account: TARGET, execution_mode: 'paper' }],
    availability: { quantity: '9007199254740993.000000000000000001', reason: null as string | null } };
  const events: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    events.push(sql);
    if (sql.includes('SELECT true AS accepted')) return { rows: state.accepted ? [{ accepted: true }] : [] };
    if (sql.includes('FROM user_wallet_subscriptions subscription')) return { rows: state.candidates };
    if (sql.includes('FROM user_balances')) return { rows: state.balances };
    if (sql.includes('SELECT source.wallet_address')) return { rows: [state.source] };
    if (sql.includes("key = 'blacklist'")) return { rows: [{ value: state.blacklist }] };
    if (sql.includes('SELECT account.status')) return { rows: [state.policy] };
    if (sql.includes('SELECT DISTINCT position.target_account')) return { rows: state.lots };
    if (sql.includes('SELECT id FROM copy_positions')) return { rows: [{ id: OTHER }] };
    if (sql.includes('WITH lots AS')) return { rows: [state.availability] };
    if (sql.includes('SELECT lot.id')) return { rows: [{ id: OTHER }] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    throw new Error('Unscripted real SQL: ' + sql + JSON.stringify(values));
  });
  const client = { query } as unknown as PoolClient;
  const transactionCalls = vi.fn();
  const ports: OwnedFanoutPolicyPorts = {
    async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
      transactionCalls();
      events.push('acquire'); const result = await operation(client); events.push('COMMIT'); return result;
    },
    mode: vi.fn(async () => ({ effectiveMode: 'paper' as const })),
    safety: vi.fn(async () => ({ isSafe: true })),
    capacity: vi.fn(async () => ({ capacity: { outcome: 'admit' as const }, decision: null, logLine: 'inert capacity' })),
    operatorAutoExecute: vi.fn(() => true), paperTargetAccount: vi.fn(() => TARGET), now: () => new Date(NOW),
    minimumBalanceUsd: 0, minimumSignalScore: 70, maximumSourceEventAgeMs: 1000,
    log: vi.fn(), warn: vi.fn(), error: vi.fn()
  };
  const policy = () => createOwnedFanoutPolicy(ports);
  return { state, events, query, client, ports, policy, transactionCalls,
    enumerate: () => policy().prepareEnumeration(sourceInput(side), { allowed: true, requiresOwnedExit: side === 'sell' }, null)(job(side)) };
}

describe('actual boot-delegated owned fanout composition', () => {
  it('enumerates canonical candidates on one caller client and scopes operator/tenant before descriptor output', async () => {
    const f = fixture();
    const snapshot = await f.enumerate();
    expect(snapshot.exclusions).toEqual([]);
    expect(snapshot.recipients.map(row => [row.userId, row.executionMode, row.targetAccount])).toEqual([
      [null, 'paper', TARGET], [USER, 'paper', TARGET]
    ]);
    expect(snapshot.recipients.map(row => (row.descriptor.data as Record<string, unknown>).tokenMint)).toEqual([TOKEN, TOKEN]);
    expect(snapshot.recipients.every(row => !(row.descriptor.data as Record<string, unknown>).copyExecutionId)).toBe(true);
    const candidateIndex = f.events.findIndex(sql => sql.includes('FROM user_wallet_subscriptions subscription'));
    const balanceIndex = f.events.findIndex(sql => sql.includes('FROM user_balances'));
    expect(f.events.slice(candidateIndex, balanceIndex + 1).some(event => event === 'acquire' || event === 'COMMIT')).toBe(false);
    expect(f.ports.capacity).toHaveBeenCalledWith(expect.objectContaining({ masterWalletAddress: MASTER,
      projection: expect.objectContaining({ cohortSize: 1, projectedNotionalUsd: 100 }), cohortDirection: 'buy' }));
  });
  it('does not charge capacity for opted-out users and retains explicit stable exclusion', async () => {
    const f = fixture(); f.state.candidates.push({ ...candidate(OTHER), auto_execute: false });
    f.state.balances.push({ ...balance(OTHER), usd: 99999 });
    const snapshot = await f.enumerate();
    expect(snapshot.exclusions).toEqual([{ userId: OTHER, code: 'auto-execute-off' }]);
    expect(f.ports.capacity).toHaveBeenCalledWith(expect.objectContaining({
      projection: expect.objectContaining({ cohortSize: 1, projectedNotionalUsd: 100 }) }));
  });
  it.each(['balance-unknown', 'capacity-unknown', 'chain-mode-unknown'] as const)('keeps %s retryable instead of freezing exclusion', async reason => {
    const f = fixture();
    if (reason === 'balance-unknown') f.state.balances = [];
    if (reason === 'capacity-unknown') f.ports.capacity = vi.fn(async () => ({ capacity: null, decision: null, logLine: 'unknown' }));
    if (reason === 'chain-mode-unknown') f.ports.mode = vi.fn(async () => null);
    await expect(f.enumerate()).rejects.toThrow(reason);
    expect(classifyFanoutRefusal(reason)).toBe('retryable');
    expect(f.query.mock.calls.some(([sql]) => sql.includes('SELECT account.status'))).toBe(false);
  });
  it('keeps a real capacity breach stable while capacity reader failures do not become empty cohorts', async () => {
    const f = fixture(); f.ports.capacity = vi.fn(async () => ({ capacity: { outcome: 'skip' as const }, decision: null, logLine: 'breach' }));
    expect((await f.enumerate()).exclusions).toEqual([{ userId: USER, code: 'capacity-exhausted' }]);
    f.ports.capacity = vi.fn(async () => { throw new Error('capacity transport lost'); });
    await expect(f.enumerate()).rejects.toThrow('Fanout recipient enumeration unavailable');
  });
  it('refuses 1001 candidates before recipient-scope transactions', async () => {
    const f = fixture(); f.state.candidates = Array.from({ length: 1001 }, () => ({ ...candidate(), auto_execute: false }));
    await expect(f.enumerate()).rejects.toThrow('Fanout cohort exceeds bounded snapshot');
    expect(f.query.mock.calls.some(([sql]) => sql.includes('SELECT account.status'))).toBe(false);
  });
  it('requires protected accepted evidence before mode, candidates or current admission; labels are insufficient', async () => {
    const f = fixture(); f.state.accepted = false;
    await expect(f.enumerate()).rejects.toThrow('accepted-source-verification-unavailable');
    await expect(f.policy().admission(f.client, descriptor())).resolves.toEqual({ allowed: false, reason: 'accepted-source-verification-unavailable' });
    expect(f.ports.mode).not.toHaveBeenCalled(); expect(f.ports.safety).not.toHaveBeenCalled();
    expect(f.query.mock.calls.every(([sql]) => sql.includes('SELECT true AS accepted'))).toBe(true);
    expect(f.query.mock.calls[0][0]).toContain('evidence.binding_digest = binding.binding_digest');
    expect(f.query.mock.calls[0][0]).toContain('authority.identity_digest = evidence.provider_identity_digest');
  });
  it('captures source, eligibility and nested job terms before acquisition and rejects mismatches before acquisition', async () => {
    const f = fixture(); const source = sourceInput(); const plan = job();
    const eligibility = { allowed: true as const, requiresOwnedExit: false };
    const enumerate = f.policy().prepareEnumeration(source, eligibility, null);
    source.eventAt.setTime(0);
    const normalTransaction = f.ports.transaction;
    f.ports.transaction = async operation => {
      (plan.operator.data as { tokenMint: string }).tokenMint = TARGET;
      return normalTransaction(operation);
    };
    expect((await enumerate(plan)).recipients).toHaveLength(2);
    expect(f.query.mock.calls.find(([sql]) => sql.includes('FROM user_wallet_subscriptions subscription'))![1]).toEqual([MASTER]);
    const invalid = fixture(); const badPlan = job();
    (badPlan.operator.data as { sourceTradeId: string }).sourceTradeId = OTHER;
    await expect(invalid.policy().prepareEnumeration(sourceInput(), eligibility, null)(badPlan)).rejects.toThrow('source/job scope mismatch');
    expect(invalid.transactionCalls).not.toHaveBeenCalled();
  });
  it('keeps failed caller COMMIT out of cohort output without scope reads or fallback', async () => {
    const f = fixture();
    f.ports.transaction = async operation => { await operation(f.client); throw new Error('caller COMMIT unavailable'); };
    await expect(f.enumerate()).rejects.toThrow('caller COMMIT unavailable');
    expect(f.query.mock.calls).toHaveLength(1);
    expect(f.ports.mode).not.toHaveBeenCalled();
  });
  it('rejects malformed recipient tenant/target before accepted-source query', async () => {
    const f = fixture(); const input = descriptor();
    (input.data as { userId: string }).userId = '*';
    await expect(f.policy().admission(f.client, input)).rejects.toThrow('Invalid fanout policy identity');
    expect(f.query).not.toHaveBeenCalled();
  });
  it('captures descriptor tenant/target/source before accepted-read mutation', async () => {
    const f = fixture(); const input = descriptor();
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values) => {
      if (sql.includes('SELECT true AS accepted')) (input.data as { userId: string }).userId = OTHER;
      return original(sql, values);
    });
    await expect(f.policy().admission(f.client, input)).resolves.toEqual({ allowed: true });
    expect(f.query.mock.calls.find(([sql]) => sql.includes('SELECT account.status'))![1]).toEqual([USER, 'solana', MASTER]);
  });
});

describe('actual current-recipient admission and reducing-owned exits', () => {
  it('uses the supplied transaction client for verifier/source/blacklist/current scope before buy safety', async () => {
    const f = fixture();
    await expect(f.policy().admission(f.client, descriptor())).resolves.toEqual({ allowed: true });
    expect(f.transactionCalls).not.toHaveBeenCalled();
    expect(f.query.mock.calls.find(([sql]) => sql.includes('SELECT source.wallet_address'))![1]).toEqual([SIGNAL, SOURCE]);
    expect(f.query.mock.calls.find(([sql]) => sql.includes('SELECT account.status'))![1]).toEqual([USER, 'solana', MASTER]);
    expect(f.ports.safety).toHaveBeenCalledWith(TOKEN);
  });
  it.each(['token-blacklisted', 'blacklist-unreadable', 'user-killed', 'account-not-active',
    'user-chain-execution-off', 'immutable-recipient-scope-changed', 'entry-safety-refused', 'entry-score-refused'] as const)(
    'retains current refusal %s without source claim or queue authority', async reason => {
      const f = fixture(); const input = descriptor();
      if (reason === 'token-blacklisted') f.state.blacklist = [TOKEN];
      if (reason === 'blacklist-unreadable') f.state.blacklist = { unknown: true };
      if (reason === 'user-killed') f.state.policy.killed = true;
      if (reason === 'account-not-active') f.state.policy.status = 'suspended';
      if (reason === 'user-chain-execution-off') f.state.policy.mode = 'off';
      if (reason === 'immutable-recipient-scope-changed') (input.data as { targetAccount: string }).targetAccount = MASTER;
      if (reason === 'entry-safety-refused') f.ports.safety = vi.fn(async () => ({ isSafe: false }));
      if (reason === 'entry-score-refused') (input.data as { score: number }).score = 79;
      await expect(f.policy().admission(f.client, input)).resolves.toEqual({ allowed: false, reason });
      expect(f.query.mock.calls.some(([sql]) => /INSERT|UPDATE|SET ROLE/.test(sql))).toBe(false);
    });
  it.each(['future', 'stale', 'identity', 'unconfirmed'] as const)('refuses %s source before current scope', async kind => {
    const f = fixture();
    if (kind === 'future') f.state.source.event_at = new Date(NOW.getTime() + 1);
    if (kind === 'stale') f.state.source.event_at = new Date(NOW.getTime() - 1001);
    if (kind === 'identity') f.state.source.token_mint = TARGET;
    if (kind === 'unconfirmed') f.state.source.confirmation_state = 'observed';
    await expect(f.policy().admission(f.client, descriptor())).resolves.toEqual({ allowed: false,
      reason: 'source-identity-confirmation-or-freshness-unavailable' });
    expect(f.ports.mode).not.toHaveBeenCalled();
  });
  it('reducing winding-down sells bypass buy balance/score/position/capacity/safety but require exact held-lot availability', async () => {
    const f = fixture('sell'); f.state.candidates[0] = { ...candidate(), subscription_state: 'winding_down',
      min_signal_score: 100, open_position_count: '99' }; f.state.balances = [];
    f.state.policy.state = 'winding_down';
    expect((await f.enumerate()).recipients.map(row => row.userId)).toEqual([null, USER]);
    await expect(f.policy().admission(f.client, descriptor('sell'))).resolves.toEqual({ allowed: true });
    expect(f.ports.capacity).not.toHaveBeenCalled(); expect(f.ports.safety).not.toHaveBeenCalled();
    const lots = f.query.mock.calls.find(([sql, values]) => sql.includes('SELECT DISTINCT position.target_account')
      && values?.[0] === USER)!;
    expect(lots[1]).toEqual([USER, 'solana', TOKEN, MASTER]);
    expect(lots[0]).toContain('acquisition.user_id IS NOT DISTINCT FROM lot.user_id');
    expect(lots[0]).toContain('acquisition.source_trade_id = lot.source_trade_id');
    const availability = f.query.mock.calls.find(([sql]) => sql.includes('WITH lots AS'))!;
    expect(availability[1]!.slice(0, 6)).toEqual([TARGET, 'solana', TOKEN, null, MASTER, 'paper']);
    expect(availability[0]).toContain('application.active');
  });
  it('reducing sells still stop on blacklist and missing/mixed/unknown inventory stays retryable', async () => {
    const f = fixture('sell'); f.state.blacklist = [TOKEN];
    await expect(f.policy().admission(f.client, descriptor('sell'))).resolves.toEqual({ allowed: false, reason: 'token-blacklisted' });
    f.state.blacklist = []; f.state.lots = [];
    await expect(f.policy().admission(f.client, descriptor('sell'))).resolves.toEqual({ allowed: false, reason: 'owned-exit-scope-missing-or-mixed' });
    await expect(f.enumerate()).rejects.toThrow('owned-exit-scope-missing-or-mixed');
    expect(classifyFanoutRefusal('owned-exit-scope-missing-or-mixed')).toBe('retryable');
    f.state.lots = [{ target_account: TARGET, execution_mode: 'paper' }];
    f.state.availability = { quantity: '', reason: 'Master inventory availability is unknown' };
    await expect(f.policy().admission(f.client, descriptor('sell'))).resolves.toEqual({ allowed: false, reason: 'Master inventory availability is unknown' });
  });
  it('operator opt-in remains mandatory and unknown user settings never become defaults at current admission', async () => {
    const f = fixture(); f.ports.operatorAutoExecute = vi.fn(() => false);
    await expect(f.policy().admission(f.client, descriptor('buy', null))).resolves.toEqual({ allowed: false, reason: 'operator-auto-execute-off' });
    f.state.policy.killed = undefined as unknown as boolean;
    await expect(f.policy().admission(f.client, descriptor())).resolves.toEqual({ allowed: false, reason: 'user-killed-or-unreadable' });
  });
});
