import { describe, expect, it, vi } from 'vitest';
import { createCheckedPipelineTransaction, createProtectedPipelineSource, readPipelineBackendApproval, PIPELINE_IDENTITY_SQL,
  PIPELINE_BACKEND_ROUTINE_SQL, PipelineCommitUncertainError, type PipelineProtectedPurpose, type PoolClient } from '../../../packages/db/src/wave4-pipeline-source-owned.js';
import { createProtectedFanoutTransaction } from '../../../packages/db/src/wave4-pipeline-fanout-owned.js';
import { sourceBindingDigest,sourceContentDigest,type SourceVerificationBinding,
  type SourceVerificationEvidence } from '../../../packages/db/src/source-verification.js';
import type { SourceTradeEventInput } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const CAPABILITY = '22222222-2222-4222-8222-222222222222';
const WALLET = 'solana:11111111111111111111111111111111';
const TOKEN = 'solana:11111111111111111111111111111112';
const time = new Date('2026-11-23T00:00:01.000Z');
const provider = { providerId: 'inert-provider',authorityId: 'inert-authority',chain: 'solana' as const,
  network: 'inert-not-approved-network',verifierVersion: 'inert-v1',identityDigest: 'a'.repeat(64),
  validUntil: '2026-11-23T00:01:00.000Z' };
const binding: SourceVerificationBinding = { chain: 'solana',network: provider.network,sourceEventType: 'transaction',
  sourceEventId: 'inert-tx',sourceEventIndex: '0',transactionHash: 'inert-tx',walletAddress: WALLET,tokenMint: TOKEN,
  side: 'buy',rawQuantity: '9007199254740993000000000000000001',quantityScale: 18,
  eventAt: '2026-11-23T00:00:00.000Z',amountUsd: '20',priceUsd: null,feeUsd: '0' };
function observation(): SourceTradeEventInput { return { chain: binding.chain,sourceEventType: binding.sourceEventType,
  sourceEventId: binding.sourceEventId,sourceEventIndex: binding.sourceEventIndex,transactionHash: binding.transactionHash,
  walletAddress: WALLET,tokenMint: TOKEN,side: 'buy',quantity: '9007199254740993.000000000000000001',amountUsd: '20',
  priceUsd: null,feeUsd: '0',eventAt: new Date(binding.eventAt),observedAt: new Date(time),confirmationState: 'observed',
  confirmationEvidenceId: 'inert-observation',verificationBinding: { ...binding } }; }
function evidence(): SourceVerificationEvidence { return { evidenceId: 'inert-evidence',binding: { ...binding },finality: 'confirmed',
  blockHash: 'inert-block',blockHeight: '1',revision: '1',reversesEvidenceId: null,observedAt: time.toISOString(),
  provenance: { providerId: provider.providerId,authorityId: provider.authorityId,verifierVersion: provider.verifierVersion,receiptId: 'inert-receipt' },
  content: 'inert-content',contentDigest: sourceContentDigest('inert-content') }; }

/** Inert IO calls the actual owned/source/store functions. It is intentionally
 * NOT a server/RLS/direct endpoint/provider acceptance or SQL application test. */
