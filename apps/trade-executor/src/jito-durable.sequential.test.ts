import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJupiterJitoRuntime, type JupiterJitoPendingStore, type JupiterJitoResolution } from './jupiter-jito-runtime.js';
import { createCanonicalJitoQuote, createJitoReceiptCommit, dispatchSolanaTrade, mapSubmissionToOutcome, SOL_MINT } from './solana-dispatch.js';
import { createJupiterJitoRuntimeFromEnvironment, getConfiguredCanonicalJitoQuote, getJupiterJitoLiveReadiness,
  resetJupiterJitoRuntimeForTests, settleConfiguredJitoResolution } from './jupiter-jito-config.js';
import { assertQuantifiedJitoReceipt, retainWorkerUncertaintyWithClient, reconcileWorkerFillWithClient,
  type DurableJitoPending, type QuantifiedJitoReceipt, type CopyExecutionRecord } from '@swat/db';
const transport = vi.hoisted(() => ({ build: vi.fn(), post: vi.fn(), status: vi.fn(), floor: vi.fn(), accounts: vi.fn() }));
vi.mock('@swat/shared', async original => ({ ...await original<typeof import('@swat/shared')>(),
  buildJupiterSwap: transport.build, submitJitoBundle: transport.post, getJitoBundleStatus: transport.status,
  getJitoTipFloor: transport.floor, getJitoTipAccounts: transport.accounts }));
const execution = { executionId: 'execution', clientOrderId: 'order', userId: null, chain: 'solana', targetAccount: 'solana:wallet' } as const;
const attempt = { executionId: 'execution', userId: null, fence: '1', policyRevision: 'revision', riskEpoch: null };
const intent = { inputMint: 'token', outputMint: SOL_MINT, inputAmountRaw: '1000', minimumOutputAmountRaw: '941',
  slippageBps: 100, recipient: 'wallet', tokenDecimals: 3, maxFeeLamports: '1000000', maxFeeUsd: '1' };
const quote = { inputMint: 'token', outputMint: SOL_MINT, inAmount: '1000', outAmount: '950', otherAmountThreshold: '941',
  swapMode: 'ExactIn' as const, slippageBps: 100, priceImpactPct: '0', routePlan: [], contextSlot: 1 };
const pending: DurableJitoPending = { clientOrderId: 'order', execution, intent, attempt, bundleId: null,
  signedTransactions: ['c3dhcA==','dGlw'], signatures: ['swap-signature','tip-signature'], lastValidBlockHeight: 1000,
  expiresAt: new Date('2026-11-16T00:10:00Z'), tipLamports: 10000 };
const receipt: QuantifiedJitoReceipt = { execution, signature: 'swap-signature', slot: 42, inputMint: 'token', outputMint: SOL_MINT,
  inputAmountRaw: '1000', outputAmountRaw: '942', feeLamports: '15000', feeUsd: '0.1', quoteUsd: '10', baseQuantity: '1',
  recipient: 'wallet', confirmationState: 'finalized', occurredAt: new Date('2026-11-16T00:00:01Z') };
let events: string[];
function store() {
  const claims = new Set<string>(); let p: typeof pending | null = null; let r: JupiterJitoResolution | null = null;
  const value: JupiterJitoPendingStore = { findPending: async () => p, findResolution: async () => r,
    listPending: async () => p ? [p] : [],
    claim: vi.fn(async e => { events.push('claim-commit'); if (claims.has(e.clientOrderId)) return false; claims.add(e.clientOrderId); return true; }),
    prepare: vi.fn(async v => { events.push('prepare-commit'); p = v as DurableJitoPending; }),
    save: vi.fn(async v => { events.push('response-commit'); p = v as DurableJitoPending; }),
    resolve: vi.fn(async (_id, resolution) => { events.push('ack'); r = resolution; p = null; }) };
  return value;
}
function runtime(s = store(), overrides: Partial<Parameters<typeof createJupiterJitoRuntime>[0]> = {}) {
  return createJupiterJitoRuntime({ pendingStore: s, jito: { baseUrl: 'https://inert.test' },
    signTransaction: vi.fn(async tx => tx === 'swap' ? 'c3dhcA==' : 'dGlw'), buildTipTransaction: async () => 'tip',
    extractSignatures: async () => ['swap-signature','tip-signature'], authorizeSignedBundle: async () => { events.push('authorize'); return true; },
    maxTipLamports: 1000000, fallbackTipLamports: 10000, pendingTtlMs: 600000, now: () => new Date('2026-11-16T00:00:00Z'), ...overrides });
}
const submit = { clientOrderId: 'order', execution, intent, attempt, quote, signerPublicKey: 'wallet' };
beforeEach(() => { vi.clearAllMocks(); resetJupiterJitoRuntimeForTests(); events = [];
  transport.build.mockResolvedValue({ swapTransaction: 'swap', lastValidBlockHeight: 1000 });
  transport.floor.mockResolvedValue(null); transport.accounts.mockResolvedValue(['TipAccountzzzzzzzzzzzzzzzzzzzzzzzz']);
  transport.status.mockResolvedValue(null); transport.post.mockImplementation(async () => { events.push('POST'); return { ok: true, bundleId: 'bundle' }; }); });
