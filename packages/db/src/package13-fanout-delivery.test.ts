import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  claimFanoutDelivery, claimFanoutEnumeration, completeFanoutEnumeration,
  ensureFanoutEnumeration, failFanoutEnumeration, listFanoutDeliveries,
  listFanoutEnumerationRepairs, markFanoutDeliveryQueued, settleFanoutDelivery, prepareFanoutDeliveryQueueWithClient,
  type FanoutDeliveryIdentity, type FanoutRecipient
} from './package13-fanout-delivery.js';

const SIGNAL = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const USER2 = '44444444-4444-4444-8444-444444444444';
const EXECUTION = '55555555-5555-4555-8555-555555555555';
const TARGET = 'solana:11111111111111111111111111111111';
const NOW = new Date('2026-11-13T12:00:00Z');
const identity = (userId: string | null = USER): FanoutDeliveryIdentity => ({ signalId: SIGNAL, userId, executionMode: 'paper', targetAccount: TARGET });
const enumeration = { signalId: SIGNAL, sourceTradeId: SOURCE, owner: 'enum-owner', fence: '2' };
const claim = { ...identity(), owner: 'worker-owner', fence: '3' };
function db(rows: unknown[][] = [], userId: string | null = USER) {
  const query = vi.fn();
  const normalize = (row: unknown) => {
    const value = row as Record<string, unknown>;
    return value.state && !Object.hasOwn(value, 'submission_id')
      ? { ...value, job_id: recipient(userId).jobId, descriptor: recipient(userId).descriptor, execution_id: EXECUTION,
        scope_chain: 'solana', scope_token_mint: TARGET }
      : value;
  };
  const first = rows[0]?.[0] as Record<string, unknown> | undefined;
  if (first?.state && !Object.hasOwn(first, 'submission_id')) {
    const row = normalize(first);
    const scope = { id: EXECUTION, target_account: TARGET, chain: 'solana', token_mint: TARGET, user_id: userId };
    const prior = (first.state === 'claimed' ? [] : rows[1] ?? []).map(execution => ({ ...scope,
      ...(execution as Record<string, unknown>) }));
    const protocol = [[row], [scope], [], prior, [row], ...(first.state === 'claimed' ? rows.slice(1) : rows.slice(2))];
    for (const result of protocol) query.mockResolvedValueOnce({ rows: result });
  } else for (const result of rows) query.mockResolvedValueOnce({ rows: result.map(normalize) });
  query.mockResolvedValue({ rows: [{ signal_id: SIGNAL, fence: '3' }] });
  return { query, client: { query } as unknown as PoolClient };
}
function recipient(userId: string | null): FanoutRecipient {
  const jobId = userId === null ? 'source-operator' : `source-user-${userId}`;
  return { ...identity(userId), jobId, descriptor: {
    name: 'signal-trade', queue: 'swat-trades-solana', chain: 'solana', data: {
      copyExecutionId: EXECUTION, chain: 'solana', signalId: SIGNAL, sourceTradeId: SOURCE,
      userId, executionMode: 'paper', targetAccount: TARGET, tokenMint: TARGET,
      masterWalletAddress: TARGET, direction: 'buy', requestedBaseQuantity: '1.000000000000000001',
      requestedQuoteQuantity: null, exitLotId: null
    }, options: { jobId }
  } };
}

