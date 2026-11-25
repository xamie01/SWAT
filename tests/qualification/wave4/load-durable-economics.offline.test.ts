import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import { sourceBindingDigest } from '../../../packages/db/src/source-verification.js';
import { captureLoadFixture, loadAmount, loadDigest, loadFixtureRequest, loadReceiptDigest,
  type LoadFixture } from './load-durable-contract.js';
import { assertLoadOriginalQuoteEncoding, drainLoadAccounting, loadCaptureKinds, requireLoadFinalAccounting,
  type LoadFinalAccounting, type LoadDrainPorts } from './load-durable-economics.js';
import { createLoadDurableSqlObserver } from './load-durable-observer.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FIXTURE = '33333333-3333-4333-8333-333333333333';
const SOURCE = '44444444-4444-4444-8444-444444444444';
const SIGNAL = '55555555-5555-4555-8555-555555555555';
const EXECUTION = '66666666-6666-4666-8666-666666666666';
const EVIDENCE = '77777777-7777-4777-8777-777777777777';
const TRADE = '88888888-8888-4888-8888-888888888888';
const POSITION = '99999999-9999-4999-8999-999999999999';
const LOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REPLAY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const scope = { runId: RUN, namespace: `wave4-load-${RUN}`, network: `solana:wave4-${RUN}`, backendIdentity: 'inert-owned-backend-not-approval' };
const walletAddress = 'solana:11111111111111111111111111111111';
const tokenMint = 'solana:11111111111111111111111111111112';
const at = '2026-11-23T00:00:00.000Z';
function journal(): LoadFinalAccounting {
  const fixture: LoadFixture = { scope, fixtureId: FIXTURE, userId: USER, kind: 'wallet', walletAddress, tokenMint,
    targetAccount: walletAddress, binding: { chain: 'solana', network: scope.network, sourceEventType: 'transaction',
      sourceEventId: `${scope.namespace}/${FIXTURE}`, sourceEventIndex: '0', transactionHash: `${scope.namespace}/${FIXTURE}`,
      walletAddress, tokenMint, side: 'buy', rawQuantity: '9007199254740993000000000000000001', quantityScale: 18,
      eventAt: at, amountUsd: '1', priceUsd: null, feeUsd: '0' },
    // Intentionally different master vs follower sizing, beyond JS integer precision.
    base: { raw: '9007199254740993000000000000000002', scale: 18 },
    quoteBudget: { raw: '124000000000000000000', scale: 18 },
    quote: { raw: '123456789012345678901', scale: 18 }, fee: { raw: '1', scale: 18 }, requestDigest: '' };
  (fixture as { requestDigest: string }).requestDigest = loadDigest(loadFixtureRequest(fixture));
  const base = '9007199254740993.000000000000000002', quote = '123.456789012345678901', fee = '0.000000000000000001';
  const debit = '123.456789012345678902', jobId = `source-trade-${SIGNAL}-u-${USER}`;
  const attempt = { attemptId: ATTEMPT, fixtureId: FIXTURE, runId: RUN, namespace: scope.namespace, userId: USER,
    requestDigest: fixture.requestDigest, route: '/v1/me/wallets' as const, status: 201, startedAt: at, finishedAt: at };
  const admission = { attemptId: ATTEMPT, fixtureId: FIXTURE, runId: RUN, namespace: scope.namespace, userId: USER,
    requestDigest: fixture.requestDigest, outcome: 'admitted' as const, reason: null, sourceTradeId: SOURCE,
    signalId: SIGNAL, executionId: EXECUTION, jobId, admittedAt: at };
  const snapshot = { executionId: EXECUTION, userId: USER, tradeId: TRADE, fence: '1', totals: {
    base, quote, debit, fee, unknown: '0', quoteUnknown: '0', completes: true, evidenceCount: '1', invalidCorrections: '0' }, accountingComplete: true };
  return { scope, fixtures: [fixture], attempts: [attempt, { ...attempt, attemptId: REPLAY, status: 200 }],
    admissions: [admission, { ...admission, attemptId: REPLAY, outcome: 'replay' }], durable: {
      scope, sources: [{ id: SOURCE, binding: fixture.binding, bindingDigest: sourceBindingDigest(fixture.binding),
        accepted: true, evidenceId: 'inert-protected-source', finality: 'confirmed', applicationActive: true }],
      executions: [{ id: EXECUTION, signalId: SIGNAL, sourceTradeId: SOURCE, userId: USER, targetAccount: walletAddress,
        chain: 'solana', tokenMint, direction: 'buy', executionMode: 'paper', state: 'confirmed', requestedBase: null,
        requestedQuote: '124', confirmedBase: base, confirmedQuote: quote, quoteUnknown: '0' }],
      deliveries: [{ executionId: EXECUTION, signalId: SIGNAL, userId: USER, targetAccount: walletAddress,
        executionMode: 'paper', jobId, state: 'completed', fence: '1', descriptor: { chain: 'solana', options: { jobId },
          data: { copyExecutionId: EXECUTION, signalId: SIGNAL, sourceTradeId: SOURCE, userId: USER, chain: 'solana', tokenMint,
            targetAccount: walletAddress, masterWalletAddress: walletAddress, executionMode: 'paper', direction: 'buy',
            requestedBaseQuantity: null, requestedQuoteQuantity: '124', exitLotId: null, score: 90 } } }],
      workerAttempts: [{ executionId: EXECUTION, userId: USER, fence: '1', policyRevision: 'inert-policy', riskEpoch: '1', state: 'settled' }],
      evidence: [{ id: EVIDENCE, executionId: EXECUTION, userId: USER, sourceTradeId: SOURCE, evidenceId: 'inert-original-paper-receipt',
        evidenceType: 'paper_simulation', confirmationState: 'confirmed', completes: true, base, quote, fee,
        quoteCurrency: 'USD', nativeQuote: quote, nativePrice: '1', effectiveQuote: quote, effectiveFee: fee,
        correctionId: null, applicationActive: true }],
      trades: [{ id: TRADE, executionId: EXECUTION, userId: USER, signalId: SIGNAL, sourceTradeId: SOURCE, tokenMint,
        chain: 'solana', direction: 'buy', executionMode: 'paper', base, quote, fee, status: 'filled' }],
      receipts: [{ receiptId: loadReceiptDigest(snapshot), snapshot }],
      applications: [{ evidenceId: EVIDENCE, executionId: EXECUTION, positionId: POSITION, userId: USER,
        targetAccount: walletAddress, tokenMint, chain: 'solana', active: true }],
      positions: [{ id: POSITION, userId: USER, targetAccount: walletAddress, tokenMint, chain: 'solana', base, basis: debit }],
      lots: [{ id: LOT, positionId: POSITION, userId: USER, tokenMint, chain: 'solana', masterWalletAddress: walletAddress,
        acquisitionExecutionId: EXECUTION, acquisitionEvidenceId: EVIDENCE, acquisitionSourceTradeId: SOURCE,
        acquisitionMode: 'paper', acquiredBase: base, remainingBase: base, acquiredBasis: debit, remainingBasis: debit }],
      risk: [{ executionId: EXECUTION, account: USER, epoch: '1', state: 'confirmed', debit,
        liability: debit, chain: 'solana', executionMode: 'paper' }],
      capacity: [{ sourceTradeId: SOURCE, executionMode: 'paper', notional: quote,
        chain: 'solana', tokenMint, masterWalletAddress: walletAddress }], corrections: [], reductions: [] } };
}
/** Authored inert tests only. No PostgreSQL/provider/server/runtime acceptance. */
describe('Wave4 durable load exact source accounting', () => {
  it('joins original and replay attempts to one durable effect with raw precision and false runtime flags', () => {
    const result = requireLoadFinalAccounting(journal());
    expect(result.totals).toEqual({ base: '9007199254740993.000000000000000002', quote: '123.456789012345678901',
      fee: '0.000000000000000001', debit: '123.456789012345678902' });
    expect(result).toMatchObject({ attempts: 2, admitted: 1, replays: 1, sourceOnly: true,
      runtimeAccepted: false, liveCapabilityAccepted: false, protectedRuntimeAccepted: false });
  });
  it('raw zero does not imply unknown and neither numbers nor exponent/leading-zero encodings are accepted', () => {
    expect(loadAmount({ raw: '0', scale: 18 }, true)).toBe('0');
    for (const raw of ['00', '01', '-1', '1e3', '1.0', ' 1', '1\n']) expect(() => loadAmount({ raw, scale: 18 })).toThrow();
    for (const scale of [-1, 19, 1.5, NaN]) expect(() => loadAmount({ raw: '1', scale })).toThrow();
    expect(() => loadAmount({ raw: 1 as unknown as string, scale: 0 })).toThrow();
  });
  const hostile: [string, (j: any) => void][] = [
    ['duplicate HTTP attempt', j => j.attempts.push(j.attempts[0])],
    ['duplicate protected admission', j => j.admissions.push(j.admissions[0])],
    ['missing protected correlation', j => j.admissions = []],
    ['HTTP-only', j => j.durable.executions = []],
    ['queue-only completion', j => j.durable.receipts = []],
    ['unknown tenant', j => j.attempts[0].userId = LOT],
    ['wrong request digest', j => j.admissions[0].requestDigest = 'a'.repeat(64)],
    ['foreign namespace', j => j.admissions[0].namespace += '-other'],
    ['foreign observer backend', j => j.durable.scope = { ...scope, backendIdentity: 'wrong' }],
    ['unknown attempt fixture', j => j.attempts[0].fixtureId = LOT],
    ['orphan replay', j => j.admissions[0].outcome = 'replay'],
    ['replay new job', j => j.admissions[1].jobId += '-other'],
    ['replay new execution', j => j.admissions[1].executionId = LOT],
    ['duplicate admission', j => j.admissions[1].outcome = 'admitted'],
    ['duplicate obligation', j => j.durable.executions.push(j.durable.executions[0])],
    ['unknown economic row', j => j.durable.trades.push({ ...j.durable.trades[0], id: LOT })],
    ['orphan position', j => j.durable.positions.push({ ...j.durable.positions[0], id: LOT })],
    ['cross-tenant execution', j => j.durable.executions[0].userId = LOT],
    ['wrong durable job', j => j.durable.deliveries[0].jobId += '-other'],
    ['fixture base cannot set buy requested quantity', j => j.durable.executions[0].requestedBase = j.durable.executions[0].confirmedBase],
    ['fill quote cannot replace trusted budget', j => j.durable.executions[0].requestedQuote = j.durable.executions[0].confirmedQuote],
    ['wrong descriptor tenant', j => j.durable.deliveries[0].descriptor.data.userId = LOT],
    ['live descriptor', j => j.durable.deliveries[0].descriptor.data.executionMode = 'live'],
    ['unknown scope source', j => j.durable.sources[0].binding.network += '-other'],
    ['source observation only', j => j.durable.sources[0].accepted = false],
    ['source reversed', j => j.durable.sources[0].finality = 'reversed'],
    ['missing source application', j => j.durable.sources[0].applicationActive = false],
    ['unknown fee', j => j.durable.evidence[0].fee = null],
    ['unknown effective quote', j => j.durable.evidence[0].effectiveQuote = null],
    ['valued USD missing nativeQuote', j => j.durable.evidence[0].nativeQuote = null],
    ['valued USD missing nativePrice', j => j.durable.evidence[0].nativePrice = null],
    ['valued USD non-USD currency', j => j.durable.evidence[0].quoteCurrency = 'SOL'],
    ['valued USD non-1 nativePrice', j => j.durable.evidence[0].nativePrice = '2'],
    ['valued USD mismatched nativeQuote', j => j.durable.evidence[0].nativeQuote = '123.456789012345678900'],
    ['unknown accounting coverage', j => j.durable.executions[0].quoteUnknown = '1'],
    ['false receipt completion', j => j.durable.receipts[0].snapshot.accountingComplete = false],
    ['missing invalidCorrections in receipt', j => { delete j.durable.receipts[0].snapshot.totals.invalidCorrections; }],
    ['nonzero invalidCorrections in receipt', j => { j.durable.receipts[0].snapshot.totals.invalidCorrections = '1'; }],
    ['receipt hash differs', j => j.durable.receipts[0].receiptId = 'a'.repeat(64)],
    ['wrong receipt trade', j => j.durable.receipts[0].snapshot.tradeId = LOT],
    ['noncanonical decimal', j => j.durable.trades[0].quote += '0'],
    ['one raw unit disappeared', j => j.durable.positions[0].base = '9007199254740993.000000000000000001'],
    ['fee dropped from basis', j => j.durable.positions[0].basis = '123.456789012345678901'],
    ['wrong lot acquisition lineage', j => j.durable.lots[0].acquisitionEvidenceId = LOT],
    ['lot basis changed', j => j.durable.lots[0].remainingBasis = '0'],
    ['wrong worker fence', j => j.durable.workerAttempts[0].fence = '2'],
    ['risk fee excluded', j => j.durable.risk[0].debit = '123.456789012345678901'],
    ['risk liability not discharged', j => j.durable.risk[0].liability = '124'],
    ['risk wrong account', j => j.durable.risk[0].account = LOT],
    ['capacity foreign master', j => j.durable.capacity[0].masterWalletAddress = tokenMint],
    ['capacity fee wrongly included', j => j.durable.capacity[0].notional = '123.456789012345678902'],
    ['unqualified correction', j => j.durable.corrections.push({ executionId: EXECUTION, correctionId: 'unknown' })],
    ['sell reduction', j => j.durable.reductions.push({ executionId: EXECUTION, evidenceId: EVIDENCE, lotId: LOT })],
    ['callback result inserted', j => j.durable.receipts[0].snapshot.totals.base = () => true]
  ];
  it.each(hostile)('refuses %s', (_label, mutate) => { const j = structuredClone(journal()); mutate(j); expect(() => requireLoadFinalAccounting(j)).toThrow(); });
  it('does not turn an all-refused HTTP count into economic success', () => {
    const j: any = journal();
    j.attempts.forEach((a: any) => a.status = 429);
    j.admissions.forEach((a: any) => Object.assign(a, { outcome: 'refused', reason: 'rate-limited', sourceTradeId: null,
      signalId: null, executionId: null, jobId: null }));
    expect(() => requireLoadFinalAccounting(j)).toThrow(/count-only/);
  });
  it('preserves independent sizing, refuses hostile identifiers and mutable label authority', () => {
    const fixture: any = journal().fixtures[0];
    expect(captureLoadFixture(fixture).base.raw).not.toBe(fixture.binding.rawQuantity);
    for (const fixtureId of ['../outside', `${FIXTURE}\n`, `${FIXTURE} `, 'not-a-uuid']) {
      expect(() => captureLoadFixture({ ...fixture, fixtureId })).toThrow();
    }
    expect(() => captureLoadFixture({ ...fixture, label: () => true })).toThrow(/inert JSON/);
  });
  it('enforces four NULLs for absent quote and canonical amount/amount/USD/1 for valued USD original', () => {
    expect(() => assertLoadOriginalQuoteEncoding({ quote: null, quoteCurrency: null, nativeQuote: null, nativePrice: null })).not.toThrow();
    expect(() => assertLoadOriginalQuoteEncoding({ quote: null, quoteCurrency: 'USD', nativeQuote: null, nativePrice: null })).toThrow(/four NULLs/);
    expect(() => assertLoadOriginalQuoteEncoding({ quote: null, quoteCurrency: null, nativeQuote: '1', nativePrice: null })).toThrow(/four NULLs/);
    expect(() => assertLoadOriginalQuoteEncoding({ quote: null, quoteCurrency: null, nativeQuote: null, nativePrice: '1' })).toThrow(/four NULLs/);
    expect(() => assertLoadOriginalQuoteEncoding({ quote: '123.456789012345678901', quoteCurrency: 'USD', nativeQuote: '123.456789012345678901', nativePrice: '1' })).not.toThrow();
    expect(() => assertLoadOriginalQuoteEncoding({ quote: '10', quoteCurrency: 'USDC', nativeQuote: '10', nativePrice: '1' })).toThrow(/must be USD/);
    expect(() => assertLoadOriginalQuoteEncoding({ quote: '10', quoteCurrency: 'USD', nativeQuote: '10', nativePrice: '1.0' })).toThrow(/canonical exact decimal/);
    expect(() => assertLoadOriginalQuoteEncoding({ quote: '10', quoteCurrency: 'USD', nativeQuote: '10', nativePrice: '2' })).toThrow(/USD\/1 required/);
    expect(() => assertLoadOriginalQuoteEncoding({ quote: '10', quoteCurrency: 'USD', nativeQuote: '9', nativePrice: '1' })).toThrow(/USD\/1 required/);
  });
});

