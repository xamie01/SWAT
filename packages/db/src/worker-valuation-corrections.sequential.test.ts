import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
const mocks = vi.hoisted(()=>({ source:vi.fn() }));
vi.mock('./source-verification-store.js',()=>({hasAcceptedSourceVerificationWithClient:mocks.source}));
import { appendWorkerValuationCorrectionWithClient, readWorkerFinancialTotalsWithClient, projectWorkerEconomicsWithClient,
  workerMoney, workerQuantity, workerOriginalEvidenceDigest, workerOriginalEvidenceSnapshot } from './worker-valuation-corrections.js';
const execution = {id:'execution',userId:null,sourceTradeId:'source',chain:'solana',targetAccount:'solana:paper',tokenMint:'solana:asset',executionMode:'paper'} as never;
const original: {id:string;execution_id:string;user_id:string|null;source_trade_id:string|null;evidence_type:string;evidence_id:string;
  base_quantity:string;quote_quantity:string|null;quote_native_quantity:string|null;quote_currency:string|null;quote_native_usd_price:string|null;
  price_usd:string|null;fee_usd:string|null;occurred_at:Date;completes_execution:boolean;confirmation_state:string;application_active:boolean} = {id:'original',execution_id:'execution',user_id:null,source_trade_id:'source',evidence_type:'paper_simulation',evidence_id:'immutable',
  base_quantity:'1',quote_quantity:null,quote_native_quantity:null,quote_currency:null,quote_native_usd_price:null,price_usd:null,fee_usd:null,
  occurred_at:new Date('2026-11-17T00:00:00Z'),completes_execution:true,confirmation_state:'confirmed',application_active:true};