function fixture(role = 'swat_source_provider_writer') {
  const state = { role,session: role,pid: 42,unsafeRole: false,schema: true,capability: true,providerEnabled: true,
    registered: false,drift: false,commit: 'COMMIT',commitThrow: false,accepted: true,bound: false,inserted: false,
    sourceState: 'observed',history: false };
  const calls: { sql: string; values: unknown[] }[] = [];
  let persistedEvidence: { source_trade_id: string; evidence_digest: string } | null = null;
  let head: { evidence_id: string;revision: string;confirmation_state: string;authority_id: string } | null = null;
  const source = () => ({ id: SOURCE,chain: binding.chain,source_event_type: binding.sourceEventType,source_event_id: binding.sourceEventId,
    source_event_index: '0',transaction_hash: binding.transactionHash,wallet_address: WALLET,token_mint: TOKEN,direction: 'buy',
    token_amount: observation().quantity,quantity: observation().quantity,amount_usd: '20',price_usd: null,fee_usd: '0',
    event_at: new Date(binding.eventAt),observed_at: time,confirmation_state: state.sourceState,payload_matches: true });
  const reply = (rows: unknown[] = [],command?: string,rowCount = rows.length) => ({ rows,command,rowCount });
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql,values });
    if (sql === PIPELINE_IDENTITY_SQL) return reply([{ runtime_role: state.role,session_role: state.session,role_setting: 'none',
      row_security: 'on',search_path: 'pg_catalog, public',rolcanlogin: true,rolsuper: state.unsafeRole,rolbypassrls: false,
      rolinherit: false,rolcreaterole: false,rolcreatedb: false,rolreplication: false,memberships: false,owns_objects: false,
      can_create: false,backend_pid: state.pid,database_oid: '1',server_address: 'unix',server_port: 0,
      backend_identity: `inert|unix|0|${role}`,observed_at: time,transaction_clean: true }]);
    if (sql === PIPELINE_BACKEND_ROUTINE_SQL) return reply(state.schema ? [{ prosecdef: true,proconfig: ['search_path=pg_catalog'],
      owner_role: 'swat_runtime_lookup',rolcanlogin: false,rolsuper: false,rolbypassrls: false,rolinherit: false,rolcreaterole: false,
      rolcreatedb: false,rolreplication: false,memberships: false,executable: true,public_execute: false }] : []);
    if (sql.startsWith('SELECT * FROM public.swat_pipeline_backend_capability')) return reply(state.capability ? [{
      capability_id: CAPABILITY,revision: state.drift ? '2' : '1',purpose: values[0],authority_id: values[1],runtime_role: role,
      database_oid: '1',server_address: 'unix',server_port: 0,backend_identity: `inert|unix|0|${role}`,
      valid_from: new Date(time.getTime()-1000),expires_at: new Date(time.getTime()+50000),revoked_at: null,approved_terms: null,
      provider_id: provider.providerId,chain: provider.chain,network: provider.network,verifier_version: provider.verifierVersion,
      identity_digest: provider.identityDigest,provider_valid_until: new Date(provider.validUntil) }] : []);
    if (sql === 'SELECT statement_timestamp() AS database_now') return reply([{ database_now: time }]);
    if (sql.startsWith('SELECT set_config')) return reply();
    if (sql.startsWith('BEGIN')) return reply([],'BEGIN');
    if (sql === 'COMMIT') { if (state.commitThrow) throw new Error('inert transport uncertainty'); return reply([],state.commit); }
    if (sql === 'ROLLBACK') return reply([],'ROLLBACK');
    if (sql.includes('INSERT INTO public.source_provider_authorities')) { state.registered = true; return reply([],undefined,1); }
    if (sql.includes('FROM public.source_provider_authorities')) return reply(state.registered ? [{ authority_id: provider.authorityId,
      provider_id: provider.providerId,chain: provider.chain,network: provider.network,verifier_version: provider.verifierVersion,
      identity_digest: provider.identityDigest,valid_until: new Date(provider.validUntil),enabled: state.providerEnabled }] : []);
    if (sql.includes('INSERT INTO source_trades')) { const fresh = !state.inserted; state.inserted = true; return reply(fresh ? [{ id: SOURCE }] : []); }
    if (sql.includes('INSERT INTO source_verification_bindings')) { state.bound = true; return reply([],undefined,1); }
    if (sql.includes('SELECT binding, binding_digest')) return reply(state.bound ? [{ binding,binding_digest: sourceBindingDigest(binding) }] : []);
    if (sql.includes('SELECT binding_digest')) return reply(state.bound ? [{ binding_digest: sourceBindingDigest(binding) }] : []);
    if (sql.includes('FROM source_provider_authorities WHERE')) return reply([{ identity_digest: provider.identityDigest,
      provider_id: provider.providerId,chain: provider.chain,network: provider.network,verifier_version: provider.verifierVersion,
      valid_until: new Date(provider.validUntil),enabled: state.providerEnabled }]);
    if (sql.includes('INSERT INTO source_verified_evidence')) {
      if (persistedEvidence) return reply(); persistedEvidence = { source_trade_id: SOURCE,evidence_digest: values[3] as string };
      return reply([],undefined,1);
    }
    if (sql.includes('SELECT source_trade_id, evidence_digest')) return reply(persistedEvidence ? [persistedEvidence] : []);
    if (sql.includes('SELECT head.evidence_id')) return reply(head ? [head] : []);
    if (sql.includes('AS exists')) return reply([{ exists: state.history }]);
    if (sql.includes('SELECT network, quantity_scale')) return reply([{ network: binding.network,quantity_scale: binding.quantityScale }]);
    if (sql.includes('AS unsafe')) return reply([{ unsafe: false }]);
    if (sql.includes('AS verified')) return reply([{ verified: true }]);
    if (sql.includes('UPDATE source_trades SET')) { state.sourceState = values[1] as string; return reply([],undefined,1); }
    if (sql.includes('INSERT INTO source_verification_heads')) { head = { evidence_id: values[1] as string,revision: values[2] as string,
      confirmation_state: values[3] as string,authority_id: provider.authorityId }; return reply([],undefined,1); }
    if (sql.includes('INSERT INTO source_verification_history')) { state.history = true; return reply([],undefined,1); }
    if (sql.includes('FROM source_trades')) return reply([source()]);
    if (sql.includes('pg_advisory_xact_lock') || sql.startsWith('INSERT INTO ') || sql.trimStart().startsWith('WITH RECURSIVE')) return reply([],undefined,1);
    if (sql === 'SELECT 1') return reply([{ value: 1 }]);
    throw new Error(`Unscripted inert SQL ${sql}`);
  });
  const client = { query } as unknown as PoolClient;
  const release = vi.fn(),acquire = vi.fn(async () => ({ client,release }));
  const verifier = { validateProvider: vi.fn(async () => provider),verifyEvidence: vi.fn(async (input: { evidenceDigest: string }) => ({
    accepted: state.accepted,evidenceDigest: input.evidenceDigest,identityDigest: provider.identityDigest })) };
  const owned = createProtectedPipelineSource({ acquire,provider,verifier,now: () => new Date(time),maximumEvidenceAgeMs: 1000 });
  return { state,calls,query,client,release,acquire,verifier,owned };
}

