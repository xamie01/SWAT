import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PIPELINE_WORKER_ROUTINES, pipelinePayload, preparePipelineWorkerCapability,
  registerPipelineWorkerCapabilityWithClient, requirePipelineWorkerRoutine,
  createProtectedPipelineWorkerRegistry, type PipelineWorkerCapabilityRegistration }
  from '../../../packages/db/src/wave4-pipeline-capability-owned.js';
import { preparePipelineRiskPolicy, writePipelineRiskPolicyWithClient, type PipelineRiskPolicyWrite }
  from '../../../packages/db/src/wave4-pipeline-risk-owned.js';
import { preparePipelineValuationAuthority, registerPipelineValuationAuthorityWithClient,
  preparePipelineTrustedWorkerValuation, recordPipelineTrustedWorkerValuationWithClient,
  pipelinePaperEvidenceDigest, preparePipelinePaperValuation, readPipelinePaperValuationWithClient,
  type PipelineValuationAuthority, type PipelineTrustedWorkerValuation, type PipelinePaperValuationEvidence }
  from '../../../packages/db/src/wave4-pipeline-valuation-owned.js';
import { pipelineWorkerReceiptDigest, pipelineReceiptEvidence, preparePipelineWorkerPaperReceipt,
  recordPipelineWorkerPaperReceiptWithClient, readPipelineWorkerPaperReceiptWithClient,
  reconcilePipelineWorkerPaperFillWithClient, reconcilePipelineWorkerPaperValuationWithClient,
  type PipelineWorkerPaperReceipt }
  from '../../../packages/db/src/wave4-pipeline-receipt-owned.js';
import { createOwnedObligationScopedTransaction } from '../../../packages/db/src/obligation-runtime-owned.js';
import { createExactPaperQuote } from '../../../apps/trade-executor/src/worker-paper-quote.js';

const EXECUTION = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const CAPABILITY = '44444444-4444-4444-8444-444444444444';
const ORIGINAL = '55555555-5555-4555-8555-555555555555';
const time = new Date('2026-11-23T00:00:01.000Z');
const expiry = '2026-11-23T00:01:00.000Z';
const scope = { userId: USER,chain: 'solana' as const,tokenMint: 'solana:inert-mint',targetAccount: 'solana:inert-user' };
const registration: PipelineWorkerCapabilityRegistration = { ...scope,capabilityId: CAPABILITY,revision: '1',
  executionId: EXECUTION,runtimeRole: 'swat_app',databaseOid: '42',serverAddress: 'unix',serverPort: 0,
  backendIdentity: 'inert|unix|0|swat_app',validFrom: '2026-11-23T00:00:00.000Z',expiresAt: expiry,
  executionMode: 'paper',obligationKind: 'fanout',obligationId: 'immutable-inert-job',policyId: 'a'.repeat(64),policyRevision: 'b'.repeat(64) };
const risk: PipelineRiskPolicyWrite = { ...scope,executionId: EXECUTION,account: USER,executionMode: 'paper',
  previousEpoch: null,epoch: '1',enabled: true,capUsd: '9007199254740993.000000000000000001',accountingReady: true };
const authority: PipelineValuationAuthority = { userId: USER,chain: 'solana',authorityId: 'inert-authority',
  network: 'inert-not-network',providerId: 'inert-provider',identityDigest: 'a'.repeat(64),verifierVersion: 'inert-v1',
  enabled: true,validUntil: expiry,maxQuoteUsd: '9007199254740993.000000000000000001',maxFeeUsd: '10' };
const trusted: PipelineTrustedWorkerValuation = { valuationId: 'inert-valuation',authorityId: authority.authorityId,
  originalEvidenceId: ORIGINAL,executionId: EXECUTION,userId: USER,sourceEvidenceId: 'inert-source-proof',
  lineageSourceTradeId: SOURCE,lineageAcquisitionEvidenceId: null,lineageMasterWalletAddress: 'solana:inert-master',
  originalDigest: 'c'.repeat(64),providerId: authority.providerId,providerIdentityDigest: authority.identityDigest,
  verifierVersion: authority.verifierVersion,revision: '1',quoteUsd: '20',feeUsd: null,validUntil: expiry };
