import { describe, expect, it } from 'vitest';
import { createWithdrawalOwnedComposition } from './withdrawal-owned-composition.js';
import { assertOwnedFinancialConservation } from './withdrawal-owned-observer.js';
import {
  createCheckedFinancialTransaction, createFinancialReceiptAdmission, FinancialCommitUncertainError, financialOperationSqlAllowed,
  type FinancialOwnedClient
} from '@swat/db/dist/withdrawal-owned.js';
import { createProtectedWithdrawalOtp, consumeProtectedWithdrawalOtp } from '@swat/db/dist/withdrawal-otp.js';
import { financialHash, type FinancialReceipt, type WithdrawalIntent, type WithdrawalTransaction,
  type WithdrawalRequest, type WithdrawalSqlClient } from '@swat/db/dist/withdrawal-contract.js';
import { withdrawalSqlFixture, financialAuthorizationFixture, financialFundingFixture } from '../../../packages/db/src/withdrawal-test-fixture.js';

const user = '11111111-1111-4111-8111-111111111111';
const request: WithdrawalRequest = {requestKey:'owned-offline',chain:'polygon',network:'offline-137',assetId:'USDC',assetScale:6,
  sourceWalletId:'source',destination:`0x${'a'.repeat(40)}`,amountRaw:'100',maxFeeRaw:'10',feeAssetId:'MATIC',feeAssetScale:18,
  feeFundingAccountId:'fee',mode:'paper'};
