import { describe, expect, it } from 'vitest';
import { createReducingOwnedComposition, assertReducingEconomicConservation, reducingOwnedBoundary } from './reducing-owned-composition.js';
import { assertOwnedFinancialConservation } from './withdrawal-owned-observer.js';
import { assertOwnedFinancialSettler } from './reducing-owned-journal.js';
import { applyPerpsReducingReceiptWithClient } from '@swat/db/dist/reducing-owned.js';
import { createReducingService } from '@swat/db/dist/reducing-service.js';
import { reducingIntent, type ReducingIntent, type ReducingRequest } from '@swat/db/dist/reducing-contract.js';
import { financialHash, type FinancialRecord, type FinancialReceipt, type WithdrawalSqlClient, type WithdrawalTransaction } from '@swat/db/dist/withdrawal-contract.js';
import { createDurableFinancialRunner, reducingAccountingAdapter } from '../../../apps/trade-executor/src/reducing-orchestration.js';
import { withdrawalSqlFixture, financialAuthorizationFixture, financialFundingFixture, reducingMappingFixture } from '../../../packages/db/src/withdrawal-test-fixture.js';
import { createFinancialReceiptAdmission } from '@swat/db/dist/withdrawal-owned.js';
import { admitWave4SpotAccountingWithClient, createWave4SpotSettler, type Wave4SpotAdmission } from '@swat/db/dist/wave4-financial-backing-owned.js';

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
        permanentTombstoneSupported:true,now:async()=>db.now,lockScope:async(r,a)=>financialAuthorizationFixture(r,a,db.now,'offline-provider'),
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
  it('joined non-impersonating polymarket-perps composition settles partial -> final fills with settler drift refusal',async()=>{
    const POSITION_ID='22222222-2222-4222-8222-222222222222';
    const perpsReq:ReducingRequest={...request,positionId:POSITION_ID};
    const db=withdrawalSqlFixture();
    let appRole:'swat_app'|'swat_financial_receipt_writer'='swat_app';
    let settlerRow:Record<string,unknown>={owner_role:'swat_financial_settler',rolcanlogin:false,rolsuper:false,rolbypassrls:false,
      rolinherit:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,prosecdef:true,
      proconfig:['search_path=pg_catalog'],can_execute:true,has_memberships:false};
    const identityRow=(role:'swat_app'|'swat_financial_receipt_writer')=>({role_name:role,session_role:role,role_setting:'none',
      row_security:'on',rolcanlogin:true,rolsuper:false,rolbypassrls:false,rolinherit:false,rolcreaterole:false,rolcreatedb:false,
      rolreplication:false,backend_pid:456,transaction_clean:true,has_memberships:false,owns_objects:false,
      receipt_insert:role==='swat_financial_receipt_writer',intent_insert:role==='swat_app'});
    const wrap=(receiptWriter=false):WithdrawalTransaction=>(tenant,operation)=>db.transaction(tenant,async base=>{
      const client:WithdrawalSqlClient={async query<Row>(sql:string,values:unknown[]=[]){
        const marker=/\/\* ([a-z-]+:[a-z-]+) \*\//.exec(sql)?.[1];
        const state=db.state();
        let rows:unknown[]|null=null;
        if(marker==='financial-owned:identity') rows=[identityRow(receiptWriter?'swat_financial_receipt_writer':appRole)];
        if(marker==='financial-owned:settler') rows=[settlerRow];
        if(marker==='reducing-owned:mapping') rows=state.mappings.filter(r=>r.user_id===values[0]&&r.position_id===values[1]&&r.mapping_id===values[2])
          .map(r=>({mapping:r.mapping,mapping_hash:r.mapping_hash}));
        if(marker==='financial-owned:receipt-intent') rows=state.intents.filter(r=>r.user_id===tenant&&r.id===values[1]);
        if(marker==='financial-owned:receipt-attempt') rows=state.attempts.filter(r=>r.user_id===tenant&&r.intent_id===values[1]);
        if(marker==='financial-owned:receipt-replay') rows=state.receipts.filter(r=>r.user_id===tenant&&r.intent_id===values[1]&&r.receipt_id===values[2]);
        if(marker==='financial-owned:receipt-admit'){db.admit(JSON.parse(String(values[6])) as FinancialReceipt,tenant);rows=[];}
        if(marker==='reducing:perps-delta'){
          const rec=state.receipts.find(r=>r.receipt_id===values[0]&&r.intent_id===values[1]&&r.user_id===values[2]&&r.receipt_hash===values[3]);
          const att=rec?state.attempts.find(a=>a.id===rec.receipt.attemptId&&a.intent_id===rec.intent_id&&a.user_id===rec.user_id&&!a.terminal):null;
          rows=rec&&att?[{delta_raw:(BigInt(rec.receipt.cumulativeRaw)-BigInt(att.completed_raw)).toString(),
            delta_fee_raw:(BigInt(rec.receipt.feeRaw)-BigInt(att.completed_fee_raw)).toString()}]:[];
        }
        if(marker==='reducing:perps-economics') rows=state.economics.filter(e=>e.receipt_id===values[0]&&e.intent_id===values[1]&&e.user_id===values[2])
          .map(e=>({economics_reference:e.economics_reference}));
        if(marker==='reducing:perps-account'){
          const parent=state.intents.find(i=>i.id===values[0]&&i.user_id===tenant);
          const rec=state.receipts.find(r=>r.receipt_id===values[1]&&r.intent_id===values[0]&&r.user_id===tenant);
          const att=rec?state.attempts.find(a=>a.id===rec.receipt.attemptId):null;
          if(!parent||!rec||!att) throw new Error('missing perps account scope');
          const delta=(BigInt(rec.receipt.cumulativeRaw)-BigInt(att.completed_raw)).toString();
          const beforeRaw=state.held;
          const afterRaw=(BigInt(beforeRaw)-BigInt(delta)).toString();
          state.held=afterRaw;
          rows=[{accounting_reference:'perps-journal:'+rec.receipt_id,position_id:parent.intent.positionId,
            position_side:parent.intent.positionSide,before_raw:beforeRaw,after_raw:afterRaw}];
        }
        if(marker==='financial-observer:intent') rows=state.intents.filter(r=>r.user_id===tenant&&r.id===values[1]);
        if(marker==='financial-observer:attempts') rows=state.attempts.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({id:r.id,intentId:r.intent_id,userId:r.user_id,intentHash:r.intent_hash,clientOrderId:r.client_order_id,
            state:r.state,completedRaw:r.completed_raw,completedFeeRaw:r.completed_fee_raw,terminal:r.terminal}));
        if(marker==='financial-observer:receipts') rows=state.receipts.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({receipt:r.receipt,hash:r.receipt_hash}));
        if(marker==='financial-observer:applications') rows=state.applications.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({receiptId:r.receipt_id,attemptId:r.attempt_id,deltaRaw:r.delta_raw,accountingReference:r.accounting_reference}));
        if(marker==='financial-observer:reservations') rows=state.reservations.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({budgetKey:r.budget_key,amountRaw:r.amount_raw,feeRaw:r.fee_raw,reservedRaw:r.reserved_raw}));
        if(marker==='financial-observer:outbox') rows=state.outbox.filter(r=>r.user_id===tenant&&r.intent_id===values[1]).map(r=>({intentHash:r.intent_hash}));
        if(marker==='financial-observer:authorization') rows=state.auth.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({id:r.id,consumed:r.consumed_at!==null,failures:r.failures,delivery:r.delivery_state}));
        return rows===null?base.query<Row>(sql,values):{rows:structuredClone(rows) as Row[]};
      }};
      return operation(client);
    });
    let selected:FinancialReceipt|null=null, mappingId='';
    const receipts=createFinancialReceiptAdmission<ReducingIntent>({transaction:wrap(true),verify:async(_r,_a,obs)=>obs===selected?selected:null});
    const c=createReducingOwnedComposition({
      application:{transaction:wrap(),lockExposure:async(_client,intent)=>({...intent,heldRaw:'100',revision:'r1',observedAt:db.now,
        validUntil:new Date(Date.parse(db.now)+60_000).toISOString(),proof:'inert'}),
        lockFunding:async(_client,tenant,budget)=>financialFundingFixture(tenant,budget,db.now)},
      observer:wrap(),
      mappingId:async()=>mappingId,
      provider:{identity:'offline-provider',network:'offline-137',reduceOnlySupported:true,atomicDeadlineSupported:true,
        permanentTombstoneSupported:true,now:async()=>db.now,lockScope:async(r,a)=>financialAuthorizationFixture(r,a,db.now,'offline-provider'),
        currentExposure:async r=>({...r.intent,heldRaw:'100',observedAt:db.now,validUntil:new Date(Date.parse(db.now)+60_000).toISOString(),proof:'inert'}),
        placeReduceOnly:async()=>null,reconcile:async()=>selected,verifyNoFutureAcceptance:async()=>false},
      receipts});
    const fakeRecord:FinancialRecord<ReducingIntent>={id:'intent-1',userId:user,intent:reducingIntent(user,perpsReq,'2026-11-17T12:05:00.000Z'),
      intentHash:'0'.repeat(64),status:'queued',completedRaw:'0',terminal:false,createdAt:db.now};
    const mapping=reducingMappingFixture(fakeRecord,db.now);
    mappingId=mapping.mappingId;
    db.admitMapping(fakeRecord,mapping);
    const admitted=await c.application.request(user,perpsReq);
    // Non-impersonation check: swat_app cannot be substituted by receipt writer.
    appRole='swat_financial_receipt_writer';
    await expect(c.process(user,admitted.id)).rejects.toMatchObject({code:'financial-distinct-approved-database-identity-unavailable'});
    appRole='swat_app';

    // First process creates uncertain attempt.
    expect((await c.process(user,admitted.id)).record.status).toBe('uncertain');
    const attempt=db.state().attempts[0]!;
    const partialReceipt:FinancialReceipt={...receipt(admitted,'2'),receiptId:'perps-partial',attemptId:attempt.id,
      clientOrderId:attempt.client_order_id,cumulativeRaw:'40',feeRaw:'2',terminal:false};
    await db.transaction(user,cl=>cl.query('/* fixture:economics */',[admitted.id,user,partialReceipt.receiptId,'econ-partial',JSON.stringify({pnl:'-1'})]));
    selected=partialReceipt;
    expect((await c.process(user,admitted.id)).record.status).toBe('partial');

    const finalReceipt:FinancialReceipt={...receipt(admitted,'5'),receiptId:'perps-final',attemptId:attempt.id,
      clientOrderId:attempt.client_order_id,cumulativeRaw:'100',feeRaw:'5',terminal:true};
    await db.transaction(user,cl=>cl.query('/* fixture:economics */',[admitted.id,user,finalReceipt.receiptId,'econ-final',JSON.stringify({pnl:'-2'})]));
    selected=finalReceipt;
    expect((await c.process(user,admitted.id)).record.status).toBe('settled');

    const journal=await c.observe(user,admitted.id);
    assertOwnedFinancialConservation(journal);
    expect(journal.applications.map(a=>a.deltaRaw)).toEqual(['40','60']);
    assertReducingEconomicConservation({side:'LONG',beforeRaw:'100',deltaRaw:'40',afterRaw:'60',
      collateralBeforeRaw:'1000',realizedPnlRaw:'-1',collateralAfterRaw:'999',marginBeforeRaw:'500',marginAfterRaw:'300'});

    // Drift checks on assertOwnedFinancialSettler.
    for(const drift of [{owner_role:'swat_app'},{prosecdef:false},{proconfig:['search_path=public']},{rolcanlogin:true}]) {
      const saved=settlerRow;
      settlerRow={...settlerRow,...drift};
      await expect(wrap()(user,cl=>assertOwnedFinancialSettler(cl))).rejects.toMatchObject({code:'financial-distinct-protected-settler-unavailable'});
      settlerRow=saved;
    }
  });
  it('joined non-impersonating spot composition settles LONG lot exit with createWave4SpotSettler and refuses zero-base fee-only fill',async()=>{
    const POSITION_ID='22222222-2222-4222-8222-222222222222';
    const EXECUTION_ID='33333333-3333-4333-8333-333333333333';
    const LOT_ID='44444444-4444-4444-8444-444444444444';
    const IDENTITY_ID='55555555-5555-4555-8555-555555555555';
    const EVIDENCE_ID='66666666-6666-4666-8666-666666666666';
    const REDUCTION_ID='77777777-7777-4777-8777-777777777777';
    const spotReq:ReducingRequest={requestKey:'spot-owned-source',chain:'solana',network:'solana:offline',venue:'spot',
      positionId:POSITION_ID,accountId:'solana:inert-account',assetId:'solana:inert-asset',assetScale:6,mode:'paper',positionSide:'LONG',
      quantityRaw:'1250000',maxFeeRaw:'10',feeAssetId:'SOL',feeAssetScale:9,feeFundingAccountId:'solana:inert-fee-account',
      limitPriceExact:'2',expectedRevision:'r1'};
    const db=withdrawalSqlFixture();
    const spotAdmissions:Record<string,any>[]=[];
    const accountingAdmissions:Record<string,any>[]=[];
    const spotSettlements:Record<string,any>[]=[];
    let evidenceRow:Record<string,any>|null=null;
    let positionState={beforeRaw:'2500000.00000000000000000000',afterRaw:'1250000.00000000000000000000',afterQty:'1.25'};
    const executionRow={id:EXECUTION_ID,signal_id:null,source_trade_id:null,exit_lot_id:LOT_ID,exit_trigger:'manual',
      chain:spotReq.chain,target_account:spotReq.accountId,user_id:user,token_mint:spotReq.assetId,direction:'sell',
      execution_mode:'paper',client_order_id:'fixed-order',state:'submitted',requested_base_quantity:'1.25',
      requested_quote_quantity:null,confirmed_base_quantity:'0',confirmed_quote_quantity:null,quote_unassessed_fill_count:0,
      reserved_base_quantity:'1.25',submission_attempts:1,max_submission_attempts:3,simulation_id:null,submission_type:null,
      submission_id:null,next_reconciliation_at:null,reconciliation_claim_id:null,reconciliation_attempts:0,
      max_reconciliation_attempts:3,source_position_before_quantity:null,source_sell_fraction:null};
    const identityRow=(role:'swat_app'|'swat_financial_receipt_writer')=>({role_name:role,session_role:role,role_setting:'none',
      row_security:'on',rolcanlogin:true,rolsuper:false,rolbypassrls:false,rolinherit:false,rolcreaterole:false,rolcreatedb:false,
      rolreplication:false,backend_pid:789,transaction_clean:true,has_memberships:false,owns_objects:false,
      receipt_insert:role==='swat_financial_receipt_writer',intent_insert:role==='swat_app'});
    const wrap=(receiptWriter=false):WithdrawalTransaction=>(tenant,operation)=>db.transaction(tenant,async base=>{
      const client:WithdrawalSqlClient={async query<Row>(sql:string,values:unknown[]=[]){
        const marker=/\/\* ([a-z-]+:[a-z-]+) \*\//.exec(sql)?.[1];
        const state=db.state();
        let rows:unknown[]|null=null;
        if(marker==='financial-owned:identity') rows=[identityRow(receiptWriter?'swat_financial_receipt_writer':'swat_app')];
        else if(marker==='financial-owned:receipt-intent') rows=state.intents.filter(r=>r.user_id===tenant&&r.id===values[1]);
        else if(marker==='financial-owned:receipt-attempt') rows=state.attempts.filter(r=>r.user_id===tenant&&r.intent_id===values[1]);
        else if(marker==='financial-owned:receipt-replay') rows=state.receipts.filter(r=>r.user_id===tenant&&r.intent_id===values[1]&&r.receipt_id===values[2]);
        else if(marker==='financial-owned:receipt-admit'){db.admit(JSON.parse(String(values[6])) as FinancialReceipt,tenant);rows=[];}
        else if(marker==='financial-owned:accounting-admission'){
          rows=accountingAdmissions.filter(a=>a.user_id===values[0]&&a.intent_id===values[1]&&a.receipt_id===values[2]
            &&a.delta_raw===values[3]&&a.delta_fee_raw===values[4]).map(a=>({accounting_reference:a.accounting_reference}));
        }
        else if(marker==='financial-observer:intent') rows=state.intents.filter(r=>r.user_id===tenant&&r.id===values[1]);
        else if(marker==='financial-observer:attempts') rows=state.attempts.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({id:r.id,intentId:r.intent_id,userId:r.user_id,intentHash:r.intent_hash,clientOrderId:r.client_order_id,
            state:r.state,completedRaw:r.completed_raw,completedFeeRaw:r.completed_fee_raw,terminal:r.terminal}));
        else if(marker==='financial-observer:receipts') rows=state.receipts.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({receipt:r.receipt,hash:r.receipt_hash}));
        else if(marker==='financial-observer:applications') rows=state.applications.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({receiptId:r.receipt_id,attemptId:r.attempt_id,deltaRaw:r.delta_raw,accountingReference:r.accounting_reference}));
        else if(marker==='financial-observer:reservations') rows=state.reservations.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({budgetKey:r.budget_key,amountRaw:r.amount_raw,feeRaw:r.fee_raw,reservedRaw:r.reserved_raw}));
        else if(marker==='financial-observer:outbox') rows=state.outbox.filter(r=>r.user_id===tenant&&r.intent_id===values[1]).map(r=>({intentHash:r.intent_hash}));
        else if(marker==='financial-observer:authorization') rows=state.auth.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({id:r.id,consumed:r.consumed_at!==null,failures:r.failures,delivery:r.delivery_state}));
        else if(sql.includes('wave4_direct089(')) rows=[{allowed:true}];
        else if(sql.includes('INSERT INTO public.wave4_spot_admissions089')){
          spotAdmissions.push({user_id:values[0],receipt_id:values[1],intent_id:values[2],attempt_id:values[3],execution_id:values[6],
            lot_id:values[7],position_id:values[8],delta_raw:values[18],delta_fee_raw:values[19],intent_hash:values[21],
            receipt_hash:values[24],evidence_input:JSON.parse(String(values[25])),evidence_hash:values[27],
            economics_hash:values[30],accounting_reference:values[31]});
          rows=[];
        }
        else if(sql.includes('INSERT INTO public.withdrawal_reducing_accounting_admissions')){
          accountingAdmissions.push({receipt_id:values[0],user_id:values[1],intent_id:values[2],delta_raw:values[3],
            delta_fee_raw:values[4],accounting_reference:values[5]});
          rows=[];
        }
        else if(sql.includes(' AS before_raw')) rows=spotAdmissions.filter(p=>p.user_id===values[0]&&p.intent_id===values[1]
          &&p.receipt_id===values[2]&&p.receipt_hash===values[3]&&p.intent_hash===values[4]&&p.delta_raw===values[5]
          &&p.delta_fee_raw===values[6]&&p.position_id===values[7]).map(p=>({...p,before_raw:positionState.beforeRaw}));
        else if(sql.includes(' AS after_raw')) rows=[{after_raw:positionState.afterRaw,evidence_id:EVIDENCE_ID}];
        else if(sql.includes('INSERT INTO public.wave4_spot_settlements089')){spotSettlements.push({values});rows=[];}
        else if(sql.includes('FROM copy_executions')&&sql.includes('FOR UPDATE')) rows=[executionRow];
        else if(sql.includes('INSERT INTO copy_execution_evidence')){
          evidenceRow={id:EVIDENCE_ID,execution_id:values[0],evidence_type:values[1],evidence_id:values[2],base_quantity:values[3],
            quote_quantity:values[4],quote_native_quantity:values[5],quote_currency:values[6],quote_native_usd_price:values[7],
            price_usd:values[8],confirmation_state:values[9],completes_execution:values[10],occurred_at:values[11]};
          rows=[];
        }
        else if(sql.includes(' AS payload_matches')&&sql.includes('FROM copy_execution_evidence')) rows=[{...evidenceRow,payload_matches:true}];
        else if(sql.includes('SELECT id')&&sql.includes('FROM copy_positions')) rows=[{id:POSITION_ID}];
        else if(sql.includes('SELECT id FROM copy_position_master_lot_reductions')) rows=[];
        else if(sql.includes('INSERT INTO copy_position_master_lot_reductions')) rows=[{id:REDUCTION_ID}];
        else if(sql.includes(' AS confirmed_base_quantity')&&sql.includes('SUM(base_quantity)')) rows=[{
          confirmed_base_quantity:'1.25',valued_quote_usd_sum:'2.5',valued_fill_count:'1',unvalued_fill_count:'0',completes_execution:true}];
        else if(sql.includes('WITH RECURSIVE ordered_events')) rows=[{id:POSITION_ID,target_account:spotReq.accountId,chain:spotReq.chain,
          token_mint:spotReq.assetId,user_id:user,confirmed_quantity:positionState.afterQty,reserved_sell_quantity:'0',
          cost_basis_usd:null,total_acquired_quantity:'2.5',total_reduced_quantity:'1.25',unmatched_reduction_quantity:'0',
          cost_basis_unvalued_fill_count:1,last_evidence_at:new Date(db.now)}];
        else if(sql.includes('UPDATE copy_executions')&&sql.includes('SET state')) rows=[{...executionRow,state:values[1]}];
        else if(sql.includes('UPDATE copy_executions')&&sql.includes('SET confirmed_base_quantity')) rows=[{...executionRow,state:'confirmed',
          confirmed_base_quantity:'1.25',confirmed_quote_quantity:'2.5',reserved_base_quantity:'0'}];
        else if(/^\s*(?:INSERT INTO (?:copy_positions|copy_position_applications|copy_execution_state_history)|UPDATE copy_position_master_lots lot)\b/.test(sql)) rows=[];
        return rows===null?base.query<Row>(sql,values):{rows:structuredClone(rows) as Row[]};
      }};
      return operation(client);
    });
    let selected:FinancialReceipt|null=null;
    const receipts=createFinancialReceiptAdmission<ReducingIntent>({transaction:wrap(true),verify:async(_r,_a,obs)=>obs===selected?selected:null});
    const c=createReducingOwnedComposition({
      application:{transaction:wrap(),lockExposure:async(_client,intent)=>({...intent,heldRaw:'2500000',revision:'r1',observedAt:db.now,
        validUntil:new Date(Date.parse(db.now)+60_000).toISOString(),proof:'inert'}),
        lockFunding:async(_client,tenant,budget)=>financialFundingFixture(tenant,budget,db.now)},
      observer:wrap(),
      spotSettler:createWave4SpotSettler(),
      provider:{identity:'offline-provider',network:'solana:offline',reduceOnlySupported:true,atomicDeadlineSupported:true,
        permanentTombstoneSupported:true,now:async()=>db.now,lockScope:async(r,a)=>financialAuthorizationFixture(r,a,db.now,'offline-provider'),
        currentExposure:async r=>({...r.intent,heldRaw:'2500000',observedAt:db.now,validUntil:new Date(Date.parse(db.now)+60_000).toISOString(),proof:'inert'}),
        placeReduceOnly:async()=>null,reconcile:async()=>selected,verifyNoFutureAcceptance:async()=>false},
      receipts});
    const admitted=await c.application.request(user,spotReq);
    expect((await c.process(user,admitted.id)).record.status).toBe('uncertain');
    const attempt=db.state().attempts[0]!;
    executionRow.client_order_id=attempt.client_order_id;
    const spotReceipt:FinancialReceipt={receiptId:'spot-final',providerIdentity:'offline-provider',proof:'inert-evidence',
      intentId:admitted.id,intentHash:admitted.intentHash,attemptId:attempt.id,clientOrderId:attempt.client_order_id,
      cumulativeRaw:'1250000',feeRaw:'1',feeAssetId:spotReq.feeAssetId,feeAssetScale:spotReq.feeAssetScale,
      feeFundingAccountId:spotReq.feeFundingAccountId,terminal:true,outcome:'fill',observedAt:db.now};
    const spotInput:Wave4SpotAdmission={identityId:IDENTITY_ID,authorityRevision:'1',lotId:LOT_ID,executionId:EXECUTION_ID,
      evidence:{executionId:EXECUTION_ID,evidenceType:'paper_simulation',evidenceId:'spot-copy-ev-1',baseQuantity:'1.25',
        quoteLeg:{amount:'2.5',currency:'USD'},priceUsd:'2',feeUsd:'0.000001',confirmationState:'finalized',
        completesExecution:true,occurredAt:db.now,observedAt:db.now},
      economics:{feeAssetId:spotReq.feeAssetId,feeAssetScale:spotReq.feeAssetScale,feeFundingAccountId:spotReq.feeFundingAccountId,
        feeRaw:'1',feeUnitUsd:'1',feeUsd:'0.000001',quoteAssetId:'USDC',quoteAssetScale:6,
        quoteAccountId:spotReq.accountId,quoteRaw:'2500000',quoteCurrency:'USD'}};
    const attemptObj={id:attempt.id,intentId:attempt.intent_id,userId:attempt.user_id,clientOrderId:attempt.client_order_id,
      intentHash:attempt.intent_hash,state:'uncertain' as const,completedRaw:attempt.completed_raw,
      completedFeeRaw:attempt.completed_fee_raw,terminal:attempt.terminal};
    const ref=await wrap(true)(user,cl=>admitWave4SpotAccountingWithClient(cl,admitted,attemptObj,
      spotReceipt,'1250000','1',spotInput));
    expect(ref).toBe(`spot:${EXECUTION_ID}:spot-final`);
    selected=spotReceipt;
    const settled=await c.process(user,admitted.id);
    expect(settled.record.status).toBe('settled');
    expect(spotSettlements).toHaveLength(1);
    const journal=await c.observe(user,admitted.id);
    assertOwnedFinancialConservation(journal);
    await expect(wrap()(user,cl=>createWave4SpotSettler()(cl,admitted,spotReceipt,'0','1'))).rejects.toThrow('invalid-exact-raw');
  });
});