function paperEvidence(overrides: Partial<PipelinePaperValuationEvidence> = {}): PipelinePaperValuationEvidence {
  const body: Omit<PipelinePaperValuationEvidence,'evidenceDigest'> = { ...scope,executionId: EXECUTION,executionMode: 'paper',
    direction: 'buy',requestedBase: null,requestedQuote: '20',authorityId: authority.authorityId,
    providerId: authority.providerId,providerIdentity: authority.identityDigest,verifierVersion: authority.verifierVersion,
    network: authority.network,baseDecimals: 18,sourceTradeId: SOURCE,sourceEvidenceId: 'inert-source-proof',
    bindingDigest: 'd'.repeat(64),rawQuantity: '9007199254740993000000000000000001',quantityScale: 18,priceUsd: '3',
    quoteCurrency: 'USD',evidenceId: 'inert-paper-proof',observedAt: '2026-11-23T00:00:00.000Z',expiresAt: expiry,
    simulationModelId: 'inert-exact-v1',simulatedFeeBps: '0',simulatedFixedFeeUsd: '0.000000000000000001',...overrides };
  delete (body as any).evidenceDigest;
  return { ...body,evidenceDigest: pipelinePaperEvidenceDigest(body) };
}
function execution(value = paperEvidence()) {
  return { id: EXECUTION,...scope,signalId: CAPABILITY,sourceTradeId: SOURCE,exitLotId: null,exitTrigger: null,
    clientOrderId: 'inert-client-order',executionMode: 'paper',direction: value.direction,state: 'requested',
    requestedBaseQuantity: value.requestedBase,requestedQuoteQuantity: value.requestedQuote,
    confirmedBaseQuantity: '0',confirmedQuoteQuantity: '0',submissionId: null,submissionAttempts: 0 } as any;
}
const attempt = { executionId: EXECUTION,userId: USER,policyRevision: 'b'.repeat(64),riskEpoch: '1',fence: '1' };
function paperReceipt(overrides: Partial<PipelineWorkerPaperReceipt['evidence']> = {}): PipelineWorkerPaperReceipt {
  const body: Omit<PipelineWorkerPaperReceipt,'receiptId'> = { ...scope,executionId: EXECUTION,executionMode: 'paper',
    workerFence: attempt.fence,policyRevision: attempt.policyRevision,riskEpoch: attempt.riskEpoch,
    paperValuationEvidenceId: 'inert-paper-proof',paperValuationDigest: paperEvidence().evidenceDigest,
    executor: 'paper-exact-simulated',evidence: { executionId: EXECUTION,evidenceType: 'paper_simulation',
      evidenceId: 'paper:inert-client-order:inert-paper-proof:inert-exact-v1',baseQuantity: '6.666666666666666666',
      quoteLeg: { amount: '19.999999999999999998',currency: 'USD' },priceUsd: '3',feeUsd: '0.020000000000000000998',
      confirmationState: 'confirmed',completesExecution: true,occurredAt: time.toISOString(),...overrides } };
  return { ...body,receiptId: pipelineWorkerReceiptDigest(body) };
}
function receiptInput(receipt = paperReceipt()) {
  return { ...receipt.evidence,occurredAt: new Date(receipt.evidence.occurredAt) } as any;
}

/** Inert mandatory-client replies exercise source authoring only. This fixture is
 * NOT PostgreSQL/RLS/ACL/restart/concurrency/provider/runtime acceptance. No actual
 * keys, receipts, fund movement, signing, connection, migration or service. */