function identity(role: 'swat_app' | 'swat_financial_receipt_writer' = 'swat_app') {
  return {role_name:role,session_role:role,role_setting:'none',row_security:'on',rolcanlogin:true,rolsuper:false,rolbypassrls:false,
    rolinherit:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,backend_pid:123,transaction_clean:true,has_memberships:false,owns_objects:false,
    receipt_insert:role === 'swat_financial_receipt_writer',intent_insert:role === 'swat_app'};
}
/** Inert transport only. Production service/store/runner/OTP/observer bodies are never mocked. */
function fixture() {
  const db = withdrawalSqlFixture();
  let fail: string | null = null, role = 'swat_app';
  let selected: FinancialReceipt | null = null, authorization: ReturnType<typeof financialAuthorizationFixture<WithdrawalIntent>> | null = null;
  let code: string | null = null, deliveries = 0, submissions = 0, captures = 0;
  let destinationVerifiedAt = '2026-11-15T12:00:00.000Z';
  const observedQueries: {marker:string;client:object}[] = [];
  const accounting = new Map<string,string>();
  const wrap = (receiptWriter = false): WithdrawalTransaction => (tenant,operation) => db.transaction(tenant,async base => {
    const client = {
      async query<Row>(sql: string, values: unknown[] = []): Promise<{rows:Row[]}> {
        const marker = /\/\* ([a-z-]+:[a-z-]+) \*\//.exec(sql)?.[1];
        observedQueries.push({marker:marker ?? 'unmarked',client});
        if (marker === fail) throw new Error('inert owned fault');
        const state = db.state();
        let rows: unknown[] | null = null;
        if (marker === 'financial-owned:identity') rows = [identity(receiptWriter ? 'swat_financial_receipt_writer' : role === 'swat_app' ? 'swat_app' : 'swat_financial_receipt_writer')];
        if (marker === 'financial-owned:receipt-intent') rows = state.intents.filter(r=>r.user_id===tenant&&r.id===values[1]);
        if (marker === 'financial-owned:receipt-attempt') rows = state.attempts.filter(r=>r.user_id===tenant&&r.intent_id===values[1]);
        if (marker === 'financial-owned:receipt-replay') rows = state.receipts.filter(r=>r.user_id===tenant&&r.intent_id===values[1]&&r.receipt_id===values[2]);
        if (marker === 'financial-owned:receipt-admit') {
          const receipt = JSON.parse(String(values[6])) as FinancialReceipt;
          db.admit(receipt,tenant); rows = [];
        }
        if (marker === 'financial-owned:accounting-admission') {
          if(fail==='deferred-commit') db.fail('deferred-commit');
          rows = accounting.has(String(values[2])) ? [{accounting_reference:accounting.get(String(values[2]))}] : [];
        }
        if (marker === 'financial-observer:intent') rows = state.intents.filter(r=>r.user_id===tenant&&r.id===values[1]);
        if (marker === 'financial-observer:attempts') rows = state.attempts.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({id:r.id,intentId:r.intent_id,userId:r.user_id,intentHash:r.intent_hash,clientOrderId:r.client_order_id,
            state:r.state,completedRaw:r.completed_raw,completedFeeRaw:r.completed_fee_raw,terminal:r.terminal}));
        if (marker === 'financial-observer:receipts') rows = state.receipts.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({receipt:r.receipt,hash:r.receipt_hash}));
        if (marker === 'financial-observer:applications') rows = state.applications.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({receiptId:r.receipt_id,attemptId:r.attempt_id,deltaRaw:r.delta_raw,accountingReference:r.accounting_reference}));
        if (marker === 'financial-observer:reservations') rows = state.reservations.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({budgetKey:r.budget_key,amountRaw:r.amount_raw,feeRaw:r.fee_raw,reservedRaw:r.reserved_raw}));
        if (marker === 'financial-observer:outbox') rows = state.outbox.filter(r=>r.user_id===tenant&&r.intent_id===values[1]).map(r=>({intentHash:r.intent_hash}));
        if (marker === 'financial-observer:authorization') rows = state.auth.filter(r=>r.user_id===tenant&&r.intent_id===values[1])
          .map(r=>({id:r.id,consumed:r.consumed_at!==null,failures:r.failures,delivery:r.delivery_state}));
        return rows === null ? base.query<Row>(sql,values) : {rows:structuredClone(rows) as Row[]};
      }
    };
    return operation(client);
  });
  const application = wrap(), observer = wrap(), writer = wrap(true);
  const receipts = createFinancialReceiptAdmission<WithdrawalIntent>({transaction:writer,verify:async(_r,_a,observation)=> observation === selected ? selected : null});
  const composed = createWithdrawalOwnedComposition({application:{transaction:application,
    lockEligibility:async(_client,intent)=>({...intent,destinationVerifiedAt,availableRaw:'1000',
      observedAt:db.now,validUntil:new Date(Date.parse(db.now)+60_000).toISOString(),custodyRevision:'inert-r1',balanceProof:'inert-not-authority'}),
    lockFunding:async(_client,tenant,budget)=>financialFundingFixture(tenant,budget,db.now)},observer,
    otpKey:{withKey:async operation=>operation(new Uint8Array(32).fill(19))},
    otpDelivery:{resolveVerifiedRecipient:async tenant=>({userId:tenant,verified:true,recipientHandle:{inert:true}}),
      deliver:async(_recipient,secret)=>{deliveries++;code=secret;expect(db.events.at(-1)).toBe(`commit:${user}`);return 'sent';}},
    otpCapture:{consume:async(_tenant,_id,_auth,consume)=>{captures++;if(code===null)throw new Error('no inert capture');return consume(code);}},
    transfer:{authorize:async(record,attempt)=>{authorization=financialAuthorizationFixture(record,attempt,db.now);return authorization;},
      submit:async()=>{submissions++;return null;},reconcile:async()=>selected},receipts});
  function receipt(cumulativeRaw: string, feeRaw: string, terminal: boolean, receiptId = 'receipt-1'): FinancialReceipt {
    if (!authorization) throw new Error('real production prepared attempt required');
    return {receiptId,providerIdentity:'fixture-provider',proof:'inert-authenticated-transport',intentId:authorization.intentId,
      intentHash:authorization.intentHash,attemptId:authorization.attemptId,clientOrderId:authorization.clientOrderId,cumulativeRaw,feeRaw,
      feeAssetId:request.feeAssetId,feeAssetScale:request.feeAssetScale,feeFundingAccountId:request.feeFundingAccountId,
      terminal,outcome:'fill',observedAt:db.now};
  }
  return {db,composed,receipts,observedQueries,receipt,select:(value:FinancialReceipt|null)=>{selected=value;},
    independentAccounting:(id:string)=>accounting.set(id,'inert-independent-ledger:'+id),fault:(marker:string|null)=>{fail=marker;},
    wrongRole:()=>{role='writer';},counts:()=>({deliveries,submissions,captures}),
    setDestinationVerifiedAt:(iso:string)=>{destinationVerifiedAt=iso;},currentCode:()=>code};
}

