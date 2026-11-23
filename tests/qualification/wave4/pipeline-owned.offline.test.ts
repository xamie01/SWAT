import type { PoolClient } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import { describe, expect, it, vi } from 'vitest';
import { advanceSourceTradeConfirmation, buildCopyExecutionClientOrderId, claimSourceSignalForCopyExecutionWithClient,
  insertSourceTradeSignalWithClient, listSourceTradeSignalCandidatesWithClient, prepareRecordSourceTradeEvent,
  prepareInsertSourceTradeSignal,
  recordSourceTradeEventWithClient, verifySourceTradeWithClient, type SourceTradeEventInput
} from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import { sourceBindingDigest, sourceContentDigest, type SourceVerificationBinding,
  type SourceVerificationEvidence, type TrustedSourceVerifier } from '../../../packages/db/src/source-verification.js';
import { createOwnedObligationScopedTransaction } from '../../../packages/db/src/obligation-runtime-owned.js';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const SIGNAL = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const EXECUTION = '44444444-4444-4444-8444-444444444444';
const WALLET = 'solana:11111111111111111111111111111111';
const TOKEN = 'solana:11111111111111111111111111111112';
const now = new Date('2026-11-18T00:00:01.000Z');
const binding: SourceVerificationBinding = { chain: 'solana', network: 'offline-not-runtime-authority',
  sourceEventType: 'transaction', sourceEventId: 'inert-transaction', sourceEventIndex: '0', transactionHash: 'inert-transaction',
  walletAddress: WALLET, tokenMint: TOKEN, side: 'buy', rawQuantity: '9007199254740993000000000000000001', quantityScale: 18,
  eventAt: '2026-11-18T00:00:00.000Z', amountUsd: '20', priceUsd: null, feeUsd: '0' };
const observation: SourceTradeEventInput = { chain: binding.chain, sourceEventType: binding.sourceEventType,
  sourceEventId: binding.sourceEventId, transactionHash: binding.transactionHash, walletAddress: WALLET, tokenMint: TOKEN,
  side: 'buy', quantity: '9007199254740993.000000000000000001', amountUsd: '20', feeUsd: '0',
  eventAt: new Date(binding.eventAt), observedAt: now, confirmationState: 'observed', confirmationEvidenceId: 'inert-provenance',
  verificationBinding: binding };
const evidence: SourceVerificationEvidence = { evidenceId: 'inert-evidence', binding, finality: 'confirmed', blockHash: 'inert-block',
  blockHeight: '1', revision: '1', reversesEvidenceId: null, observedAt: now.toISOString(),
  provenance: { providerId: 'inert-provider', authorityId: 'inert-authority', verifierVersion: 'inert-v1', receiptId: 'inert-receipt' },
  content: 'inert-receipt', contentDigest: sourceContentDigest('inert-receipt') };
const provider = { providerId: 'inert-provider', authorityId: 'inert-authority', chain: binding.chain,
  network: binding.network, verifierVersion: 'inert-v1', identityDigest: 'a'.repeat(64), validUntil: '2026-11-18T00:01:00.000Z' };
const claimInput = { signalId: SIGNAL, targetAccount: WALLET, userId: USER, executionMode: 'paper' as const,
  requestedBaseQuantity: '1.5', requestedQuoteQuantity: '20', maxPositionEvidenceAgeMs: 1000, now };

/** Inert SQL replies exercise actual production bodies. This is NOT PostgreSQL,
 * RLS, concurrent lock, full buy/sell/correction scenario or provider acceptance. */
