import { describe, expect, it, vi } from 'vitest';
vi.mock('@swat/db', async () => ({
  ...await import('@swat/db/dist/withdrawal-contract.js'),
  ...await import('@swat/db/dist/withdrawal-store.js'),
  ...await import('@swat/db/dist/withdrawal-service.js'),
  ...await import('@swat/db/dist/reducing-contract.js'),
  ...await import('@swat/db/dist/reducing-service.js')
}));
import { createDurableFinancialRunner, reducingAccountingAdapter } from './reducing-orchestration.js';
import { createReduceOnlyEffectPorts, type ReduceOnlyProvider } from './reducing-provider.js';
import { withdrawalSqlFixture, financialFundingFixture, financialAuthorizationFixture, reducingMappingFixture } from '@swat/db/dist/withdrawal-test-fixture.js';
import { createReducingService } from '@swat/db/dist/reducing-service.js';
import { createWithdrawalService, type WithdrawalEligibility } from '@swat/db/dist/withdrawal-service.js';
import { type ReducingExposure, type ReducingIntent, type ReducingRequest } from '@swat/db/dist/reducing-contract.js';
import { financialHash, type FinancialAttempt, type FinancialRecord, type FinancialReceipt, type WithdrawalSqlClient } from '@swat/db/dist/withdrawal-contract.js';

