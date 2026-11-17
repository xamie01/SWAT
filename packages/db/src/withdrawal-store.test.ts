import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { withdrawalSqlStore } from './withdrawal-store.js';
import { financialHash, withdrawalIntent, type FinancialRecord, type FinancialReceipt, type WithdrawalSqlClient, type FinancialAttempt } from './withdrawal-contract.js';

const schema=readFileSync(new URL('../../../threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql',import.meta.url),'utf8');
const intent=withdrawalIntent('user-1',{requestKey:'w1',chain:'polygon',network:'polygon137',assetId:'USDC',assetScale:6,
  sourceWalletId:'wallet-1',destination:'0x'+'a'.repeat(40),amountRaw:'100',maxFeeRaw:'10',
  feeAssetId:'USDC',feeAssetScale:6,feeFundingAccountId:'wallet-1',mode:'paper'},'2026-11-17T12:05:00.000Z');
const record:FinancialRecord={id:'intent-1',userId:'user-1',intent,intentHash:financialHash(intent),status:'queued',completedRaw:'0',terminal:false,createdAt:'2026-11-17T12:00:00.000Z'};
const attempt:FinancialAttempt={id:'attempt-1',intentId:record.id,userId:record.userId,clientOrderId:'client-1',intentHash:record.intentHash,state:'uncertain',completedRaw:'0',completedFeeRaw:'0',terminal:false};
const receipt:FinancialReceipt={receiptId:'r1',providerIdentity:'independent',proof:'proof',intentId:record.id,intentHash:record.intentHash,
  attemptId:attempt.id,clientOrderId:attempt.clientOrderId,cumulativeRaw:'100',feeRaw:'0',feeAssetId:'USDC',feeAssetScale:6,
  feeFundingAccountId:'wallet-1',terminal:true,outcome:'fill',observedAt:'2026-11-17T12:00:00.000Z'};