describe('actual Jito runtime durable seams', () => {
  it('commits canonical claim and exact signed prewrite before final authority and POST', async () => {
    const s = store(); expect((await runtime(s).submit(submit)).status).toBe('submitted');
    expect(events).toEqual(['claim-commit','prepare-commit','authorize','POST','response-commit']);
    expect(s.claim).toHaveBeenCalledWith(execution, intent, attempt);
    expect(s.prepare).toHaveBeenCalledWith(expect.objectContaining({ signedTransactions: pending.signedTransactions, signatures: pending.signatures, attempt }));
  });
  it('concurrent submit winners cannot duplicate an irreversible POST', async () => {
    const rt = runtime(); const results = await Promise.all([rt.submit(submit),rt.submit(submit)]);
    expect(results.some(r => r.status === 'submission_unknown')).toBe(true); expect(transport.post).toHaveBeenCalledOnce();
  });
  it.each(['execution','intent','attempt'] as const)('refuses absent %s before build/sign/POST', async key => {
    expect((await runtime().submit({ ...submit, [key]: undefined })).status).toBe('rejected'); expect(transport.build).not.toHaveBeenCalled();
  });
  it('refuses a quote-derived wider output minimum', async () => {
    expect((await runtime().submit({ ...submit, intent: { ...intent, minimumOutputAmountRaw: '950' } })).status).toBe('rejected');
    expect(transport.post).not.toHaveBeenCalled();
  });
  it('refuses Redis/nonclaim store and absent final-byte authority before signing', async () => {
    const rt = runtime(store(), { authorizeSignedBundle: undefined }); expect((await rt.submit(submit)).status).toBe('rejected');
    expect(transport.build).not.toHaveBeenCalled();
  });
  it('prewrite rollback or unknown commit never invokes POST', async () => {
    const s = store(); s.prepare = vi.fn(async () => { throw new Error('commit lost'); });
    expect((await runtime(s).submit(submit)).status).toBe('submission_unknown'); expect(transport.post).not.toHaveBeenCalled();
  });
  it('fresh authority refusal after exact prewrite preserves the durable claim', async () => {
    const s = store(); expect((await runtime(s, { authorizeSignedBundle: async () => false }).submit(submit)).status).toBe('submission_unknown');
    expect(await s.findPending('order')).not.toBeNull(); expect(transport.post).not.toHaveBeenCalled();
  });
  it.each(['throw','bad-response','4xx'] as const)('POST %s uncertainty retains exact bytes and forbids resend', async failure => {
    transport.post.mockImplementation(async () => { if (failure === 'throw') throw new Error('lost');
      return failure === '4xx' ? { ok: false, reason: '4xx', retryable: false } : { ok: true, bundleId: 'pending_unknown' }; });
    const s = store(); const rt = runtime(s); expect((await rt.submit(submit)).status).toBe('submission_unknown');
    expect((await rt.submit(submit)).status).toBe('submission_unknown'); expect(transport.post).toHaveBeenCalledOnce();
    expect((await s.findPending('order'))?.signedTransactions).toEqual(pending.signedTransactions);
  });
  it('bundle Landed/Failed/expiry status is never a quantified receipt', async () => {
    for (const status of ['Landed','Failed','Invalid']) {
      transport.status.mockResolvedValue({ bundleId: 'bundle', status, transactions: ['swap-signature'], slot: 42 });
      expect((await runtime().reconcile({ ...pending, bundleId: 'bundle' },1001))?.status).toBe('ambiguous');
    }
  });
  it('unknown POST is reconciled by exact persisted swap signature, not response identity', async () => {
    const resolution = await runtime(store(), { readReceipt: async () => receipt }).reconcile(pending);
    expect(resolution).toMatchObject({ status: 'filled', signature: 'swap-signature', receipt }); expect(transport.status).not.toHaveBeenCalled();
  });
  it('sweep observes but never clears pending before settlement', async () => {
    const s = store(); await s.save(pending); const rt = runtime(s, { readReceipt: async () => receipt });
    expect(await rt.sweep()).toHaveLength(1); expect(await s.findPending('order')).not.toBeNull(); expect(s.resolve).not.toHaveBeenCalled();
  });
  it('settle invokes same-client commit adapter and waits for COMMIT before ack', async () => {
    const s = store(); await s.save(pending); events = [];
    const resolution = { status: 'filled', clientOrderId: 'order', signature: receipt.signature, slot: receipt.slot, receipt } as const;
    const client = {} as never; const financial = vi.fn(async c => { expect(c).toBe(client); events.push('financial'); return true; });
    const commit = createJitoReceiptCommit(async operation => { const result = await operation(client); events.push('COMMIT'); return result; }, financial);
    expect(await runtime(s).settle(resolution, commit)).toBe(true); expect(events).toEqual(['financial','COMMIT','ack']);
  });
  it('rollback/unknown financial commit cannot ack and duplicate reconciliation stays replayable', async () => {
    const s = store(); await s.save(pending); const rt = runtime(s);
    const resolution = { status: 'filled', clientOrderId: 'order', signature: receipt.signature, slot: receipt.slot, receipt } as const;
    expect(await rt.settle(resolution, createJitoReceiptCommit(async () => { throw new Error('rollback'); }))).toBe(false);
    expect(s.resolve).not.toHaveBeenCalled(); expect(await s.findPending('order')).not.toBeNull();
    expect(await rt.settle(resolution, async () => true)).toBe(true); expect(await rt.settle(resolution, async () => true)).toBe(false);
  });
});
describe('real worker uncertainty/reconciliation lock ordering', () => {
  it('both invoked paths acquire position→execution before attempt and terminal reread remains intact', async () => {
    const canonical = { id: 'execution',userId: null,chain: 'solana',targetAccount: 'solana:wallet',tokenMint: 'solana:token',
      direction: 'sell',executionMode: 'live' } as CopyExecutionRecord;
    let trace: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) { trace.push('position'); return { rows: [] }; }
      if (sql.startsWith('SELECT id FROM copy_executions')) { trace.push('execution'); return { rows: [{ id: 'execution' }] }; }
      if (sql.includes('copy_execution_worker_attempts')) { trace.push('attempt'); return { rows: [{ state: 'dispatched',execution_id: 'execution' }] }; }
      if (sql.includes('AS accounting_complete')) { trace.push('terminal-reread'); return { rows: [{ state: 'confirmed',accounting_complete: true }] }; }
      if (sql.startsWith('SELECT confirmed_quote')) { trace.push('financial-after-locks'); throw new Error('fixture stops before financial writes'); }
      throw new Error(`Unexpected lock fixture SQL ${sql}`);
    }) } as unknown as import('@swat/db').PoolClient;
    await retainWorkerUncertaintyWithClient(client,{ execution: canonical,attempt,risk: null,reason: 'late callback' });
    expect(trace).toEqual(['position','execution','attempt','terminal-reread']);
    const advisory = vi.mocked(client.query).mock.calls[0]![1] as unknown[];
    expect(advisory).toEqual([JSON.stringify(['solana:wallet','solana','solana:token',null])]);
    trace = [];
    await expect(reconcileWorkerFillWithClient(client,{ execution: canonical,attempt,risk: null,executor: 'jupiter-jito',slippageBps: 100,
      evidence: { executionId: 'execution',evidenceType: 'chain_receipt',evidenceId: receipt.signature,baseQuantity: '1',
        quoteLeg: { amount: '10',currency: 'USD' },feeUsd: '0.1',confirmationState: 'confirmed',completesExecution: true,occurredAt: receipt.occurredAt } },
    async owned => { expect(owned).toBe(client); trace.push('receipt-ownership'); })).rejects.toThrow('fixture stops before financial writes');
    expect(trace).toEqual(['position','execution','receipt-ownership','attempt','financial-after-locks']);
  });
});