function setup(venue:'spot'|'polymarket-perps'='polymarket-perps',positionSide:'LONG'|'SHORT'='LONG') {
  const db=withdrawalSqlFixture();
  const input: { -readonly [K in keyof ReducingRequest]: ReducingRequest[K] } = {requestKey:'close-1',chain:'polygon',network:'polygon-137',venue,positionId:'position-1',accountId:'account-1',
    assetId:'1',assetScale:8,mode:'paper',positionSide,quantityRaw:'100',maxFeeRaw:'0',
    feeAssetId:'USDC',feeAssetScale:6,feeFundingAccountId:'fee-account',limitPriceExact:'65000',expectedRevision:'r1'};
  const exposure:ReducingExposure={userId:'user-1',positionId:input.positionId,accountId:input.accountId,assetId:input.assetId,
    assetScale:8,mode:'paper',positionSide,chain:input.chain,network:input.network,venue,heldRaw:'100',revision:'r1',
    observedAt:db.now,validUntil:'2026-11-17T12:01:00.000Z',proof:'fixture-independent-exposure'};
  const lockVenueMapping=vi.fn(async(_client:WithdrawalSqlClient,record:FinancialRecord<ReducingIntent>)=>{
    const existing=db.state().mappings.find(m=>m.intent_id===record.id);
    const mapping=existing?.mapping??reducingMappingFixture(record,db.now);
    db.admitMapping(record,mapping);return mapping;
  });
  const service=createReducingService({transaction:db.transaction,lockExposure:async()=>exposure,lockVenueMapping,
    lockFunding:async(_c,u,b)=>financialFundingFixture(u,b,db.now,db.state().feeHeld)});
  let selected:FinancialReceipt|null=null;
  let identity: {record:FinancialRecord<ReducingIntent>;attempt:FinancialAttempt}|null=null;
  const authorize=vi.fn(async(record:FinancialRecord<ReducingIntent>,attempt:FinancialAttempt)=>{
    identity={record,attempt};return financialAuthorizationFixture(record,attempt,db.now);
  });
  const submit=vi.fn(async()=>{db.events.push('effect:submit');return selected;});
  const reconcile=vi.fn(async()=>selected);
  const verify=vi.fn(async(_record:FinancialRecord<ReducingIntent>,_attempt:FinancialAttempt,observation:unknown)=>observation as FinancialReceipt|null);
  const account=vi.fn(async(client:WithdrawalSqlClient,record:FinancialRecord<ReducingIntent>,receipt:FinancialReceipt,delta:string,fee:string)=>{
    const before=db.state().held;
    const economicsReference='fixture-full-economics:'+receipt.receiptId;
    const mapping=db.state().mappings.find(m=>m.intent_id===record.id)?.mapping??reducingMappingFixture(record,db.now);
    // Actual same-client persisted economics fixture journal, rolled back with inventory/fee/application on failure.
    await client.query(`INSERT INTO fixture_economics VALUES($1,$2,$3,$4,$5) /* fixture:economics */`,[
      record.id,record.userId,receipt.receiptId,economicsReference,JSON.stringify({receiptId:receipt.receiptId,intentId:record.id,
        economicsReference,venueMappingId:mapping.mappingId,collateralAssetId:mapping.collateralAssetId,
        collateralAssetScale:mapping.collateralAssetScale,collateralAccountId:mapping.collateralAccountId,
        deltaRaw:delta,deltaFeeRaw:fee,beforeRaw:before,afterRaw:(BigInt(before)-BigInt(delta)).toString(),
        feeBalanceBeforeRaw:db.state().feeHeld,feeBalanceAfterRaw:(BigInt(db.state().feeHeld)-BigInt(fee)).toString(),
        realizedPnlExact:'1',collateralDeltaExact:'1',initialMarginBeforeExact:'10',initialMarginAfterExact:'0',
        maintenanceMarginBeforeExact:'5',maintenanceMarginAfterExact:'0',entryPriceExact:'64000',executionPriceExact:'65000',
        positionEconomicsReference:'fixture-position-economics',accountJournalReference:'fixture-account-journal'})]);
    await client.query('SELECT $1 /* fixture:account */',[delta,fee]);
    return {accountingReference:'canonical:'+record.intent.positionId+':'+receipt.receiptId,positionId:record.intent.positionId,
      positionSide:record.intent.positionSide,beforeRaw:before,afterRaw:db.state().held,economicsReference};
  });
  const runner=()=>createDurableFinancialRunner({transaction:db.transaction,revalidate:service.revalidate,
    effects:{authorize,submit,reconcile,verify},account:reducingAccountingAdapter(account)});
  function receipt(quantity:string,terminal:boolean,id='receipt-1',overrides:Partial<FinancialReceipt>={}) {
    if(!identity)throw new Error('attempt not prepared');
    selected={receiptId:id,providerIdentity:'independent-fixture',proof:'fixture-proof',intentId:identity.record.id,
      intentHash:identity.record.intentHash,attemptId:identity.attempt.id,clientOrderId:identity.attempt.clientOrderId,
      cumulativeRaw:quantity,feeRaw:'0',feeAssetId:input.feeAssetId,feeAssetScale:input.feeAssetScale,
      feeFundingAccountId:input.feeFundingAccountId,terminal,outcome:'fill',observedAt:db.now,...overrides};
    db.admit(selected,'user-1');return selected;
  }
  return {db,input,service,exposure,lockVenueMapping,authorize,submit,reconcile,verify,account,runner,receipt,
    selected:(value:FinancialReceipt|null)=>{selected=value;},identity:()=>identity};
}
describe('durable financial effect actual injected orchestration (SQL transcript, not PG)',()=>{
  it('persists reservation/outbox/attempt and commits write-ahead uncertain fence before provider effect',async()=>{
    const s=setup(),record=await s.service.request('user-1',s.input);
    const result=await s.runner().run('user-1',record.id);
    expect(result.kind).toBe('uncertain');expect(result.submitted).toBe(true);expect(result.record.completedRaw).toBe('0');
    const fence=s.db.events.indexOf('financial:dispatch-fence'),effect=s.db.events.indexOf('effect:submit');
    expect(fence).toBeGreaterThan(s.db.events.indexOf('financial:prepare'));
    expect(s.db.events.slice(fence+1,effect)).toContain('commit:user-1');
    expect(s.db.state().intents[0]!.status).toBe('uncertain');expect(s.db.state().outbox).toHaveLength(1);
  });
  it('restart and every uncertain retry reconcile without duplicate submission or false completion',async()=>{
    const s=setup(),record=await s.service.request('user-1',s.input);
    s.submit.mockRejectedValue(new Error('timeout after provider accepted'));
    await s.runner().run('user-1',record.id);
    for(let i=0;i<3;i++)expect((await s.runner().run('user-1',record.id)).kind).toBe('uncertain');
    expect(s.submit).toHaveBeenCalledTimes(1);expect(s.reconcile).toHaveBeenCalledTimes(3);expect(s.db.state().attempts).toHaveLength(1);
    expect(s.account).not.toHaveBeenCalled();expect(s.db.state().reservations.find(r=>r.purpose==='exposure')!.reserved_raw).toBe('100');
  });
  it('crash-left prepared attempt remains reconciliation-only even when no effect was sent',async()=>{
    const s=setup(),record=await s.service.request('user-1',s.input);
    s.authorize.mockRejectedValue(new Error('authority absent'));
    await s.runner().run('user-1',record.id);await s.runner().run('user-1',record.id);
    expect(s.submit).not.toHaveBeenCalled();expect(s.authorize).toHaveBeenCalledTimes(1);expect(s.reconcile).toHaveBeenCalledTimes(1);
  });
  it.each(['mode','quantity','revision'])('revalidates %s after authorization and before durable effect fence',async(kind)=>{
    const s=setup(),record=await s.service.request('user-1',s.input);
    s.authorize.mockImplementation(async(r,a)=>{Object.assign(s.exposure,kind==='mode'?{mode:'live'}:kind==='quantity'?{heldRaw:'99'}:{revision:'r2'});return financialAuthorizationFixture(r,a,s.db.now);});
    await expect(s.runner().run('user-1',record.id)).rejects.toThrow();expect(s.submit).not.toHaveBeenCalled();
    expect(s.db.state().attempts[0]!.state).toBe('prepared');
  });
  it.each(['spot','polymarket-perps'] as const)('accounts %s partial then final authenticated receipts exactly once',async(venue)=>{
    const s=setup(venue),record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);
    const partial=s.receipt('40',false),first=await s.runner().run('user-1',record.id);
    expect(first.kind).toBe('partial');expect(first.record.completedRaw).toBe('40');expect(first.record.terminal).toBe(false);
    expect(s.db.state().held).toBe('60');expect(s.db.state().reservations.find(r=>r.purpose==='exposure')!.reserved_raw).toBe('60');
    await s.runner().run('user-1',record.id);expect(s.account).toHaveBeenCalledTimes(1);
    s.receipt('100',true,'receipt-2');const final=await s.runner().run('user-1',record.id);
    expect(final.kind).toBe('settled');expect(final.record.terminal).toBe(true);expect(final.record.completedRaw).toBe('100');
    expect(s.db.state().held).toBe('0');expect(s.db.state().reservations.find(r=>r.purpose==='exposure')!.reserved_raw).toBe('0');
    expect(s.account.mock.calls.map(c=>c[3])).toEqual(['40','60']);expect(s.submit).toHaveBeenCalledTimes(1);
    s.selected(partial);await s.runner().run('user-1',record.id);expect(s.account).toHaveBeenCalledTimes(2);
    const accountingWrites=s.db.transcript.filter(t=>['fixture:economics','fixture:account','financial:apply-receipt'].includes(t.marker));
    expect(accountingWrites).toHaveLength(6);expect(s.db.state().economics).toHaveLength(2);
    expect(accountingWrites.slice(0,3).every(t=>t.client===accountingWrites[0]!.client)).toBe(true);
    expect(accountingWrites.slice(3).every(t=>t.client===accountingWrites[3]!.client)).toBe(true);
    expect(accountingWrites[0]!.client).not.toBe(accountingWrites[3]!.client);
  });
  it('terminal partial receipt releases only unfilled remainder and does not report fully settled/closed',async()=>{
    const s=setup(),record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);s.receipt('40',true);
    const result=await s.runner().run('user-1',record.id);
    expect(result.kind).toBe('partial');expect(result.record.terminal).toBe(true);expect(result.record.completedRaw).toBe('40');
    expect(s.db.state().reservations.find(r=>r.purpose==='exposure')!.reserved_raw).toBe('0');expect(s.db.state().held).toBe('60');expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it.each(['overfill','scope','fee','unadmitted'])('denies %s without accounting/settlement',async(kind)=>{
    const s=setup(),record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);
    const r=s.receipt(kind==='overfill'?'101':'40',true,'receipt-bad',kind==='scope'?{intentHash:'f'.repeat(64)}:kind==='fee'?{feeRaw:'1'}:{});
    if(kind==='unadmitted')s.db.state().receipts.length=0;
    await expect(s.runner().run('user-1',record.id)).rejects.toThrow();expect(s.account).not.toHaveBeenCalled();
    expect(s.db.state().intents[0]!.status).toBe('uncertain');expect(s.db.state().applications).toHaveLength(0);expect(r).toBeTruthy();
  });
  it('regressing cumulative evidence cannot undo accounting or authorize retry',async()=>{
    const s=setup(),record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);
    s.receipt('40',false);await s.runner().run('user-1',record.id);s.receipt('39',true,'regression');
    await expect(s.runner().run('user-1',record.id)).rejects.toThrow('financial-receipt-overfill-or-regression');
    expect(s.db.state().held).toBe('60');expect(s.account).toHaveBeenCalledTimes(1);expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it('rolls back canonical inventory and application when receipt persistence fails',async()=>{
    const s=setup(),record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);s.receipt('40',false);
    s.db.fail('financial:apply-receipt');await expect(s.runner().run('user-1',record.id)).rejects.toThrow();
    expect(s.db.state().held).toBe('100');expect(s.db.state().economics).toHaveLength(0);expect(s.db.state().applications).toHaveLength(0);expect(s.db.state().attempts[0]!.completed_raw).toBe('0');
    s.db.fail(null);await s.runner().run('user-1',record.id);expect(s.db.state().held).toBe('60');expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it('refuses a missing canonical accounting join instead of claiming provider fill closes inventory',async()=>{
    const s=setup('spot'),record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);s.receipt('100',true);
    s.account.mockRejectedValue(new Error('canonical-spot-settlement-adapter-unavailable'));
    await expect(s.runner().run('user-1',record.id)).rejects.toThrow('canonical-spot-settlement-adapter-unavailable');
    expect(s.db.state().intents[0]!.status).toBe('uncertain');expect(s.db.state().held).toBe('100');
  });
  it('expired queued no-attempt intent is audited cancelled/releases all budgets and never becomes uncertain',async()=>{
    const s=setup();const record=await s.service.request('user-1',s.input);s.db.advance(300_000);
    const result=await s.runner().run('user-1',record.id);
    expect(result.kind).toBe('cancelled');expect(result.record.terminal).toBe(true);
    expect(result.record.cancellationReason).toBe('expired-before-attempt');expect(s.db.state().cancellations).toHaveLength(1);
    expect(s.db.state().reservations.every(r=>r.reserved_raw==='0')).toBe(true);expect(s.db.state().attempts).toHaveLength(0);
    await s.runner().run('user-1',record.id);expect(s.authorize).not.toHaveBeenCalled();expect(s.submit).not.toHaveBeenCalled();
  });
  it('expiry on an already prepared/uncertain attempt NEVER cancels or releases',async()=>{
    const s=setup();const record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);s.db.advance(900_000);
    expect((await s.runner().run('user-1',record.id)).kind).toBe('uncertain');expect(s.db.state().cancellations).toHaveLength(0);
    expect(s.db.state().reservations.find(r=>r.purpose==='exposure')!.reserved_raw).toBe('100');
  });
  it('plain terminal absence without permanent provider tombstone cannot release before delayed submit',async()=>{
    const s=setup();const record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);
    s.receipt('0',true,'plain404',{outcome:'absent-final'});
    await expect(s.runner().run('user-1',record.id)).rejects.toThrow('financial-no-future-acceptance-unavailable');
    expect(s.db.state().intents[0]!.status).toBe('uncertain');expect(s.db.state().reservations.find(r=>r.purpose==='exposure')!.reserved_raw).toBe('100');
  });
  it('fee-only then partial paid-fee receipts derive separate outstanding funding and exposure',async()=>{
    const s=setup();s.input.maxFeeRaw='10';const record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);
    s.receipt('0',false,'fee-only',{feeRaw:'2'});await s.runner().run('user-1',record.id);
    expect(s.db.state().feeHeld).toBe('998');expect(s.db.state().held).toBe('100');
    expect(s.db.state().reservations.find(r=>r.purpose==='funding')!.reserved_raw).toBe('8');
    s.receipt('40',false,'partial-paid-fee',{feeRaw:'5'});await s.runner().run('user-1',record.id);
    expect(s.db.state().held).toBe('60');expect(s.db.state().feeHeld).toBe('995');
    expect(s.db.state().reservations.find(r=>r.purpose==='funding')!.reserved_raw).toBe('5');
    expect(s.db.state().reservations.find(r=>r.purpose==='exposure')!.reserved_raw).toBe('60');
    expect(s.account.mock.calls.map(c=>[c[3],c[4]])).toEqual([['0','2'],['40','3']]);
  });
  it('nonterminal full fill closes exposure then final fee-only journal does not reopen or double reduce',async()=>{
    const s=setup();s.input.maxFeeRaw='10';const record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);
    s.receipt('100',false,'full-exposure',{feeRaw:'2'});const first=await s.runner().run('user-1',record.id);
    expect(first.record.terminal).toBe(false);expect(s.db.state().held).toBe('0');expect(s.db.state().positionStatus).toBe('closed');
    expect(s.db.state().reservations.find(r=>r.purpose==='funding')!.reserved_raw).toBe('8');
    s.receipt('100',true,'final-paid-fee',{feeRaw:'5'});const final=await s.runner().run('user-1',record.id);
    expect(final.kind).toBe('settled');expect(s.db.state().held).toBe('0');expect(s.db.state().positionStatus).toBe('closed');
    expect(s.db.state().feeHeld).toBe('995');expect(s.db.state().economics).toHaveLength(2);
    expect(s.db.state().economics[1]!.journal).toMatchObject({beforeRaw:'0',afterRaw:'0',deltaRaw:'0',deltaFeeRaw:'3'});
    expect(s.db.state().reservations.every(r=>r.reserved_raw==='0')).toBe(true);
    await s.runner().run('user-1',record.id);expect(s.account.mock.calls.map(c=>[c[3],c[4]])).toEqual([['100','2'],['0','3']]);
  });
  it('native fee and independently mapped USDC collateral stay distinct in actual persisted economics journal',async()=>{
    const s=setup();s.input.feeAssetId='MATIC';s.input.feeAssetScale=18;s.input.feeFundingAccountId='native-fee-account';s.input.maxFeeRaw='10';
    const record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);s.receipt('40',false,'native-fee-fill',{feeRaw:'2'});
    await s.runner().run('user-1',record.id);
    expect(record.intent.feeAssetId).toBe('MATIC');expect(record.intent.feeAssetScale).toBe(18);
    expect(s.db.state().economics[0]!.journal).toMatchObject({collateralAssetId:'USDC',collateralAssetScale:6,collateralAccountId:'collateral-account'});
    expect(s.db.state().feeHeld).toBe('998');
  });
  it('missing/unadmitted independent mapping refuses perps before outbox',async()=>{
    const s=setup();s.lockVenueMapping.mockImplementation(async(_c,r)=>reducingMappingFixture(r,s.db.now));
    await expect(s.service.request('user-1',s.input)).rejects.toThrow('reducing-independent-collateral-mapping-unavailable');
    expect(s.db.state().outbox).toHaveLength(0);expect(s.db.state().intents).toHaveLength(0);
  });
  it('deferred commit failure rolls back actual coherent position/economics/application',async()=>{
    const s=setup();s.input.maxFeeRaw='10';const record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);
    s.receipt('100',true,'deferred-full',{feeRaw:'5'});
    s.db.fail('deferred-commit');await expect(s.runner().run('user-1',record.id)).rejects.toThrow('deferred commit failure');
    expect(s.db.state().held).toBe('100');expect(s.db.state().positionStatus).toBe('open');expect(s.db.state().feeHeld).toBe('1000');
    expect(s.db.state().economics).toHaveLength(0);expect(s.db.state().applications).toHaveLength(0);expect(s.db.state().intents[0]!.status).toBe('uncertain');
    s.db.fail(null);await s.runner().run('user-1',record.id);
    expect(s.db.state().held).toBe('0');expect(s.db.state().positionStatus).toBe('closed');expect(s.db.state().feeHeld).toBe('995');
    expect(s.db.state().economics).toHaveLength(1);expect(s.db.state().economics[0]!.journal).toMatchObject({
      receiptId:'deferred-full',deltaRaw:'100',deltaFeeRaw:'5',feeBalanceBeforeRaw:'1000',feeBalanceAfterRaw:'995'});
  });
  it('two concurrent worker instances submit at most once under durable attempt/fence',async()=>{
    const s=setup(),record=await s.service.request('user-1',s.input);
    await Promise.all([s.runner().run('user-1',record.id),s.runner().run('user-1',record.id)]);
    expect(s.submit).toHaveBeenCalledTimes(1);expect(s.db.state().attempts).toHaveLength(1);
  });
});
describe('injected atomic reduce-only provider adapter',()=>{
  it.each(['LONG','SHORT'] as const)('sends exact %s reducing IOC with fixed clientOrderId and no TP/SL/leverage',async(side)=>{
    const s=setup('polymarket-perps',side);const record=await s.service.request('user-1',s.input);
    await s.runner().run('user-1',record.id);const attempt=s.identity()!.attempt;
    const provider:ReduceOnlyProvider={identity:'provider-keyless',network:s.input.network,reduceOnlySupported:true,
      atomicDeadlineSupported:true,permanentTombstoneSupported:true,now:async()=>s.db.now,
      lockScope:vi.fn(async()=>financialAuthorizationFixture(record,attempt,s.db.now,'provider-keyless')),
      currentExposure:vi.fn(async()=>({...s.exposure,proof:'provider-proof'})),
      placeReduceOnly:vi.fn(async()=>null),reconcile:vi.fn(async()=>null),verifyReceipt:vi.fn(async()=>null),
      verifyNoFutureAcceptance:vi.fn(async()=>true),admitReceipt:vi.fn(async()=>{})};
    const ports=createReduceOnlyEffectPorts(provider),authorization=await ports.authorize(record,attempt);
    await ports.submit(record,attempt,authorization);
    expect(provider.placeReduceOnly).toHaveBeenCalledWith(expect.objectContaining({accountId:'account-1',assetId:'1',clientOrderId:attempt.clientOrderId,
      intentId:record.id,intentHash:record.intentHash,attemptId:attempt.id,deadline:record.intent.expiresAt,
      feeAssetId:'USDC',feeAssetScale:6,feeFundingAccountId:'fee-account',
      side:side==='LONG'?'SELL':'BUY',quantity:'0.00000100',limitPriceExact:'65000',reduceOnly:true,timeInForce:'IOC'}),authorization);
    Object.assign(provider,{currentExposure:async()=>({...s.exposure,heldRaw:'99'})});
    await expect(ports.submit(record,attempt,authorization)).rejects.toThrow('reducing-would-cross-zero');
    expect(provider.placeReduceOnly).toHaveBeenCalledTimes(1);
  });
  it('provider acquisition delayed past deadline refuses before place even after durable uncertain fence',async()=>{
    const s=setup();const record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);
    const attempt=s.identity()!.attempt;
    const provider:ReduceOnlyProvider={identity:'provider-keyless',network:s.input.network,reduceOnlySupported:true,
      atomicDeadlineSupported:true,permanentTombstoneSupported:true,now:async()=>s.db.now,
      lockScope:async()=>financialAuthorizationFixture(record,attempt,s.db.now,'provider-keyless'),
      currentExposure:async()=>{s.db.advance(300_000);return {...s.exposure};},placeReduceOnly:vi.fn(async()=>null),
      reconcile:async()=>null,verifyReceipt:async()=>null,verifyNoFutureAcceptance:async()=>true,admitReceipt:async()=>{}};
    const effects=createReduceOnlyEffectPorts(provider),authorization=await effects.authorize(record,attempt);
    await expect(effects.submit(record,attempt,authorization)).rejects.toThrow('financial-authorization-expired');
    expect(provider.placeReduceOnly).not.toHaveBeenCalled();
  });
  it.each(['userId','network','assetScale','positionId','stale'])('provider refuses acquired %s scope/freshness before actual place',async(field)=>{
    const s=setup();const record=await s.service.request('user-1',s.input);await s.runner().run('user-1',record.id);const attempt=s.identity()!.attempt;
    const exposure={...s.exposure,...(field==='stale'?{observedAt:'2026-11-17T11:00:00.000Z'}:{[field]:field==='assetScale'?9:'substituted'})};
    const provider:ReduceOnlyProvider={identity:'provider-keyless',network:s.input.network,reduceOnlySupported:true,atomicDeadlineSupported:true,
      permanentTombstoneSupported:true,now:async()=>s.db.now,lockScope:async()=>financialAuthorizationFixture(record,attempt,s.db.now,'provider-keyless'),
      currentExposure:async()=>exposure,placeReduceOnly:vi.fn(async()=>null),reconcile:async()=>null,verifyReceipt:async()=>null,
      verifyNoFutureAcceptance:async()=>true,admitReceipt:async()=>{}};
    const effects=createReduceOnlyEffectPorts(provider),authorization=await effects.authorize(record,attempt);
    await expect(effects.submit(record,attempt,authorization)).rejects.toThrow();expect(provider.placeReduceOnly).not.toHaveBeenCalled();
  });
  it('interleaved absent-final tombstone permanently blocks original paused submitter after release',async()=>{
    const s=setup();const record=await s.service.request('user-1',s.input);
    let paused!:()=>void,resume!:()=>void;
    const atPlace=new Promise<void>(r=>{paused=r;}),gate=new Promise<void>(r=>{resume=r;});
    let tombstoned=false,selected:FinancialReceipt|null=null,attempt:FinancialAttempt|null=null;
    const provider:ReduceOnlyProvider={identity:'provider-keyless',network:s.input.network,reduceOnlySupported:true,
      atomicDeadlineSupported:true,permanentTombstoneSupported:true,now:async()=>s.db.now,
      lockScope:async(r,a)=>{attempt=a;return financialAuthorizationFixture(r,a,s.db.now,'provider-keyless');},
      currentExposure:async()=>({...s.exposure}),
      placeReduceOnly:vi.fn(async()=>{paused();await gate;if(tombstoned)throw new Error('provider permanent tombstone rejects late acceptance');return null;}),
      reconcile:async()=>{
        // Authenticated provider first atomically records permanent order tombstone, THEN returns final absence.
        tombstoned=true;
        selected={receiptId:'tombstone-receipt',providerIdentity:'provider-keyless',proof:'provider-proof',intentId:record.id,intentHash:record.intentHash,
          attemptId:attempt!.id,clientOrderId:attempt!.clientOrderId,cumulativeRaw:'0',feeRaw:'0',feeAssetId:record.intent.feeAssetId,
          feeAssetScale:record.intent.feeAssetScale,feeFundingAccountId:record.intent.feeFundingAccountId,terminal:true,outcome:'absent-final',observedAt:s.db.now,
          noFutureAcceptance:{intentId:record.id,intentHash:record.intentHash,attemptId:attempt!.id,clientOrderId:attempt!.clientOrderId,
            providerIdentity:'provider-keyless',tombstoneId:'provider-permanent-order-tombstone',proof:'authenticated-provider-proof',
            effectiveAt:s.db.now,guarantee:'permanent-no-future-acceptance'}};
        return selected;
      },verifyReceipt:async(_r,_a,o)=>o as FinancialReceipt|null,
      verifyNoFutureAcceptance:async()=>tombstoned,admitReceipt:async r=>{s.db.admit(r,'user-1');}};
    const effects=createReduceOnlyEffectPorts(provider),runner=createDurableFinancialRunner({transaction:s.db.transaction,
      revalidate:s.service.revalidate,effects,account:reducingAccountingAdapter(s.account)});
    const original=runner.run('user-1',record.id);await atPlace;
    const reconciled=await runner.run('user-1',record.id);
    expect(reconciled.kind).toBe('failed');expect(s.db.state().reservations.every(r=>r.reserved_raw==='0')).toBe(true);
    resume();await original;expect(tombstoned).toBe(true);expect(s.db.state().held).toBe('100');expect(s.account).not.toHaveBeenCalled();
    expect(provider.placeReduceOnly).toHaveBeenCalledTimes(1);
  });
  it('refuses a provider without atomic reduceOnly rather than trusting a fresh snapshot',()=>{
    expect(()=>createReduceOnlyEffectPorts({identity:'fixture',network:'polygon',reduceOnlySupported:false} as ReduceOnlyProvider))
      .toThrow('provider-atomic-reduce-only-unavailable');
  });
});