function client(rows:unknown[]=[]){const query=vi.fn(async(_text:string,_values?:unknown[])=>({rows}));return {query,client:{query} as WithdrawalSqlClient};}
describe('withdrawal SQL protocol parameter and scope source regression (NOT runtime SQL)',()=>{
  it('binds principal, kind and exact request key on locked retry lookup',async()=>{
    const c=client();await withdrawalSqlStore.byKey(c.client,'user-1','withdrawal','w1');
    expect(c.query).toHaveBeenCalledWith(expect.stringContaining('user_id=$1 AND kind=$2 AND request_key=$3 FOR UPDATE'),['user-1','withdrawal','w1']);
  });
  it('does not expose app INSERT receipt authority; reselects immutable independent admission',async()=>{
    const c=client([{receipt_id:'r1'}]);await withdrawalSqlStore.admittedReceipt(c.client,record,attempt,receipt);
    const [sql,values]=c.query.mock.calls[0]!;
    expect(sql).toMatch(/^SELECT receipt_id/);expect(sql).not.toMatch(/INSERT|UPDATE/);
    expect(values).toEqual(['user-1','intent-1','attempt-1','r1',financialHash(receipt)]);
  });
  it('attempt fixed clientOrderId is derived from durable identity and short enough for venue',async()=>{
    const c=client([{id:'a1',intent_id:'intent-1',user_id:'user-1',client_order_id:'c1',intent_hash:record.intentHash,state:'prepared',completed_raw:'0',completed_fee_raw:'0',terminal:false}]);
    await withdrawalSqlStore.prepare(c.client,record);
    const values=c.query.mock.calls[0]![1] as unknown[];
    expect(values.slice(0,3)).toEqual(['intent-1','user-1',record.intentHash]);expect(values[3]).toMatch(/^w3-[a-f0-9]{48}$/);
  });
  it('write-ahead uncertain fence uses exact immutable attempt, tenant, prior state and terminal guard',async()=>{
    const c=client([]);expect(await withdrawalSqlStore.dispatchFence(c.client,record,attempt)).toBe(false);
    expect(c.query).toHaveBeenCalledWith(expect.stringMatching(/id=\$1 AND intent_id=\$2 AND user_id=\$3 AND state='prepared' AND NOT terminal/),['attempt-1','intent-1','user-1']);
  });
  it('application does not write arbitrary settled snapshots; DB derives from independent receipt',async()=>{
    const c=client();await withdrawalSqlStore.progress(c.client,record,attempt,receipt,'100','journal-1');
    expect(c.query.mock.calls[0]![0]).toContain('INSERT INTO public.withdrawal_reducing_applications');
    expect(c.query.mock.calls.map(v=>v[0]).join('\n')).not.toMatch(/SET status='settled'|SET completed_raw/);
  });
});
describe('082 proposal governance/security source obligations (NOT PostgreSQL acceptance)',()=>{
  it('forces tenant RLS on every new financial ledger without app bypass policy',()=>{
    expect(schema).toContain('FORCE ROW LEVEL SECURITY');expect(schema).toContain('user_id=public.current_app_user_id()');
    expect(schema).toContain('TO swat_app,swat_financial_settler,swat_financial_receipt_writer');
  });
  it('immutable exact identity and unique tenant request key survive retries',()=>{
    expect(schema).toContain('UNIQUE(user_id,kind,request_key)');expect(schema).toContain('financial exact intent immutable');
    expect(schema).toContain('NEW.intent,NEW.intent_hash,NEW.expires_at');
  });
  it('OTP consumption is conditional, lockout monotonic and deferred atomic outbox required',()=>{
    expect(schema).toContain('DEFERRABLE INITIALLY DEFERRED');expect(schema).toContain('authorization consumption requires atomic durable request');
    expect(schema).toContain("OLD.failures>=5 OR OLD.expires_at<=NEW.consumed_at");expect(schema).toContain('NEW.failures>OLD.failures+1');
  });
  it('fixed one-use attempt fence has unique intent and does not expire into replay',()=>{
    expect(schema).toContain('intent_id uuid NOT NULL UNIQUE');expect(schema).toContain('fence=1');
    expect(schema).toContain('fixed attempt fence immutable');expect(schema).not.toContain('lease_until');
  });
  it('receipt authority is independent, app cannot self-certify settlement or perps closure',()=>{
    expect(schema).toContain("current_user<>'swat_financial_receipt_writer'");
    expect(schema).toContain('GRANT INSERT ON public.withdrawal_reducing_receipts TO swat_financial_receipt_writer');
    expect(schema).not.toMatch(/GRANT INSERT ON public.withdrawal_reducing_receipts TO swat_app/);
    expect(schema).toContain('REVOKE UPDATE ON public.polymarket_perps_positions FROM swat_app');
    expect(schema).toContain('perps initial exposure cannot self-certify closure');
  });
  it('settled derives only full terminal receipt; partial is partial and canonical join required',()=>{
    expect(schema).toContain("receipt.terminal AND receipt.cumulative_raw=maximum THEN 'settled'");
    expect(schema).toContain("receipt.cumulative_raw>0 THEN 'partial'");
    expect(schema).toContain('canonical perps position application unavailable');
    expect(schema).toContain('canonical withdrawal/spot accounting admission unavailable');
  });
  it('narrow role helper EXECUTE and every-fill economics are explicit, not broad permissions',()=>{
    expect(schema).toContain('GRANT EXECUTE ON FUNCTION public.current_app_user_id(),public.is_rls_bypassed() TO swat_financial_settler,swat_financial_receipt_writer');
    expect(schema).not.toContain('GRANT EXECUTE ON ALL FUNCTIONS');
    expect(schema).toContain('perps EVERY fill economics admission unavailable');
  });
  it('fee denominations and cumulative paid fees derive reservation progress from receipt trigger',()=>{
    expect(schema).toContain('fee_asset_id text NOT NULL');expect(schema).toContain('PRIMARY KEY(intent_id,budget_key)');
    expect(schema).toContain('-CASE WHEN fee_raw>0 THEN receipt.fee_raw ELSE 0 END');
    expect(schema).toContain('permanent provider no-future-acceptance tombstone required');
  });
  it('expired cancellation locks no-attempt proof and permanently prevents later dispatch',()=>{
    expect(schema).toContain("parent.status<>'queued' OR parent.terminal OR parent.expires_at>clock_timestamp()");
    expect(schema).toContain('OR EXISTS(SELECT 1 FROM public.withdrawal_reducing_attempts WHERE intent_id=parent.id)');
    expect(schema).toContain("status='cancelled',terminal=true");expect(schema).toContain('withdrawal_reducing_cancellations');
  });
  it('direct app attempt INSERT locks parent before current queued/cancelled/expiry checks',()=>{
    const guard=schema.slice(schema.indexOf('CREATE FUNCTION public.w3_guard_attempt()'),schema.indexOf('CREATE FUNCTION public.w3_guard_receipt()'));
    expect(guard).toContain('user_id=NEW.user_id FOR UPDATE');
    expect(guard.indexOf('FOR UPDATE')).toBeLessThan(guard.indexOf("parent.status<>'queued'"));
    expect(guard).toContain('parent.terminal OR parent.cancelled_at IS NOT NULL');
    expect(guard).toContain('parent.expires_at<=clock_timestamp()');
    expect(guard).not.toContain('parent.expires_at<=statement_timestamp()');
    // RLS app direct INSERT stays granted, but this boundary serializes against cancel locked-parent absence proof.
    expect(schema).toContain('public.withdrawal_reducing_outbox,public.withdrawal_reducing_attempts,public.withdrawal_reducing_applications TO swat_app');
  });
  it('closed perps fee-only path requires exact prior applied receipt journal and does not reopen',()=>{
    expect(schema).toContain("IF position.status='closed' THEN");
    expect(schema).toContain('delta<>0 OR before_quantity<>0 OR after_quantity<>0');
    expect(schema).toContain('closed perps fee-only requires exact prior receipt journal');
    expect(schema).toContain("ELSIF position.status IN('open','closing') THEN");
  });
  it('economics collateral binds independently admitted deployed mapping, never public fee fields',()=>{
    const guard=schema.slice(schema.indexOf('CREATE FUNCTION public.w3_guard_perps_economics_admission()'),schema.indexOf('CREATE TRIGGER w3_perps_economics_guard'));
    expect(guard).toContain('public.reducing_perps_venue_mappings');
    expect(guard).toContain('mapping.collateral_asset_id');expect(guard).toContain('mapping.collateral_account_id');
    expect(guard).not.toContain("parent.intent->>'feeAssetId'");expect(guard).not.toContain("parent.intent->>'feeAssetScale'");
    expect(schema).toContain('public.reducing_perps_venue_mappings TO swat_financial_receipt_writer');
    const mappingTable=schema.slice(schema.indexOf('CREATE TABLE public.reducing_perps_venue_mappings'),schema.indexOf('-- Every perps nonzero fill'));
    expect(mappingTable).not.toContain('REFERENCES public.withdrawal_reducing_intents');
    expect(mappingTable).toContain('mapping_id text PRIMARY KEY');
  });
  it('receipt timestamp uses statement time, not historical transaction-start expiry',()=>{
    expect(schema).toContain('NEW.admitted_at:=statement_timestamp()');expect(schema).toContain('NEW.consumed_at:=statement_timestamp()');
    expect(schema).toContain('parent.expires_at<=NEW.consumed_at');
  });
});
