import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import type { CopyExecutionRecord } from './copy-trade-lifecycle.js';
const accepted = vi.hoisted(() => vi.fn());
vi.mock('./source-verification-store.js', () => ({ hasAcceptedSourceVerificationWithClient: accepted }));
import { allocateExactSourceSellLots, readSourceSellLotProofWithClient, persistSourceSellLotAllocationWithClient } from './source-sell-lot-allocation.js';
const execution = { id: 'sell', userId: 'user', chain: 'solana', tokenMint: 'solana:token', targetAccount: 'solana:target',
  direction: 'sell', executionMode: 'paper', sourceTradeId: 'source-sell', sourceSellFraction: '0.1',
  sourcePositionBeforeQuantity: '100', requestedBaseQuantity: '9007199254740993.000000000000000001',
  confirmedBaseQuantity: '0', exitLotId: null, exitTrigger: null, state: 'requested', submissionId: null,
  submissionAttempts: 0 } as CopyExecutionRecord;
const master = 'solana:master';
const lot = { lot_id: 'lot', remaining_quantity: execution.requestedBaseQuantity!, reserved_quantity: '0',
  acquisition_execution_id: 'buy', acquisition_evidence_id: 'fill', source_trade_id: 'source-buy',
  execution_mode: 'paper', max_slippage_bps: 50 };
const allocation = { lot_id: 'lot', ordinal: 0, requested_quantity: execution.requestedBaseQuantity!,
  acquisition_execution_id: 'buy', acquisition_evidence_id: 'fill', acquisition_source_trade_id: 'source-buy' };
