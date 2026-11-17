import { describe, expect, it, vi } from 'vitest';
import { createReducingService } from './reducing-service.js';
import { reducingIntent, reducingRemainder, decimalToRaw, rawToDecimal, type ReducingRequest, type ReducingExposure } from './reducing-contract.js';
import { withdrawalSqlFixture, financialFundingFixture, reducingMappingFixture } from './withdrawal-test-fixture.js';

const request:ReducingRequest={requestKey:'close-1',chain:'polygon',network:'polygon:137',venue:'polymarket-perps',positionId:'position-1',
  accountId:'account-1',assetId:'1',assetScale:8,mode:'paper',positionSide:'LONG',quantityRaw:'100',maxFeeRaw:'0',
  feeAssetId:'USDC',feeAssetScale:6,feeFundingAccountId:'fee-account',limitPriceExact:'65000',expectedRevision:'r1'};
function setup(overrides:Partial<ReducingRequest>={}) {
  const db=withdrawalSqlFixture(),input={...request,...overrides};
  const exposure:ReducingExposure={userId:'user-1',chain:input.chain,network:input.network,venue:input.venue,positionId:input.positionId,
    accountId:input.accountId,assetId:input.assetId,assetScale:input.assetScale,mode:input.mode,positionSide:input.positionSide,
    heldRaw:'100',revision:'r1',observedAt:db.now,validUntil:'2026-11-17T12:01:00.000Z',proof:'independent-exposure'};
  const lockExposure=vi.fn(async()=>exposure);
  const service=createReducingService({transaction:db.transaction,lockExposure,
    lockVenueMapping:async(_c,record)=>{const mapping=reducingMappingFixture(record,db.now);db.admitMapping(record,mapping);return mapping;},
    lockFunding:async(_c,u,b)=>financialFundingFixture(u,b,db.now)});
  return {db,input,exposure,service,lockExposure};
}
describe('durable exact reducing injected admission',()=>{
  it.each(['LONG','SHORT'] as const)('derives opposite order for %s without closing on admission',async(positionSide)=>{
    const s=setup({positionSide});const record=await s.service.request('user-1',s.input);
    expect(record.intent.side).toBe(positionSide==='LONG'?'SELL':'BUY');expect(record.intent.quantityRaw).toBe('100');
    expect(record.status).toBe('queued');expect(record.completedRaw).toBe('0');expect(record.terminal).toBe(false);
    expect(s.db.state().outbox).toHaveLength(1);expect(s.db.state().reservations.find(r=>r.purpose==='exposure')!.reserved_raw).toBe('100');
  });
  it('spot longs reserve exact held inventory but never an arbitrary condition or opposite-side short',async()=>{
    const s=setup({venue:'spot',chain:'solana',network:'solana-genesis',assetId:'mint',assetScale:9});
    expect((await s.service.request('user-1',s.input)).intent.side).toBe('SELL');
    await expect(s.service.request('user-1',{...s.input,requestKey:'short',positionSide:'SHORT'})).rejects.toMatchObject({code:'spot-short-unavailable'});
  });
  it.each(['revision','mode','owner','side','quantity','stale'])('denies stale/substituted %s without outbox',async(kind)=>{
    const s=setup();
    if(kind==='revision')Object.assign(s.exposure,{revision:'r2'});
    if(kind==='mode')Object.assign(s.exposure,{mode:'live'});
    if(kind==='owner')Object.assign(s.exposure,{userId:'user-2'});
    if(kind==='side')Object.assign(s.exposure,{positionSide:'SHORT'});
    if(kind==='quantity')Object.assign(s.exposure,{heldRaw:'99'});
    if(kind==='stale')Object.assign(s.exposure,{observedAt:'2026-11-17T11:00:00.000Z'});
    await expect(s.service.request('user-1',s.input)).rejects.toThrow();
    expect(s.db.state().intents).toHaveLength(0);expect(s.db.state().outbox).toHaveLength(0);
  });
  it('exact same-key retry returns same request but altered quantity cannot substitute',async()=>{
    const s=setup();const first=await s.service.request('user-1',s.input),second=await s.service.request('user-1',s.input);
    expect(first.id).toBe(second.id);expect(s.db.state().outbox).toHaveLength(1);
    await expect(s.service.request('user-1',{...s.input,quantityRaw:'99'})).rejects.toMatchObject({code:'reducing-request-key-conflict'});
    expect(await s.service.status('user-2',first.id)).toBeNull();
  });
  it('shared account asset budget prevents simultaneous over-reduction even on distinct position ids',async()=>{
    const s=setup();await s.service.request('user-1',s.input);
    Object.assign(s.exposure,{positionId:'position-2'});
    await expect(s.service.request('user-1',{...s.input,requestKey:'close-2',positionId:'position-2'})).rejects.toMatchObject({code:'reducing-exposure-or-fee-reserved'});
    expect(s.db.state().outbox).toHaveLength(1);
  });
  it('retains capability distinction rather than reporting runtime/live acceptance from injection',()=>{
    const s=setup();expect(s.service.capability).toMatchObject({supported:false,sourceImplemented:true,injectedVerified:false,runtimeAccepted:false,liveAccepted:false});
  });
});
describe('exact cross-zero-safe accounting math',()=>{
  it.each(['LONG','SHORT'] as const)('non-increasing %s partial and exact-zero full reduction',side=>{
    const order=side==='LONG'?'SELL':'BUY';
    expect(reducingRemainder(side,order,'900719925474099312345678','12345678')).toBe('900719925474099300000000');
    expect(reducingRemainder(side,order,'100','100')).toBe('0');
    expect(()=>reducingRemainder(side,order,'100','101')).toThrow('reducing-would-cross-zero');
    expect(()=>reducingRemainder(side,order==='BUY'?'SELL':'BUY','100','1')).toThrow('reducing-direction-increases-exposure');
  });
  it('converts base units exactly without rounding off unseen dust',()=>{
    expect(rawToDecimal('900719925474099312345678',18)).toBe('900719.925474099312345678');
    expect(decimalToRaw('900719.925474099312345678',18)).toBe('900719925474099312345678');
    expect(()=>decimalToRaw('1.000000001',8)).toThrow('position-scale-loss');
    expect(decimalToRaw('1.000000000',8)).toBe('100000000');
  });
  it('does not accept perps chain masquerading as Solana',()=>{
    expect(()=>reducingIntent('user-1',{...request,chain:'solana'},'2026-11-17T12:05:00.000Z')).toThrow('perps-chain-mismatch');
  });
});