describe('P4b concrete protected source/fanout backing (inert IO, unexecuted authoring)', () => {
  it.each(['confirmed','finalized','reversed'] as const)('refuses public %s before acquisition', state => {
    const f = fixture(); expect(() => f.owned.intake({ ...observation(),confirmationState: state })).toThrow('finality label refused');
    expect(f.acquire).not.toHaveBeenCalled();
  });
  it('refuses numeric economics and raw-scale drift before acquisition', () => {
    const f = fixture(); expect(() => f.owned.intake({ ...observation(),amountUsd: 20 })).toThrow('exact strings');
    expect(() => f.owned.intake({ ...observation(),verificationBinding: { ...binding,quantityScale: 17 } })).toThrow('immutable observation');
    expect(f.acquire).not.toHaveBeenCalled();
  });
  it('does not turn provider/identity/client labels into backend approval', async () => {
    const f = fixture(); f.state.capability = false;
    await expect(f.owned.register()).rejects.toThrow('persisted backend capability unavailable');
    expect(f.calls.some(c => c.sql.includes('INSERT INTO public.source_provider_authorities'))).toBe(false);
    expect(f.release).toHaveBeenCalledWith(true);
  });
  it('missing schema refuses before invoking nonexistent routines or canonical DML', async () => {
    const f = fixture(); f.state.schema = false;
    await expect(f.owned.register()).rejects.toThrow('protected schema/approved lookup unavailable');
    expect(f.calls.some(c => c.sql.startsWith('SELECT * FROM public.swat_pipeline_backend_capability'))).toBe(false);
  });
  it.each(['session','unsafeRole'] as const)('refuses exact direct identity drift (%s)', async field => {
    const f = fixture(); if (field === 'session') f.state.session = 'swat_app'; else f.state.unsafeRole = true;
    await expect(f.owned.register()).rejects.toThrow('direct session identity/backend');
    expect(f.calls.some(c => c.sql.startsWith('BEGIN'))).toBe(false);
  });
  it('registers only protected approved provider, snapshots nested intake, applies canonical evidence and immutable replay', async () => {
    const f = fixture(); await f.owned.register();
    const input = observation(),pending = f.owned.intake(input);
    input.eventAt.setTime(0); input.observedAt!.setTime(0);
    (input.verificationBinding as { rawQuantity: string }).rawQuantity = '1'; input.side = 'sell';
    await expect(pending).resolves.toMatchObject({ inserted: true,eligibleForCopy: false });
    const inserted = f.calls.find(c => c.sql.includes('INSERT INTO source_trades'))!.values;
    expect(inserted[4]).toBe('buy'); expect(inserted[6]).toBe('9007199254740993.000000000000000001');
    expect(inserted[13]).toEqual(new Date(binding.eventAt));
    const candidate = evidence(),verified = f.owned.verify(SOURCE,candidate);
    (candidate.provenance as { receiptId: string }).receiptId = 'mutated';
    await expect(verified).resolves.toMatchObject({ applied: true,replayed: false });
    await expect(f.owned.verify(SOURCE,evidence())).resolves.toMatchObject({ applied: false,replayed: true });
    expect(f.calls.filter(c => c.sql.includes('INSERT INTO source_position_economic_history')
      || c.sql.includes(') INSERT INTO source_position_economic_history'))).toHaveLength(1);
    expect(f.verifier.verifyEvidence).toHaveBeenCalledWith(expect.objectContaining({ evidence: expect.objectContaining({
      provenance: expect.objectContaining({ receiptId: 'inert-receipt' }) }) }));
    expect(f.calls.filter(c => c.sql === 'COMMIT')).toHaveLength(4);
  });
  it('revoked provider and adapter rejection cannot reach source state/application changes', async () => {
    const f = fixture(); await f.owned.register(); await f.owned.intake(observation());
    f.state.accepted = false;
    await expect(f.owned.verify(SOURCE,evidence())).rejects.toThrow('verifier rejected evidence');
    expect(f.state.sourceState).toBe('observed');
    f.state.providerEnabled = false;
    await expect(f.owned.verify(SOURCE,evidence())).rejects.toThrow('absent/revoked');
  });
  it('freshness and providerless configuration refuse before acquisition', () => {
    const f = fixture(); expect(() => f.owned.verify(SOURCE,{ ...evidence(),observedAt: '2026-11-22T00:00:00.000Z' })).toThrow('freshness');
    const unavailable = createProtectedPipelineSource({ acquire: f.acquire,provider,verifier: null,now: () => time,maximumEvidenceAgeMs: 1000 });
    expect(() => unavailable.intake(observation())).toThrow('providerless'); expect(f.acquire).not.toHaveBeenCalled();
  });
  it.each(['rollback-tag','transport'] as const)('withholds results on uncertain COMMIT (%s), no rollback claim', async kind => {
    const f = fixture(); if (kind === 'transport') f.state.commitThrow = true; else f.state.commit = 'ROLLBACK';
    const published = vi.fn();
    await expect(f.owned.register().then(published)).rejects.toBeInstanceOf(PipelineCommitUncertainError);
    expect(published).not.toHaveBeenCalled(); expect(f.calls.some(c => c.sql === 'ROLLBACK')).toBe(false);
    expect(f.release).toHaveBeenCalledWith(true);
  });
  it('rechecks persisted capability before COMMIT and poisons caught nesting or escaped queries', async () => {
    const f = fixture('swat_fanout'),transaction = createProtectedFanoutTransaction(f.acquire);
    await expect(transaction(async client => { await client.query('SELECT 1'); f.state.drift = true; return 'not-success'; }))
      .rejects.toThrow('drift before COMMIT');
    expect(f.calls.some(c => c.sql === 'COMMIT')).toBe(false);
    f.state.drift = false;
    await expect(transaction(async () => { try { await transaction(async () => 1); } catch { /* swallowed */ } }))
      .rejects.toThrow('lifetime escaped');
    let escaped: PoolClient | null = null;
    await transaction(async client => { escaped = client; });
    await expect(escaped!.query('SELECT 1')).rejects.toThrow('expired');
  });
  it.each([
    ['worker-register','swat_capability_writer'],['risk-write','swat_risk_writer'],
    ['valuation-register','swat_valuation_writer'],['valuation-write','swat_valuation_writer'],
    ['paper-valuation','swat_valuation_writer'],['paper-receipt','swat_worker_receipt_writer']
  ] as const)('shared %s support captures independently persisted terms but never grants runtime', async (purpose,role) => {
    const f = fixture(role),terms = { executionId: SOURCE,nested: { rawQuantity: '9007199254740993000000000000000001' } };
    const raw = f.client.query.bind(f.client);
    const client = { query: async (sql: string,values?: unknown[]) => {
      const result = await raw(sql,values);
      if (sql.startsWith('SELECT * FROM public.swat_pipeline_backend_capability')) result.rows[0].approved_terms = terms;
      return result;
    } } as unknown as PoolClient;
    const approval = await readPipelineBackendApproval(client,purpose,SOURCE);
    terms.nested.rawQuantity = '1';
    expect(approval.runtimeRole).toBe(role); expect(approval.databaseOid).toBe('1');
    expect(approval.terms).toEqual({ executionId: SOURCE,nested: { rawQuantity: '9007199254740993000000000000000001' } });
    expect(Object.isFrozen(approval.terms)).toBe(true);
    expect(() => createCheckedPipelineTransaction({ acquire: f.acquire,purpose: 'worker-runtime' as PipelineProtectedPurpose,authorityId: SOURCE }))
      .toThrow('invalid protected selector');
  });
  it('fanout cannot acquire authority from the ordinary runtime role', async () => {
    const f = fixture('swat_app'),operation = vi.fn();
    await expect(createCheckedPipelineTransaction({ acquire: f.acquire,purpose: 'fanout',authorityId: '' })(operation))
      .rejects.toThrow('direct session identity'); expect(operation).not.toHaveBeenCalled();
  });
});
