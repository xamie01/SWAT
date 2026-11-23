import { describe, expect, it } from 'vitest';
import { createReducingOwnedComposition, assertReducingEconomicConservation, reducingOwnedBoundary } from './reducing-owned-composition.js';
import { applyPerpsReducingReceiptWithClient } from '@swat/db/dist/reducing-owned.js';
import { createReducingService } from '@swat/db/dist/reducing-service.js';
import { reducingIntent, type ReducingIntent, type ReducingRequest } from '@swat/db/dist/reducing-contract.js';
import { financialHash, type FinancialRecord, type FinancialReceipt, type WithdrawalSqlClient } from '@swat/db/dist/withdrawal-contract.js';
import { createDurableFinancialRunner, reducingAccountingAdapter } from '../../../apps/trade-executor/src/reducing-orchestration.js';
import { withdrawalSqlFixture, financialAuthorizationFixture, financialFundingFixture, reducingMappingFixture } from '../../../packages/db/src/withdrawal-test-fixture.js';
import { createFinancialReceiptAdmission } from '@swat/db/dist/withdrawal-owned.js';

const user='11111111-1111-4111-8111-111111111111',now='2026-11-17T12:00:00.000Z';
const request:ReducingRequest={requestKey:'perps-owned-source',chain:'polygon',network:'offline-137',venue:'polymarket-perps',
  positionId:'position',accountId:'venue-account',assetId:'instrument',assetScale:6,mode:'paper',positionSide:'LONG',quantityRaw:'100',
  maxFeeRaw:'10',feeAssetId:'MATIC',feeAssetScale:18,feeFundingAccountId:'native-fee-account',limitPriceExact:'2.123456',expectedRevision:'r1'};
function record(side:'LONG'|'SHORT'='LONG'):FinancialRecord<ReducingIntent>{
  const intent=reducingIntent(user,{...request,positionSide:side},'2026-11-17T12:05:00.000Z');
  return {id:'intent',userId:user,intent,intentHash:financialHash(intent),status:'uncertain',completedRaw:'0',terminal:false,createdAt:now};
}
function receipt(r:FinancialRecord<ReducingIntent>,fee='0'):FinancialReceipt{
  return {receiptId:'receipt',providerIdentity:'offline-provider',proof:'inert-evidence',intentId:r.id,intentHash:r.intentHash,
    attemptId:'attempt',clientOrderId:'fixed-order',cumulativeRaw:'40',feeRaw:fee,feeAssetId:r.intent.feeAssetId,
    feeAssetScale:r.intent.feeAssetScale,feeFundingAccountId:r.intent.feeFundingAccountId,terminal:false,outcome:'fill',observedAt:now};
}
/** Actual protected perps body; only external SQL result transport inert. No copied production business/SQL trigger logic. */
function perpsTransport(r:FinancialRecord<ReducingIntent>){
  const queries:{marker:string;client:WithdrawalSqlClient;values:unknown[]}[]=[];
  let missing:string|null=null,badAfter=false;
  const client:WithdrawalSqlClient={async query<Row>(sql:string,values:unknown[]=[]){
    const marker=/\/\* ([a-z-]+:[a-z-]+) \*\//.exec(sql)?.[1];if(!marker)throw new Error('unexpected inert SQL');
    queries.push({marker,client,values});
    const rows=missing===marker?[]:marker==='reducing:perps-delta'?[{delta_raw:'40',delta_fee_raw:'0'}]
      :marker==='reducing:perps-economics'?[{economics_reference:'independent-economics'}]
      :marker==='reducing:perps-account'?[{accounting_reference:'position-journal',position_id:r.intent.positionId,
        position_side:r.intent.positionSide,before_raw:'100',after_raw:badAfter?'101':'60'}]:[];
    return {rows:rows as Row[]};
  }};
  return {client,queries,missing:(value:string)=>{missing=value;},badAfter:()=>{badAfter=true;}};
}