function fixture() {
  const source = { id: SOURCE, chain: binding.chain, source_event_type: binding.sourceEventType,
    source_event_id: binding.sourceEventId, source_event_index: '0', transaction_hash: binding.transactionHash,
    wallet_address: WALLET, token_mint: TOKEN, direction: 'buy', token_amount: observation.quantity,
    quantity: observation.quantity, amount_usd: '20', price_usd: null, fee_usd: '0', event_at: new Date(binding.eventAt),
    observed_at: now, confirmation_state: 'observed', payload_matches: true, wallet_score: '90', wallet_tier: 'elite' };
  let bound = false, inserted = false, verified: { source_trade_id: string; evidence_digest: string } | null = null;
  let head: { evidence_id: string; revision: string; confirmation_state: string; authority_id: string } | null = null;
  let signal: Record<string, unknown> | null = null;
  const execution = { id: EXECUTION, user_id: USER, signal_id: SIGNAL, source_trade_id: SOURCE, exit_lot_id: null,
    chain: binding.chain, token_mint: TOKEN, target_account: WALLET, direction: 'buy', execution_mode: 'paper', state: 'requested',
    client_order_id: buildCopyExecutionClientOrderId({ sourceTradeId: SOURCE, chain: binding.chain, targetAccount: WALLET,
      executionMode: 'paper', userId: USER }), requested_base_quantity: '1.5', requested_quote_quantity: '20',
    confirmed_base_quantity: '0', confirmed_quote_quantity: '0', reserved_base_quantity: '0', submission_attempts: 0,
    max_submission_attempts: 3, max_reconciliation_attempts: 10, reconciliation_attempts: 0 };
  const state = { authority: true, unsafe: false, replayMatches: true, candidateRows: [source] };
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    const reply = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
    if (sql.includes('INSERT INTO source_trades')) { const fresh = !inserted; inserted = true; return reply(fresh ? [{ id: SOURCE }] : []); }
    if (sql.includes('INSERT INTO source_verification_bindings')) { bound = true; return reply([], 1); }
    if (sql.includes('SELECT binding, binding_digest')) return reply(bound ? [{ binding, binding_digest: sourceBindingDigest(binding) }] : []);
    if (sql.includes('SELECT binding_digest')) return reply(bound ? [{ binding_digest: sourceBindingDigest(binding) }] : []);
    if (sql.includes('FROM source_provider_authorities WHERE')) return reply([{ identity_digest: provider.identityDigest,
      provider_id: provider.providerId, chain: binding.chain, network: binding.network, verifier_version: provider.verifierVersion,
      valid_until: new Date(provider.validUntil), enabled: state.authority }]);
    if (sql.includes('INSERT INTO source_verified_evidence')) { if (verified) return reply();
      verified = { source_trade_id: SOURCE, evidence_digest: values[3] as string }; return reply([], 1); }
    if (sql.includes('SELECT source_trade_id, evidence_digest')) return reply(verified ? [verified] : []);
    if (sql.includes('SELECT head.evidence_id')) return reply(head ? [head] : []);
    if (sql.includes('SELECT network, quantity_scale')) return reply([{ network: binding.network, quantity_scale: binding.quantityScale }]);
    if (sql.includes('AS unsafe')) return reply([{ unsafe: state.unsafe }]);
    if (sql.includes('AS verified')) return reply([{ verified: !state.unsafe }]);
    if (sql.includes('AS exists')) return reply([{ exists: false }]);
    if (sql.includes('UPDATE source_trades SET')) source.confirmation_state = values[1] as string;
    if (sql.includes('INSERT INTO source_verification_heads')) head = { evidence_id: values[1] as string,
      revision: values[2] as string, confirmation_state: values[3] as string, authority_id: provider.authorityId };
    if (sql.includes('SELECT true AS accepted')) return reply(state.authority && head ? [{ accepted: true }] : []);
    if (sql.includes('JOIN wallets wallet')) return reply(state.authority && head ? state.candidateRows : []);
    if (sql.includes('FROM source_trades')) return reply([source]);
    if (sql.includes('INSERT INTO signals')) { if (signal) return reply();
      signal = { id: SIGNAL, source_trade_id: SOURCE, chain: binding.chain, token_mint: TOKEN, source_side: 'buy',
        source_position_before_quantity: null, source_sell_fraction: null, status: 'eligible', expires_at: null }; return reply([signal]); }
    if (sql.includes('FROM signals')) return reply(signal ? [signal] : []);
    if (sql.includes('AS matches')) return reply([{ matches: state.replayMatches }]);
    if (sql.includes('FROM copy_executions')) return reply([execution]);
    return reply([], 1);
  });
  const client = { query } as unknown as PoolClient;
  const verifier: TrustedSourceVerifier = { validateProvider: vi.fn(async () => provider),
    verifyEvidence: vi.fn(async input => ({ accepted: true, evidenceDigest: input.evidenceDigest, identityDigest: provider.identityDigest })) };
  const transaction = async <T>(action: (client: PoolClient) => Promise<T>) => action(client);
  const intake = () => transaction(client => recordSourceTradeEventWithClient(client, observation));
  const verify = () => transaction(client => verifySourceTradeWithClient(client, { sourceTradeId: SOURCE, evidence, verifier, now }));
  const derive = () => transaction(client => insertSourceTradeSignalWithClient(client, { sourceTradeId: SOURCE, confidence: 90,
    signalScore: 90, triggerData: { sourceTradeId: 'hostile-overwrite' }, maxEventAgeMs: 1000, maxPositionEvidenceAgeMs: 1000, now }));
  return { source, execution, calls, state, client, verifier, transaction, intake, verify, derive };
}

