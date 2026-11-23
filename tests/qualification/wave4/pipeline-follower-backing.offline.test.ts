import { describe,expect,it,vi } from 'vitest';
import { createProtectedExactFollowerEntryRequest,createProtectedExactFollowerProvider,pipelineFollowerEvidenceDigest } from '../../../packages/db/src/wave4-pipeline-follower-owned.js';
import { PIPELINE_IDENTITY_SQL,PIPELINE_BACKEND_ROUTINE_SQL,PIPELINE_FOLLOWER_ROUTINE_SQL,
  type PoolClient } from '../../../packages/db/src/wave4-pipeline-source-owned.js';

const USER = '33333333-3333-4333-8333-333333333333';
const TARGET = 'solana:11111111111111111111111111111111';
const TOKEN = 'solana:11111111111111111111111111111112';
const now = new Date('2026-11-23T00:00:01.000Z');
const authority = { authorityId: 'inert-follower-authority',providerId: 'inert-provider',providerIdentity: 'b'.repeat(64),
  chain: 'solana' as const,network: 'inert-not-runtime-authority' };
const descriptor = () => ({ chain: 'solana' as const,data: { userId: USER,targetAccount: TARGET,tokenMint: TOKEN,
  executionMode: 'paper',direction: 'buy' } });
/** Actual protected provider and canonical exactFollowerEntryRequest bodies;
 * fake SQL facts do not establish real protected provider/RLS acceptance. */
function fixture() {
  const row = { authority_id: authority.authorityId,provider_id: authority.providerId,provider_identity: authority.providerIdentity,
    user_id: USER,chain: 'solana',network: authority.network,target_account: TARGET,token_mint: TOKEN,execution_mode: 'paper',
    evidence_id: 'inert-balance-evidence',evidence_digest: 'c'.repeat(64),enabled: true,revoked_at: null,
    available_usd: '9007199254740993.000000000000000001',raw_available_usd: '9007199254740993000000000000000001',usd_scale: 18,
    observed_at: now,expires_at: new Date(now.getTime()+10000),provider_valid_until: new Date(now.getTime()+50000),database_now: now };
  const state = { schema: true,provider: true,backend: true,role: 'swat_fanout',pct: '10',cap: '100000000000000000',spent: '0',unknown: false };
  function rehash() {
    row.evidence_digest = pipelineFollowerEvidenceDigest({ authorityId: row.authority_id,providerId: row.provider_id,
      providerIdentity: row.provider_identity,evidenceId: row.evidence_id,userId: row.user_id,chain: 'solana',network: row.network,
      targetAccount: row.target_account,tokenMint: row.token_mint,executionMode: 'paper',rawAvailableUsd: row.raw_available_usd,
      usdScale: row.usd_scale,availableUsd: row.available_usd,observedAt: row.observed_at.toISOString(),expiresAt: row.expires_at.toISOString() });
  }
  rehash();
  const calls: { sql: string;values: unknown[] }[] = [];
  const query = vi.fn(async (sql: string,values: unknown[] = []) => {
    calls.push({ sql,values });
    if (sql === PIPELINE_IDENTITY_SQL) return { rows: [{ runtime_role: state.role,session_role: state.role,role_setting: 'none',row_security: 'on',
      search_path: 'pg_catalog, public',rolcanlogin: true,rolsuper: false,rolbypassrls: false,rolinherit: false,rolcreaterole: false,
      rolcreatedb: false,rolreplication: false,memberships: false,owns_objects: false,can_create: false,backend_pid: 42,database_oid: '1',
      server_address: 'unix',server_port: 0,backend_identity: 'inert|unix|0|swat_fanout',observed_at: now }] };
    if (sql === PIPELINE_BACKEND_ROUTINE_SQL || sql === PIPELINE_FOLLOWER_ROUTINE_SQL) return { rows: state.schema ? [{
      prosecdef: true,proconfig: ['search_path=pg_catalog'],owner_role: 'swat_runtime_lookup',rolcanlogin: false,rolsuper: false,
      rolbypassrls: false,rolinherit: false,rolcreaterole: false,rolcreatedb: false,rolreplication: false,memberships: false,
      executable: true,public_execute: false }] : [] };
    if (sql.startsWith('SELECT * FROM public.swat_pipeline_backend_capability')) return { rows: state.backend ? [{
      capability_id: '22222222-2222-4222-8222-222222222222',revision: '1',purpose: 'fanout',authority_id: '',runtime_role: 'swat_fanout',
      database_oid: '1',server_address: 'unix',server_port: 0,backend_identity: 'inert|unix|0|swat_fanout',
      valid_from: new Date(now.getTime()-1000),expires_at: new Date(now.getTime()+50000),revoked_at: null,approved_terms: null }] : [] };
    if (sql.startsWith('SELECT * FROM public.swat_pipeline_exact_follower_balance')) return { rows: state.provider ? [row] : [] };
    if (sql.includes('FROM user_execution_settings')) return { rows: [{ max_position_pct: state.pct,auto_execute: true,killed: false }] };
    if (sql.includes('FROM risk_policy_control')) return { rows: [{ cap_usd: state.cap,spent: state.spent,enabled: true,accounting_ready: true,unknown: state.unknown }] };
    throw new Error(`Unscripted inert SQL ${sql}`);
  });
  const client = { query } as unknown as PoolClient;
  const request = createProtectedExactFollowerEntryRequest({ authority,now: () => new Date(now),maximumAgeMs: 1000 });
  return { row,state,calls,query,client,request,rehash };
}