describe('explicit fixed bounded accounting drain', () => {
  function ports(accounting = journal()) {
    let clock = 1000;
    const p: LoadDrainPorts = { now: () => clock, stopAdmission: vi.fn(async () => {}), accounting: vi.fn(async () => accounting),
      capture: vi.fn(async input => ({ scope, kind: input.kind, phase: input.phase, capturedAt: at, records: [{ observed: 'exact-inert-record' }] })),
      wait: vi.fn(async input => { clock += input.milliseconds; }) };
    return { p, clock: (value: number) => { clock = value; } };
  }
  const input = { scope, loadDeadline: 1000, drainDeadline: 2000, maximumPolls: 2, pollIntervalMs: 10, phases: ['load', 'drain'] };
  it('stops admission and captures all six independent ports for every phase without runtime acceptance', async () => {
    const { p } = ports(); const result = await drainLoadAccounting(input, p);
    expect(p.stopAdmission).toHaveBeenCalledOnce(); expect(p.capture).toHaveBeenCalledTimes(loadCaptureKinds.length * 2);
    expect(result.runtimeAccepted).toBe(false); expect(result.accounting.runtimeAccepted).toBe(false);
  });
  it('bounded unresolved HTTP/queue work never extends the fixed drain', async () => {
    const bad: any = journal(); bad.durable.receipts = [];
    const { p } = ports(bad);
    await expect(drainLoadAccounting(input, p)).rejects.toThrow(/unresolved/);
    expect(p.accounting).toHaveBeenCalledTimes(2); expect(p.wait).toHaveBeenCalledOnce();
  });
  it('refuses foreign or empty captures and stops before accounting', async () => {
    const { p } = ports(); p.capture = vi.fn(async request => ({ scope, kind: request.kind, phase: request.phase,
      capturedAt: at, records: [] }));
    await expect(drainLoadAccounting(input, p)).rejects.toThrow(/coverage/); expect(p.accounting).not.toHaveBeenCalled();
  });
  it('rejects deadline excess, early drain and backwards clocks', async () => {
    const { p, clock } = ports(); clock(999);
    await expect(drainLoadAccounting(input, p)).rejects.toThrow(/deadline/);
    clock(1000); p.stopAdmission = vi.fn(async () => clock(2000));
    await expect(drainLoadAccounting(input, p)).rejects.toThrow(/deadline/);
    clock(1000); p.stopAdmission = vi.fn(async () => clock(999));
    await expect(drainLoadAccounting(input, p)).rejects.toThrow(/monotonic/);
    await expect(drainLoadAccounting({ ...input, drainDeadline: 999999 }, p)).rejects.toThrow(/bounded/);
  });
  it('does not swallow capture or owned accounting port failure as a successful callback', async () => {
    const { p } = ports(); p.accounting = vi.fn(async () => { throw new Error('owned transaction failed'); });
    await expect(drainLoadAccounting(input, p)).rejects.toThrow(/owned transaction failed/);
  });
});