describe('strict quantified receipt bounds', () => {
  it.each([{ inputAmountRaw: '999' },{ inputAmountRaw: '1001' },{ outputAmountRaw: '899' },{ signature: 'tip-signature' },
    { recipient: 'foreign' },{ feeLamports: '1' },{ feeLamports: '1000001' },{ feeUsd: '1.000000000000000001' },
    { baseQuantity: '1000' },{ quoteUsd: 'NaN' },{ confirmationState: 'observed' },{ execution: { ...execution,userId: 'other' } }])(
    'refuses mismatched receipt %j', change => expect(() => assertQuantifiedJitoReceipt({ ...receipt,...change } as QuantifiedJitoReceipt,pending)).toThrow());
  it('accepts exact raw token scale without float conversion', () => expect(() => assertQuantifiedJitoReceipt(receipt,pending)).not.toThrow());
});
describe('canonical dispatch and config unavailable neighbors', () => {
  it('legacy dispatch cannot send a quote without independent identity', async () => {
    const rt = runtime(); expect(await dispatchSolanaTrade({ clientOrderId: 'order', tokenMint: 'token', direction: 'sell',
      amountSol: 0, sellBaseUnits: '1000', slippageBps: 100 },{ runtime: rt,signerPublicKey: 'wallet' })).toMatchObject({ reason: 'canonical-jito-intent-unavailable' });
    expect(transport.build).not.toHaveBeenCalled();
  });
  it('legacy resolved signature cannot become filled accounting', () => expect(mapSubmissionToOutcome({ status: 'already_resolved',clientOrderId: 'order',
    resolution: { status: 'filled',clientOrderId: 'order',signature: 'sig',slot: 1 } })).toMatchObject({ kind: 'ambiguous' }));
  it('canonical quote joins exact execution, independent intent and original worker fence', async () => {
    const rt = runtime(); const canonical = { id: 'execution',clientOrderId: 'order',userId: null,chain: 'solana',targetAccount: 'solana:wallet',
      executionMode: 'live',tokenMint: 'solana:token',direction: 'sell',requestedBaseQuantity: '1' } as CopyExecutionRecord;
    const q = await createCanonicalJitoQuote({ runtime: rt,signerPublicKey: 'wallet', observe: async () => ({ intent, quote,requestedDebitUsd: null }) })(canonical,100);
    expect(q).not.toBeNull(); expect(await q!.execute({ execution: canonical,attempt,maxSlippageBps: 100,risk: null })).toMatchObject({ kind: 'unknown' });
    expect(transport.post).toHaveBeenCalledOnce();
    expect(await createCanonicalJitoQuote({ runtime: rt,signerPublicKey: 'wallet', observe: async () => ({ intent,quote,requestedDebitUsd: null }) })({ ...canonical,requestedBaseQuantity: '2' },100)).toBeNull();
  });
  it('environment boot does not inspect signer, Redis or readiness flags', async () => {
    const redis = { hget: vi.fn(),hset: vi.fn(),hgetall: vi.fn() };
    expect(createJupiterJitoRuntimeFromEnvironment(redis)).toBeNull(); expect(getJupiterJitoLiveReadiness().ready).toBe(false);
    expect(await getConfiguredCanonicalJitoQuote()({} as never,100)).toBeNull();
    expect(await settleConfiguredJitoResolution({ status: 'ambiguous',clientOrderId: 'order',reason: 'unknown' })).toBe(false);
    expect(redis.hget).not.toHaveBeenCalled();
  });
});
