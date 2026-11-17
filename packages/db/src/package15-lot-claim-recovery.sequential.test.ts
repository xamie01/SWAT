import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), capture: vi.fn() }));
vi.mock('./worker-policy.js', () => ({ captureWorkerPolicyWithClient: mocks.capture }));
vi.mock('./client.js', () => ({ query: mocks.query }));
vi.mock('./transaction.js', () => ({ withTransaction: mocks.transaction }));
// Complete inert shared facade: do not import the shared service/crypto barrel.
vi.mock('@swat/shared', () => ({
  canTransitionCopyExecution: vi.fn(), canTransitionSourceConfirmation: vi.fn(),
  isAppliedSourceConfirmation: (state: string) => ['confirmed', 'finalized'].includes(state),
  resolveChainAddress: (value: string, chain: string) => ({
    raw: value.startsWith(`${chain}:`) ? value.slice(chain.length + 1) : value,
    prefixed: value.startsWith(`${chain}:`) ? value : `${chain}:${value}`
  }), resolveChainValue: vi.fn()
}));
import { claimLotExitExecution, claimLotExitExecutionWithClient,
  claimSourceSignalForCopyExecution, requestCopyExecution } from './copy-trade-lifecycle.js';
import { getMasterSellAvailabilityWithClient } from './lot-allocation.js';

const lotId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';
const positionId = '33333333-3333-3333-3333-333333333333';
const exact = '9007199254740992.000000000000000001';
const owner = { position_id: positionId, target_account: 'solana:target', chain: 'solana',
  token_mint: 'solana:token', master_wallet_address: 'solana:master', signal_id: 'signal', execution_mode: 'live' };
