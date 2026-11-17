import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn(), capture: vi.fn(),
  persistAllocation: vi.fn(), readAllocation: vi.fn(), availability: vi.fn() }));
vi.mock('./client.js', () => ({ query: mocks.query }));
vi.mock('./transaction.js', () => ({ withTransaction: mocks.transaction }));
vi.mock('./worker-policy.js', () => ({ captureWorkerPolicyWithClient: mocks.capture }));
vi.mock('./source-sell-lot-allocation.js', () => ({ persistSourceSellLotAllocationWithClient: mocks.persistAllocation,
  readSourceSellLotProofWithClient: mocks.readAllocation }));
vi.mock('./lot-allocation.js', () => ({ assertExactExitQuantity: (value: unknown) => {
  if (typeof value !== 'string') throw new Error('Exact quantity string required');
}, getMasterSellAvailabilityWithClient: mocks.availability }));
vi.mock('@swat/shared', () => ({
  resolveChainAddress: (value: string, chain: string) => ({ raw: value.replace(`${chain}:`, ''), prefixed: value.startsWith(`${chain}:`) ? value : `${chain}:${value}` }),
  resolveChainValue: (value: string, chain: string) => ({ raw: value.replace(`${chain}:`, ''), prefixed: value.startsWith(`${chain}:`) ? value : `${chain}:${value}` }),
  isAppliedSourceConfirmation: (state: string) => ['confirmed','finalized'].includes(state),
  canTransitionSourceConfirmation: () => true, canTransitionCopyExecution: () => true
}));
import { claimSourceSignalForCopyExecution, claimSourceSignalForCopyExecutionWithClient,
  getSourceConfirmationReadiness, listSourceTradeSignalCandidates } from './copy-trade-lifecycle.js';
import { readWorkerExecutionContextWithClient } from './worker-execution.js';
const userId = '11111111-1111-1111-1111-111111111111';
const input = { signalId: 'signal', targetAccount: 'target', userId, executionMode: 'paper' as const,
  requestedBaseQuantity: '1.000000000000000001', maxPositionEvidenceAgeMs: 60_000,
  now: new Date('2026-11-17T00:01:00.000Z') };
const source = { id: 'source', chain: 'solana', source_event_type: 'transaction', source_event_id: 'tx',
  source_event_index: 'wallet', transaction_hash: 'tx', wallet_address: 'solana:master', token_mint: 'solana:token',
  direction: 'buy', quantity: '1', amount_usd: '1', price_usd: null, fee_usd: null,
  event_at: input.now, observed_at: input.now, confirmation_state: 'confirmed' };
function execution(overrides: Record<string, unknown> = {}) { return { id: 'execution', signal_id: 'signal', source_trade_id: 'source',
  chain: 'solana', target_account: 'solana:target', user_id: userId, token_mint: 'solana:token', direction: 'buy',
  execution_mode: 'paper', client_order_id: 'inert', state: 'requested', requested_base_quantity: input.requestedBaseQuantity,
  requested_quote_quantity: null, confirmed_base_quantity: '0', confirmed_quote_quantity: '0', reserved_base_quantity: '0',
  submission_attempts: 0, max_submission_attempts: 3, reconciliation_attempts: 0, max_reconciliation_attempts: 10,
  simulation_id: null, submission_type: null, submission_id: null, next_reconciliation_at: null,
  reconciliation_claim_id: null, source_position_before_quantity: null, source_sell_fraction: null, ...overrides }; }
