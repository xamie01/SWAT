import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
const mocks = vi.hoisted(() => ({ evidence: vi.fn(), transition: vi.fn(), capacity: vi.fn(), risk: vi.fn(), trade: vi.fn(),
  totals: vi.fn(), correction: vi.fn(), delivery: vi.fn(), assert: vi.fn(), finish: vi.fn() }));
vi.mock('./copy-trade-lifecycle.js', () => ({ recordCopyExecutionEvidenceWithClient: mocks.evidence, transitionCopyExecutionWithClient: mocks.transition }));
vi.mock('./worker-valuation-corrections.js', () => ({ readWorkerFinancialTotalsWithClient: mocks.totals,
  projectWorkerEconomicsWithClient: mocks.capacity, appendWorkerValuationCorrectionWithClient: mocks.correction }));
vi.mock('./package13-fanout-delivery.js', () => ({ settleFanoutDelivery: mocks.delivery }));
vi.mock('./risk-policy.js', () => ({ updateRiskSpendReservation: mocks.risk }));
vi.mock('./trades.js', () => ({ insertTradeWithClient: mocks.trade }));
vi.mock('./worker-execution.js', () => ({ assertWorkerAttemptWithClient: mocks.assert, finishWorkerAttemptWithClient: mocks.finish }));
import { settleWorkerFillWithClient, reconcileWorkerFillWithClient, retainWorkerUncertaintyWithClient, reconcileWorkerValuationWithClient } from './worker-settlement.js';
const execution = { id: 'execution', userId: null, signalId: 'signal', sourceTradeId: 'source', chain: 'solana',
  executionMode: 'paper', tokenMint: 'solana:token', direction: 'buy', requestedQuoteQuantity: '20', clientOrderId: 'canonical' } as const;
const input = { execution: execution as never, attempt: { executionId: 'execution', userId: null, fence: '1', policyRevision: 'revision', riskEpoch: '7' },
  risk: { account: 'operator', chain: 'solana' as const, executionMode: 'paper' as const, executionId: 'execution', policyEpoch: '7' },
  evidence: { executionId: 'execution', evidenceType: 'paper_simulation' as const, evidenceId: 'fill', baseQuantity: '0.000000000000000001',
    quoteLeg: { amount: '10', currency: 'USD' as const }, feeUsd: '2', confirmationState: 'confirmed' as const, completesExecution: true, occurredAt: new Date() },
  executor: 'paper-exact', slippageBps: 40 };
