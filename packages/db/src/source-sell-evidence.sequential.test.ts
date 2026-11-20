import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./client.js', () => ({ query: vi.fn() }));
vi.mock('./transaction.js', () => ({ withTransaction: vi.fn() }));
vi.mock('./worker-policy.js', () => ({ captureWorkerPolicyWithClient: vi.fn() }));
vi.mock('@swat/shared', () => ({ isAppliedSourceConfirmation: (state: string) => ['confirmed','finalized'].includes(state),
  canTransitionSourceConfirmation: vi.fn(), canTransitionCopyExecution: vi.fn(), resolveChainAddress: vi.fn(), resolveChainValue: vi.fn() }));
import { synchronizeSourceSellLotEvidenceWithClient, type CopyExecutionRecord } from './copy-trade-lifecycle-owned.js';
const execution = { id: 'sell', userId: 'tenant', chain: 'solana', tokenMint: 'solana:token', targetAccount: 'solana:target',
  direction: 'sell', executionMode: 'paper', sourceTradeId: 'source-sell', requestedBaseQuantity: '3', exitLotId: null } as CopyExecutionRecord;
const evidence = { id: 'fill-1', baseQuantity: '1.5', quoteQuantity: '6', occurredAt: new Date('2026-11-17T00:00:00.000Z') };
function fixture(options: { valid?: boolean; prior?: string; consumed?: [string,string]; replay?: Array<{ lot_id:string;quantity:string }>; physicalFail?: boolean } = {}) {
  const calls: Array<{sql:string;values:unknown[]}> = [];
  const query = vi.fn(async (sql:string,values:unknown[] = []) => {
    calls.push({sql,values});
    if (sql.includes('WITH allocation AS')) return { rows: [{valid: options.valid !== false,prior_quantity:options.prior ?? '0',
      allocations:[{lot_id:'reserved-second-acquired',ordinal:0,requested_quantity:'1',remaining_quantity:'1',consumed_quantity:options.consumed?.[0] ?? '0'},
        {lot_id:'reserved-first-acquired',ordinal:1,requested_quantity:'2',remaining_quantity:'2',consumed_quantity:options.consumed?.[1] ?? '0'}]}] };
    if (sql.includes('SELECT lot_id, quantity::text')) return { rows: options.replay ?? [] };
    if (sql.includes('INSERT INTO copy_position_master_lot_reductions')) return { rows: options.physicalFail ? [] : [{id:'reduction'}] };
    return {rows:[]};
  });
  return { calls,client:{query} as unknown as PoolClient };
}
const apply=(f:ReturnType<typeof fixture>,item=evidence)=>synchronizeSourceSellLotEvidenceWithClient(f.client,
  {execution,positionId:'position',masterWalletAddress:'solana:master',evidence:item});
describe('actual lifecycle reserved source-sell reduction seam (mocked SQL protocol, not DB execution)',()=>{
  it('reduces persisted ordinal lots, not acquired-at FIFO or aggregate floating quantity',async()=>{
    const f=fixture(); await apply(f);
    const inserts=f.calls.filter(({sql})=>sql.includes('INSERT INTO copy_position_master_lot_reductions'));
    expect(inserts.map(({values})=>[values[0],values[3]])).toEqual([['reserved-second-acquired','1'],['reserved-first-acquired','0.5']]);
    expect(inserts.every(({sql})=>sql.includes('$5::numeric * $4::numeric / $9::numeric'))).toBe(true);
    expect(f.calls[0]?.sql).toContain('ORDER BY reserved.ordinal');
    expect(f.calls[1]?.sql).toContain('SUM(requested_quantity) = $10::numeric');
    expect(f.calls.every(({sql})=>!sql.includes('ORDER BY acquired_at'))).toBe(true);
  });
  it('generated reduction binds every placeholder contiguously and uses fill rather than requested quantity for proceeds',async()=>{
    const f=fixture(); await apply(f);
    for(const {sql,values} of f.calls){
      const indices=[...new Set([...sql.matchAll(/\$(\d+)/g)].map(match=>Number(match[1])))].sort((a,b)=>a-b);
      const maximum=indices.at(-1) ?? 0;
      expect(indices).toEqual(Array.from({length:maximum},(_,index)=>index+1));
      expect(values).toHaveLength(maximum);
      if(sql.includes('INSERT INTO copy_position_master_lot_reductions')){
        expect(values[8]).toBe(evidence.baseQuantity);
        expect(values[8]).not.toBe(execution.requestedBaseQuantity);
        expect(sql).toContain('$5::numeric * $4::numeric / $9::numeric');
      }
    }
  });
  it('partial later evidence consumes only remaining ordered reservation prefix',async()=>{
    const f=fixture({prior:'1.5',consumed:['1','0.5']}); await apply(f,{...evidence,id:'fill-2',baseQuantity:'1'});
    expect(f.calls.filter(({sql})=>sql.includes('INSERT INTO copy_position_master_lot_reductions')).map(({values})=>[values[0],values[3]]))
      .toEqual([['reserved-first-acquired','1']]);
  });
  it('same evidence replay proves exact original per-lot reductions and never reapplies inventory',async()=>{
    const f=fixture({replay:[{lot_id:'reserved-second-acquired',quantity:'1.0'},{lot_id:'reserved-first-acquired',quantity:'0.500'}]});
    await apply(f); expect(f.calls.some(({sql})=>sql.includes('INSERT INTO copy_position_master_lot_reductions'))).toBe(false);
    expect(f.calls.some(({sql})=>sql.includes('UPDATE copy_position_master_lots'))).toBe(false);
  });
  it('older fill replay after later consumption returns its original reductions without shifting prefix',async()=>{
    const f=fixture({prior:'1',consumed:['0','1'],replay:[{lot_id:'reserved-second-acquired',quantity:'1'},{lot_id:'reserved-first-acquired',quantity:'0.5'}]});
    await apply(f); expect(f.calls.some(({sql})=>sql.includes('INSERT INTO copy_position_master_lot_reductions'))).toBe(false);
  });
  it.each([{valid:false},{prior:'2.5',consumed:['1','1.5']},{prior:'1.5',consumed:['0.5','1']},
    {replay:[{lot_id:'different-lot',quantity:'1.5'}]}])('refuses wrong scope/sum/prefix/replay before mutations %j',async options=>{
    const f=fixture(options); await expect(apply(f)).rejects.toThrow();
    expect(f.calls.some(({sql})=>sql.includes('INSERT INTO copy_position_master_lot_reductions'))).toBe(false);
  });
  it('acquisition receipt/application scope is required but master reorg does not strand settled follower receipt',async()=>{
    const f=fixture(); await apply(f); const proof=f.calls.find(({sql})=>sql.includes('WITH allocation AS'))!;
    for(const clause of ['receipt.confirmation_state','application.active','acquisition.execution_mode = $8',
      'lot.acquisition_evidence_id = reserved.acquisition_evidence_id','lot.user_id IS NOT DISTINCT FROM $3']) expect(proof.sql).toContain(clause);
    expect(proof.sql).not.toContain('acquisition_source.confirmation_state');
    expect(proof.sql).not.toContain('source_verification_heads');
    expect(proof.values.slice(0,8)).toEqual(['sell','position','tenant','solana','solana:token','solana:master','solana:target','paper']);
  });
  it('physical reserved lot shortage rejects without projection update',async()=>{
    const f=fixture({physicalFail:true}); await expect(apply(f)).rejects.toThrow(/physical reduction/);
    expect(f.calls.some(({sql})=>sql.includes('UPDATE copy_position_master_lots'))).toBe(false);
  });
});