let fills: Array<typeof original>, values: Map<string,Record<string,unknown>>, ledger:Array<Record<string,unknown>>, sqls:string[];
let capacity:string|null, position:string|null, inventory:string, failProjection:boolean;
let lineageValid:boolean, historyValid:boolean;
function trusted(id:string,quote:string|null,fee:string|null,revision='1') {
  values.set(id,{valuation_id:id,original_evidence_id:'original',execution_id:'execution',user_id:null,
    original_digest:workerOriginalEvidenceDigest(workerOriginalEvidenceSnapshot(fills[0]!)),quote_usd:quote,fee_usd:fee,revision,
    authorized:true,max_quote_usd:'100',max_fee_usd:'10'});
}
const patch=(id:string,previous:string|null=null)=>({execution,originalEvidenceId:'original',correctionId:id,valuationId:id,previousCorrectionId:previous,now:new Date('2026-11-17T01:00:00Z')});
function effective(fill:typeof original) {
  const row=ledger.filter(c=>c.original_evidence_id===fill.id).at(-1);
  return {quote:row?row.effective_quote_usd as string|null:fill.quote_quantity,fee:row?row.effective_fee_usd as string|null:fill.fee_usd};
}
// Stateful SQL protocol fixture; NO SQL engine, RLS or concurrency acceptance.
function client():PoolClient {return {query:vi.fn(async(sql:string,args:unknown[]=[])=>{
  sqls.push(sql);
  if(sql.includes('SELECT evidence.id, evidence.execution_id')) return {rows:fills.filter(f=>f.id===args[0]).map(f=>({...f}))};
  if(sql.includes('FROM trusted_worker_valuations valuation')) return {rows:values.has(String(args[0]))?[{...values.get(String(args[0]))}]:[]};
  if(sql.includes('FROM worker_correction_lineage')) return {rows:lineageValid?[{source_trade_id:'source',acquisition_evidence_id:fills[0]!.source_trade_id===null?'acquisition':null,master_wallet_address:'solana:master'}]:[]};
  if(sql.includes('WHERE correction_id = $1')) return {rows:ledger.filter(c=>c.correction_id===args[0]).map(c=>({...c,accepted:historyValid}))};
  if(sql.includes('ORDER BY revision DESC LIMIT 1')) return {rows:ledger.filter(c=>c.original_evidence_id===args[0]).slice(-1).map(c=>({...c,accepted:historyValid}))};
  if(sql.startsWith('INSERT INTO copy_execution_valuation_corrections')) {
    if(ledger.some(c=>c.valuation_id===args[1])) throw new Error('duplicate trusted valuation');
    const [correction_id,valuation_id,original_evidence_id,execution_id,user_id,original_digest,original_snapshot,revision,previous_correction_id,effective_quote_usd,effective_fee_usd,
      recorded_at,lineage_source_trade_id,lineage_acquisition_evidence_id,lineage_master_wallet_address,quote_origin_valuation_id,fee_origin_valuation_id]=args;
    ledger.push({correction_id,valuation_id,original_evidence_id,execution_id,user_id,original_digest,original_snapshot,revision,previous_correction_id,effective_quote_usd,effective_fee_usd,
      recorded_at,lineage_source_trade_id,lineage_acquisition_evidence_id,lineage_master_wallet_address,quote_origin_valuation_id,fee_origin_valuation_id});
    return {rows:[{correction_id}]};
  }
  if(sql.includes('SUM(base_quantity)')) {
    const active=fills.filter(f=>['confirmed','finalized'].includes(f.confirmation_state));
    const subtotal=(field:'quote'|'fee')=>active.map(effective).filter(e=>e[field]!==null).reduce((sum,e)=>sum+BigInt(e[field]!),0n);
    const unknown=active.filter(f=>{const e=effective(f);return e.quote===null||e.fee===null;}).length;
    return {rows:[{base:String(active.length),quote:active.some(f=>effective(f).quote!==null)?String(subtotal('quote')):null,
      fee:active.some(f=>effective(f).fee!==null)?String(subtotal('fee')):null,debit:String(subtotal('quote')+subtotal('fee')),
      unknown:String(unknown),invalidCorrections:historyValid?'0':'1',quoteUnknown:String(active.filter(f=>effective(f).quote===null).length),completes:active.some(f=>f.completes_execution),evidenceCount:String(active.length)}]};
  }
  if(sql.startsWith('SELECT NOT EXISTS (')) return {rows:[{authorized:true}]};
  if(sql.startsWith('UPDATE copy_executions execution SET')) return {rows:[{id:'execution'}]};
  if(sql.startsWith('UPDATE master_capacity_ledger')) {capacity=effective(fills[0]!).quote;return {rows:[{source_trade_id:'source'}]};}
  if(sql.startsWith('WITH RECURSIVE ordered')) {
    if(failProjection) throw new Error('projection rollback');
    const e=effective(fills[0]!);position=e.quote===null||e.fee===null?null:String(BigInt(e.quote)+BigInt(e.fee));return {rows:[{id:'position'}]};
  }
  if(sql.startsWith('UPDATE copy_position_master')) return {rows:[]};
  throw new Error(`unexpected SQL ${sql}`);
})} as unknown as PoolClient;}
beforeEach(()=>{fills=[{...original}];values=new Map();ledger=[];sqls=[];capacity=null;position=null;inventory='1';failProjection=false;lineageValid=true;historyValid=true;mocks.source.mockResolvedValue(true);});
describe('immutable persisted-authorized worker valuation corrections',()=>{
  it('price-only preserves original unknown fee and immutable inventory',async()=>{
    trusted('price','20',null);const tx=client();await appendWorkerValuationCorrectionWithClient(tx,patch('price'));
    expect(await readWorkerFinancialTotalsWithClient(tx,'execution')).toMatchObject({quote:'20',fee:null,unknown:'1',debit:'20'});
    await projectWorkerEconomicsWithClient(tx,execution);
    expect(fills[0]).toEqual(original);expect(inventory).toBe('1');expect(capacity).toBe('20');expect(position).toBeNull();
  });
  it('fee-only preserves original known price and becomes complete only with coverage',async()=>{
    fills[0]!.quote_quantity='20';trusted('fee',null,'2');const tx=client();await appendWorkerValuationCorrectionWithClient(tx,patch('fee'));
    expect(await readWorkerFinancialTotalsWithClient(tx,'execution')).toMatchObject({quote:'20',fee:'2',unknown:'0',debit:'22'});
    await projectWorkerEconomicsWithClient(tx,execution);expect(position).toBe('22');expect(fills[0]!.fee_usd).toBeNull();
  });
  it('multiple partial patches carry cumulative fields and duplicate has no new accrual',async()=>{
    trusted('price','20',null);trusted('fee',null,'2','2');const tx=client();
    await appendWorkerValuationCorrectionWithClient(tx,patch('price'));await appendWorkerValuationCorrectionWithClient(tx,patch('fee','price'));
    expect(await appendWorkerValuationCorrectionWithClient(tx,patch('fee','price'))).toMatchObject({replayed:true});
    await projectWorkerEconomicsWithClient(tx,execution);await projectWorkerEconomicsWithClient(tx,execution);
    expect(ledger).toHaveLength(2);expect(capacity).toBe('20');expect(position).toBe('22');expect(inventory).toBe('1');
    expect(sqls.every(s=>!s.includes('INSERT INTO copy_position')&&!s.includes('UPDATE copy_execution_evidence'))).toBe(true);
  });
  it('second uncorrected fill retains unknown coverage even with terminal first fill',async()=>{
    fills.push({...original,id:'second',completes_execution:false});trusted('full','20','2');const tx=client();
    await appendWorkerValuationCorrectionWithClient(tx,patch('full'));
    expect(await readWorkerFinancialTotalsWithClient(tx,'execution')).toMatchObject({base:'2',unknown:'1',completes:true,evidenceCount:'2'});
  });
  it.each(['missing','untrusted','tenant','digest','clamp','source','reversal'])('denies %s without economic writes',async(kind)=>{
    trusted('value','20','2');const value=values.get('value')!;
    if(kind==='missing')values.clear();if(kind==='untrusted')value.authorized=false;if(kind==='tenant')value.user_id='other';
    if(kind==='digest')value.original_digest='wrong';if(kind==='clamp')value.quote_usd='101';if(kind==='source')mocks.source.mockResolvedValue(false);
    if(kind==='reversal')fills[0]!.confirmation_state='reversed';
    await expect(appendWorkerValuationCorrectionWithClient(client(),patch('value'))).rejects.toThrow();expect(ledger).toEqual([]);expect(capacity).toBeNull();
  });
  it('conflicting id/revision/predecessor fail, authorized downward price is not inventory reversal',async()=>{
    trusted('first','20','2');trusted('second','10',null,'2');const tx=client();await appendWorkerValuationCorrectionWithClient(tx,patch('first'));
    await expect(appendWorkerValuationCorrectionWithClient(tx,patch('second'))).rejects.toThrow(/predecessor/);
    await expect(appendWorkerValuationCorrectionWithClient(tx,{...patch('first'),valuationId:'second'})).rejects.toThrow(/conflict/);
    await appendWorkerValuationCorrectionWithClient(tx,patch('second','first'));expect(effective(fills[0]!).quote).toBe('10');expect(inventory).toBe('1');
  });
  it('caller transaction rollback discards append and projections together',async()=>{
    trusted('value','20','2');const tx=client(),before=structuredClone({ledger,capacity,position,inventory,fills});failProjection=true;
    try{await appendWorkerValuationCorrectionWithClient(tx,patch('value'));await projectWorkerEconomicsWithClient(tx,execution);}catch{
      ledger=before.ledger;capacity=before.capacity;position=before.position;inventory=before.inventory;fills=before.fills;
    }
    expect(ledger).toEqual([]);expect(capacity).toBeNull();expect(inventory).toBe('1');expect(fills[0]).toEqual(original);
  });
  it('explicit lot exit correction binds acquisition lineage instead of requiring direct source id',async()=>{
    fills[0]!.source_trade_id=null;trusted('exit','20','2');const tx=client();
    const exit={...patch('exit'),execution:{id:'execution',userId:null,sourceTradeId:null,chain:'solana',targetAccount:'solana:paper',tokenMint:'solana:asset',executionMode:'paper',direction:'sell',exitLotId:'lot'} as never};
    await appendWorkerValuationCorrectionWithClient(tx,exit);
    expect(ledger[0]).toMatchObject({lineage_source_trade_id:'source',lineage_acquisition_evidence_id:'acquisition',lineage_master_wallet_address:'solana:master'});
    expect(inventory).toBe('1');lineageValid=false;
    await expect(appendWorkerValuationCorrectionWithClient(tx,exit)).rejects.toThrow(/lineage/);
  });
  it('accepted historical correction survives admission expiry but explicit invalidation refuses replay/accounting',async()=>{
    trusted('value','20','2');const tx=client();await appendWorkerValuationCorrectionWithClient(tx,patch('value'));
    values.get('value')!.authorized=false;mocks.source.mockResolvedValue(false);
    expect(await appendWorkerValuationCorrectionWithClient(tx,{...patch('value'),now:new Date('2030-01-01')})).toMatchObject({replayed:true});
    expect(await readWorkerFinancialTotalsWithClient(tx,'execution')).toMatchObject({debit:'22'});
    historyValid=false;
    await expect(appendWorkerValuationCorrectionWithClient(tx,patch('value'))).rejects.toThrow(/invalidated/);
    await expect(readWorkerFinancialTotalsWithClient(tx,'execution')).rejects.toThrow(/authorization/);
  });
  it('fee-only carries exact price field origin and denies invalid predecessor history',async()=>{
    trusted('price','20',null);trusted('fee',null,'2','2');const tx=client();
    await appendWorkerValuationCorrectionWithClient(tx,patch('price'));historyValid=false;
    await expect(appendWorkerValuationCorrectionWithClient(tx,patch('fee','price'))).rejects.toThrow(/carried field/);
    historyValid=true;await appendWorkerValuationCorrectionWithClient(tx,patch('fee','price'));
    expect(ledger[1]).toMatchObject({quote_origin_valuation_id:'price',fee_origin_valuation_id:'fee',effective_quote_usd:'20'});
  });
  it('base/native quantity precision is not restricted by USD money scale',()=>{
    const quantity='123456789012345678901234567890.0000000000000000000000001';
    expect(workerQuantity(quantity)).toBe(quantity);
    const snapshot=workerOriginalEvidenceSnapshot({...original,base_quantity:quantity,quote_native_quantity:quantity});
    expect(snapshot).toMatchObject({baseQuantity:quantity,quoteNativeQuantity:quantity});
  });
  it.each(['NaN','1e3','-1','0.0000000000000000001','100000000000000000000'])('rejects unsupported money %s',value=>expect(()=>workerMoney(value)).toThrow());
  it('preserves exact large decimal text without IEEE rounding',()=>expect(workerMoney('99999999999999999999.000000000000000001')).toBe('99999999999999999999.000000000000000001'));
});