const input = { lotId, userId, requestId: 'recovery', trigger: 'stop-loss' as const, requestedBaseQuantity: exact };
const scope = [owner.target_account, owner.chain, owner.token_mint, userId];
function execution(overrides: Record<string, unknown> = {}) {
  return { id: 'execution', signal_id: owner.signal_id, source_trade_id: null, exit_lot_id: lotId,
    exit_trigger: input.trigger, chain: owner.chain, target_account: owner.target_account, user_id: userId,
    token_mint: owner.token_mint, direction: 'sell', execution_mode: owner.execution_mode,
    client_order_id: 'swat-fixture', state: 'requested', requested_base_quantity: exact,
    requested_quote_quantity: null, confirmed_base_quantity: '0', confirmed_quote_quantity: '0',
    reserved_base_quantity: exact, source_position_before_quantity: null, source_sell_fraction: null,
    submission_attempts: 0, max_submission_attempts: 3, reconciliation_attempts: 0,
    max_reconciliation_attempts: 10, simulation_id: null, submission_type: null, submission_id: null,
    next_reconciliation_at: null, reconciliation_claim_id: null, quote_unassessed_fill_count: 0,
    payload_matches: true, ...overrides };
}
// Independent retained-row faults. This mock is clause-sensitive so the fresh
// regression shows omitted SQL proof, not just a preprogrammed rejection. It is
// deliberately not a SQL engine or PostgreSQL/concurrency acceptance fixture.
const acquisitionFaults = {
  missingEvidence: 'evidence.id = lot.acquisition_evidence_id',
  wrongEvidenceExecution: 'evidence.execution_id = acquisition.id',
  observedEvidence: "evidence.confirmation_state IN ('confirmed', 'finalized')",
  reversedEvidence: "evidence.confirmation_state IN ('confirmed', 'finalized')",
  missingApplication: 'application.evidence_id = evidence.id',
  wrongApplicationEvidence: 'application.evidence_id = evidence.id',
  wrongApplicationExecution: 'application.execution_id = acquisition.id',
  inactiveApplication: 'application.active',
  wrongApplicationPosition: 'application.position_id = lot.position_id',
  wrongApplicationTenant: 'application.user_id IS NOT DISTINCT FROM lot.user_id',
  wrongApplicationAccount: 'application.target_account = acquisition.target_account',
  wrongApplicationChain: 'application.chain = lot.chain',
  wrongApplicationToken: 'application.token_mint = lot.token_mint'
} as const;
type AcquisitionFault = keyof typeof acquisitionFaults;
function fixture(options: { quantity?: string | null; reason?: string; existing?: Record<string, unknown>;
  missingOwner?: boolean; missingPosition?: boolean; missingHeld?: boolean; missingDecision?: boolean; insertError?: boolean;
  acquisitionFault?: AcquisitionFault; faultAt?: 'all' | 'locked' | 'replay'; appliedState?: 'confirmed' | 'finalized' } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = { query: vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    const faultRejected = options.acquisitionFault !== undefined && sql.includes(acquisitionFaults[options.acquisitionFault]);
    const rejection = { quantity: null, reason: 'Master lot acquisition provenance is unavailable' };
    if (sql.includes('WITH lots AS')) return { rows: options.missingDecision ? [] : [
      faultRejected ? rejection : {
        quantity: options.quantity === undefined ? exact : options.quantity, reason: options.reason ?? null }] };
    if (sql.includes('SELECT lot.position_id')) {
      const checkHere = options.faultAt !== 'replay' && (options.faultAt !== 'locked' || sql.includes('FOR UPDATE OF lot'));
      return { rows: options.missingOwner || (checkHere && faultRejected) ? [] : [{ ...owner }] };
    }
    if (sql.includes('SELECT lot.id')) return { rows: options.missingHeld ? [] : [{ id: lotId }] };
    if (sql.includes('INSERT INTO copy_executions')) {
      if (options.insertError) throw new Error('fixture insert refused');
      return { rows: [execution({ user_id: values[5], requested_base_quantity: values[9], reserved_base_quantity: values[9] })] };
    }
    if (sql.includes('FROM copy_executions') && !sql.includes('WITH RECURSIVE')) return {
      rows: options.existing && !faultRejected ? [options.existing] : []
    };
    // Legacy unsafe lot-only availability deliberately says yes: fresh red must
    // show the real lifecycle ignored the master-scoped decision.
    if (sql.includes('AS available')) return { rows: [{ quantity: exact, available: true }] };
    if (sql.includes('WITH RECURSIVE')) return { rows: [{ id: positionId, ...owner,
      confirmed_quantity: exact, reserved_sell_quantity: exact, cost_basis_usd: '1' }] };
    if (sql.includes('FROM copy_positions')) return { rows: options.missingPosition ? [] : [{ id: positionId }] };
    if (sql.includes('FROM signals')) return { rows: [{ id: 'signal', status: 'eligible', source_trade_id: 'source', source_side: 'sell' }] };
    if (sql.includes('FROM source_trades')) return { rows: [{ id: 'source', ...owner,
      wallet_address: owner.master_wallet_address, direction: 'sell', confirmation_state: 'confirmed' }] };
    return { rows: [] };
  }) };
  mocks.transaction.mockImplementation(async operation => operation(client));
  return { client: client as unknown as PoolClient, calls };
}
const reservations = (calls: Array<{ sql: string; values: unknown[] }>) => calls.filter(({ sql }) => sql.includes('INSERT INTO copy_executions'));
beforeEach(() => { vi.resetAllMocks(); });