describe('withdrawal owned P5b source composition; inert IO, no runtime acceptance',()=>{
  it('joins concrete keyed OTP protected principal capture, cooling/funding, one-use consumption and one outbox without exposing a code',async()=>{
    const s=fixture();const result=await s.composed.requestAndConsume(user,request);
    expect(result.record.status).toBe('queued');expect(s.counts()).toEqual({deliveries:1,submissions:0,captures:1});
    expect(JSON.stringify(result)).not.toMatch(/digest|recipientHandle|scopeProof/);
    expect(s.composed.application).not.toHaveProperty('process');expect(result.boundary.runtimeAccepted).toBe(false);
    const before=await s.composed.observe(user,result.record.id);
    await s.composed.requestAndConsume(user,request);
    expect(await s.composed.observe(user,result.record.id)).toEqual(before);expect(s.counts().deliveries).toBe(1);
    expect(s.db.state().auth).toHaveLength(1);expect(s.db.state().outbox).toHaveLength(1);
  });
  it('unknown execution reconciles exact independently committed receipts without resubmission and checks durable conservation',async()=>{
    const s=fixture();const admitted=await s.composed.requestAndConsume(user,request);
    expect((await s.composed.process(user,admitted.record.id)).record.status).toBe('uncertain');
    const receipt=s.receipt('100','5',true);s.independentAccounting(receipt.receiptId);s.select(receipt);
    const settled=await s.composed.process(user,admitted.record.id);expect(settled.record.status).toBe('settled');
    const journal=await s.composed.observe(user,admitted.record.id);assertOwnedFinancialConservation(journal);
    expect(journal.applications).toHaveLength(1);expect(journal.reservations.every(r=>r.reservedRaw==='0')).toBe(true);
    await s.composed.process(user,admitted.record.id);expect(await s.composed.observe(user,admitted.record.id)).toEqual(journal);
    expect(s.counts().submissions).toBe(1);
    const writes=s.db.transcript.filter(t=>t.marker==='financial:apply-receipt');expect(writes).toHaveLength(1);
    expect(s.observedQueries.some(t=>t.marker==='financial-owned:accounting-admission')).toBe(true);
  });
  it('source runner publishes only partial durable quantity/fee progress and preserves remaining reservations across exact receipt replay',async()=>{
    const s=fixture();const a=await s.composed.requestAndConsume(user,request);await s.composed.process(user,a.record.id);
    const partial=s.receipt('40','3',false,'partial');s.independentAccounting(partial.receiptId);s.select(partial);
    expect((await s.composed.process(user,a.record.id)).record.status).toBe('partial');
    const before=await s.composed.observe(user,a.record.id);expect(before.reservations.map(r=>r.reservedRaw).sort()).toEqual(['60','7']);
    await s.composed.process(user,a.record.id);expect(await s.composed.observe(user,a.record.id)).toEqual(before);
    const final=s.receipt('100','5',true,'final');s.independentAccounting(final.receiptId);s.select(final);
    await s.composed.process(user,a.record.id);const after=await s.composed.observe(user,a.record.id);
    expect(after.applications.map(r=>r.deltaRaw)).toEqual(['40','60']);assertOwnedFinancialConservation(after);
    expect(s.counts().submissions).toBe(1);
  });
  it('missing actual application identity refuses even though a port/client exists',async()=>{
    const s=fixture();s.wrongRole();await expect(s.composed.requestAndConsume(user,request))
      .rejects.toMatchObject({code:'financial-distinct-approved-database-identity-unavailable'});
    expect(s.db.state().intents).toHaveLength(0);expect(s.counts().deliveries).toBe(0);
  });
  it('independent receipt commit failure retains unknown economic state and never applies or resubmits',async()=>{
    const s=fixture();const a=await s.composed.requestAndConsume(user,request);await s.composed.process(user,a.record.id);
    s.select(s.receipt('100','5',true));s.fault('financial-owned:receipt-admit');
    expect((await s.composed.process(user,a.record.id)).record.status).toBe('uncertain');
    expect(s.db.state().receipts).toHaveLength(0);expect(s.db.state().applications).toHaveLength(0);expect(s.counts().submissions).toBe(1);
  });
  it('missing canonical ledger admission is a source backing gap, not a successful accounting callback',async()=>{
    const s=fixture();const a=await s.composed.requestAndConsume(user,request);await s.composed.process(user,a.record.id);
    s.select(s.receipt('100','0',true));await expect(s.composed.process(user,a.record.id))
      .rejects.toMatchObject({code:'financial-canonical-accounting-admission-unavailable'});
    expect(s.db.state().applications).toHaveLength(0);expect(s.db.state().held).toBe('100');
  });
  it.each(['financial:apply-receipt','deferred-commit'])('actual runner rolls back receipt application on %s failure without replaying transfer',async marker=>{
    const s=fixture();const a=await s.composed.requestAndConsume(user,request);await s.composed.process(user,a.record.id);
    const r=s.receipt('100','5',true);s.independentAccounting(r.receiptId);s.select(r);
    if(marker==='deferred-commit') {
      // Fault is injected in the application transaction only, after independent receipt COMMIT.
      s.fault('deferred-commit');
    } else s.db.fail(marker);
    const before=structuredClone(s.db.state());
    const work=s.composed.process(user,a.record.id);
    if(marker==='deferred-commit') await expect(work).rejects.toThrow('injected deferred commit failure');
    else await expect(work).rejects.toThrow('injected SQL failure');
    expect(s.db.state().applications).toEqual(before.applications);expect(s.db.state().held).toBe(before.held);
    expect(s.counts().submissions).toBe(1);
  });
  it('durable observer refuses forged application hashes, quantity, fee and reservation projections',async()=>{
    const s=fixture();const a=await s.composed.requestAndConsume(user,request);await s.composed.process(user,a.record.id);
    const r=s.receipt('100','5',true);s.independentAccounting(r.receiptId);s.select(r);await s.composed.process(user,a.record.id);
    const j=await s.composed.observe(user,a.record.id);
    for(const changed of [ {...j,receipts:j.receipts.map(r=>({...r,hash:'0'.repeat(64)}))},
      {...j,record:{...j.record,completedRaw:'99'}}, {...j,reservations:j.reservations.map(r=>({...r,reservedRaw:'1'}))}]) {
      expect(()=>assertOwnedFinancialConservation(changed)).toThrow();
    }
  });
  it('enforces 24h cooling-off at requestOtp and on drift before process revalidation',async()=>{
    const s=fixture();
    s.setDestinationVerifiedAt(new Date(Date.parse(s.db.now)-86_399_000).toISOString());
    await expect(s.composed.requestAndConsume(user,request)).rejects.toMatchObject({code:'withdrawal-cooling-off'});
    expect(s.db.state().intents).toHaveLength(0);
    expect(s.counts()).toEqual({deliveries:0,submissions:0,captures:0});

    const s2=fixture();
    const admitted=await s2.composed.requestAndConsume(user,request);
    s2.setDestinationVerifiedAt(new Date(Date.parse(s2.db.now)-86_399_000).toISOString());
    await expect(s2.composed.process(user,admitted.record.id)).rejects.toMatchObject({code:'withdrawal-cooling-off'});
    expect(s2.counts().submissions).toBe(0);
  });
  it('increments OTP failures, locks after 5 wrong codes, and rejects wrong OTP after consumption',async()=>{
    const s=fixture();
    const issued=await s.composed.application.requestOtp(user,request);
    expect(issued.delivery).toBe('sent');
    const validCode=s.currentCode()!;
    const wrongCode=validCode==='000000'?'000001':'000000';
    for(let i=0;i<5;i++) {
      await expect(s.composed.application.submit(user,{intentId:issued.intent.id,authorizationId:issued.authorizationId,otp:wrongCode}))
        .rejects.toMatchObject({code:'withdrawal-otp-invalid'});
      expect(s.db.state().auth[0]?.failures).toBe(i+1);
    }
    await expect(s.composed.application.submit(user,{intentId:issued.intent.id,authorizationId:issued.authorizationId,otp:validCode}))
      .rejects.toMatchObject({code:'withdrawal-otp-locked'});
    expect(s.db.state().outbox).toHaveLength(0);
    expect(s.db.state().intents[0]?.status).toBe('awaiting-authorization');

    const s2=fixture();
    const consumed=await s2.composed.requestAndConsume(user,request);
    const authId=s2.db.state().auth[0]!.id;
    const validCode2=s2.currentCode()!;
    const wrongCode2=validCode2==='000000'?'000001':'000000';
    await expect(s2.composed.application.submit(user,{intentId:consumed.record.id,authorizationId:authId,otp:wrongCode2}))
      .rejects.toMatchObject({code:'withdrawal-otp-invalid'});
    await expect(s2.composed.application.submit(user,{intentId:consumed.record.id,authorizationId:authId,otp:validCode2}))
      .resolves.toMatchObject({id:consumed.record.id,status:'queued'});
  });
});