describe('owned canonical-schema SQL observer source', () => {
  it('requires explicit approved observer identity, read-only transaction and consistent snapshot', async () => {
    const query = vi.fn(async () => ({ rows: [{ role: 'swat_app', session: 'swat_app', rolsuper: false,
      rolbypassrls: false, row_security: 'on', read_only: 'off', isolation: 'read committed', bypass: 'off' }] }));
    const client = { query } as unknown as PoolClient;
    const assertObserverWithClient = vi.fn(async () => {});
    const observer = createLoadDurableSqlObserver({ transaction: action => action(client), assertObserverWithClient, now: () => new Date(at) });
    await expect(observer({ scope, fixtures: journal().fixtures })).rejects.toThrow(/read-only/);
    expect(assertObserverWithClient).toHaveBeenCalledWith(client, scope); expect(query).toHaveBeenCalledOnce();
  });
  it('queries actual canonical leaves and scans assets, not a fake load schema or only response IDs', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('pg_catalog.pg_roles')) return { rows: [{ role: 'inert-observer', session: 'inert-observer', rolsuper: false,
        rolbypassrls: false, row_security: 'on', read_only: 'on', isolation: 'repeatable read', bypass: 'off' }] };
      return { rows: [] };
    });
    const observer = createLoadDurableSqlObserver({ transaction: action => action({ query } as unknown as PoolClient),
      assertObserverWithClient: async () => {}, now: () => new Date(at) });
    const output = await observer({ scope, fixtures: journal().fixtures });
    expect(output.executions).toEqual([]); expect(() => requireLoadFinalAccounting({ ...journal(), durable: output })).toThrow();
    const sql = calls.join('\n');
    expect(sql).toContain('public.worker_effective_execution_evidence'); expect(sql).toContain('public.copy_execution_financial_receipts');
    expect(sql).toContain('source_provider_authorities'); expect(sql).toContain('token_mint=ANY'); expect(sql).toContain('LIMIT 10001');
    expect(sql).not.toMatch(/(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|GRANT|CREATE)\b/); expect(sql).not.toContain('readWorkerFinancialTotals');
    expect(sql).not.toContain('load_http_attempts');
  });
});
