import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PIPELINE_WORKER_ROUTINES, pipelinePayload, preparePipelineWorkerCapability,
  registerPipelineWorkerCapabilityWithClient, requirePipelineWorkerRoutine,
  createProtectedPipelineWorkerRegistry, pipelineWriterTransaction, PIPELINE_WORKER_BOUNDS, pipelineElapsedClock,
  type PipelineWorkerCapabilityRegistration }
  from '../../../packages/db/src/wave4-pipeline-capability-owned.js';
import { preparePipelineRiskPolicy, writePipelineRiskPolicyWithClient, createProtectedPipelineRiskWriter, type PipelineRiskPolicyWrite }
  from '../../../packages/db/src/wave4-pipeline-risk-owned.js';
import { preparePipelineValuationAuthority, registerPipelineValuationAuthorityWithClient,
  preparePipelineTrustedWorkerValuation, recordPipelineTrustedWorkerValuationWithClient,
  pipelinePaperEvidenceDigest, preparePipelinePaperValuation, readPipelinePaperValuationWithClient, createProtectedPipelineValuationBacking,
  type PipelineValuationAuthority, type PipelineTrustedWorkerValuation, type PipelinePaperValuationEvidence }
  from '../../../packages/db/src/wave4-pipeline-valuation-owned.js';
import { pipelineWorkerReceiptDigest, pipelineReceiptEvidence, preparePipelineWorkerPaperReceipt,
  recordPipelineWorkerPaperReceiptWithClient, readPipelineWorkerPaperReceiptWithClient,
  reconcilePipelineWorkerPaperFillWithClient, reconcilePipelineWorkerPaperValuationWithClient,
  createProtectedPipelinePaperReceiptWriter, readPipelineWorkerRecoveryWithClient, preparePipelineWorkerRecoverySelector,
  assertPipelineOriginalPaperEvidence,
  type PipelineWorkerPaperReceipt }
  from '../../../packages/db/src/wave4-pipeline-receipt-owned.js';
import { createOwnedObligationScopedTransaction } from '../../../packages/db/src/obligation-runtime-owned.js';
import { createExactPaperQuote } from '../../../apps/trade-executor/src/worker-paper-quote.js';
import { readWorkerExecutionContextWithClient } from '../../../packages/db/src/worker-execution.js';
import { readCapturedWorkerPolicyWithClient, readCurrentWorkerPolicyWithClient } from '../../../packages/db/src/worker-policy.js';

vi.mock('../../../packages/db/src/worker-execution.js',async importOriginal => ({
  ...await importOriginal<typeof import('../../../packages/db/src/worker-execution.js')>(),
  readWorkerExecutionContextWithClient: vi.fn()
}));
vi.mock('../../../packages/db/src/worker-policy.js',async importOriginal => ({
  ...await importOriginal<typeof import('../../../packages/db/src/worker-policy.js')>(),
  readCapturedWorkerPolicyWithClient: vi.fn(),readCurrentWorkerPolicyWithClient: vi.fn()
}));

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
    // Zero bps means the canonical unrounded fee is exactly the fixed fee.
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
      quoteLeg: { amount: '19.999999999999999998',currency: 'USD' },priceUsd: '3',feeUsd: '0.000000000000000001',
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