describe('P4a actual owned intake/verified signal/exact claim seams', () => {
  it.each(['confirmed', 'finalized', 'reversed'] as const)('refuses public %s labels before any client query/acquisition', async confirmationState => {
    const f = fixture();
    expect(() => prepareRecordSourceTradeEvent({ ...observation, confirmationState })).toThrow('verifier is unavailable');
    await expect(recordSourceTradeEventWithClient(f.client, { ...observation, confirmationState })).rejects.toThrow('verifier is unavailable');
    await expect(advanceSourceTradeConfirmation({ sourceTradeId: SOURCE, confirmationState, evidenceId: 'caller-label' })).rejects.toThrow('verifier is unavailable');
    expect(f.client.query).not.toHaveBeenCalled();
  });
  it('captures observed-only intake identity and timestamps before caller mutation/acquisition', async () => {
    const f = fixture();
    const input = { ...observation, eventAt: new Date(observation.eventAt), observedAt: new Date(now) };
    const record = prepareRecordSourceTradeEvent(input);
    input.confirmationState = 'confirmed'; input.side = 'sell'; input.chain = 'polygon';
    input.eventAt.setTime(0); input.observedAt.setTime(0);
    expect(f.client.query).not.toHaveBeenCalled();
    await expect(record(f.client)).resolves.toMatchObject({ inserted: true, eligibleForCopy: false });
    const values = f.calls.find(call => call.sql.includes('INSERT INTO source_trades'))!.values;
    expect(values[0]).toBe('solana'); expect(values[4]).toBe('buy'); expect(values[9]).toBe('observed');
    expect(values[13]).toEqual(new Date(binding.eventAt)); expect(values[14]).toEqual(now);
    expect(f.calls.find(call => call.sql.includes('INSERT INTO source_trade_confirmation_history'))!.values[1]).toBe('observed');
  });
  it('captures nested signal payload and serialization hooks before acquisition', async () => {
    const f = fixture(); await f.intake(); await f.verify();
    const serialized = { value: 'captured' };
    const toJSON = vi.fn(() => ({ value: serialized.value }));
    const triggerData = { nested: { values: ['captured'], at: new Date(now) },
      hook: { toJSON }, sourceTradeId: 'caller-overwrite' };
    const derive = prepareInsertSourceTradeSignal({ sourceTradeId: SOURCE, confidence: 90,
      signalScore: 90, triggerData, maxEventAgeMs: 1000, maxPositionEvidenceAgeMs: 1000, now });
    expect(toJSON).toHaveBeenCalledTimes(1);
    triggerData.nested.values[0] = 'changed'; triggerData.nested.at.setTime(0);
    serialized.value = 'changed';
    await derive(f.client);
    const trigger = JSON.parse(f.calls.find(call => call.sql.includes('INSERT INTO signals'))!.values[5] as string);
    expect(trigger.nested).toEqual({ values: ['captured'], at: now.toISOString() });
    expect(trigger.hook).toEqual({ value: 'captured' });
    expect(trigger.sourceTradeId).toBe(SOURCE);
    expect(toJSON).toHaveBeenCalledTimes(1);
  });
  it.each(['cycle', 'bigint', 'throwing-hook'] as const)('rejects %s signal payload before acquisition', async kind => {
    const f = fixture();
    const triggerData: Record<string, unknown> = {};
    if (kind === 'cycle') triggerData.nested = triggerData;
    if (kind === 'bigint') triggerData.nested = { value: 1n };
    if (kind === 'throwing-hook') triggerData.nested = { toJSON() { throw new Error('unserializable'); } };
    const acquire = vi.fn(f.transaction);
    expect(() => acquire(prepareInsertSourceTradeSignal({ sourceTradeId: SOURCE, confidence: 90,
      signalScore: 90, triggerData, maxEventAgeMs: 1000, maxPositionEvidenceAgeMs: 1000, now }))).toThrow();
    expect(acquire).not.toHaveBeenCalled(); expect(f.client.query).not.toHaveBeenCalled();
    await expect(insertSourceTradeSignalWithClient(f.client, { sourceTradeId: SOURCE, confidence: 90,
      signalScore: 90, triggerData, maxEventAgeMs: 1000, maxPositionEvidenceAgeMs: 1000, now })).rejects.toThrow();
    expect(f.client.query).not.toHaveBeenCalled();
  });
  it('moves exact bound observation through real verification and signal insertion, then exact persisted execution replay', async () => {
    const f = fixture(); expect(await f.intake()).toMatchObject({ inserted: true, eligibleForCopy: false, position: null });
    await expect(f.derive()).rejects.toThrow('verifier is unavailable');
    expect(await f.verify()).toMatchObject({ applied: true });
    expect(await f.verify()).toMatchObject({ applied: false, replayed: true });
    expect(await f.intake()).toMatchObject({ inserted: false, event: { confirmationState: 'confirmed' } });
    expect(await f.derive()).toMatchObject({ inserted: true, id: SIGNAL });
    expect(await f.derive()).toMatchObject({ inserted: false, id: SIGNAL });
    const start = f.calls.length;
    const replay = await f.transaction(client => claimSourceSignalForCopyExecutionWithClient(client, claimInput));
    expect(replay).toMatchObject({ created: false, claimed: false, execution: { id: EXECUTION, userId: USER } });
    const calls = f.calls.slice(start);
    expect(calls.findIndex(call => call.sql.includes('pg_advisory_xact_lock'))).toBeLessThan(calls.findIndex(call => call.sql.includes('FOR UPDATE')));
    expect(calls.find(call => call.sql.includes('FROM copy_executions'))?.values).toEqual([SOURCE, WALLET, 'paper', USER]);
    expect(calls.some(call => call.sql.includes('INSERT INTO copy_executions'))).toBe(false);
    const trigger = JSON.parse(f.calls.find(call => call.sql.includes('INSERT INTO signals'))!.values[5] as string);
    expect(trigger.sourceTradeId).toBe(SOURCE);
    expect(f.calls.some(call => /^(BEGIN|COMMIT|ROLLBACK)$/.test(call.sql))).toBe(false);
  });
  it('filters persisted accepted authority before LIMIT and rechecks the same client', async () => {
    const f = fixture(); await f.intake(); await f.verify();
    expect(await listSourceTradeSignalCandidatesWithClient(f.client, { maxEventAgeMs: 1000, limit: 1, now })).toHaveLength(1);
    const selected = f.calls.find(call => call.sql.includes('JOIN wallets wallet'))!;
    expect(selected.sql.indexOf('authority.enabled')).toBeLessThan(selected.sql.indexOf('LIMIT $4'));
    expect(selected.values).toEqual([1000, now, null, 1]);
    f.state.authority = false;
    expect(await listSourceTradeSignalCandidatesWithClient(f.client, { maxEventAgeMs: 1000, limit: 1, now })).toEqual([]);
  });
  it('withholds revoked authority before execution replay and rejects changed replay quantities/tenant', async () => {
    const f = fixture(); await f.intake(); await f.verify(); await f.derive();
    f.state.authority = false; const start = f.calls.length;
    expect(await claimSourceSignalForCopyExecutionWithClient(f.client, claimInput)).toMatchObject({ execution: null, claimed: false });
    expect(f.calls.slice(start).some(call => call.sql.includes('FROM copy_executions'))).toBe(false);
    f.state.authority = true; f.state.replayMatches = false;
    await expect(claimSourceSignalForCopyExecutionWithClient(f.client, claimInput)).rejects.toThrow('quantity identity collision');
    f.state.replayMatches = true; f.execution.user_id = SOURCE;
    await expect(claimSourceSignalForCopyExecutionWithClient(f.client, claimInput)).rejects.toThrow('identity collision');
  });
  it('refuses immutable intake collision and legacy unbound quarantine replay', async () => {
    const f = fixture(); await f.intake(); f.source.payload_matches = false;
    await expect(f.intake()).rejects.toThrow('different immutable payload');
    const legacy = fixture(); await recordSourceTradeEventWithClient(legacy.client, { ...observation, verificationBinding: undefined });
    await expect(legacy.intake()).rejects.toThrow('missing immutable binding');
  });
  it('does not return an intake result on uncertain caller COMMIT', async () => {
    const f = fixture(); const publish = vi.fn();
    const uncertainTransaction = async <T>(action: (client: PoolClient) => Promise<T>): Promise<T> => {
      await action(f.client); throw new Error('uncertain COMMIT; caller must retain ownership');
    };
    await expect(uncertainTransaction(client => recordSourceTradeEventWithClient(client, observation)).then(publish)).rejects.toThrow('uncertain COMMIT');
    expect(publish).not.toHaveBeenCalled(); // Does not assert whether a real server committed.
  });
  it('cannot obtain worker transaction authority from queue flags without protected persisted capability', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('pg_catalog.pg_roles') ? [{ role_name: 'swat_app', session_role: 'swat_app',
      row_security: 'on', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false,
      rolinherit: false, has_memberships: false, owns_objects: false, can_create: false }] : [] }));
    const action = vi.fn();
    const factory = createOwnedObligationScopedTransaction({ transaction: async fn => fn({ query } as unknown as PoolClient),
      now: () => now, maximumAgeMs: 1000 });
    await expect(factory({ copyExecutionId: EXECUTION, userId: USER, approved: true })!(action)).rejects.toThrow('capability unavailable');
    expect(action).not.toHaveBeenCalled();
  });
});