let client: PoolClient;
let events: string[];
beforeEach(() => {
  vi.clearAllMocks(); events = [];
  client = { query: vi.fn(async (sql: string) => {
    if (sql.includes('pg_advisory_xact_lock') || sql.startsWith('SELECT id FROM copy_executions')) return { rows: [{ id: 'execution' }] };
    if (sql.startsWith('SELECT source_trade_id')) { events.push('cohort-lock'); return { rows: [{}] }; }
    if (sql.includes('FROM copy_execution_worker_attempts')) return { rows: [{ execution_id: 'execution' }] };
    if (sql.startsWith('SELECT confirmed_quote')) return { rows: [{ confirmed_quote_quantity: '3' }] };
    if (sql.startsWith('UPDATE master_capacity')) return { rows: [{ source_trade_id: 'source' }] };
    if (sql.startsWith('SELECT finalize_worker_correction')) return {rows:[{finalized:true}]};
    if (sql.includes('source_fanout_deliveries')) return { rows: [{ execution_id: 'execution' }] };
    if (sql.includes('copy_execution_financial_receipts')) { events.push('financial-receipt'); return { rows: [{ receipt_id: 'receipt' }] }; }
    if (sql.startsWith('SELECT id FROM copy_execution_evidence')) return { rows: [{ id: 'original' }] };
    if (sql.includes('SUM(base_quantity)')) return { rows: [{ base: '0.000000000000000001', quote: '10', debit: '12', fee: '2', unknown: '0' }] };
    throw new Error(`unexpected SQL ${sql}`);
  }) } as unknown as PoolClient;
  mocks.transition.mockImplementation(async () => ({ ...execution, state: 'reconciliation_required' }));
  mocks.evidence.mockImplementation(async () => { events.push('evidence'); return { execution: { ...execution, state: 'confirmed', confirmedQuoteQuantity: '10', quoteUnassessedFillCount: 0 },
    fillValuation: { currency: 'USD' }, confirmedQuoteTotal: { usdAmount: '10' } }; });
  mocks.capacity.mockImplementation(async () => { events.push('capacity'); });
  mocks.totals.mockResolvedValue({ base:'0.000000000000000001',quote:'10',debit:'12',fee:'2',unknown:'0',quoteUnknown:'0',completes:true,evidenceCount:'1' });
  mocks.correction.mockResolvedValue({replayed:false,correctionId:'correction'});
  mocks.delivery.mockImplementation(async () => { events.push('delivery-settle'); return true; });
  mocks.risk.mockImplementation(async () => { events.push('risk'); });
  mocks.trade.mockImplementation(async () => { events.push('trade'); return { id: 'trade' }; });
  mocks.finish.mockImplementation(async () => { events.push('finish'); });
});
describe('joined same-client financial settlement', () => {
  it('settles evidence/lot, cumulative capacity delta, fees+risk, trade and attempt on exactly one client', async () => {
    expect(await settleWorkerFillWithClient(client, input)).toMatchObject({ tradeId: 'trade' });
    expect(events).toEqual(['cohort-lock','evidence','capacity','risk','trade','financial-receipt','finish']);
    expect(mocks.capacity).toHaveBeenCalledWith(client, input.execution);
    expect(mocks.risk).toHaveBeenCalledWith(client, expect.objectContaining({ state: 'confirmed', confirmedUsd: '12' }));
    expect(mocks.trade).toHaveBeenCalledWith(client, expect.objectContaining({ tokenAmount: '0.000000000000000001', feeUsd: '2', amountUsd: '10' }));
    expect(mocks.evidence.mock.calls[0]![0]).toBe(client);
  });
  it('missing capacity row fails the transaction before risk/trade/ack, never catch-and-warn', async () => {
    mocks.capacity.mockRejectedValue(new Error('Capacity accounting unavailable: ledger-row-missing'));
    await expect(settleWorkerFillWithClient(client, input)).rejects.toThrow(/Capacity accounting unavailable/);
    expect(mocks.trade).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('unpriced/unknown fee evidence retains risk unknown instead of terminal release', async () => {
    vi.mocked(client.query).mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.startsWith('SELECT confirmed_quote')) return { rows: [{ confirmed_quote_quantity: '3' }] } as never;
      if (text.startsWith('UPDATE master_capacity')) return { rows: [{}] } as never;
      return { rows: [{ base: '1', quote: '10', debit: '10', fee: null, unknown: '1' }] } as never;
    });
    mocks.totals.mockResolvedValue({ base:'1',quote:'10',debit:'10',fee:null,unknown:'1',quoteUnknown:'0',completes:true,evidenceCount:'1' });
    const result = await settleWorkerFillWithClient(client, input);
    expect(result.accountingComplete).toBe(false);
    expect(result.execution.state).toBe('reconciliation_required');
    expect(mocks.finish).toHaveBeenCalledWith(client, input.attempt, 'unknown');
    expect(mocks.trade).toHaveBeenCalledWith(client, expect.objectContaining({ status: 'partial' }));
    expect(mocks.risk).toHaveBeenCalledWith(client, expect.objectContaining({ state: 'unknown', confirmedUsd: '10' }));
    expect(mocks.trade).toHaveBeenCalledWith(client, expect.objectContaining({ feeUsd: null }));
  });
  it('replay zero delta does not reaccrue but still joins canonical cumulative settlement', async () => {
    mocks.capacity.mockResolvedValue({ applied: false, code: 'no-new-usd' });
    await settleWorkerFillWithClient(client, input);
    expect(mocks.trade).toHaveBeenCalledOnce();
  });
  it('threads exact exit lot identity into the canonical trade', async () => {
    await settleWorkerFillWithClient(client, { ...input, execution: { ...execution, sourceTradeId: null, exitLotId: 'lot', direction: 'sell' } as never, risk: null });
    expect(mocks.trade).toHaveBeenCalledWith(client, expect.objectContaining({ exitLotId: 'lot', sourceTradeId: null }));
  });
  it('receipt-owned reconciliation accepts unknown fence without changing it to dispatched', async () => {
    const receiptOwner = vi.fn().mockResolvedValue(undefined);
    expect(await reconcileWorkerFillWithClient(client, input, receiptOwner)).toMatchObject({ accountingComplete: true });
    expect(receiptOwner).toHaveBeenCalledWith(client, input.attempt, input.evidence);
    expect(mocks.assert).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
    expect(vi.mocked(client.query).mock.calls.some(call => String(call[0]).includes("state IN ('dispatched','unknown','settled')"))).toBe(true);
    expect(vi.mocked(client.query).mock.calls.some(call => String(call[0]).includes("SET state = 'dispatched'"))).toBe(false);
  });
  it('unowned durable receipt cannot settle or mutate economics', async () => {
    await expect(reconcileWorkerFillWithClient(client, input, async () => { throw new Error('receipt fence mismatch'); })).rejects.toThrow('receipt fence mismatch');
    expect(mocks.evidence).not.toHaveBeenCalled(); expect(mocks.trade).not.toHaveBeenCalled();
  });
  it.each(['buy','sell'])('sweep-first %s accounting survives late uncertainty callbacks idempotently', async direction => {
    let fence = 'dispatched', state = 'requested', complete = false;
    const originalQuery = vi.mocked(client.query).getMockImplementation()!;
    vi.mocked(client.query).mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.startsWith('SELECT state FROM copy_execution_worker_attempts')) return { rows: [{ state: fence }] } as never;
      if (sql.includes('AS accounting_complete')) return { rows: [{ state, accounting_complete: complete }] } as never;
      return originalQuery(...args as never) as never;
    });
    const economicInput = { ...input, execution: { ...execution, direction } as never, risk: direction === 'buy' ? input.risk : null };
    await reconcileWorkerFillWithClient(client, economicInput, async () => {});
    state = 'confirmed'; complete = true;
    mocks.transition.mockClear(); mocks.risk.mockClear(); mocks.finish.mockClear();
    await retainWorkerUncertaintyWithClient(client, { ...economicInput, reason: 'late transport uncertainty' });
    await retainWorkerUncertaintyWithClient(client, { ...economicInput, reason: 'duplicate late callback' });
    expect(mocks.transition).not.toHaveBeenCalled(); expect(mocks.risk).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled(); expect(fence).toBe('dispatched');
  });
  it.each(['buy','sell'])('retain-first %s stays nonresubmittable while sweep accounting and late repeats succeed', async direction => {
    let fence = 'dispatched', state = 'requested', complete = false;
    const originalQuery = vi.mocked(client.query).getMockImplementation()!;
    vi.mocked(client.query).mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.startsWith('SELECT state FROM copy_execution_worker_attempts')) return { rows: [{ state: fence }] } as never;
      if (sql.includes('AS accounting_complete')) return { rows: [{ state, accounting_complete: complete }] } as never;
      return originalQuery(...args as never) as never;
    });
    mocks.finish.mockImplementation(async () => { fence = 'unknown'; state = 'reconciliation_required'; });
    const economicInput = { ...input, execution: { ...execution, direction } as never, risk: direction === 'buy' ? input.risk : null };
    await retainWorkerUncertaintyWithClient(client, { ...economicInput, reason: 'initial uncertainty' });
    expect(fence).toBe('unknown');
    await reconcileWorkerFillWithClient(client, economicInput, async () => {});
    state = 'confirmed'; complete = true;
    mocks.transition.mockClear(); mocks.risk.mockClear(); mocks.finish.mockClear();
    await retainWorkerUncertaintyWithClient(client, { ...economicInput, reason: 'duplicate late callback' });
    expect(mocks.transition).not.toHaveBeenCalled(); expect(mocks.risk).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
    expect(fence).toBe('unknown');
  });
  it.each(['unknown','settled'])('late callback on %s fence is idempotent even without terminal evidence', async fence => {
    const originalQuery = vi.mocked(client.query).getMockImplementation()!;
    vi.mocked(client.query).mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.startsWith('SELECT state FROM copy_execution_worker_attempts')) return { rows: [{ state: fence }] } as never;
      if (sql.includes('AS accounting_complete')) return { rows: [{ state: 'reconciliation_required', accounting_complete: false }] } as never;
      return originalQuery(...args as never) as never;
    });
    await retainWorkerUncertaintyWithClient(client, { ...input, reason: 'late' });
    expect(mocks.transition).not.toHaveBeenCalled(); expect(mocks.risk).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('delivery settlement follows durable financial receipt and rejects wrong identity before effects', async () => {
    const delivery = {claim:{signalId:'signal',userId:null,executionMode:'paper' as const,targetAccount:undefined as never,owner:'owner',fence:'1'},now:new Date()};
    await settleWorkerFillWithClient(client,{...input,delivery});
    const queries = vi.mocked(client.query).mock.calls.map(call=>String(call[0]));
    expect(queries.findIndex(sql=>sql.includes('pg_advisory_xact_lock'))).toBeLessThan(queries.findIndex(sql=>sql.startsWith('SELECT id FROM copy_executions')));
    expect(queries.findIndex(sql=>sql.startsWith('SELECT id FROM copy_executions'))).toBeLessThan(queries.findIndex(sql=>sql.includes('FROM source_fanout_deliveries')));
    expect(events.lastIndexOf('delivery-settle')).toBeGreaterThan(events.indexOf('financial-receipt'));
    expect(mocks.delivery).toHaveBeenCalledWith(client,delivery.claim,expect.objectContaining({outcome:'completed',executionId:'execution'}));
    mocks.evidence.mockClear();
    await expect(settleWorkerFillWithClient(client,{...input,delivery:{...delivery,claim:{...delivery.claim,userId:'other'}}})).rejects.toThrow(/identity/);
    expect(mocks.evidence).not.toHaveBeenCalled();
  });
  it('unknown accounting settles delivery reconciliation rather than economic completion', async () => {
    mocks.totals.mockResolvedValue({base:'1',quote:null,debit:'0',fee:null,unknown:'1',quoteUnknown:'1',completes:true,evidenceCount:'1'});
    const delivery = {claim:{signalId:'signal',userId:null,executionMode:'paper' as const,targetAccount:undefined as never,owner:'owner',fence:'1'},now:new Date()};
    await settleWorkerFillWithClient(client,{...input,delivery});
    expect(mocks.delivery).toHaveBeenCalledWith(client,delivery.claim,expect.objectContaining({outcome:'reconciliation_required'}));
  });
  it('receipt-owned correction recovery does not insert evidence or duplicate inventory', async () => {
    const recovered = await reconcileWorkerValuationWithClient(client,{...input,
      correction:{originalEvidenceId:'original',correctionId:'correction',valuationId:'value',previousCorrectionId:null,now:new Date()}},async()=>{});
    expect(recovered.accountingComplete).toBe(true);
    expect(mocks.correction).toHaveBeenCalledWith(client,expect.objectContaining({execution:input.execution}));
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(mocks.risk).toHaveBeenCalledWith(client,expect.objectContaining({valuationCorrectionId:'correction',confirmedUsd:'12'}));
    expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('financial receipt failure prevents delivery completion', async () => {
    const original = vi.mocked(client.query).getMockImplementation()!;
    vi.mocked(client.query).mockImplementation(async (...args: unknown[]) => {
      if(String(args[0]).includes('INSERT INTO copy_execution_financial_receipts')) throw new Error('receipt rollback');
      return original(...args as never) as never;
    });
    const delivery = {claim:{signalId:'signal',userId:null,executionMode:'paper' as const,targetAccount:undefined as never,owner:'owner',fence:'1'},now:new Date()};
    await expect(settleWorkerFillWithClient(client,{...input,delivery})).rejects.toThrow('receipt rollback');
    expect(mocks.delivery).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('trade failure prevents durable attempt completion', async () => {
    mocks.trade.mockRejectedValue(new Error('trade write failed'));
    await expect(settleWorkerFillWithClient(client, input)).rejects.toThrow('trade write failed');
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});