describe('withdrawal exact effect/reconciliation uses actual service and runner',()=>{
  it('mutated destination verification enters cooling before effect, no provider dispatch',async()=>{
    const db=withdrawalSqlFixture(),request={requestKey:'cooling-w1',chain:'polygon' as const,network:'polygon137',assetId:'USDC',assetScale:6,
      sourceWalletId:'wallet-1',destination:'0x'+'a'.repeat(40),amountRaw:'100',maxFeeRaw:'0',feeAssetId:'MATIC',feeAssetScale:18,
      feeFundingAccountId:'fee-wallet',mode:'paper' as const};
    const evidence:WithdrawalEligibility={...request,userId:'user-1',destinationVerifiedAt:'2026-11-15T12:00:00.000Z',availableRaw:'1000',
      observedAt:db.now,validUntil:'2026-11-17T12:01:00.000Z',custodyRevision:'r1',balanceProof:'proof'};
    const service=createWithdrawalService({transaction:db.transaction,lockEligibility:async()=>evidence,
      lockFunding:async(_c,u,b)=>financialFundingFixture(u,b,db.now),
      otp:{issue:async h=>({code:'123456',digest:financialHash([h,'123456'])}),digest:async(h,c)=>financialHash([h,c]),deliver:async()=>true}});
    const auth=await service.requestOtp('user-1',request);await service.submit('user-1',{intentId:auth.intent.id,authorizationId:auth.authorizationId,otp:'123456'});
    const submit=vi.fn(async()=>null),runner=createDurableFinancialRunner({transaction:db.transaction,revalidate:service.revalidate,
      effects:{authorize:async(r,a)=>{Object.assign(evidence,{destinationVerifiedAt:db.now});return financialAuthorizationFixture(r,a,db.now);},
        submit,reconcile:async()=>null,verify:async()=>null},account:async()=>{throw new Error('should not account');}});
    await expect(runner.run('user-1',auth.intent.id)).rejects.toThrow('withdrawal-cooling-off');expect(submit).not.toHaveBeenCalled();
  });
  it('accounts cumulative amount/fee delta once on reconciliation in distinct funding units',async()=>{
    const db=withdrawalSqlFixture();
    const request={requestKey:'w1',chain:'polygon' as const,network:'polygon-137',assetId:'USDC',assetScale:6,sourceWalletId:'wallet-1',
      destination:'0x'+'a'.repeat(40),amountRaw:'100',maxFeeRaw:'10',feeAssetId:'MATIC',feeAssetScale:18,feeFundingAccountId:'fee-wallet',mode:'paper' as const};
    const evidence:WithdrawalEligibility={...request,userId:'user-1',destinationVerifiedAt:'2026-11-15T12:00:00.000Z',availableRaw:'1000',
      observedAt:db.now,validUntil:'2026-11-17T12:01:00.000Z',custodyRevision:'r1',balanceProof:'proof'};
    const service=createWithdrawalService({transaction:db.transaction,lockEligibility:async()=>evidence,
      lockFunding:async(_c,u,b)=>financialFundingFixture(u,b,db.now,b.amountRaw!=='0'?evidence.availableRaw:db.state().feeHeld),
      otp:{issue:async h=>({code:'123456',digest:financialHash([h,'123456'])}),digest:async(h,c)=>financialHash([h,c]),deliver:async()=>true}});
    const auth=await service.requestOtp('user-1',request);await service.submit('user-1',{intentId:auth.intent.id,authorizationId:auth.authorizationId,otp:'123456'});
    let receipt:FinancialReceipt|null=null;let identity:FinancialAttempt|null=null;
    const submit=vi.fn(async()=>null),account=vi.fn(async(client:WithdrawalSqlClient,_r:unknown,_receipt:FinancialReceipt,delta:string,fee:string)=>{
      await client.query('SELECT $1 /* fixture:account */',[delta,fee]);return 'canonical-withdrawal-journal';});
    const runner=createDurableFinancialRunner({transaction:db.transaction,revalidate:service.revalidate,
      effects:{authorize:async(r,a)=>{identity=a;return financialAuthorizationFixture(r,a,db.now);},submit,reconcile:async()=>receipt,verify:async(_r,_a,o)=>o as FinancialReceipt|null},account});
    await runner.run('user-1',auth.intent.id);
    receipt={receiptId:'wr1',providerIdentity:'fixture-provider',proof:'proof',intentId:auth.intent.id,intentHash:auth.intent.intentHash,
      attemptId:identity!.id,clientOrderId:identity!.clientOrderId,cumulativeRaw:'100',feeRaw:'5',
      feeAssetId:request.feeAssetId,feeAssetScale:request.feeAssetScale,feeFundingAccountId:request.feeFundingAccountId,
      terminal:true,outcome:'fill',observedAt:db.now};
    db.admit(receipt,'user-1');expect((await runner.run('user-1',auth.intent.id)).kind).toBe('settled');
    await runner.run('user-1',auth.intent.id);expect(account).toHaveBeenCalledTimes(1);expect(db.state().held).toBe('0');expect(db.state().feeHeld).toBe('995');
    expect(submit).toHaveBeenCalledTimes(1);expect(db.state().reservations.every(r=>r.reserved_raw==='0')).toBe(true);
  });
});
