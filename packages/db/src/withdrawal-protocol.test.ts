import { describe, expect, it, vi } from 'vitest';
import { financialHash, withdrawalIntent, exactRaw, type WithdrawalRequest } from './withdrawal-contract.js';
import { createWithdrawalService, type WithdrawalEligibility } from './withdrawal-service.js';
import { withdrawalSqlFixture, financialFundingFixture } from './withdrawal-test-fixture.js';

const request: WithdrawalRequest = { requestKey:'withdraw-1',chain:'polygon',network:'polygon:137:genesis',assetId:'polygon:USDC',
  assetScale:6,sourceWalletId:'custody-wallet-1',destination:'0x'+'a'.repeat(40),amountRaw:'100',maxFeeRaw:'10',
  feeAssetId:'polygon:USDC',feeAssetScale:6,feeFundingAccountId:'custody-wallet-1',mode:'paper' };
function setup() {
  const db=withdrawalSqlFixture();
  const evidence: WithdrawalEligibility={userId:'user-1',chain:request.chain,network:request.network,mode:request.mode,
    assetId:request.assetId,assetScale:6,sourceWalletId:request.sourceWalletId,destination:request.destination,
    destinationVerifiedAt:'2026-11-15T12:00:00.000Z',availableRaw:'1000',observedAt:db.now,validUntil:'2026-11-17T12:01:00.000Z',
    custodyRevision:'custody-r1',balanceProof:'independent-balance-proof'};
  const digest=(hash:string,code:string)=>financialHash(['keyless-fixture-digest',hash,code]);
  const issue=vi.fn(async(hash:string)=>({code:'123456',digest:digest(hash,'123456')}));
  const deliver=vi.fn(async()=>{db.events.push('deliver');return true;});
  const lockEligibility=vi.fn(async()=>evidence);
  const service=createWithdrawalService({transaction:db.transaction,lockEligibility,
    lockFunding:async(_client,userId,budget)=>financialFundingFixture(userId,budget,db.now,evidence.availableRaw),
    otp:{issue,digest:async(hash,code)=>digest(hash,code),deliver}});
  return {db,evidence,service,issue,deliver,lockEligibility};
}
async function admitted(s:ReturnType<typeof setup>) {
  const auth=await s.service.requestOtp('user-1',request);
  return {auth,input:{intentId:auth.intent.id,authorizationId:auth.authorizationId,otp:'123456'}};
}
describe('durable withdrawal actual injected service with SQL transcript (not PG runtime)',()=>{
  it('commits exact immutable intent before OTP delivery and returns no code/public digest',async()=>{
    const s=setup();const {auth}=await admitted(s);
    expect(s.db.events.indexOf('commit:user-1')).toBeLessThan(s.db.events.indexOf('deliver'));
    expect(auth.intent.status).toBe('awaiting-authorization');
    expect(auth.delivery).toBe('sent');
    expect(auth).not.toHaveProperty('code');expect(auth).not.toHaveProperty('digest');
    expect(auth.intent.intent.amountRaw).toBe('100');expect(auth.intent.intent.maxFeeRaw).toBe('10');
    expect(s.db.state().outbox).toHaveLength(0);
    expect(s.db.state().auth[0]!.digest).not.toBe('123456');
  });
  it('consumes once with balance reservation and durable outbox in the same client/commit',async()=>{
    const s=setup();const {input}=await admitted(s);
    const first=await s.service.submit('user-1',input),second=await s.service.submit('user-1',input);
    expect(first.status).toBe('queued');expect(second.id).toBe(first.id);expect(second.status).toBe('queued');
    expect(s.db.state().auth[0]!.consumed_at).toBe(s.db.now);
    expect(s.db.state().reservations[0]!.reserved_raw).toBe('110');expect(s.db.state().outbox).toHaveLength(1);
    const writes=s.db.transcript.filter(t=>['financial:reserve','withdrawal:consume','financial:outbox','financial:queue'].includes(t.marker));
    expect(writes).toHaveLength(4);expect(writes.every(t=>t.client===writes[0]!.client)).toBe(true);
  });
  it('rolls back OTP consumption and reservation when atomic outbox fails',async()=>{
    const s=setup();const {input}=await admitted(s);s.db.fail('financial:outbox');
    await expect(s.service.submit('user-1',input)).rejects.toThrow('injected SQL failure');
    expect(s.db.state().auth[0]!.consumed_at).toBeNull();expect(s.db.state().reservations).toHaveLength(0);
    expect(s.db.state().outbox).toHaveLength(0);
  });
  it('does not deliver a code on commit failure',async()=>{
    const s=setup();s.db.fail('commit');await expect(s.service.requestOtp('user-1',request)).rejects.toThrow();
    expect(s.deliver).not.toHaveBeenCalled();expect(s.db.state().intents).toHaveLength(0);
  });
  it.each(['false','throw','persist-failure'])('delivery %s stays non-authorizing on durable retry',async(kind)=>{
    const s=setup();
    if(kind==='false')s.deliver.mockResolvedValue(false);
    if(kind==='throw')s.deliver.mockRejectedValue(new Error('mail timeout'));
    if(kind==='persist-failure')s.db.fail('withdrawal:delivery');
    const {auth,input}=await admitted(s);
    expect(auth.delivery).not.toBe('sent');
    await expect(s.service.submit('user-1',input)).rejects.toMatchObject({code:'withdrawal-otp-delivery-unconfirmed'});
    const replay=await s.service.requestOtp('user-1',request);
    expect(replay.replay).toBe(true);expect(s.issue).toHaveBeenCalledTimes(1);expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.db.state().outbox).toHaveLength(0);
  });
  it.each(['amountRaw','maxFeeRaw','destination','network','mode','assetScale'])('rejects substituted %s on request-key replay',async(field)=>{
    const s=setup();await admitted(s);
    const substitutions:Record<string,unknown>={amountRaw:'101',maxFeeRaw:'11',destination:'0x'+'b'.repeat(40),network:'other',mode:'live',assetScale:7};
    await expect(s.service.requestOtp('user-1',{...request,[field]:substitutions[field]})).rejects.toMatchObject({code:'withdrawal-request-key-conflict'});
    expect(s.issue).toHaveBeenCalledTimes(1);
  });
  it('denies cross-tenant status and submit, ignoring an untrusted intent user label',async()=>{
    const s=setup();const {input}=await admitted(s);
    expect(await s.service.status('user-2',input.intentId)).toBeNull();
    await expect(s.service.submit('user-2',input)).rejects.toMatchObject({code:'withdrawal-intent-not-found'});
    expect(s.db.state().outbox).toHaveLength(0);
  });
  it('commits wrong OTP failures and locks after five attempts',async()=>{
    const s=setup();const {input}=await admitted(s);
    for(let i=0;i<5;i++)await expect(s.service.submit('user-1',{...input,otp:'654321'})).rejects.toMatchObject({code:'withdrawal-otp-invalid'});
    expect(s.db.state().auth[0]!.failures).toBe(5);
    await expect(s.service.submit('user-1',input)).rejects.toMatchObject({code:'withdrawal-otp-locked'});
    expect(s.db.state().outbox).toHaveLength(0);
  });
  it.each(['cooling','owner','balance','mode','stale','expiry'])('rechecks %s before atomic OTP consumption',async(kind)=>{
    const s=setup();const {input}=await admitted(s);
    if(kind==='cooling')Object.assign(s.evidence,{destinationVerifiedAt:s.db.now});
    if(kind==='owner')Object.assign(s.evidence,{userId:'user-2'});
    if(kind==='balance')Object.assign(s.evidence,{availableRaw:'109'});
    if(kind==='mode')Object.assign(s.evidence,{mode:'live'});
    if(kind==='stale')Object.assign(s.evidence,{observedAt:'2026-11-17T11:00:00.000Z'});
    if(kind==='expiry')s.db.state().auth[0]!.expires_at='2026-11-17T11:59:59.000Z';
    await expect(s.service.submit('user-1',input)).rejects.toThrow();
    expect(s.db.state().auth[0]!.consumed_at).toBeNull();expect(s.db.state().outbox).toHaveLength(0);
  });
  it('hash binding survives jsonb key reordering and rejects mutated persisted intent',async()=>{
    const s=setup();const {input}=await admitted(s);
    const row=s.db.state().intents[0]!;
    row.intent=Object.fromEntries(Object.entries(row.intent).reverse());
    expect(await s.service.status('user-1',input.intentId)).not.toBeNull();
    row.intent.amountRaw='101';
    await expect(s.service.submit('user-1',input)).rejects.toMatchObject({code:'durable-financial-intent-binding-mismatch'});
    expect(s.db.state().outbox).toHaveLength(0);
  });
  it.each(['feeAssetId','feeAssetScale','feeFundingAccountId'])('binds substituted fee denomination %s to one-use intent',async(field)=>{
    const s=setup();await admitted(s);
    await expect(s.service.requestOtp('user-1',{...request,[field]:field==='feeAssetScale'?18:'different'}))
      .rejects.toThrow('withdrawal-request-key-conflict');
  });
  it('reserves unlike amount/fee denominations in deterministic separate budgets and checks native funding',async()=>{
    const s=setup();
    const service=createWithdrawalService({transaction:s.db.transaction,lockEligibility:s.lockEligibility,
      lockFunding:async(_c,u,b)=>financialFundingFixture(u,b,s.db.now,b.assetId==='MATIC'?'10':s.evidence.availableRaw),
      otp:{issue:async h=>({code:'123456',digest:financialHash([h,'123456'])}),digest:async(h,c)=>financialHash([h,c]),deliver:async()=>true}});
    const auth=await service.requestOtp('user-1',{...request,feeAssetId:'MATIC',feeAssetScale:18,feeFundingAccountId:'native-wallet'});
    await service.submit('user-1',{intentId:auth.intent.id,authorizationId:auth.authorizationId,otp:'123456'});
    expect(s.db.state().reservations.map(r=>[r.asset_id,r.asset_scale,r.account_id,r.reserved_raw]).sort()).toEqual([
      ['MATIC',18,'native-wallet','10'],['polygon:USDC',6,'custody-wallet-1','100']].sort());
    const locks=s.db.transcript.filter(t=>t.marker==='financial:budget-lock').slice(-2).map(t=>String(t.values[0]));
    expect(locks).toEqual([...locks].sort());
  });
  it('missing native fee funding refuses before OTP despite sufficient transfer asset balance',async()=>{
    const s=setup();const service=createWithdrawalService({transaction:s.db.transaction,lockEligibility:s.lockEligibility,
      lockFunding:async(_c,u,b)=>financialFundingFixture(u,b,s.db.now,b.assetId==='MATIC'?'9':s.evidence.availableRaw),
      otp:{issue:s.issue,digest:async(h,c)=>financialHash([h,c]),deliver:s.deliver}});
    await expect(service.requestOtp('user-1',{...request,feeAssetId:'MATIC',feeAssetScale:18,feeFundingAccountId:'native-wallet'}))
      .rejects.toThrow('withdrawal-balance-insufficient');expect(s.issue).not.toHaveBeenCalled();expect(s.db.state().intents).toHaveLength(0);
  });
  it('rolls back consume/reservations/outbox on deferred commit failure',async()=>{
    const s=setup();const {input}=await admitted(s);s.db.fail('deferred-commit');
    await expect(s.service.submit('user-1',input)).rejects.toThrow('deferred commit failure');
    expect(s.db.state().auth[0]!.consumed_at).toBeNull();expect(s.db.state().outbox).toHaveLength(0);expect(s.db.state().reservations).toHaveLength(0);
  });
  it('reserves the common asset budget across concurrent exact intents including fee ceiling',async()=>{
    const s=setup();Object.assign(s.evidence,{availableRaw:'200'});
    const a=await admitted(s),b=await s.service.requestOtp('user-1',{...request,requestKey:'withdraw-2'});
    const results=await Promise.allSettled([s.service.submit('user-1',a.input),s.service.submit('user-1',{
      intentId:b.intent.id,authorizationId:b.authorizationId,otp:'123456'})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(s.db.state().outbox).toHaveLength(1);
  });
});
describe('exact withdrawal contract boundaries',()=>{
  it.each(['1e2','+1','-1','00','1.0',1,Number.MAX_SAFE_INTEGER])('rejects noncanonical raw %j',value=>{
    expect(()=>exactRaw(value)).toThrow();
  });
  it('preserves raw values beyond safe Number and binds every field including expiry',()=>{
    const i=withdrawalIntent('user-1',{...request,amountRaw:'900719925474099312345678'},'2026-11-17T12:05:00.000Z');
    expect(i.amountRaw).toBe('900719925474099312345678');expect(Object.isFrozen(i)).toBe(true);
    expect(financialHash(i)).not.toBe(financialHash({...i,expiresAt:'2026-11-17T12:06:00.000Z'}));
  });
});