function deferred<T>() {
  let resolve!: (value: T) => void,reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes,no) => { resolve = yes; reject = no; });
  return { promise,resolve,reject };
}
function originalRow(receipt = paperReceipt()) {
  const quote = receipt.evidence.quoteLeg?.amount ?? null;
  return { id: ORIGINAL,execution_id: receipt.executionId,evidence_type: 'paper_simulation',evidence_id: receipt.evidence.evidenceId,
    base_quantity: receipt.evidence.baseQuantity,quote_quantity: quote,quote_native_quantity: quote,
    quote_currency: quote === null ? null : 'USD',quote_native_usd_price: quote === null ? null : '1',
    price_usd: receipt.evidence.priceUsd,fee_usd: receipt.evidence.feeUsd,confirmation_state: 'confirmed',
    completes_execution: true,occurred_at: new Date(receipt.evidence.occurredAt) };
}
function recoveryHarness(unknown = false) {
  const validScope = { ...scope,tokenMint: `solana:${'1'.repeat(31)}2`,targetAccount: `solana:${'1'.repeat(32)}` };
  const master = `solana:${'1'.repeat(31)}3`;
  const e = { ...execution(),...validScope,state: 'reconciliation_required' };
  const { receiptId: _receiptId,...body } = paperReceipt(unknown ? { quoteLeg: null,priceUsd: null,feeUsd: null } : {});
  const terms = { ...body,...validScope },receipt = { ...terms,receiptId: pipelineWorkerReceiptDigest(terms) };
  const h = harness('swat_app',receipt);
  const snapshot = { scope: { account: USER,chain: 'solana' as const,tokenMint: e.tokenMint,masterWalletAddress: master },
    policyId: 'a'.repeat(64),revision: attempt.policyRevision,mode: 'paper' as const,mirrors: 'buys-and-sells' as const,
    autoExecute: true,killed: false,maxSlippageBps: 50 };
  const context = { execution: e,masterWalletAddress: master,ownedExit: null };
  vi.mocked(readWorkerExecutionContextWithClient).mockResolvedValue(context);
  vi.mocked(readCapturedWorkerPolicyWithClient).mockResolvedValue(snapshot);
  vi.mocked(readCurrentWorkerPolicyWithClient).mockResolvedValue({ snapshot: { ...snapshot,revision: 'e'.repeat(64),
    killed: true,autoExecute: false,maxSlippageBps: 5 },platformMode: 'off',minimumScore: 100 });
  const state = { original: originalRow(receipt) as any,attempt: { execution_id: EXECUTION,user_id: USER,
    fence: attempt.fence,policy_revision: attempt.policyRevision,risk_epoch: attempt.riskEpoch,state: 'unknown' },
    reservation: { account: USER,chain: 'solana',execution_mode: 'paper',execution_id: EXECUTION,policy_epoch: '1',state: 'unknown' },
    delivery: { signal_id: e.signalId,user_id: USER,execution_mode: 'paper',target_account: e.targetAccount,
      execution_id: EXECUTION,fence: '7',lease_owner: null as string | null,lease_until: null as Date | null,
      state: 'reconciliation_required',job_id: 'inert-persisted-job',descriptor: { name: 'signal-trade',chain: 'solana',
        queue: 'swat-trades-solana',options: { jobId: 'inert-persisted-job' },data: { ...validScope,signalId: e.signalId,
          sourceTradeId: SOURCE,copyExecutionId: EXECUTION,executionMode: 'paper',direction: 'buy',masterWalletAddress: master,
          requestedBaseQuantity: null,requestedQuoteQuantity: '20',exitLotId: null,score: 99 } } } };
  const baseQuery = h.query.getMockImplementation()!;
  h.query.mockImplementation(async (sql: string,values: unknown[] = []) => {
    if (sql.includes('FROM public.copy_execution_worker_attempts')) return { rows: [state.attempt] } as any;
    if (sql.includes('FROM public.copy_execution_evidence')) return { rows: state.original ? [state.original] : [] } as any;
    if (sql.includes('FROM public.risk_policy_control')) return { rows: [{ epoch: '2' }] } as any;
    if (sql.includes('FROM public.risk_spend_reservations')) return { rows: [state.reservation] } as any;
    if (sql.includes('FROM public.source_fanout_deliveries')) return { rows: [state.delivery] } as any;
    return baseQuery(sql,values);
  });
  return { ...h,recovery: state,receipt,e,snapshot,context,
    selector: { executionId: EXECUTION,workerFence: attempt.fence,evidenceId: receipt.evidence.evidenceId } };
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
    expect(await readPipelinePaperValuationWithClient(h.client,execution(value),time,2000)).toEqual(value);
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
    expect(quote!.requestedDebitUsd).toBe('19.999999999999999999');
    const outcome = await quote!.execute({ execution: canonical,attempt,maxSlippageBps: 50,risk: null });
    expect(outcome.kind).toBe('fill');
    if (outcome.kind === 'fill') {
      expect(outcome.evidence.baseQuantity).toBe('6.666666666666666666');
      expect(outcome.evidence.quoteLeg?.amount).toBe('19.999999999999999998');
      expect(outcome.evidence.feeUsd).toBe('0.000000000000000001');
      const receipt = paperReceipt(),{ receiptId,...body } = receipt;
      expect(pipelineReceiptEvidence(outcome.evidence)).toEqual(receipt.evidence);
      expect(receipt.paperValuationEvidenceId).toBe(value.evidenceId);
      expect(receipt.paperValuationDigest).toBe(value.evidenceDigest);
      expect(pipelineWorkerReceiptDigest({ ...body,evidence: pipelineReceiptEvidence(outcome.evidence) })).toBe(receiptId);
      expect(() => preparePipelineWorkerPaperReceipt(receipt)).not.toThrow();
    }
    expect(canonical.requestedBaseQuantity).toBeNull(); expect(canonical.requestedQuoteQuantity).toBe('20');
  });
  it.each([
    ['simulatedFeeBps','10'],['simulatedFixedFeeUsd','0.000000000000000002'],
    ['simulationModelId','inert-exact-v2'],['bindingDigest','e'.repeat(64)]
  ] as const)('binds %s into the approved valuation digest and independent receipt', async (field,changed) => {
    const value = paperEvidence(),altered = paperEvidence({ [field]: changed });
    expect(altered.evidenceDigest).not.toBe(value.evidenceDigest);
    expect(() => preparePipelinePaperValuation({ ...value,[field]: changed })).toThrow('digest');
    const valuation = harness('swat_valuation_writer',value);
    valuation.state.output = altered;
    await expect(readPipelinePaperValuationWithClient(valuation.client,execution(value),time,2000)).rejects.toThrow('approved evidence');
    const receipt = paperReceipt(),{ receiptId: _id,...body } = receipt;
    expect(receipt.paperValuationDigest).toBe(value.evidenceDigest);
    expect(() => preparePipelineWorkerPaperReceipt({ ...receipt,paperValuationDigest: altered.evidenceDigest })).toThrow('digest');
    const rebound = { ...body,paperValuationDigest: altered.evidenceDigest };
    const candidate = { ...rebound,receiptId: pipelineWorkerReceiptDigest(rebound) };
    expect(candidate.receiptId).not.toBe(receipt.receiptId);
    const writer = harness('swat_worker_receipt_writer',receipt);
    await expect(recordPipelineWorkerPaperReceiptWithClient(writer.client,candidate)).rejects.toThrow('independent');
    expect(writer.calls.some(c => c.sql.includes(' AS result'))).toBe(false);
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
  it('keeps the TEN independent purposes and seven scalar JSONB signatures unchanged', () => {
    const source = readFileSync(new URL('../../../packages/db/src/wave4-pipeline-source-owned.ts',import.meta.url),'utf8');
    expect(source).toContain("| 'worker-register' | 'risk-write' | 'valuation-register' | 'valuation-write' | 'paper-valuation' | 'paper-receipt'");
    expect(source).not.toContain("'worker-recovery'");
    expect(Object.values(PIPELINE_WORKER_ROUTINES).map(r => r.signature)).toEqual([
      'public.swat_pipeline_register_worker_capability(uuid,jsonb)',
      'public.swat_pipeline_write_risk_policy(uuid,jsonb)',
      'public.swat_pipeline_register_worker_valuation_authority(text,jsonb)',
      'public.swat_pipeline_record_trusted_worker_valuation(text,jsonb)',
      'public.swat_pipeline_paper_valuation(uuid)',
      'public.swat_pipeline_record_worker_paper_receipt(uuid,bigint,jsonb)',
      'public.swat_pipeline_worker_paper_receipt(uuid,bigint,text)'
    ]);
  });
  it('rejects numeric identity/revision/fence/epoch coercion', () => {
    expect(() => preparePipelineWorkerCapability({ ...registration,databaseOid: 42 } as any)).toThrow();
    expect(() => preparePipelineRiskPolicy({ ...risk,previousEpoch: 1,epoch: '2' } as any)).toThrow();
    expect(() => preparePipelineTrustedWorkerValuation({ ...trusted,revision: 1 } as any)).toThrow();
    expect(() => preparePipelineWorkerPaperReceipt({ ...paperReceipt(),workerFence: 1 } as any)).toThrow();
    expect(() => preparePipelineWorkerRecoverySelector({ executionId: EXECUTION,workerFence: 1,evidenceId: 'inert' } as any)).toThrow();
  });
  it.each(['registry','risk','authority','trusted','valuation','receipt'])('forwards pre-abort to %s without acquiring a physical lease', async kind => {
    const controller = new AbortController(); controller.abort();
    const acquire = vi.fn(),signal = controller.signal;
    const valuations = createProtectedPipelineValuationBacking({ acquire,signal,now: () => time,maximumAgeMs: 2000 });
    let pending: Promise<unknown>;
    if (kind === 'registry') pending = createProtectedPipelineWorkerRegistry({ acquire,signal }).register(registration);
    else if (kind === 'risk') pending = createProtectedPipelineRiskWriter({ acquire,signal }).write(risk);
    else if (kind === 'authority') pending = valuations.register(authority);
    else if (kind === 'trusted') pending = valuations.record(trusted);
    else if (kind === 'valuation') pending = valuations.read(execution());
    else pending = createProtectedPipelinePaperReceiptWriter({ acquire,signal }).record(paperReceipt());
    await expect(pending).rejects.toThrow();
    expect(acquire).not.toHaveBeenCalled();
  });
  it('bounds acquisition and destroys a late physical lease exactly once', async () => {
    vi.useFakeTimers();
    try {
      const late = deferred<any>(),release = vi.fn(),client = { query: vi.fn() };
      const operation = vi.fn();
      const pending = pipelineWriterTransaction(() => late.promise,'worker-register',EXECUTION)(operation);
      const rejected = expect(pending).rejects.toThrow('acquisition timed out');
      await vi.advanceTimersByTimeAsync(PIPELINE_WORKER_BOUNDS.acquisitionMs + 1);
      await rejected;
      late.resolve({ client,release });
      await Promise.resolve(); await Promise.resolve();
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
      expect(operation).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each(['timeout','abort'])('destroys blocked physical query on %s and ignores late success', async mode => {
    vi.useFakeTimers();
    try {
      const blocked = deferred<any>(),entered = deferred<void>(),h = harness('swat_capability_writer',registration);
      h.query.mockImplementation(async () => { entered.resolve(); return blocked.promise; });
      const controller = new AbortController(),operation = vi.fn();
      const pending = pipelineWriterTransaction(h.acquire,'worker-register',EXECUTION,controller.signal)(operation);
      const rejected = expect(pending).rejects.toThrow();
      await entered.promise;
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(PIPELINE_WORKER_BOUNDS.queryMs + 1);
      else controller.abort();
      await rejected;
      expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
      blocked.resolve({ rows: [] }); await Promise.resolve(); await Promise.resolve();
      expect(operation).not.toHaveBeenCalled(); expect(h.query).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('bounds a callback that never finishes, closes its lease, and refuses escaped use', async () => {
    vi.useFakeTimers();
    try {
      const h = harness('swat_capability_writer',registration),entered = deferred<void>(),blocked = deferred<string>();
      let escaped: any;
      const pending = pipelineWriterTransaction(h.acquire,'worker-register',EXECUTION)(async client => {
        escaped = client; entered.resolve(); return blocked.promise;
      });
      const rejected = expect(pending).rejects.toThrow('transaction cancelled/timed out');
      await entered.promise;
      await vi.advanceTimersByTimeAsync(PIPELINE_WORKER_BOUNDS.transactionMs + 1); await rejected;
      expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
      await expect(escaped.query('SELECT 1')).rejects.toThrow();
      blocked.resolve('late-success'); await Promise.resolve(); await Promise.resolve();
      expect(h.calls.some(c => c.sql === 'COMMIT')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('rejects concurrent physical-client reuse without releasing the first holder', async () => {
    const h = harness('swat_capability_writer',registration),entered = deferred<void>(),finish = deferred<string>();
    const first = pipelineWriterTransaction(h.acquire,'worker-register',EXECUTION)(async () => {
      entered.resolve(); return finish.promise;
    });
    await entered.promise;
    const secondRelease = vi.fn();
    await expect(pipelineWriterTransaction(async () => ({ client: h.client,release: secondRelease }),
      'worker-register',EXECUTION)(async () => 'unauthorized')).rejects.toThrow('physical lease refused');
    expect(secondRelease).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
    finish.resolve('first'); expect(await first).toBe('first');
    expect(h.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('quarantines a broken client even when host destruction throws', async () => {
    const h = harness('swat_capability_writer',registration);
    h.query.mockRejectedValue(new Error('inert query failure'));
    h.release.mockImplementation(() => { throw new Error('inert destroy failure'); });
    await expect(pipelineWriterTransaction(h.acquire,'worker-register',EXECUTION)(async () => 'no')).rejects.toThrow();
    const otherRelease = vi.fn();
    await expect(pipelineWriterTransaction(async () => ({ client: h.client,release: otherRelease }),
      'worker-register',EXECUTION)(async () => 'no')).rejects.toThrow('quarantined');
    expect(otherRelease).not.toHaveBeenCalled(); expect(h.release).toHaveBeenCalledTimes(1);
  });
  it('poisons swallowed nested transactions so neither can commit', async () => {
    const h = harness('swat_capability_writer',registration),inner = harness('swat_capability_writer',registration);
    await expect(pipelineWriterTransaction(h.acquire,'worker-register',EXECUTION)(async () => {
      await pipelineWriterTransaction(inner.acquire,'worker-register',EXECUTION)(async () => 'nested').catch(() => {});
      return 'swallowed';
    })).rejects.toThrow('poisoned');
    expect(inner.acquire).not.toHaveBeenCalled();
    expect(h.calls.some(c => c.sql === 'COMMIT')).toBe(false);
  });
  it('withholds receipt success and canonical settlement until checked writer COMMIT', async () => {
    const receipt = paperReceipt(),h = harness('swat_worker_receipt_writer',receipt),entered = deferred<void>(),commit = deferred<any>();
    const baseQuery = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql,values) => {
      if (sql === 'COMMIT') { entered.resolve(); return commit.promise; }
      return baseQuery(sql,values);
    });
    const settlement = vi.fn();
    const pending = createProtectedPipelinePaperReceiptWriter({ acquire: h.acquire }).record(receipt).then(settlement);
    await entered.promise; expect(settlement).not.toHaveBeenCalled();
    commit.resolve({ command: 'COMMIT',rows: [] }); await pending;
    expect(settlement).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(['ROLLBACK','lost','abort'])('refuses receipt %s COMMIT and never invokes canonical settlement', async mode => {
    const receipt = paperReceipt(),h = harness('swat_worker_receipt_writer',receipt),controller = new AbortController();
    const baseQuery = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql,values) => {
      if (sql === 'COMMIT') {
        if (mode === 'lost') throw new Error('inert connection loss after COMMIT');
        if (mode === 'abort') controller.abort();
        return { command: mode === 'ROLLBACK' ? 'ROLLBACK' : 'COMMIT',rows: [] };
      }
      return baseQuery(sql,values);
    });
    const settlement = vi.fn();
    await expect(createProtectedPipelinePaperReceiptWriter({ acquire: h.acquire,signal: controller.signal })
      .record(receipt).then(settlement)).rejects.toThrow();
    expect(settlement).not.toHaveBeenCalled(); expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.calls.some(c => c.sql === 'ROLLBACK')).toBe(false);
  });
  it('checks composition receipt COMMIT/read ordering before actual canonical worker settlement', () => {
    const app = readFileSync(new URL('../../../apps/trade-executor/src/wave4-pipeline-protected-composition.ts',import.meta.url),'utf8');
    const write = app.indexOf('await receipts.record('),read = app.indexOf('await checkedTransaction(client => assertPipelineWorkerPaperReceiptWithClient');
    expect(write).toBeGreaterThan(0); expect(read).toBeGreaterThan(write);
    expect(app.indexOf('return outcome;',read)).toBeGreaterThan(read);
    expect(app).toContain('runCanonicalWorkerJob(captured,owned.ports)');
    expect(app).not.toMatch(/runtimeAcquire|swat_claim_runtime_capability\(|INSERT INTO.*(?:trades|copy_execution_evidence)|SET ROLE/);
    expect(app).toContain('acquire: receiptAcquire,signal');
  });
  it('snapshots caller Date and advances evidence freshness across database waits', async () => {
    const now = new Date(time),clock = pipelineElapsedClock(now),before = clock().getTime();
    now.setTime(0); expect(clock().getTime()).toBeGreaterThanOrEqual(before);
    expect(() => pipelineElapsedClock(new Date(NaN))).toThrow('finite');
    const value = paperEvidence(),h = harness('swat_valuation_writer',value),baseQuery = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql,values) => {
      if (sql.includes('statement_timestamp() AS database_now')) return { rows: [{ database_now: new Date(expiry) }] };
      return baseQuery(sql,values);
    });
    await expect(readPipelinePaperValuationWithClient(h.client,execution(value),time,2000)).rejects.toThrow('expired');
  });
  it('reconstructs identity-only restart from persisted records despite current stop and risk epoch change', async () => {
    const h = recoveryHarness(),persisted = await readPipelineWorkerRecoveryWithClient(h.client,h.selector,time);
    expect(persisted.execution).toEqual(h.e); expect(persisted.attempt).toEqual(attempt);
    expect(persisted.risk?.policyEpoch).toBe('1'); expect(persisted.slippageBps).toBe(50);
    expect(persisted.delivery?.claim.fence).toBe('7'); expect(persisted.attempt.fence).toBe('1');
    expect(persisted.evidence).toEqual(receiptInput(h.receipt));
    expect(persisted.executor).toBe('paper-exact-simulated');
  });
  it('does not trust legacy caller slippage while preserving exact comparison scope', async () => {
    const h = recoveryHarness(),persisted = await readPipelineWorkerRecoveryWithClient(h.client,h.selector,time);
    const next = await readPipelineWorkerRecoveryWithClient(h.client,{ ...persisted,slippageBps: 0 },time);
    expect(next.slippageBps).toBe(50);
    await expect(readPipelineWorkerRecoveryWithClient(h.client,{ ...persisted,attempt: { ...persisted.attempt,fence: '8' } },time))
      .rejects.toThrow('never resend');
  });
  it.each(['receipt','attempt','reservation','descriptor','policy','claimed-expiry','original','original-id'])('fails closed on missing/conflicting recovery %s before settlement', async mode => {
    const h = recoveryHarness();
    if (mode === 'receipt') h.state.output = null;
    if (mode === 'attempt') h.recovery.attempt.state = 'prepared';
    if (mode === 'reservation') h.recovery.reservation.execution_id = SOURCE;
    if (mode === 'descriptor') h.recovery.delivery.descriptor.data.requestedQuoteQuantity = '21';
    if (mode === 'policy') vi.mocked(readCapturedWorkerPolicyWithClient).mockResolvedValue({ ...h.snapshot,revision: 'f'.repeat(64) });
    if (mode === 'claimed-expiry') {
      h.recovery.delivery.state = 'claimed'; h.recovery.delivery.lease_owner = 'inert-owner';
      h.recovery.delivery.lease_until = new Date(time.getTime() + 1000); h.state.now = new Date(time.getTime() + 2000);
    }
    if (mode === 'original') h.recovery.original.fee_usd = '0';
    await expect(readPipelineWorkerRecoveryWithClient(h.client,h.selector,time,mode === 'original-id' ? SOURCE : undefined)).rejects.toThrow();
    expect(h.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql))).toBe(false);
  });
  it('requires persisted original for NULL quote/price/fee and rejects invented zero', async () => {
    const h = recoveryHarness(true),persisted = await readPipelineWorkerRecoveryWithClient(h.client,h.selector,time,ORIGINAL);
    expect(persisted.evidence.quoteLeg).toBeNull(); expect(persisted.evidence.priceUsd).toBeNull(); expect(persisted.evidence.feeUsd).toBeNull();
    expect(() => assertPipelineOriginalPaperEvidence({ ...h.recovery.original,fee_usd: '0' },h.receipt)).toThrow('original');
    h.recovery.original = null;
    await expect(readPipelineWorkerRecoveryWithClient(h.client,h.selector,time)).rejects.toThrow('persisted original');
  });
  it.each(['native-amount','native-price','currency','no-quote-native','unknown-price','unknown-fee'])('compares all immutable canonical original quote fields and refuses %s mismatch', mode => {
    const receipt = paperReceipt(mode.startsWith('unknown') || mode === 'no-quote-native' ? { quoteLeg: null,priceUsd: null,feeUsd: null } : {});
    const original = originalRow(receipt);
    expect(() => assertPipelineOriginalPaperEvidence(original,receipt)).not.toThrow();
    if (mode === 'native-amount') original.quote_native_quantity = null;
    if (mode === 'native-price') original.quote_native_usd_price = null;
    if (mode === 'currency') original.quote_currency = null;
    if (mode === 'no-quote-native') original.quote_native_quantity = '0';
    if (mode === 'unknown-price') original.price_usd = '0';
    if (mode === 'unknown-fee') original.fee_usd = '0';
    expect(() => assertPipelineOriginalPaperEvidence(original,receipt)).toThrow('original');
  });
  it.each([
    { originalBase: '1.000000000000000000',receiptBase: '1' },
    { originalBase: '1',receiptBase: `1.${'0'.repeat(36)}` },
    { originalBase: '6.666666666666666666000000000000000000',receiptBase: '6.666666666666666666' },
    { originalBase: '9007199254740993.000000000000000001000000000000000000',receiptBase: '9007199254740993.000000000000000001' },
    { originalBase: '9007199254740993.123456789012345678901234567890123450',receiptBase: '9007199254740993.12345678901234567890123456789012345' },
    { originalBase: `0.${'0'.repeat(35)}1`,receiptBase: `0.${'0'.repeat(35)}1` },
    { originalBase: `${'9'.repeat(78)}.${'0'.repeat(36)}`,receiptBase: '9'.repeat(78) }
  ])('compares exact original base $originalBase with receipt $receiptBase without changing immutable text', ({ originalBase,receiptBase }) => {
    const receipt = paperReceipt({ baseQuantity: receiptBase,quoteLeg: null,priceUsd: null,feeUsd: null });
    const original = { ...originalRow(receipt),base_quantity: originalBase };
    expect(() => preparePipelineWorkerPaperReceipt(receipt)).not.toThrow();
    expect(() => assertPipelineOriginalPaperEvidence(original,receipt)).not.toThrow();
    expect(original.base_quantity).toBe(originalBase); expect(receipt.evidence.baseQuantity).toBe(receiptBase);
  });
  it.each([
    { originalBase: `1.${'0'.repeat(35)}1`,receiptBase: '1' },
    { originalBase: '1',receiptBase: `1.${'0'.repeat(35)}1` },
    { originalBase: '9007199254740992',receiptBase: '9007199254740993' },
    { originalBase: '9007199254740993.000000000000000001',receiptBase: '9007199254740993.000000000000000002' },
    { originalBase: `${'9'.repeat(78)}.123456789012345678901234567890123456`,receiptBase: `${'9'.repeat(78)}.123456789012345678901234567890123457` },
    { originalBase: `0.${'0'.repeat(35)}1`,receiptBase: `0.${'0'.repeat(35)}2` }
  ])('refuses true base difference $originalBase versus $receiptBase down to the 36th fractional digit', ({ originalBase,receiptBase }) => {
    const receipt = paperReceipt({ baseQuantity: receiptBase,quoteLeg: null,priceUsd: null,feeUsd: null });
    expect(() => preparePipelineWorkerPaperReceipt(receipt)).not.toThrow();
    expect(() => assertPipelineOriginalPaperEvidence({ ...originalRow(receipt),base_quantity: originalBase },receipt)).toThrow('original');
  });
  it.each([null,undefined,1,NaN,Infinity,'','0','0.000000000000000000','-1','+1','01','1e0','1.','.1',' 1','1 ',
    'NaN','Infinity','1.0garbage','1\u0000','1'.repeat(257)])('refuses NULL, zero, numeric or malformed base %s on either side', invalid => {
    const receipt = paperReceipt({ baseQuantity: '1',quoteLeg: null,priceUsd: null,feeUsd: null }),original = originalRow(receipt);
    expect(() => assertPipelineOriginalPaperEvidence({ ...original,base_quantity: invalid as any },receipt)).toThrow('Exact decimal');
    const hostile = { ...receipt,evidence: { ...receipt.evidence,baseQuantity: invalid as any } };
    expect(() => assertPipelineOriginalPaperEvidence(original,hostile)).toThrow('Exact decimal');
    expect(() => preparePipelineWorkerPaperReceipt(hostile)).toThrow();
  });
  it('reconstructs recovery from padded NUMERIC base text but refuses a real 36th-place change', async () => {
    const h = recoveryHarness(),base = `${h.receipt.evidence.baseQuantity}${'0'.repeat(18)}`;
    h.recovery.original.base_quantity = base;
    const persisted = await readPipelineWorkerRecoveryWithClient(h.client,h.selector,time,ORIGINAL);
    expect(persisted.evidence.baseQuantity).toBe(h.receipt.evidence.baseQuantity);
    expect(h.recovery.original.base_quantity).toBe(base);
    h.recovery.original.base_quantity = `${base.slice(0,-1)}1`;
    await expect(readPipelineWorkerRecoveryWithClient(h.client,h.selector,time,ORIGINAL)).rejects.toThrow('original');
    expect(h.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql))).toBe(false);
  });
  it('retains canonical USD amount/amount/1 and four NULL no-quote fields with unknown price and fee', () => {
    const receipt = paperReceipt({ baseQuantity: '1',quoteLeg: { amount: '1',currency: 'USD' },priceUsd: null,feeUsd: null });
    const original = { ...originalRow(receipt),base_quantity: '1.000000000000000000',quote_quantity: '1.000000000000000000',
      quote_native_quantity: '1.000000000000000000',quote_native_usd_price: '1.000000000000000000' };
    expect(() => assertPipelineOriginalPaperEvidence(original,receipt)).not.toThrow();
    expect(original.price_usd).toBeNull(); expect(original.fee_usd).toBeNull();
    const unvalued = paperReceipt({ baseQuantity: '1',quoteLeg: null,priceUsd: null,feeUsd: null }),absent = originalRow(unvalued);
    expect([absent.quote_quantity,absent.quote_native_quantity,absent.quote_currency,absent.quote_native_usd_price]).toEqual([null,null,null,null]);
    expect(() => assertPipelineOriginalPaperEvidence(absent,unvalued)).not.toThrow();
    for (const [field,value] of [['quote_quantity','0'],['quote_native_quantity','0'],['quote_currency','USD'],
      ['quote_native_usd_price','1'],['price_usd','0'],['fee_usd','0']] as const) {
      expect(() => assertPipelineOriginalPaperEvidence({ ...absent,[field]: value },unvalued)).toThrow('original');
    }
  });
  it('rejects late acquisition after abort without leaking or reusing its client', async () => {
    const late = deferred<any>(),release = vi.fn(),controller = new AbortController(),started = deferred<void>();
    const acquire = vi.fn(() => { started.resolve(); return late.promise; });
    const operation = vi.fn(),pending = pipelineWriterTransaction(acquire,'worker-register',EXECUTION,controller.signal)(operation);
    const rejected = expect(pending).rejects.toThrow();
    await started.promise; controller.abort(); await rejected;
    const client = { query: vi.fn() };
    late.resolve({ client,release }); await Promise.resolve(); await Promise.resolve();
    expect(release).toHaveBeenCalledWith(true); expect(release).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
    const nextRelease = vi.fn();
    await expect(pipelineWriterTransaction(async () => ({ client: client as any,release: nextRelease }),
      'worker-register',EXECUTION)(async () => 'no')).rejects.toThrow('quarantined');
    expect(nextRelease).not.toHaveBeenCalled();
  });
  it('poisons swallowed overlapping queries and refuses queries escaped after checked success', async () => {
    const h = harness('swat_capability_writer',registration),blocked = deferred<any>(),entered = deferred<void>();
    const baseQuery = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql,values) => {
      if (sql === 'SELECT inert_blocked') { entered.resolve(); return blocked.promise; }
      return baseQuery(sql,values);
    });
    const pending = pipelineWriterTransaction(h.acquire,'worker-register',EXECUTION)(async client => {
      const first = client.query('SELECT inert_blocked'); await entered.promise;
      await client.query('SELECT inert_overlap').catch(() => {});
      blocked.resolve({ rows: [] }); await first;
      return 'swallowed';
    });
    await expect(pending).rejects.toThrow();
    expect(h.calls.some(c => c.sql === 'COMMIT')).toBe(false);
    const fresh = harness('swat_capability_writer',registration);
    let escaped: any;
    expect(await pipelineWriterTransaction(fresh.acquire,'worker-register',EXECUTION)(async client => {
      escaped = client; return 'checked';
    })).toBe('checked');
    const count = fresh.query.mock.calls.length;
    await expect(escaped.query('SELECT inert_escape')).rejects.toThrow('expired');
    expect(fresh.query).toHaveBeenCalledTimes(count);
  });
  it('rechecks protected approval revocation before receipt COMMIT', async () => {
    const receipt = paperReceipt(),h = harness('swat_worker_receipt_writer',receipt),baseQuery = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql,values) => {
      const result = await baseQuery(sql,values);
      if (sql.includes(' AS result')) h.state.approved = false;
      return result;
    });
    const settlement = vi.fn();
    await expect(createProtectedPipelinePaperReceiptWriter({ acquire: h.acquire }).record(receipt).then(settlement)).rejects.toThrow('unavailable');
    expect(settlement).not.toHaveBeenCalled(); expect(h.calls.some(c => c.sql === 'COMMIT')).toBe(false);
    expect(h.release).toHaveBeenCalledWith(true);
  });
  it('refuses changed-revision sell without a persisted historical admission policy seam', async () => {
    const h = recoveryHarness();
    vi.mocked(readWorkerExecutionContextWithClient).mockResolvedValue({ ...h.context,execution: { ...h.e,direction: 'sell' } });
    vi.mocked(readCapturedWorkerPolicyWithClient).mockResolvedValue({ ...h.snapshot,revision: 'f'.repeat(64) });
    await expect(readPipelineWorkerRecoveryWithClient(h.client,h.selector,time)).rejects.toThrow('historical policy seam');
  });
  it('lot-exit reconstruction does not invent source fanout delivery when source lineage is retained', async () => {
    const h = recoveryHarness(),sell = { ...h.e,direction: 'sell',exitLotId: ORIGINAL,exitTrigger: 'stop-loss',
      requestedBaseQuantity: '1',requestedQuoteQuantity: null };
    h.recovery.attempt.risk_epoch = null as any;
    h.recovery.original = null;
    const { receiptId: _id,...body } = h.receipt;
    const terms = { ...body,riskEpoch: null },receipt = { ...terms,receiptId: pipelineWorkerReceiptDigest(terms) };
    h.state.output = receipt;
    vi.mocked(readWorkerExecutionContextWithClient).mockResolvedValue({ ...h.context,execution: sell,ownedExit: {
      lotId: ORIGINAL,availableQuantity: '0',requestedQuantity: '1',acquisitionMode: 'paper',maxSlippageBps: 25 } });
    const persisted = await readPipelineWorkerRecoveryWithClient(h.client,h.selector,time);
    expect(persisted.delivery).toBeUndefined(); expect(persisted.risk).toBeNull(); expect(persisted.slippageBps).toBe(25);
  });
});