describe('reducing owned P5b source; canonical bodies with inert external IO only',()=>{
  it.each(['LONG','SHORT'] as const)('canonical %s perps settler joins independent exact receipt/economics before restricted SQL and never uses native fee as collateral',async side=>{
    const r=record(side),t=perpsTransport(r),proof=receipt(r);
    const applied=await reducingAccountingAdapter(applyPerpsReducingReceiptWithClient)(t.client,r,proof,'40','0');
    expect(applied).toBe('position-journal');expect(t.queries.map(q=>q.marker))
      .toEqual(['reducing:perps-delta','reducing:perps-economics','reducing:perps-account']);
    expect(t.queries.every(q=>q.client===t.client)).toBe(true);
    expect(t.queries[0]?.values).toEqual([proof.receiptId,r.id,user,financialHash(proof)]);
    expect(t.queries[2]?.values).toEqual([r.id,proof.receiptId]);
  });
  it.each(['reducing:perps-delta','reducing:perps-economics'])('missing %s refuses before position accounting, including zero-fee fills',async marker=>{
    const r=record(),t=perpsTransport(r);t.missing(marker);
    await expect(applyPerpsReducingReceiptWithClient(t.client,r,receipt(r),'40','0')).rejects.toThrow();
    expect(t.queries.some(q=>q.marker==='reducing:perps-account')).toBe(false);
  });
  it('perps accounting cannot cross zero, grow/reopen exposure or accept a substituted fee funding denomination',async()=>{
    const r=record(),t=perpsTransport(r);t.badAfter();
    await expect(applyPerpsReducingReceiptWithClient(t.client,r,receipt(r),'40','0'))
      .rejects.toMatchObject({code:'perps-reducing-accounting-conflict'});
    const other=perpsTransport(r);await expect(applyPerpsReducingReceiptWithClient(other.client,r,
      {...receipt(r),feeFundingAccountId:'caller-substituted-collateral'},'40','0'))
      .rejects.toMatchObject({code:'perps-receipt-fee-denomination-mismatch'});
    expect(other.queries).toHaveLength(0);
  });
  it('independent exact observer arithmetic conserves very large LONG/SHORT exposure and collateral/PnL/margin',()=>{
    for(const side of ['LONG','SHORT'] as const){
      const input={side,beforeRaw:'900719925474099312345',deltaRaw:'40',afterRaw:'900719925474099312305',
        collateralBeforeRaw:'900719925474099312345',realizedPnlRaw:'-7',collateralAfterRaw:'900719925474099312338',
        marginBeforeRaw:'999',marginAfterRaw:'960'};
      expect(()=>assertReducingEconomicConservation(input)).not.toThrow();
      expect(()=>assertReducingEconomicConservation({...input,afterRaw:input.beforeRaw})).toThrow();
      expect(()=>assertReducingEconomicConservation({...input,collateralAfterRaw:input.collateralBeforeRaw})).toThrow();
      expect(()=>assertReducingEconomicConservation({...input,marginAfterRaw:'1000'})).toThrow();
    }
  });
  it('the joined owned mapping adapter refuses absent actual identity despite possession of source ports and labels',async()=>{
    const db=withdrawalSqlFixture();
    const c=createReducingOwnedComposition({application:{transaction:db.transaction,
      lockExposure:async(_client,intent)=>({...intent,heldRaw:'100',revision:'r1',observedAt:db.now,
        validUntil:'2026-11-17T12:01:00.000Z',proof:'inert'}),
      lockFunding:async(_client,tenant,budget)=>financialFundingFixture(tenant,budget,db.now)},
      observer:(tenant,operation)=>db.transaction(tenant,operation),
      provider:{identity:'offline-provider',network:'offline-137',reduceOnlySupported:true,atomicDeadlineSupported:true,
        permanentTombstoneSupported:true,now:async()=>db.now,lockScope:async(r,a)=>financialAuthorizationFixture(r,a,db.now),
        currentExposure:async r=>({...r.intent,heldRaw:'100',observedAt:db.now,validUntil:'2026-11-17T12:01:00.000Z',proof:'inert'}),
        placeReduceOnly:async()=>null,reconcile:async()=>null,verifyNoFutureAcceptance:async()=>false},
      receipts:{verify:async()=>null,admit:async()=>{throw new Error('independent writer unavailable');}}});
    await expect(c.application.request(user,request)).rejects.toThrow('Unsupported fixture marker financial-owned:identity');
    expect(db.state().intents).toHaveLength(0);expect(c.application).not.toHaveProperty('process');
    expect(c.boundary).toEqual(reducingOwnedBoundary);
  });
  it('canonical admission refuses unadmitted mapping instead of deriving USDC collateral from MATIC fee or account labels',async()=>{
    const db=withdrawalSqlFixture();
    const service=createReducingService({transaction:db.transaction,
      lockExposure:async(_client,intent)=>({...intent,heldRaw:'100',revision:'r1',observedAt:db.now,
        validUntil:'2026-11-17T12:01:00.000Z',proof:'inert'}),
      lockFunding:async(_client,tenant,budget)=>financialFundingFixture(tenant,budget,db.now),
      lockVenueMapping:async(_client,r)=>reducingMappingFixture(r,db.now)});
    await expect(service.request(user,{...request,maxFeeRaw:'0'}))
      .rejects.toMatchObject({code:'reducing-independent-collateral-mapping-unavailable'});
    expect(db.state().reservations).toHaveLength(0);expect(db.state().outbox).toHaveLength(0);
  });
  it('receipt writer cannot accept a copied public receipt projection without its own actual verifier output',async()=>{
    const r=record(),db=withdrawalSqlFixture();let calls=0;
    const writer=createFinancialReceiptAdmission<ReducingIntent>({transaction:async(_user,operation)=>{calls++;return db.transaction(user,operation);},verify:async()=>null});
    await expect(writer.admit(r,{id:'attempt',intentId:r.id,userId:user,clientOrderId:'fixed-order',intentHash:r.intentHash,
      state:'uncertain',completedRaw:'0',completedFeeRaw:'0',terminal:false},receipt(r)))
      .rejects.toMatchObject({code:'financial-authenticated-receipt-verifier-required'});
    expect(calls).toBe(0);
  });
  it('real runner leaves unknown fixed attempt and exact exposure/fee reservations unchanged on null reconciliation',async()=>{
    const db=withdrawalSqlFixture();const service=createReducingService({transaction:db.transaction,
      lockExposure:async(_client,intent)=>({...intent,heldRaw:'100',revision:'r1',observedAt:db.now,
        validUntil:'2026-11-17T12:01:00.000Z',proof:'inert'}),
      lockFunding:async(_client,tenant,budget)=>financialFundingFixture(tenant,budget,db.now)});
    const admitted=await service.request(user,{...request,venue:'spot'});let submitted=0;
    const runner=createDurableFinancialRunner<ReducingIntent>({transaction:db.transaction,revalidate:service.revalidate,
      effects:{authorize:async(r,a)=>financialAuthorizationFixture(r,a,db.now),submit:async()=>{submitted++;throw new Error('unknown');},
        reconcile:async()=>null,verify:async()=>null},account:async()=>{throw new Error('no canonical spot binding');}});
    expect((await runner.run(user,admitted.id)).kind).toBe('uncertain');
    const before=structuredClone(db.state());db.advance(600_000);
    await runner.run(user,admitted.id);expect(db.state()).toEqual(before);expect(submitted).toBe(1);
    expect(db.state().applications).toHaveLength(0);expect(db.state().reservations.map(r=>r.reserved_raw)).toEqual(['100','10']);
  });
  it('settler failure preserves canonical perps receipt progress and economic journals atomically',async()=>{
    const db=withdrawalSqlFixture();
    const service=createReducingService({transaction:db.transaction,
      lockExposure:async(_client,intent)=>({...intent,heldRaw:'100',revision:'r1',observedAt:db.now,
        validUntil:'2026-11-17T12:01:00.000Z',proof:'inert'}),
      lockFunding:async(_client,tenant,budget)=>financialFundingFixture(tenant,budget,db.now),
      lockVenueMapping:async(_client,r)=>{const mapping=reducingMappingFixture(r,db.now);db.admitMapping(r,mapping);return mapping;}});
    const admitted=await service.request(user,request);let proof:FinancialReceipt|null=null;
    const runner=createDurableFinancialRunner<ReducingIntent>({transaction:db.transaction,revalidate:service.revalidate,
      effects:{authorize:async(r,a)=>financialAuthorizationFixture(r,a,db.now),submit:async()=>null,reconcile:async()=>proof,
        verify:async()=>proof},account:async()=>{throw new Error('actual economics admission unavailable');}});
    await runner.run(user,admitted.id);const a=db.state().attempts[0]!;
    proof={...receipt(admitted),attemptId:a.id,clientOrderId:a.client_order_id};db.admit(proof,user);
    const before=structuredClone(db.state());await expect(runner.run(user,admitted.id)).rejects.toThrow('actual economics admission unavailable');
    expect(db.state()).toEqual(before);expect(db.state().applications).toHaveLength(0);
  });
});