function harness(role: string, terms: unknown) {
  const flags = { rolcanlogin: true,rolsuper: false,rolbypassrls: false,rolinherit: false,
    rolcreaterole: false,rolcreatedb: false,rolreplication: false,memberships: false };
  const state = { approved: true,terms,output: terms,routine: true,publicExecute: false,owner: 'swat_migrator',
    unsafe: false,definer: false,aclCount: 2,now: time,commit: 'COMMIT',expired: false };
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = vi.fn(async (sql: string,values: unknown[] = []) => {
    calls.push({ sql,values });
    if (sql === 'COMMIT') return { command: state.commit,rows: [] };
    if (/^BEGIN/.test(sql)) return { command: 'BEGIN',rows: [] };
    if (sql === 'ROLLBACK') return { command: 'ROLLBACK',rows: [] };
    if (sql.includes('AS transaction_clean')) return { rows: [{ ...flags,runtime_role: role,session_role: role,
      role_setting: 'none',row_security: 'on',search_path: 'pg_catalog, public',owns_objects: state.unsafe,can_create: false,
      backend_pid: 99,database_oid: '42',server_address: 'unix',server_port: 0,
      backend_identity: `inert|unix|0|${role}`,observed_at: state.now,transaction_clean: true }] };
    if (sql.includes("to_regprocedure('public.swat_pipeline_backend_capability")) return { rows: [{ ...flags,
      rolcanlogin: false,owner_role: 'swat_runtime_lookup',prosecdef: true,proconfig: ['search_path=pg_catalog'],
      executable: true,public_execute: state.publicExecute }] };
    if (sql.includes('WHERE p.oid=to_regprocedure($1)')) return { rows: state.routine ? [{ ...flags,rolcanlogin: false,
      owner_role: state.owner,prosecdef: state.definer,proconfig: ['search_path=pg_catalog'],prokind: 'f',provolatile: 'v',
      proretset: false,pronargdefaults: 0,provariadic: 0,proleakproof: false,proisstrict: false,json_result: true,
      runtime_role: role,session_role: role,role_setting: 'none',row_security: 'on',executable: true,
      acl_count: state.aclCount,exact_acl: !state.publicExecute }] : [] };
    if (sql.includes('SELECT * FROM public.swat_pipeline_backend_capability')) return { rows: state.approved ? [{
      purpose: values[0],authority_id: values[1],runtime_role: role,database_oid: '42',server_address: 'unix',server_port: 0,
      backend_identity: `inert|unix|0|${role}`,revoked_at: null,valid_from: new Date('2026-11-23T00:00:00.000Z'),
      expires_at: state.expired ? time : new Date(expiry),revision: '1',capability_id: CAPABILITY,approved_terms: state.terms }] : [] };
    if (sql.includes('statement_timestamp() AS database_now')) return { rows: [{ database_now: state.now }] };
    if (sql.includes(' AS result')) return { rows: [{ result: state.output }] };
    return { rows: [] };
  });
  const client = { query } as any,release = vi.fn(),acquire = vi.fn(async () => ({ client,release }));
  return { client,query,calls,state,release,acquire };
}