describe('package15 actual lifecycle lot claim recovery (no database)', () => {
  it.each(['No attributable open master lot inventory', 'Overlapping source or explicit master exit is reserved',
    'Incompatible acquisition mode blocks reservation', 'Unattributed pending sell blocks reservation',
    'Exact lot exit exceeds unreserved lot inventory'])('refuses %s before insertion', async reason => {
    const { client, calls } = fixture({ quantity: null, reason });
    await expect(claimLotExitExecutionWithClient(client, input)).rejects.toThrow(reason);
    expect(reservations(calls)).toEqual([]);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('uses the same caller client, scope lock and exact authoritative quantity before reservation/history/rebuild', async () => {
    const { client, calls } = fixture();
    expect(await claimLotExitExecutionWithClient(client, input)).toMatchObject({ created: true,
      execution: { requestedBaseQuantity: exact, reservedBaseQuantity: exact, executionMode: 'live' } });
    const availability = calls.findIndex(({ sql }) => sql.includes('WITH lots AS'));
    expect(availability).toBeGreaterThan(0);
    expect(availability).toBeLessThan(calls.findIndex(({ sql }) => sql.includes('INSERT INTO copy_executions')));
    expect(calls.filter(({ sql }) => sql.includes('pg_advisory_xact_lock')).map(({ values }) => values)).toEqual(
      [ [JSON.stringify(scope)], [JSON.stringify(scope)] ]);
    expect(calls.slice(0, availability).some(({ sql }) => /copy_positions[\s\S]*FOR UPDATE/.test(sql))).toBe(true);
    expect(calls.slice(0, availability).some(({ sql }) => sql.includes('FOR UPDATE OF lot'))).toBe(true);
    expect(reservations(calls)[0]?.sql).toContain('$10::numeric, $10::numeric');
    expect(reservations(calls)[0]?.values[9]).toBe(exact);
    expect(calls.some(({ sql }) => /^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql))).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('operator null remains a real scoped tenant, not a fallback account', async () => {
    const { client, calls } = fixture();
    expect(await claimLotExitExecutionWithClient(client, { ...input, userId: null }))
      .toMatchObject({ execution: { userId: null }, created: true });
    expect(calls.filter(({ sql }) => sql.includes('pg_advisory_xact_lock')).map(({ values }) => values))
      .toEqual([[JSON.stringify([...scope.slice(0, 3), null])], [JSON.stringify([...scope.slice(0, 3), null])]]);
    expect(calls.find(({ sql }) => sql.includes('WITH lots AS'))?.values[3]).toBeNull();
  });
  it('wrapper composes the actual function into one mocked transaction', async () => {
    const { calls } = fixture();
    expect(await claimLotExitExecution(input)).toMatchObject({ created: true });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(reservations(calls)).toHaveLength(1);
  });
  it('rejects unequal exact replay quantities which collide as Number', async () => {
    const { client, calls } = fixture({ existing: execution({ requested_base_quantity: '9007199254740992.000000000000000002', payload_matches: false }) });
    await expect(claimLotExitExecutionWithClient(client, input)).rejects.toThrow(/identity collision/);
    expect(reservations(calls)).toEqual([]);
  });
  it('replays numerically equal DB-proved quantities without a second reservation or availability self-conflict', async () => {
    const { client, calls } = fixture({ existing: execution({ requested_base_quantity: `${exact}0` }) });
    expect(await claimLotExitExecutionWithClient(client, input)).toMatchObject({ created: false });
    const replay = calls.find(({ sql }) => sql.includes('AS payload_matches'));
    expect(replay?.sql).toContain('JOIN copy_position_master_lots');
    expect(replay?.sql).toContain('JOIN copy_positions');
    expect(replay?.sql).toContain('JOIN copy_executions acquisition');
    expect(replay?.sql).toContain('JOIN source_trades');
    expect(replay?.sql).toContain('requested_base_quantity = $4::numeric');
    expect(replay?.sql).toContain('acquisition.execution_mode');
    expect(replay?.sql).toContain('master_wallet_address');
    expect(replay?.sql).toContain('FOR UPDATE OF execution');
    expect(reservations(calls)).toEqual([]);
    expect(calls.some(({ sql }) => sql.includes('WITH lots AS'))).toBe(false);
  });
  it.each(['user_id', 'target_account', 'chain', 'token_mint', 'execution_mode', 'signal_id',
    'direction', 'source_trade_id', 'source_sell_fraction', 'source_position_before_quantity'])('refuses replay with DB-mismatched %s', async key => {
    const { client, calls } = fixture({ existing: execution({ [key]: 'wrong', payload_matches: false }) });
    await expect(claimLotExitExecutionWithClient(client, input)).rejects.toThrow(/identity collision/);
    expect(reservations(calls)).toEqual([]);
  });
  it.each([{ missingOwner: true }, { missingPosition: true }, { missingHeld: true }, { missingDecision: true }])(
    'refuses missing trusted data %j', async options => {
      const { client, calls } = fixture(options);
      await expect(claimLotExitExecutionWithClient(client, input)).rejects.toThrow();
      expect(reservations(calls)).toEqual([]);
    });
  it('keeps implicit full-lot claims exact and DB-sized', async () => {
    const { client, calls } = fixture({ quantity: '0.00000000000000000000000001' });
    expect(await claimLotExitExecutionWithClient(client, { ...input, requestedBaseQuantity: undefined }))
      .toMatchObject({ execution: { requestedBaseQuantity: '0.00000000000000000000000001' } });
    const decision = calls.find(({ sql }) => sql.includes('WITH lots AS'));
    expect(decision?.values.slice(0, 6)).toEqual([...scope, owner.master_wallet_address, 'live']);
    expect(decision?.values[6]).toBeNull();
    expect(decision?.values[8]).toBe(lotId);
  });
  it('refuses numeric authority quantities before any client query', async () => {
    const { client, calls } = fixture();
    await expect(claimLotExitExecutionWithClient(client, { ...input, requestedBaseQuantity: 1 })).rejects.toThrow(/exact decimal/);
    expect(calls).toEqual([]);
  });
  it('propagates failed insert without history/rebuild or a claimed result', async () => {
    const { client, calls } = fixture({ insertError: true });
    await expect(claimLotExitExecutionWithClient(client, input)).rejects.toThrow('fixture insert refused');
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO copy_execution_state_history'))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes('WITH RECURSIVE'))).toBe(false);
  });
});

describe('package15 acquisition evidence/application proof (mocked SQL boundaries)', () => {
  it.each(Object.keys(acquisitionFaults) as AcquisitionFault[])('availability refuses retained lot with %s', async acquisitionFault => {
    const { client, calls } = fixture({ acquisitionFault });
    expect(await getMasterSellAvailabilityWithClient(client, { targetAccount: owner.target_account,
      userId, chain: 'solana', tokenMint: owner.token_mint, masterWalletAddress: owner.master_wallet_address,
      executionMode: 'live', requestedBaseQuantity: exact })).toEqual({ quantity: null,
        reason: 'Master lot acquisition provenance is unavailable' });
    expect(reservations(calls)).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each(Object.keys(acquisitionFaults) as AcquisitionFault[])('new explicit claim refuses %s before reservation/history', async acquisitionFault => {
    const { client, calls } = fixture({ acquisitionFault });
    await expect(claimLotExitExecutionWithClient(client, input)).rejects.toThrow();
    expect(reservations(calls)).toEqual([]);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO copy_execution_state_history'))).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(Object.keys(acquisitionFaults) as AcquisitionFault[])('explicit replay refuses %s without returning old claim', async acquisitionFault => {
    const { client, calls } = fixture({ acquisitionFault, existing: execution() });
    await expect(claimLotExitExecutionWithClient(client, input)).rejects.toThrow();
    expect(reservations(calls)).toEqual([]);
    expect(calls.some(({ sql }) => sql.includes('WITH RECURSIVE'))).toBe(false);
  });
  it('reload refuses reversal after lock-key discovery before replay lookup', async () => {
    const { client, calls } = fixture({ acquisitionFault: 'reversedEvidence', faultAt: 'locked', existing: execution() });
    await expect(claimLotExitExecutionWithClient(client, input)).rejects.toThrow(/scope changed/);
    expect(calls.filter(({ sql }) => sql.includes('SELECT lot.position_id'))).toHaveLength(2);
    expect(calls.some(({ sql }) => sql.includes('AS payload_matches'))).toBe(false);
    expect(reservations(calls)).toEqual([]);
  });
  it('replay query independently proves the evidence/application association', async () => {
    const { client, calls } = fixture({ existing: execution() });
    expect(await claimLotExitExecutionWithClient(client, input)).toMatchObject({ created: false });
    const proofQueries = calls.filter(({ sql }) => sql.includes('SELECT lot.position_id') || sql.includes('AS payload_matches'));
    expect(proofQueries).toHaveLength(3);
    for (const { sql } of proofQueries) {
      for (const clause of new Set(Object.values(acquisitionFaults))) expect(sql).toContain(clause);
      expect(sql).toContain('JOIN copy_execution_evidence evidence');
      expect(sql).toContain('JOIN copy_position_applications application');
    }
    const locked = proofQueries.find(({ sql }) => sql.includes('FOR UPDATE OF lot'))!.sql;
    expect(locked).toContain('FOR SHARE OF acquisition, source, evidence, application');
    expect(reservations(calls)).toEqual([]);
  });
  it('availability requires evidence and active application in its trusted decision, not only valid acquisitions', async () => {
    const { client, calls } = fixture();
    await getMasterSellAvailabilityWithClient(client, { targetAccount: owner.target_account, userId,
      chain: 'solana', tokenMint: owner.token_mint, masterWalletAddress: owner.master_wallet_address,
      executionMode: 'live', requestedBaseQuantity: exact });
    const sql = calls.find(({ sql }) => sql.includes('WITH lots AS'))!.sql;
    for (const clause of new Set(Object.values(acquisitionFaults))) expect(sql).toContain(clause);
    expect(sql).toContain('evidence.id IS NOT NULL AND application.evidence_id IS NOT NULL');
  });
});

describe('package15 availability generated SQL and retained source refusal', () => {
  it('requires DB-attributed lots, exact numeric pending subtraction, trusted modes and overlap fences', async () => {
    const { client, calls } = fixture();
    expect(await getMasterSellAvailabilityWithClient(client, { targetAccount: owner.target_account,
      userId, chain: 'solana', tokenMint: owner.token_mint, masterWalletAddress: owner.master_wallet_address,
      executionMode: 'live', requestedBaseQuantity: exact })).toEqual({ quantity: exact, reason: null });
    const sql = calls.find(({ sql }) => sql.includes('WITH lots AS'))!.sql;
    for (const text of ['owned - master_pending', 'SUM(reserved_base_quantity)', 'aggregate_available',
      'mixed_pending', 'mixed_lots', 'overlapping_exit', 'unscoped_pending', 'untrusted_lots',
      'acquisition.execution_mode', 'JOIN source_trades', 'execution.user_id IS NOT DISTINCT FROM $4']) expect(sql).toContain(text);
    expect(sql).not.toContain('ELSE $4::numeric');
    expect(sql).not.toContain('COALESCE(exit_lot.master_wallet_address, source.wallet_address)');
  });
  it('permits implicit quantity only for an identified explicit lot', async () => {
    const { client } = fixture();
    expect(await getMasterSellAvailabilityWithClient(client, { targetAccount: owner.target_account,
      userId, chain: 'solana', tokenMint: owner.token_mint, masterWalletAddress: owner.master_wallet_address,
      executionMode: 'live', exitLotId: lotId })).toEqual({ quantity: exact, reason: null });
  });
  it('source direct request cannot bypass unavailable current verifier', async () => {
    const { calls } = fixture();
    await expect(requestCopyExecution({ sourceTradeId: 'source', targetAccount: owner.target_account,
      userId, executionMode: 'live', requestedBaseQuantity: exact })).rejects.toThrow(/verifier is unavailable/);
    expect(reservations(calls)).toEqual([]);
  });
  it('source signal claim cannot bypass unavailable current verifier', async () => {
    const { calls } = fixture();
    expect(await claimSourceSignalForCopyExecution({ signalId: 'signal', targetAccount: owner.target_account,
      userId, executionMode: 'live', maxPositionEvidenceAgeMs: 1000 })).toMatchObject({ execution: null,
      created: false, claimed: false, reason: 'Source confirmation verifier is unavailable' });
    expect(reservations(calls)).toEqual([]);
  });
  it('wires both source reservation branches to actual caller-client availability without aggregate/Number fallback (structural only behind verifier)', () => {
    const source = readFileSync(new URL('./copy-trade-lifecycle.ts', import.meta.url), 'utf8');
    for (const [start, end] of [['export async function requestCopyExecution', 'export interface LotExitExecutionInput'],
      ['export async function claimSourceSignalForCopyExecution', 'export async function transitionCopyExecution']]) {
      const body = source.slice(source.indexOf(start), source.indexOf(end));
      expect(body).toContain('await getMasterSellAvailabilityWithClient(client,');
      expect(body).toContain('masterWalletAddress: source.wallet_address');
      expect(body).not.toContain('master_lots AS');
      expect(body).not.toContain('Number(executionBase)');
      expect(body).toContain('assertExactExitQuantity(input.requestedBaseQuantity)');
    }
  });
});