describe('protected OTP body and owned COMMIT contract',()=>{
  it('lexical transaction guard permits canonical UPDATE SET and marker comments without allowing control or stacked SQL',()=>{
    for(const sql of ["UPDATE public.withdrawal_authorizations SET failures=failures+1 WHERE id=$1 /* withdrawal:failure */",
      "SELECT 'COMMIT; -- not control' AS \"SET\" /* financial-owned:identity */", "SELECT public.swat_apply_perps_reducing_receipt($1,$2)"])
      expect(financialOperationSqlAllowed(sql)).toBe(true);
    for(const sql of ['SELECT 1; COMMIT','SET ROLE swat_financial_receipt_writer','SELECT set_config($1,$2,true)',
      'DO $$BEGIN END$$','CALL public.anything()','SELECT $$literal$$','SELECT 1 /* unclosed'])
      expect(financialOperationSqlAllowed(sql)).toBe(false);
  });
  it('digest is keyed, domain-separated and exact-intent-bound; unknown delivery never reports sent',async()=>{
    const make=(key:number)=>createProtectedWithdrawalOtp({key:{withKey:async op=>op(new Uint8Array(32).fill(key))},
      delivery:{resolveVerifiedRecipient:async userId=>({userId,verified:true,recipientHandle:'inert'}),deliver:async()=> 'unknown'}});
    const otp=make(1),hash='a'.repeat(64);const digest=await otp.digest(hash,'123456');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);expect(await otp.digest(hash,'123456')).toBe(digest);
    expect(await otp.digest('b'.repeat(64),'123456')).not.toBe(digest);expect(await make(2).digest(hash,'123456')).not.toBe(digest);
  });
  it('protected OTP delivery refuses unverified, missing, or foreign recipient without invoking deliver',async()=>{
    const foreign='22222222-2222-4222-8222-222222222222';
    const intent:WithdrawalIntent={version:1,kind:'withdrawal',userId:user,requestKey:'k',chain:'polygon',network:'offline-137',
      assetId:'USDC',assetScale:6,sourceWalletId:'source',destination:`0x${'a'.repeat(40)}`,amountRaw:'100',maxFeeRaw:'10',
      feeAssetId:'MATIC',feeAssetScale:18,feeFundingAccountId:'fee',mode:'paper',expiresAt:'2026-11-17T12:10:00.000Z'};
    for(const recipient of [null,{userId:user,verified:false as const,recipientHandle:'inert'},{userId:foreign,verified:true as const,recipientHandle:'inert'}]) {
      let delivered=0;
      const otp=createProtectedWithdrawalOtp({key:{withKey:async op=>op(new Uint8Array(32).fill(1))},
        delivery:{resolveVerifiedRecipient:async()=>recipient as any,deliver:async()=>{delivered++;return 'sent';}}});
      await expect(otp.deliver(user,'123456',intent)).rejects.toMatchObject({code:'withdrawal-verified-recipient-unavailable'});
      expect(delivered).toBe(0);
    }
    const mismatchedOtp=createProtectedWithdrawalOtp({key:{withKey:async op=>op(new Uint8Array(32).fill(1))},
      delivery:{resolveVerifiedRecipient:async userId=>({userId,verified:true,recipientHandle:'inert'}),deliver:async()=> 'sent'}});
    await expect(mismatchedOtp.deliver(foreign,'123456',intent)).rejects.toMatchObject({code:'withdrawal-otp-principal-mismatch'});
  });
  it('protected capture cannot complete without consumption, substitute its returned projection or consume twice',async()=>{
    await expect(consumeProtectedWithdrawalOtp({consume:async()=> 'forged' as never},user,'i','a',async()=> 'real'))
      .rejects.toMatchObject({code:'withdrawal-protected-otp-capture-unavailable'});
    expect(await consumeProtectedWithdrawalOtp({consume:async(_u,_i,_a,consume)=>{await consume('123456');return 'forged' as never;}},user,'i','a',async()=> 'real')).toBe('real');
    await expect(consumeProtectedWithdrawalOtp({consume:async(_u,_i,_a,consume)=>{await consume('123456');return consume('123456');}},user,'i','a',async()=> 'real'))
      .rejects.toMatchObject({code:'withdrawal-protected-otp-capture-reused'});
  });
  it.each(['ROLLBACK','missing','throws'])('never reports callback completion for %s COMMIT outcome and discards uncertain lease',async outcome=>{
    const commands:string[]=[],released:boolean[]=[];
    const client:FinancialOwnedClient={query:async <Row>(sql:string)=>{
      commands.push(sql);
      if(sql==='COMMIT') {if(outcome==='throws')throw new Error('lost transport');return {rows:[],command:outcome==='missing'?undefined:outcome};}
      if(sql.includes('financial-owned:identity'))return {rows:[identity()] as Row[]};
      return {rows:[],command:sql==='BEGIN'?'BEGIN':undefined};
    }};
    const transaction=createCheckedFinancialTransaction({acquire:async()=>({client,release:broken=>released.push(broken)}),role:'swat_app',deadline:{check(){}}});
    await expect(transaction(user,async()=> 'callback finished')).rejects.toBeInstanceOf(FinancialCommitUncertainError);
    expect(commands.filter(c=>c==='ROLLBACK')).toHaveLength(0);expect(released).toEqual([true]);
  });
  it('checked transaction rejects escaped/nested capability and acknowledges COMMIT before returning value',async()=>{
    const commands:string[]=[],released:boolean[]=[];
    const client:FinancialOwnedClient={query:async <Row>(sql:string)=>{commands.push(sql);return sql.includes('financial-owned:identity')
      ? {rows:[identity()] as Row[]} : {rows:[],command:sql==='BEGIN'||sql==='COMMIT'?sql:undefined};}};
    const transaction=createCheckedFinancialTransaction({acquire:async()=>({client,release:b=>released.push(b)}),role:'swat_app',deadline:{check(){}}});
    let escaped: WithdrawalSqlClient | undefined;
    expect(await transaction(user,async owned=>{escaped=owned;return 'committed';})).toBe('committed');
    expect(commands.at(-1)).toBe('COMMIT');await expect(escaped!.query('SELECT 1')).rejects.toThrow('Uncontrolled');
    await expect(transaction(user,async()=>transaction(user,async()=>null))).rejects.toThrow('Nested');
    expect(released.at(-1)).toBe(true);
  });
});