function fixture(options: { accepted?: boolean; existing?: Record<string, unknown>; status?: string; expired?: boolean;
  direction?: string; insertFailure?: boolean; replayMatches?: boolean; changedSignal?: boolean; changedSource?: boolean; sellEvidence?: boolean } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = { query: vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('AS accepted')) return { rows: [{ accepted: options.accepted !== false }] };
    if (sql.includes('source_is_active')) return { rows: [{ before_quantity: '10', source_quantity_fits: true,
      sell_fraction: '0.1', position_evidence_at: input.now, last_event_at: input.now, source_is_active: true }] };
    if (sql.includes('AND $3::numeric = $4::numeric AS matches')) return { rows: [{ matches: true }] };
    if (sql.includes('WITH RECURSIVE')) return { rows: [{ id: 'position', confirmed_quantity: '2', cost_basis_usd: '1' }] };
    if (sql.includes('FROM signals')) return { rows: [{ id: 'signal', status: options.status ?? 'eligible',
      source_trade_id: options.changedSignal && sql.includes('FOR UPDATE') ? 'different' : 'source',
      source_position_before_quantity: options.sellEvidence ? '10' : null,
      source_sell_fraction: options.sellEvidence ? '0.1' : null, source_position_evidence_at: options.sellEvidence ? input.now : null,
      source_side: options.direction ?? 'buy', expires_at: options.expired ? input.now : null }] };
    if (sql.includes('FROM source_trades')) return { rows: [{ ...source, direction: options.direction ?? 'buy',
      token_mint: options.changedSource && sql.includes('FOR SHARE') ? 'solana:different' : source.token_mint }] };
    if (sql.includes('FROM copy_executions') && sql.includes('AS matches')) return { rows: [{ matches: options.replayMatches !== false }] };
    if (sql.includes('FROM copy_executions') && sql.includes('AS exists')) return { rows: [{ exists: true }] };
    if (sql.includes('FROM copy_executions')) return { rows: options.existing ? [options.existing] : [] };
    if (sql.includes('FROM copy_positions')) return { rows: [{ id: 'position' }] };
    if (sql.includes('INSERT INTO copy_executions')) {
      if (options.insertFailure) throw new Error('inert insertion failure'); return { rows: [execution({ direction: options.direction ?? 'buy',
        source_position_before_quantity: options.sellEvidence ? '10' : null, source_sell_fraction: options.sellEvidence ? '0.1' : null })], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }) };
  mocks.transaction.mockImplementation(async operation => operation(client));
  return { client: client as unknown as PoolClient, calls };
}
beforeEach(() => vi.resetAllMocks());
describe('actual same-client source claim for atomic fanout (no DB/runtime approval)', () => {
  it('writes claim/history/captured policy on caller client without own transaction/global query', async () => {
    const f = fixture(); expect(await claimSourceSignalForCopyExecutionWithClient(f.client, input)).toMatchObject({ created: true, claimed: true });
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledWith(f.client, expect.objectContaining({ userId, sourceTradeId: 'source' }), 'solana:master');
    const insert = f.calls.find(({sql}) => sql.includes('INSERT INTO copy_executions'))!;
    expect(insert.values[8]).toBe(input.requestedBaseQuantity); expect(insert.values[14]).toBe(userId);
    expect(f.calls.some(({sql}) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql))).toBe(false);
    expect(f.calls.findIndex(({sql}) => sql.includes('AS accepted'))).toBeLessThan(f.calls.indexOf(insert));
  });
  it('discovers without row locks, then position advisory precedes every signal/source/execution lock', async () => {
    const f = fixture(); await claimSourceSignalForCopyExecutionWithClient(f.client, input);
    const advisory = f.calls.findIndex(({sql}) => sql.includes('pg_advisory_xact_lock'));
    expect(advisory).toBe(2);
    expect(f.calls.slice(0, advisory).every(({sql}) => !/FOR (?:UPDATE|SHARE)/.test(sql))).toBe(true);
    const locked = f.calls.flatMap(({sql}, index) => /FOR (?:UPDATE|SHARE)/.test(sql) ? [index] : []);
    expect(locked.every(index => index > advisory)).toBe(true);
    expect(f.calls[advisory]?.values).toEqual([JSON.stringify(['solana:target','solana','solana:token',userId])]);
  });
  it.each([{ changedSignal: true }, { changedSource: true }])('revalidates discovered scope before execution mutation %j', async options => {
    const f = fixture(options);
    await expect(claimSourceSignalForCopyExecutionWithClient(f.client, input)).rejects.toThrow(/scope changed after lock discovery/);
    expect(f.calls.some(({sql}) => sql.includes('FROM copy_executions'))).toBe(false);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('filters accepted authority/application before LIMIT so more than 100 revoked events cannot starve valid source', async () => {
    const early = Array.from({ length: 125 }, (_, index) => ({ ...source, id: `revoked-${index}`, revoked: true, wallet_score: '99', wallet_tier: null }));
    const valid = { ...source, id: 'accepted-later', revoked: false, wallet_score: '99', wallet_tier: null };
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('AS accepted')) return { rows: values[0] === valid.id ? [{ accepted: true }] : [] };
      const beforeLimit = sql.slice(0, sql.indexOf('LIMIT $4'));
      const filters = ['authority.enabled','authority.valid_until > $2','evidence.provider_valid_until > $2',
        'application.active','evidence.binding_digest = binding.binding_digest'];
      const acceptedBeforeLimit = filters.every(filter => beforeLimit.includes(filter));
      return { rows: (acceptedBeforeLimit ? [valid] : [...early, valid]).slice(0, values[3] as number) };
    });
    mocks.transaction.mockImplementation(async operation => operation({ query }));
    const result = await listSourceTradeSignalCandidates({ maxEventAgeMs: 60_000, limit: 100, now: input.now });
    expect(result.map(item => item.sourceTradeId)).toEqual([valid.id]);
    expect(query.mock.calls[0]?.[1]).toEqual([60_000, input.now, null, 100]);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('legacy wrapper invokes exactly one transaction', async () => {
    fixture(); await claimSourceSignalForCopyExecution(input); expect(mocks.transaction).toHaveBeenCalledOnce();
  });
  it('no default verifier readiness or caller labels authorize historical source/replay', async () => {
    const f = fixture({ accepted: false, existing: execution() });
    expect(await claimSourceSignalForCopyExecutionWithClient(f.client, input)).toMatchObject({ execution: null, created: false, claimed: false });
    expect(f.calls.some(({sql}) => sql.includes('FROM copy_executions'))).toBe(false);
    expect(mocks.capture).not.toHaveBeenCalled(); expect(getSourceConfirmationReadiness().ready).toBe(false);
  });
  it('tenant replay returns persisted identity without duplicate policy capture/insertion', async () => {
    const f = fixture({ existing: execution(), status: 'executing' });
    expect(await claimSourceSignalForCopyExecutionWithClient(f.client, input)).toMatchObject({ created: false, claimed: false });
    expect(f.calls.find(({sql}) => sql.includes('user_id IS NOT DISTINCT FROM'))?.values[3]).toBe(userId);
    expect(f.calls.some(({sql}) => sql.includes('INSERT INTO copy_executions'))).toBe(false);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it.each(['user_id','token_mint','direction','chain','execution_mode','target_account','signal_id'])(
    'rejects replay wrong immutable %s', async key => {
      const f = fixture({ existing: execution({ [key]: 'wrong' }) });
      await expect(claimSourceSignalForCopyExecutionWithClient(f.client, input)).rejects.toThrow(/identity collision/);
      expect(mocks.capture).not.toHaveBeenCalled();
    });
  it('rejects exact quantity collision and terminal replay', async () => {
    const f = fixture({ existing: execution(), replayMatches: false });
    await expect(claimSourceSignalForCopyExecutionWithClient(f.client, input)).rejects.toThrow(/quantity identity/);
    const terminal = fixture({ existing: execution({ state: 'confirmed' }) });
    expect(await claimSourceSignalForCopyExecutionWithClient(terminal.client, input)).toMatchObject({ execution: null, reason: 'Source execution is confirmed' });
  });
  it.each([{ status: 'rejected' }, { expired: true }])('withholds ineligible/expired claim %j', async options => {
    const f = fixture(options); expect(await claimSourceSignalForCopyExecutionWithClient(f.client, input)).toMatchObject({ execution: null });
    expect(f.calls.some(({sql}) => sql.includes('INSERT INTO copy_executions'))).toBe(false);
  });
  it('resumable shared signal accepts a different tenant without borrowing their execution', async () => {
    const f = fixture({ status: 'executing' });
    expect(await claimSourceSignalForCopyExecutionWithClient(f.client, input)).toMatchObject({ created: true, claimed: false });
    expect(f.calls.find(({sql}) => sql.includes('AS exists'))?.values).toEqual(['signal']);
  });
  it('source sell claim persists DB-master-derived allocation after capture on same client before returning', async () => {
    const f = fixture({ direction: 'sell', sellEvidence: true });
    mocks.availability.mockResolvedValue({ quantity: input.requestedBaseQuantity });
    mocks.persistAllocation.mockResolvedValue({ executionId: 'execution', lots: [{ lotId: 'reserved' }] });
    expect(await claimSourceSignalForCopyExecutionWithClient(f.client, input)).toMatchObject({ created: true });
    expect(mocks.persistAllocation).toHaveBeenCalledWith(f.client, expect.objectContaining({ direction: 'sell',
      requestedBaseQuantity: input.requestedBaseQuantity }), 'solana:master');
    expect(mocks.capture.mock.invocationCallOrder[0]).toBeLessThan(mocks.persistAllocation.mock.invocationCallOrder[0]!);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('source sell missing allocation causes claim failure rather than a returned descriptor', async () => {
    const f = fixture({ direction: 'sell', sellEvidence: true });
    mocks.availability.mockResolvedValue({ quantity: input.requestedBaseQuantity });
    mocks.persistAllocation.mockResolvedValue(null);
    await expect(claimSourceSignalForCopyExecutionWithClient(f.client, input)).rejects.toThrow(/persist exact reserved/);
  });
  it('source sell replay requires existing proof without post-effect backfill', async () => {
    const f = fixture({ direction: 'sell', existing: execution({ direction: 'sell', state: 'partially_filled' }) });
    mocks.readAllocation.mockResolvedValue(null);
    await expect(claimSourceSignalForCopyExecutionWithClient(f.client, input)).rejects.toThrow(/replay requires/);
    expect(mocks.persistAllocation).not.toHaveBeenCalled();
  });
  it('sell without captured position evidence refuses before inventory reservation', async () => {
    const f = fixture({ direction: 'sell' });
    await expect(claimSourceSignalForCopyExecutionWithClient(f.client, input)).rejects.toThrow(/missing position evidence/);
    expect(f.calls.some(({sql}) => sql.includes('INSERT INTO copy_executions'))).toBe(false);
  });
  it('actual worker context rechecks current accepted source and withholds reorg after admission', async () => {
    let accepted = true;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS accepted')) return { rows: accepted ? [{ accepted: true }] : [] };
      if (sql.includes('SELECT source.wallet_address')) return { rows: [{ wallet_address: 'solana:master' }] };
      if (sql.includes('FROM copy_executions')) return { rows: [execution()] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    expect(await readWorkerExecutionContextWithClient(client, 'execution')).toMatchObject({ masterWalletAddress: 'solana:master' });
    accepted = false;
    expect(await readWorkerExecutionContextWithClient(client, 'execution')).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('storage/capture errors propagate instead of returning committed descriptor authority', async () => {
    const f = fixture({ insertFailure: true });
    await expect(claimSourceSignalForCopyExecutionWithClient(f.client, input)).rejects.toThrow(/insertion failure/);
    expect(mocks.capture).not.toHaveBeenCalled();
    const capture = fixture(); mocks.capture.mockRejectedValueOnce(new Error('inert policy failure'));
    await expect(claimSourceSignalForCopyExecutionWithClient(capture.client, input)).rejects.toThrow(/policy failure/);
  });
});