describe('package13 unapplied SQL storage contract', () => {
  it('propagates absent tables and never fabricates durable success', async () => {
    const { client, query } = db();
    query.mockRejectedValue(new Error('relation source_fanout_batches does not exist'));
    await expect(ensureFanoutEnumeration(client, { signalId: SIGNAL, sourceTradeId: SOURCE })).rejects.toThrow(/does not exist/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('seeds enumeration before work, with exact immutable source identity', async () => {
    const { client, query } = db();
    await ensureFanoutEnumeration(client, { signalId: SIGNAL, sourceTradeId: SOURCE });
    expect(query.mock.calls[0][1]).toEqual([SIGNAL, SOURCE]);
    expect(query.mock.calls[0][0]).toContain('source_fanout_batches.source_trade_id = EXCLUDED.source_trade_id');
    expect(query.mock.calls[0][0]).not.toMatch(/BEGIN|COMMIT|ROLLBACK/);
  });

  it('retains a failed/partial enumeration seed instead of completing an operator-only snapshot', async () => {
    const { client, query } = db();
    await expect(failFanoutEnumeration(client, enumeration, 'partial enumeration')).resolves.toBe(true);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("state = 'pending'");
    expect(sql).toContain('fence = $4::bigint');
    expect(values).toEqual([SIGNAL, SOURCE, 'enum-owner', '2', 'partial enumeration']);
  });

  it('claims bounded enumeration with a new fence and no source state promotion', async () => {
    const { client, query } = db([[{ fence: '4' }]]);
    await expect(claimFanoutEnumeration(client, { ...enumeration, now: NOW, leaseMs: 1000 })).resolves.toMatchObject({ fence: '4' });
    expect(query.mock.calls[0][0]).toContain('fence = fence + 1');
    expect(query.mock.calls[0][0]).not.toMatch(/UPDATE signals|confirmation_state/);
  });

  it('persists operator and two tenants before commit, never sharing a terminal state', async () => {
    const { client, query } = db();
    await completeFanoutEnumeration(client, enumeration, { chain: 'solana', recipients: [recipient(null), recipient(USER), recipient(USER2)], exclusions: [], now: NOW });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.slice(1).map((call) => call[1].slice(0, 4))).toEqual([
      [SIGNAL, null, 'paper', TARGET], [SIGNAL, USER, 'paper', TARGET], [SIGNAL, USER2, 'paper', TARGET]
    ]);
    expect(query.mock.calls[0][0]).toContain('lease_until > $7');
    expect(query.mock.calls.every((call) => !/BEGIN|COMMIT|UPDATE signals/.test(call[0]))).toBe(true);
  });

  it('rejects stale enumeration fencing without adding any recipients', async () => {
    const { client, query } = db([[]]);
    await expect(completeFanoutEnumeration(client, enumeration, { chain: 'solana', recipients: [recipient(null)], exclusions: [], now: NOW })).rejects.toThrow(/lease lost/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuses duplicate recipients or a changed tenant descriptor before touching SQL', async () => {
    const { client, query } = db();
    await expect(completeFanoutEnumeration(client, enumeration, { chain: 'solana', recipients: [recipient(null), recipient(USER), recipient(USER)], exclusions: [], now: NOW })).rejects.toThrow(/Duplicate/);
    const changed = { ...recipient(USER), descriptor: recipient(USER2).descriptor };
    await expect(completeFanoutEnumeration(client, enumeration, { chain: 'solana', recipients: [recipient(null), changed], exclusions: [], now: NOW })).rejects.toThrow(/identity/);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads repair obligations independently of processed/expired shared source state', async () => {
    const { client, query } = db([[], []]);
    await listFanoutEnumerationRepairs(client);
    await listFanoutDeliveries(client, SIGNAL);
    expect(query.mock.calls[1][0]).toContain("state <> 'completed'");
    expect(query.mock.calls.map((call) => call[0]).join(' ')).not.toMatch(/source_dispatched_at|signals\.status|expires_at|JOIN signals/);
  });

  it('preserves a worker clean skip/claim/completion when the queue acknowledgement arrives late', async () => {
    const { client, query } = db();
    await markFanoutDeliveryQueued(client, identity());
    expect(query.mock.calls[0][0]).toContain("CASE WHEN state = 'pending' THEN 'queued' ELSE state END");
    expect(query.mock.calls[0][1]).toEqual([SIGNAL, USER, 'paper', TARGET]);
  });
});

describe('legacy fanout quarantine preserves healthy delivery repair', () => {
  it.each([['pending', [], 'blocked'], ['pending', [{ id: EXECUTION, proven_non_submitted: false }], 'reconciliation_required'],
    ['claimed', [], 'reconciliation_required']])('quarantines legacy %s without descriptor or execution backfill', async (state, prior, expected) => {
    const { client, query } = db(); query.mockReset();
    const row = { state, descriptor: {}, job_id: 'legacy', execution_id: null, scope_chain: 'solana', scope_token_mint: TARGET };
    const scoped = (prior as Array<Record<string, unknown>>).map(execution => ({ ...execution,
      target_account: TARGET, chain: 'solana', token_mint: TARGET, user_id: USER }));
    for (const result of [[row], scoped, [], scoped, [row]]) query.mockResolvedValueOnce({ rows: result });
    query.mockResolvedValue({ rows: [] });
    const admission = vi.fn();
    expect(await claimFanoutDelivery(client, identity(), { owner: 'repair', now: NOW, leaseMs: 1000, admission })).toBeNull();
    expect(admission).not.toHaveBeenCalled(); expect(query.mock.calls[5][1]).toContain(expected);
    expect(query.mock.calls[5][0]).not.toMatch(/descriptor\s*=|execution_id\s*=/);
    expect(query.mock.calls[3][0]).toContain('copy_execution_worker_attempts');
  });
  it('honors completed historical state before validating missing canonical terms', async () => {
    const { client, query } = db(); query.mockReset(); query.mockResolvedValue({ rows: [{ state: 'completed', descriptor: {} }] });
    expect(await claimFanoutDelivery(client, identity(), { owner: 'repair', now: NOW, leaseMs: 1000, admission: vi.fn() })).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('queue repair follows actual worker position execution delivery lock order', () => {
  it('unlocked discovery precedes position/execution/delivery locks and permits a fake existing worker to settle first', async () => {
    const descriptor = recipient(USER).descriptor;
    const row = { state: 'pending', descriptor, job_id: recipient(USER).jobId, execution_id: EXECUTION,
      scope_chain: 'solana', scope_token_mint: TARGET };
    const execution = { id: EXECUTION, target_account: TARGET, chain: 'solana', token_mint: TARGET,
      user_id: USER, proven_non_submitted: true };
    let positionLocked = false, executionLocked = false, deliveryLocked = false, workerSettled = false;
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT delivery.*')) { expect(sql).not.toMatch(/FOR SHARE|FOR UPDATE/); return { rows: [row] }; }
      if (sql.startsWith('SELECT id, target_account') && !sql.includes('FOR UPDATE')) {
        expect(deliveryLocked).toBe(false); return { rows: [execution] };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        // Mock worker owns this position+execution and wants delivery. Producer
        // has not locked delivery, so worker settlement releases both first.
        expect(deliveryLocked).toBe(false); workerSettled = true; positionLocked = true;
        expect(values).toEqual([JSON.stringify([TARGET, 'solana', TARGET, USER])]); return { rows: [] };
      }
      if (sql.includes('FROM copy_executions') && sql.includes('FOR UPDATE')) {
        expect(positionLocked).toBe(true); expect(workerSettled).toBe(true); expect(deliveryLocked).toBe(false);
        executionLocked = true; return { rows: [execution] };
      }
      if (sql.startsWith('SELECT *') && sql.includes('FOR UPDATE')) {
        expect(positionLocked && executionLocked).toBe(true); deliveryLocked = true; return { rows: [row] };
      }
      if (sql.includes('RETURNING *, fence')) return { rows: [row] };
      return { rows: [{ fence: '9' }] };
    });
    const client = { query } as unknown as PoolClient;
    expect(await prepareFanoutDeliveryQueueWithClient(client, identity(), { now: NOW, admission: async locked => {
      expect(locked).toBe(client); expect(positionLocked && executionLocked && deliveryLocked).toBe(true);
      return { allowed: true }; } })).toBeTruthy();
    const sql = query.mock.calls.map(call => call[0]);
    expect(sql.findIndex(value => value.includes('pg_advisory_xact_lock'))).toBeLessThan(sql.findIndex(value => value.includes('FROM copy_executions') && value.includes('FOR UPDATE')));
    expect(sql.filter(value => value.includes('FROM copy_executions') && /FOR SHARE/.test(value))).toEqual([]);
  });
  it('rejects immutable descriptor drift after discovery before current admission or claim', async () => {
    const { client, query } = db();
    // Explicit protocol fixture; drift does not become a rebuilt comparison term.
    query.mockReset(); const row = { state: 'pending', descriptor: recipient(USER).descriptor,
      execution_id: EXECUTION, job_id: recipient(USER).jobId, scope_chain: 'solana', scope_token_mint: TARGET };
    for (const rows of [[row], [], [], [], [{ ...row, descriptor: { changed: true } }]]) query.mockResolvedValueOnce({ rows });
    const admission = vi.fn(); await expect(claimFanoutDelivery(client, identity(), { owner: 'repair', now: NOW,
      leaseMs: 1000, admission })).rejects.toThrow(/changed after discovery/);
    expect(admission).not.toHaveBeenCalled();
  });
});

describe('package13 tenant claim and truthful outcomes', () => {
  it('locks tenant/mode/target and passes the same PoolClient to current admission', async () => {
    const { client, query } = db([[{ state: 'queued', lease_until: null }], [], [{ fence: '7' }]], USER2);
    const admission = vi.fn().mockResolvedValue({ allowed: true });
    await expect(claimFanoutDelivery(client, identity(USER2), { owner: 'worker', now: NOW, leaseMs: 5000, admission })).resolves.toMatchObject({ userId: USER2, fence: '7' });
    expect(admission).toHaveBeenCalledWith(client);
    expect(query.mock.calls[4][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[0][1]).toEqual([SIGNAL, USER2, 'paper', TARGET]);
    expect(query.mock.calls[0][0]).not.toMatch(/FOR SHARE|FOR UPDATE/);
  });

  it('persists verifier/authority denial as blocked without fabricating confirmation', async () => {
    const { client, query } = db([[{ state: 'pending' }], []]);
    await expect(claimFanoutDelivery(client, identity(), { owner: 'worker', now: NOW, leaseMs: 5000, admission: async () => ({ allowed: false, reason: 'Source confirmation verifier unavailable' }) })).resolves.toBeNull();
    expect(query.mock.calls[5][0]).toContain("state = 'blocked'");
    expect(query.mock.calls[5][1]).toContain('Source confirmation verifier unavailable');
  });

  it('does not resend uncertain work when a claimed worker lease expires', async () => {
    const { client, query } = db([[{ state: 'claimed', lease_until: new Date(NOW.getTime() - 1) }]]);
    const admission = vi.fn();
    await expect(claimFanoutDelivery(client, identity(), { owner: 'worker2', now: NOW, leaseMs: 5000, admission })).resolves.toBeNull();
    expect(admission).not.toHaveBeenCalled();
    expect(query.mock.calls[5][0]).toContain("state = 'reconciliation_required'");
  });

  it('blocks a clean non-submitted skip with fenced ownership, without resolving delivery', async () => {
    const { client, query } = db([[], [{ signal_id: SIGNAL }]]);
    await expect(settleFanoutDelivery(client, claim, { outcome: 'blocked', reason: 'clean skip: no authority', now: NOW })).resolves.toBe(true);
    expect(query.mock.calls[1][0]).toContain('fence = $6::bigint');
    expect(query.mock.calls[1][0]).toContain('lease_until > $10');
    expect(query.mock.calls[1][1]).toContain('blocked');
  });

  it('refuses confirmation without matching confirmed canonical execution', async () => {
    const { client, query } = db([[{ state: 'submitted', submission_id: 'opaque' }]]);
    await expect(settleFanoutDelivery(client, claim, { outcome: 'completed', reason: 'queue done', now: NOW })).rejects.toThrow(/requires canonical/);
    await expect(settleFanoutDelivery(client, claim, { outcome: 'completed', executionId: EXECUTION, reason: 'queue done', now: NOW })).rejects.toThrow(/not confirmed/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('never releases an uncertain submitted execution as non-submitted blocked', async () => {
    const { client, query } = db([[{ state: 'failed', submission_id: 'opaque' }]]);
    await expect(settleFanoutDelivery(client, claim, { outcome: 'blocked', executionId: EXECUTION, reason: 'exhausted', now: NOW })).rejects.toThrow(/requires reconciliation/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('requires explicit classification for an existing execution even on a clean skip', async () => {
    const { client } = db([[{ id: EXECUTION }]]);
    await expect(settleFanoutDelivery(client, claim, { outcome: 'blocked', reason: 'skip', now: NOW })).rejects.toThrow(/classified/);
  });

  it('refuses a confirmed label without actual applied quantified evidence', async () => {
    const { client, query } = db([[{ state: 'confirmed', quantified_confirmed: false, submission_id: null }]]);
    await expect(settleFanoutDelivery(client, claim, { outcome: 'completed', executionId: EXECUTION, reason: 'status label', now: NOW })).rejects.toThrow(/quantified evidence/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('accepts matching quantified canonical completion only under the active fenced lease', async () => {
    const { client, query } = db([[{ state: 'confirmed', quantified_confirmed: true, submission_id: null }], [{ signal_id: SIGNAL }]]);
    await expect(settleFanoutDelivery(client, claim, { outcome: 'completed', executionId: EXECUTION, reason: 'applied evidence', now: NOW })).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain('copy_execution_evidence');
    expect(query.mock.calls[0][0]).toContain('copy_position_applications');
    expect(query.mock.calls[1][0]).toContain('lease_until > $10');
  });

  it('refuses another tenant execution in completion settlement', async () => {
    const { client, query } = db([[]]);
    await expect(settleFanoutDelivery(client, claim, { outcome: 'completed', executionId: EXECUTION, reason: 'settled', now: NOW })).rejects.toThrow(/identity mismatch/);
    expect(query.mock.calls[0][1]).toEqual([SIGNAL, USER, 'paper', TARGET, EXECUTION]);
  });
});