function setup(lots = [lot], stored = [allocation], reductions: { lot_id: string; quantity: string; scope_valid: boolean }[] = []) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.startsWith('SELECT id FROM copy_positions') ? [{ id: 'position' }]
    : sql.includes('SELECT lot.id AS lot_id') ? lots
    : sql.includes('SELECT lot_id,ordinal') ? stored
    : sql.includes('SELECT reduction.lot_id') ? reductions
    : sql.includes('SELECT EXISTS') ? [{ exists: false }] : [] }));
  return { query, client: { query } as unknown as PoolClient };
}
beforeEach(() => { accepted.mockReset(); accepted.mockResolvedValue(true); });
describe('durable exact source sell owned per-lot allocation', () => {
  it('allocates above-safe exact quantities per-lot without aggregate floating arithmetic', () => {
    expect(allocateExactSourceSellLots('9007199254740993.000000000000000002',[
      { lotId: 'a', availableQuantity: '9007199254740993.000000000000000001' },
      { lotId: 'b', availableQuantity: '0.000000000000000001' }
    ])).toEqual([{ lotId: 'a', quantity: '9007199254740993.000000000000000001' },
      { lotId: 'b', quantity: '0.000000000000000001' }]);
  });
  it('refuses unmatched quantity and duplicate lot identity', () => {
    expect(() => allocateExactSourceSellLots('1',[{ lotId:'a',availableQuantity:'0.999999999999999999' }])).toThrow(/exceeds/);
    expect(() => allocateExactSourceSellLots('2',[{lotId:'a',availableQuantity:'1'},{lotId:'a',availableQuantity:'1'}])).toThrow(/Duplicate/);
  });
  it('fresh read proves exact lot acquisition/source/evidence/mode, never fake master ownedExit', async () => {
    const s = setup(); expect(await readSourceSellLotProofWithClient(s.client,execution,master)).toMatchObject({
      executionId: execution.id, requestedQuantity: execution.requestedBaseQuantity, lots: [{ lotId:'lot', quantity: execution.requestedBaseQuantity, acquisitionMode:'paper' }] });
    expect(s.query.mock.calls[2]![0]).toContain('application.active');
    expect(s.query.mock.calls[2]![0]).toContain('acquisition.execution_mode = $7');
    expect(s.query.mock.calls[2]![1]).toContain(execution.userId);
  });
  it.each(['acquisition_execution_id','acquisition_evidence_id','acquisition_source_trade_id'])('refuses substituted %s allocation proof', async field => {
    const s = setup([lot],[{ ...allocation,[field]:'foreign' }]); expect(await readSourceSellLotProofWithClient(s.client,execution,master)).toBeNull();
  });
  it('refuses missing physical lot or exact over-allocation', async () => {
    const s = setup([]); expect(await readSourceSellLotProofWithClient(s.client,execution,master)).toBeNull();
    const over = setup([{...lot,remaining_quantity:'1'}]); expect(await readSourceSellLotProofWithClient(over.client,execution,master)).toBeNull();
  });
  it('reorged sell or acquisition blocks owned proof before any write', async () => {
    const s = setup(); accepted.mockResolvedValueOnce(false);
    expect(await readSourceSellLotProofWithClient(s.client,execution,master)).toBeNull(); expect(s.query).not.toHaveBeenCalled();
    accepted.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await readSourceSellLotProofWithClient(s.client,execution,master)).toBeNull();
  });
  it('persists immutable per-lot quantities on supplied canonical claim client before context', async () => {
    const s = setup(); await persistSourceSellLotAllocationWithClient(s.client,execution,master);
    expect(s.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO source_sell_lot_allocations'),
      [execution.id,'lot',0,execution.userId,execution.chain,execution.targetAccount,execution.tokenMint,
        master,'paper',execution.requestedBaseQuantity,'buy','fill','source-buy']);
  });
  it('partial replay keeps original immutable request10 while proving outstanding6 after exact consumed4', async () => {
    const partial={...execution,requestedBaseQuantity:'10',confirmedBaseQuantity:'4',state:'partially_filled'} as CopyExecutionRecord;
    const s=setup([{...lot,remaining_quantity:'6'}],[{...allocation,requested_quantity:'10'}],
      [{lot_id:'lot',quantity:'4',scope_valid:true}]);
    const proof=await readSourceSellLotProofWithClient(s.client,partial,master);
    expect(proof).toMatchObject({requestedQuantity:'10',lots:[{quantity:'10',consumedQuantity:'4',outstandingQuantity:'6',availableQuantity:'6'}]});
    expect(await readSourceSellLotProofWithClient(s.client,partial,master)).toEqual(proof);
    expect(s.query.mock.calls.some(call=>String(call[0]).includes('INSERT'))).toBe(false);
    expect(s.query).toHaveBeenCalledWith(expect.stringContaining('reduction.sell_execution_id = $1'),
      [partial.id,partial.userId,partial.targetAccount,partial.chain,partial.tokenMint,master]);
  });
  it('completed replay proves zero outstanding against zero remaining without recreating lots', async () => {
    const complete={...execution,requestedBaseQuantity:'10',confirmedBaseQuantity:'10',state:'confirmed'} as CopyExecutionRecord;
    const s=setup([{...lot,remaining_quantity:'0'}],[{...allocation,requested_quantity:'10'}],
      [{lot_id:'lot',quantity:'10',scope_valid:true}]);
    expect(await readSourceSellLotProofWithClient(s.client,complete,master)).toMatchObject({requestedQuantity:'10',
      lots:[{quantity:'10',consumedQuantity:'10',outstandingQuantity:'0',availableQuantity:'0'}]});
  });
  it.each([
    [{lot_id:'foreign',quantity:'4',scope_valid:true}],
    [{lot_id:'lot',quantity:'4',scope_valid:false}],
    [{lot_id:'lot',quantity:'5',scope_valid:true}],
    [{lot_id:'lot',quantity:'11',scope_valid:true}]
  ])('refuses foreign/inactive/mismatched or excess persisted consumption', async reductions => {
    const partial={...execution,requestedBaseQuantity:'10',confirmedBaseQuantity:'4',state:'partially_filled'} as CopyExecutionRecord;
    const s=setup([{...lot,remaining_quantity:'6'}],[{...allocation,requested_quantity:'10'}],[reductions]);
    expect(await readSourceSellLotProofWithClient(s.client,partial,master)).toBeNull();
  });
  it('rejects non-prefix cumulative lot consumption even when aggregate confirmed total matches', async () => {
    const partial={...execution,requestedBaseQuantity:'10',confirmedBaseQuantity:'4',state:'partially_filled'} as CopyExecutionRecord;
    const s=setup([{...lot,lot_id:'first',remaining_quantity:'5'},{...lot,lot_id:'second',remaining_quantity:'1'}],
      [{...allocation,lot_id:'first',ordinal:0,requested_quantity:'5'},{...allocation,lot_id:'second',ordinal:1,requested_quantity:'5'}],
      [{lot_id:'second',quantity:'4',scope_valid:true}]);
    expect(await readSourceSellLotProofWithClient(s.client,partial,master)).toBeNull();
  });
  it('SQL079 grants only lock-compatible UPDATE column while immutable trigger rejects all mutations', () => {
    for(const path of ['/root/SWAT/threats/project-completion-20261117/079-runtime-schema.proposal.sql',
      '/root/SWAT/packages/db/sql/079_claim_runtime_capabilities.sql']) {
      const sql=readFileSync(path,'utf8');
      expect(sql).toContain('GRANT UPDATE (requested_quantity) ON public.source_sell_lot_allocations TO swat_app;');
      expect(sql).toContain("IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'source sell allocation immutable'; END IF;");
      expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON public.source_sell_lot_allocations');
      expect(sql).not.toMatch(/GRANT\s+UPDATE\s+ON\s+public\.source_sell_lot_allocations/i);
    }
  });
  it.each([{...execution,state:'submitted'}, {...execution,submissionAttempts:1}])('forbids new proof backfill after effect', async record => {
    const s=setup(); await expect(persistSourceSellLotAllocationWithClient(s.client,record as CopyExecutionRecord,master)).rejects.toThrow(/backfilled/);
    expect(s.query.mock.calls.some(call=>String(call[0]).includes('INSERT'))).toBe(false);
  });
});