describe('FROZEN P4b worker source backing, authored offline cases (not acceptance)', () => {
  it('contains no pools/env/tenancy/barrels or third runtime capability', () => {
    for (const leaf of ['capability','risk','valuation','receipt']) {
      const text = readFileSync(new URL(`../../../packages/db/src/wave4-pipeline-${leaf}-owned.ts`,import.meta.url),'utf8');
      expect(text).not.toMatch(/new Pool|process\.env|from ['"](?:@swat\/db|\.\/(?:client|transaction|tenancy|index)\.js)['"]/);
      expect(text).not.toMatch(/ALTER\s+FUNCTION.*OWNER|CREATE\s+FUNCTION|swat_claim_runtime_capability\(/);
    }
    const app = readFileSync(new URL('../../../apps/trade-executor/src/wave4-pipeline-protected-composition.ts',import.meta.url),'utf8');
    expect(app).toContain('createOwnedExecutorRuntimePorts'); expect(app).toContain('runCanonicalWorkerJob');
    expect(app).toContain('unavailableCanonicalQuote'); expect(app).toContain('assertPipelineWorkerPaperReceiptWithClient');
    expect(app).not.toMatch(/from ['"]@swat\/db['"]|new Pool|process\.env|\.\/index\.js/);
    expect(app).toContain('runtimeAccepted: false'); expect(app).toContain('productionReady: false');
  });
  it('requires plain captured payload; rejects hooks/getters/cycles and decimal numbers', () => {
    const getter = vi.fn(() => 'hostile');
    expect(() => pipelinePayload({ get secret() { return getter(); } })).toThrow('accessor');
    expect(getter).not.toHaveBeenCalled();
    expect(() => pipelinePayload({ toJSON() { return {}; } })).toThrow();
    const cycle: any = {}; cycle.next = cycle;
    expect(() => pipelinePayload(cycle)).toThrow('acyclic');
    expect(() => pipelinePayload({ value: 1.1 })).toThrow('non-integer');
    const original = { nested: { value: 'exact' } },captured = pipelinePayload(original);
    original.nested.value = 'changed'; expect(captured.nested.value).toBe('exact'); expect(Object.isFrozen(captured.nested)).toBe(true);
  });
  it.each(['definer','owner','public','missing','extra-acl'])('refuses %s fixed routine before any effect', async mode => {
    const h = harness('swat_capability_writer',registration);
    if (mode === 'definer') h.state.definer = true;
    if (mode === 'owner') h.state.owner = 'swat_runtime_lookup';
    if (mode === 'public') h.state.publicExecute = true;
    if (mode === 'missing') h.state.routine = false;
    if (mode === 'extra-acl') h.state.aclCount = 3;
    await expect(requirePipelineWorkerRoutine(h.client,'register')).rejects.toThrow('unavailable');
    expect(h.calls.every(c => !c.sql.includes(' AS result'))).toBe(true);
  });
  it('uses fixed signatures and no third capability broker ownership', () => {
    expect(Object.values(PIPELINE_WORKER_ROUTINES)).toHaveLength(7);
    expect(PIPELINE_WORKER_ROUTINES.receiptWrite.role).toBe('swat_worker_receipt_writer');
    expect(PIPELINE_WORKER_ROUTINES.receiptRead.role).toBe('swat_app');
  });
  it('registers exact SQL079 scope only through independently approved guarded writer', async () => {
    const h = harness('swat_capability_writer',registration);
    expect(await registerPipelineWorkerCapabilityWithClient(h.client,registration)).toEqual(registration);
    expect(h.calls.find(c => c.sql.includes('register_worker_capability(') && c.sql.includes(' AS result'))?.values)
      .toEqual([EXECUTION,JSON.stringify(pipelinePayload(registration))]);
    h.state.terms = { ...registration,policyRevision: 'foreign' };
    const start = h.calls.length;
    await expect(registerPipelineWorkerCapabilityWithClient(h.client,registration)).rejects.toThrow('independent');
    expect(h.calls.slice(start).some(c => c.sql.includes(' AS result'))).toBe(false);
  });
  it.each(['approved','unsafe','expired'])('refuses unavailable %s backend and never treats a client as writer authorization', async mode => {
    const h = harness('swat_capability_writer',registration);
    if (mode === 'approved') h.state.approved = false;
    if (mode === 'unsafe') h.state.unsafe = true;
    if (mode === 'expired') h.state.expired = true;
    await expect(registerPipelineWorkerCapabilityWithClient(h.client,registration)).rejects.toThrow();
    expect(h.calls.some(c => c.sql.includes(' AS result'))).toBe(false);
  });
  it('captures terms before acquisition and withholds success on uncertain COMMIT', async () => {
    const h = harness('swat_capability_writer',registration),writer = createProtectedPipelineWorkerRegistry({ acquire: h.acquire });
    h.state.commit = 'ROLLBACK';
    await expect(writer.register(registration)).rejects.toThrow('COMMIT uncertain');
    expect(h.release).toHaveBeenCalledWith(true);
    expect(h.calls.some(c => c.sql === 'ROLLBACK')).toBe(false);
  });
  it('refuses caller policy/risk enable, stale epoch, floats and operator fallback', async () => {
    expect(() => preparePipelineWorkerCapability({ ...registration,userId: null } as any)).toThrow();
    expect(() => preparePipelineRiskPolicy({ ...risk,accountingReady: false })).toThrow();
    expect(() => preparePipelineRiskPolicy({ ...risk,previousEpoch: '1',epoch: '1' })).toThrow();
    expect(() => preparePipelineRiskPolicy({ ...risk,capUsd: 0.1 } as any)).toThrow();
    const h = harness('swat_risk_writer',risk);
    expect(await writePipelineRiskPolicyWithClient(h.client,risk)).toEqual(risk);
    expect(h.calls.some(c => /UPDATE.*risk_spend_reservations/.test(c.sql))).toBe(false);
    h.state.terms = { ...risk,enabled: false };
    await expect(writePipelineRiskPolicyWithClient(h.client,risk)).rejects.toThrow('independent');
  });
  it('keeps SQL080 authority and trusted original/source/acquisition lineage immutable', async () => {
    const h = harness('swat_valuation_writer',authority);
    expect(await registerPipelineValuationAuthorityWithClient(h.client,authority)).toEqual(authority);
    expect(() => preparePipelineValuationAuthority({ ...authority,enabled: false } as any)).toThrow();
    expect(() => preparePipelineTrustedWorkerValuation({ ...trusted,quoteUsd: null,feeUsd: null })).toThrow();
    h.state.terms = trusted; h.state.output = trusted;
    expect(await recordPipelineTrustedWorkerValuationWithClient(h.client,trusted)).toEqual(trusted);
    h.state.terms = { ...trusted,originalDigest: 'e'.repeat(64) };
    await expect(recordPipelineTrustedWorkerValuationWithClient(h.client,trusted)).rejects.toThrow('independent');
    expect(h.calls.some(c => /UPDATE.*copy_execution_evidence/.test(c.sql))).toBe(false);
  });
  it('reads exact protected raw/scale evidence and preserves null base plus exact buy budget', async () => {
    const value = paperEvidence(),h = harness('swat_valuation_writer',value);
    expect(await readPipelinePaperValuationWithClient(h.client,execution(value),time,1000)).toEqual(value);
    expect(value.rawQuantity).toBe('9007199254740993000000000000000001');
    expect(value.requestedBase).toBeNull(); expect(value.requestedQuote).toBe('20');
    await expect(readPipelinePaperValuationWithClient(h.client,{ ...execution(value),requestedQuoteQuantity: '21' },time,1000))
      .rejects.toThrow('sizing mismatch');
  });
  it.each(['raw','scale','digest','buy-base','float-price','future','stale'])('refuses hostile %s paper evidence', async mode => {
    let value = paperEvidence();
    if (mode === 'raw') value = paperEvidence({ rawQuantity: '1e10' });
    if (mode === 'scale') value = paperEvidence({ quantityScale: -1 });
    if (mode === 'digest') value = { ...value,evidenceDigest: 'f'.repeat(64) };
    if (mode === 'buy-base') value = paperEvidence({ requestedBase: '1' });
    if (mode === 'float-price') value = paperEvidence({ priceUsd: 3 as any });
    if (mode === 'future') value = paperEvidence({ observedAt: '2026-11-23T00:00:02.000Z' });
    if (mode === 'stale') value = paperEvidence({ observedAt: '2026-11-22T23:59:59.000Z' });
    const h = harness('swat_valuation_writer',value);
    await expect(readPipelinePaperValuationWithClient(h.client,execution(value),time,1000)).rejects.toThrow();
  });
  it('feeds exact approved price/fee into existing createExactPaperQuote, not source raw quantity as follower size', async () => {
    const value = paperEvidence(),canonical = execution(value);
    const provider = { providerId: value.providerId,providerIdentity: value.providerIdentity,networkForChain: () => value.network,
      readValuation: async () => ({ ...value,observedAt: new Date(value.observedAt),expiresAt: new Date(value.expiresAt) }) };
    const quote = await createExactPaperQuote({ provider,now: () => time,maximumAgeMs: 1000 })(canonical);
    expect(quote).not.toBeNull();
    const outcome = await quote!.execute({ execution: canonical,attempt,maxSlippageBps: 50,risk: null });
    expect(outcome.kind).toBe('fill');
    if (outcome.kind === 'fill') {
      expect(outcome.evidence.baseQuantity).toBe('6.666666666666666666');
      expect(outcome.evidence.quoteLeg?.amount).toBe('19.999999999999999998');
      expect(outcome.evidence.feeUsd).toBe('0.020000000000000000998');
    }
    expect(canonical.requestedBaseQuantity).toBeNull(); expect(canonical.requestedQuoteQuantity).toBe('20');
  });
  it('independent receipt write and runtime read require exact immutable evidence and fence', async () => {
    const receipt = paperReceipt(),writer = harness('swat_worker_receipt_writer',receipt);
    expect(await recordPipelineWorkerPaperReceiptWithClient(writer.client,receipt)).toEqual(receipt);
    const runtime = harness('swat_app',receipt);
    expect(await readPipelineWorkerPaperReceiptWithClient(runtime.client,attempt,receiptInput(receipt))).toEqual(receipt);
    await expect(readPipelineWorkerPaperReceiptWithClient(runtime.client,{ ...attempt,fence: '2' },receiptInput(receipt))).rejects.toThrow('provenance');
    await expect(readPipelineWorkerPaperReceiptWithClient(runtime.client,attempt,{ ...receiptInput(receipt),feeUsd: '0' })).rejects.toThrow('provenance');
    expect(() => preparePipelineWorkerPaperReceipt({ ...receipt,receiptId: 'a'.repeat(64) })).toThrow('digest');
  });
  it('preserves unknown original quote/fee for immutable correction instead of inventing zero', async () => {
    const receipt = paperReceipt({ quoteLeg: null,priceUsd: null,feeUsd: null }),h = harness('swat_app',receipt);
    expect(preparePipelineWorkerPaperReceipt(receipt).evidence.feeUsd).toBeNull();
    expect(pipelineReceiptEvidence(receiptInput(receipt)).quoteLeg).toBeNull();
    expect(await readPipelineWorkerPaperReceiptWithClient(h.client,attempt,receiptInput(receipt))).toEqual(receipt);
    await expect(readPipelineWorkerPaperReceiptWithClient(h.client,attempt,{ ...receiptInput(receipt),feeUsd: '0' })).rejects.toThrow('provenance');
  });
  it('rejects live/SQL082 receipt reconciliation before canonical settlement', async () => {
    const h = harness('swat_app',paperReceipt());
    const candidate = { execution: { ...execution(),executionMode: 'live' },executor: 'withdrawal-reducing' } as any;
    await expect(reconcilePipelineWorkerPaperFillWithClient(h.client,candidate)).rejects.toThrow('live/SQL082');
    await expect(reconcilePipelineWorkerPaperValuationWithClient(h.client,candidate)).rejects.toThrow('live/SQL082');
    expect(h.query).not.toHaveBeenCalled();
  });
  it('does not infer canonical worker authority from queue labels or writer callbacks', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('pg_catalog.pg_roles') ? [{ role_name: 'swat_app',
      session_role: 'swat_app',row_security: 'on',rolsuper: false,rolbypassrls: false,rolcreaterole: false,rolcreatedb: false,
      rolreplication: false,rolinherit: false,has_memberships: false,owns_objects: false,can_create: false }] : [] }));
    const factory = createOwnedObligationScopedTransaction({ transaction: async action => action({ query } as any),now: () => time,maximumAgeMs: 1000 });
    const operation = vi.fn();
    await expect(factory({ copyExecutionId: EXECUTION,userId: USER,approved: true,receipt: 'callback-label' })!(operation)).rejects.toThrow('capability unavailable');
    expect(operation).not.toHaveBeenCalled();
  });
});