describe('P4b protected EXACT follower backing (inert IO, unexecuted authoring)', () => {
  it('feeds raw-scale exact approved USD into canonical persisted percentage and remaining cap arithmetic', async () => {
    const f = fixture();
    await expect(f.request(f.client,descriptor())).resolves.toEqual({ requestedBaseQuantity: null,requestedQuoteQuantity: '900719925474099.3' });
    expect(f.calls.find(c => c.sql.startsWith('SELECT * FROM public.swat_pipeline_exact_follower_balance'))!.values)
      .toEqual([USER,'solana',TARGET,TOKEN,'paper']);
    expect(f.calls.some(c => /\buser_balances\b|\bsource_trades\b|master.*fill/i.test(c.sql))).toBe(false);
  });
  it('uses remaining durable cap, never master notional or queued requested quantity', async () => {
    const f = fixture(); f.state.cap = '12.000000000000000003'; f.state.spent = '10.000000000000000001';
    const hostile = { ...descriptor(),data: { ...descriptor().data,requestedQuoteQuantity: '1000000',amountUsd: 1000000 } };
    await expect(f.request(f.client,hostile)).resolves.toEqual({ requestedBaseQuantity: null,requestedQuoteQuantity: '2.000000000000000002' });
  });
  it('captures descriptor scope before the first awaited lookup', async () => {
    const f = fixture(),input = descriptor(),pending = f.request(f.client,input);
    input.data.userId = '44444444-4444-4444-8444-444444444444'; input.data.targetAccount = TOKEN;
    await pending;
    expect(f.calls.find(c => c.sql.startsWith('SELECT * FROM public.swat_pipeline_exact_follower_balance'))!.values[0]).toBe(USER);
  });
  it.each(['provider','authority','network','tenant','account','token','mode','raw-scale','numeric','expired','future','revoked'] as const)
    ('rejects protected evidence drift %s with no sizing policy read', async kind => {
      const f = fixture();
      if (kind === 'provider') f.row.provider_identity = 'd'.repeat(64);
      if (kind === 'authority') f.row.authority_id = 'other';
      if (kind === 'network') f.row.network = 'other';
      if (kind === 'tenant') f.row.user_id = '44444444-4444-4444-8444-444444444444';
      if (kind === 'account') f.row.target_account = TOKEN;
      if (kind === 'token') f.row.token_mint = TARGET;
      if (kind === 'mode') f.row.execution_mode = 'live';
      if (kind === 'raw-scale') f.row.usd_scale = 17;
      if (kind === 'numeric') (f.row as unknown as { available_usd: number }).available_usd = 100;
      if (kind === 'expired') f.row.expires_at = now;
      if (kind === 'future') f.row.observed_at = new Date(now.getTime()+1);
      if (kind === 'revoked') f.row.enabled = false;
      await expect(f.request(f.client,descriptor())).rejects.toThrow();
      expect(f.calls.some(c => c.sql.includes('FROM user_execution_settings'))).toBe(false);
    });
  it('stale but unexpired evidence refuses canonical sizing without treating cache as fresh', async () => {
    const f = fixture(); f.row.observed_at = new Date(now.getTime()-1001); f.rehash();
    await expect(f.request(f.client,descriptor())).resolves.toBeNull();
    expect(f.calls.some(c => c.sql.includes('FROM user_execution_settings'))).toBe(false);
  });
  it('providerless and operator requests remain unavailable with no query', async () => {
    const f = fixture(),unavailable = createProtectedExactFollowerEntryRequest({ authority: null,now: () => now,maximumAgeMs: 1000 });
    await expect(unavailable(f.client,descriptor())).resolves.toBeNull();
    await expect(f.request(f.client,{ ...descriptor(),data: { ...descriptor().data,userId: null } })).resolves.toBeNull();
    expect(f.query).not.toHaveBeenCalled();
  });
  it('missing protected schema/backend/provider never permits a fallback', async () => {
    const f = fixture(); f.state.schema = false;
    await expect(f.request(f.client,descriptor())).rejects.toThrow('protected schema');
    f.state.schema = true; f.state.backend = false;
    await expect(f.request(f.client,descriptor())).rejects.toThrow('backend capability unavailable');
    f.state.backend = true; f.state.provider = false;
    await expect(f.request(f.client,descriptor())).resolves.toBeNull();
    expect(f.calls.some(c => /user_balances|source_trades/.test(c.sql))).toBe(false);
  });
  it('rechecks revoked protected provider on each replay rather than keeping a balance cache', async () => {
    const f = fixture(); await f.request(f.client,descriptor()); f.row.enabled = false;
    await expect(f.request(f.client,descriptor())).rejects.toThrow('authority/scope/freshness');
    expect(f.calls.filter(c => c.sql.startsWith('SELECT * FROM public.swat_pipeline_exact_follower_balance'))).toHaveLength(2);
  });
  it('unknown risk accounting refuses; exact zero balance is supported but produces no budget', async () => {
    const f = fixture(); f.state.unknown = true; await expect(f.request(f.client,descriptor())).resolves.toBeNull();
    f.state.unknown = false; f.row.available_usd = '0'; f.row.raw_available_usd = '0'; f.rehash();
    await expect(f.request(f.client,descriptor())).resolves.toBeNull();
  });
  it('approved provider constructor cannot turn mismatched direct session into authority', async () => {
    const f = fixture(); f.state.role = 'swat_app';
    await expect(createProtectedExactFollowerProvider(authority).readBalance(f.client,{ userId: USER,chain: 'solana',
      targetAccount: TARGET,tokenMint: TOKEN,executionMode: 'paper' })).rejects.toThrow('direct session identity');
  });
});
