import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPerpsReducingReceiptWithClient, requestPerpsPositionReduction, closePerpsPosition } from './polymarket-perps.js';
import { reducingIntent } from './reducing-contract.js';
import { financialHash, type FinancialRecord, type FinancialReceipt, type WithdrawalSqlClient } from './withdrawal-contract.js';
import type { ReducingService } from './reducing-service.js';
const db=vi.hoisted(()=>({query:vi.fn(),scopedQuery:vi.fn()}));
vi.mock('./client.js',()=>({query:db.query}));
vi.mock('./tenancy.js',()=>({forUser:(userId:string)=>({userId}),scopedQuery:db.scopedQuery}));
const intent=reducingIntent('user-1',{requestKey:'p1',chain:'polygon',network:'polygon137',venue:'polymarket-perps',positionId:'position-1',
  accountId:'account-1',assetId:'1',assetScale:8,mode:'paper',positionSide:'LONG',quantityRaw:'100',maxFeeRaw:'10',
  feeAssetId:'USDC',feeAssetScale:6,feeFundingAccountId:'fee-account',
  limitPriceExact:'65000',expectedRevision:'r1'},'2026-11-17T12:05:00.000Z');
const record:FinancialRecord<typeof intent>={id:'intent-1',userId:'user-1',intent,intentHash:financialHash(intent),status:'uncertain',completedRaw:'0',terminal:false,createdAt:'2026-11-17T12:00:00.000Z'};
const receipt:FinancialReceipt={receiptId:'receipt-1',intentId:record.id,intentHash:record.intentHash,attemptId:'a1',clientOrderId:'c1',
  providerIdentity:'fixture',proof:'proof',cumulativeRaw:'40',feeRaw:'0',feeAssetId:'USDC',feeAssetScale:6,feeFundingAccountId:'fee-account',
  terminal:false,outcome:'fill',observedAt:'2026-11-17T12:00:00.000Z'};
beforeEach(()=>{vi.clearAllMocks();db.scopedQuery.mockResolvedValue([]);});
describe('perps canonical receipt adapter and legacy no-false-close compatibility',()=>{
  it('invokes restricted owned receipt SQL function, never arbitrary update/upsert',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{delta_raw:'40',delta_fee_raw:'0'}]})
      .mockResolvedValueOnce({rows:[{economics_reference:'full-perps-economics-journal'}]})
      .mockResolvedValueOnce({rows:[{accounting_reference:'position-journal-1',position_id:'position-1',position_side:'LONG',before_raw:'100',after_raw:'60'}]});
    const result=await applyPerpsReducingReceiptWithClient({query} as WithdrawalSqlClient,record,receipt,'40','0');
    expect(result).toMatchObject({beforeRaw:'100',afterRaw:'60',positionId:'position-1'});
    expect(query).toHaveBeenCalledWith(expect.stringContaining('swat_apply_perps_reducing_receipt($1,$2)'),['intent-1','receipt-1']);
    expect(db.query).not.toHaveBeenCalled();expect(db.scopedQuery).not.toHaveBeenCalled();
  });
  it.each(['side','position','quantity','fee'])('refuses %s mismatch before claiming inventory closure',async(kind)=>{
    const result={accounting_reference:'journal',position_id:kind==='position'?'position-2':'position-1',position_side:kind==='side'?'SHORT':'LONG',
      before_raw:'100',after_raw:kind==='quantity'?'101':'60'};
    const query=vi.fn().mockResolvedValueOnce({rows:[{delta_raw:'40',delta_fee_raw:'0'}]})
      .mockResolvedValueOnce({rows:[{economics_reference:'journal'}]}).mockResolvedValueOnce({rows:[result]});
    await expect(applyPerpsReducingReceiptWithClient({query} as WithdrawalSqlClient,record,receipt,'40',kind==='fee'?'1':'0')).rejects.toThrow();
    if(kind==='fee')expect(query).toHaveBeenCalledTimes(1);
  });
  it('fee-only delta after closed prior journal returns unchanged zero exposure with economics',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{delta_raw:'0',delta_fee_raw:'3'}]})
      .mockResolvedValueOnce({rows:[{economics_reference:'actual-final-fee-journal'}]})
      .mockResolvedValueOnce({rows:[{accounting_reference:'closed-position-fee-journal',position_id:'position-1',position_side:'LONG',before_raw:'0',after_raw:'0'}]});
    const result=await applyPerpsReducingReceiptWithClient({query} as WithdrawalSqlClient,record,{...receipt,cumulativeRaw:'100',feeRaw:'5',terminal:true},'0','3');
    expect(result).toMatchObject({beforeRaw:'0',afterRaw:'0',economicsReference:'actual-final-fee-journal'});
    expect(query).toHaveBeenCalledTimes(3);
  });
  it.each(['0','5'])('requires economics on every nonzero fill even fee %s',async(fee)=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{delta_raw:'40',delta_fee_raw:fee}]}).mockResolvedValueOnce({rows:[]});
    await expect(applyPerpsReducingReceiptWithClient({query} as WithdrawalSqlClient,record,{...receipt,feeRaw:fee},'40',fee))
      .rejects.toThrow('perps-every-fill-economics-unavailable');
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('close legacy still fails closed; admission returns durable operation not boolean/closed',async()=>{
    db.scopedQuery.mockResolvedValue([{id:'position-1',size:'1',side:'LONG',status:'open'}]);
    await expect(closePerpsPosition('position-1','user-1')).rejects.toMatchObject({code:'PERPS_CLOSE_UNAVAILABLE'});
    const request=vi.fn(async()=>record);
    const {version,kind,userId,side,expiresAt,...input}=intent;
    expect(await requestPerpsPositionReduction('user-1',input,{request} as unknown as ReducingService)).toBe(record);
    await expect(requestPerpsPositionReduction('user-1',input)).rejects.toThrow('perps-reducing-durable-ports-unavailable');
    expect(record.status).toBe('uncertain');expect(record.completedRaw).toBe('0');
  });
});
