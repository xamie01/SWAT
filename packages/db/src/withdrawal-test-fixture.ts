import {
  type WithdrawalSqlClient, type WithdrawalTransaction, type FinancialReceipt, type FinancialAuthorization, type FinancialRecord,
  type FinancialAttempt, type FinancialBudget, type FinancialFundingEvidence, financialHash
} from './withdrawal-contract.js';
import type { ReducingVenueMapping, ReducingIntent } from './reducing-contract.js';

/** Bounded transactional SQL transcript fixture. NOT PostgreSQL/RLS/trigger/concurrency/runtime acceptance. */
export function withdrawalSqlFixture() {
  let now = '2026-11-17T12:00:00.000Z';
  type Row = Record<string, any>;
  let state: {
    intents: Row[]; auth: Row[]; reservations: Row[]; attempts: Row[]; receipts: Row[];
    applications: Row[]; outbox: Row[]; held: string; feeHeld: string; cancellations: Row[];
    mappings: Row[]; economics: Row[]; positionStatus: 'open'|'closed';
  } = { intents: [], auth: [], reservations: [], attempts: [], receipts: [], applications: [], outbox: [], held: '100', feeHeld: '1000',
    cancellations: [], mappings: [], economics: [], positionStatus: 'open' };
  const transcript: { marker: string; values: unknown[]; client: object }[] = [];
  const events: string[] = [];
  let serial = 0;
  let failMarker: string | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const transaction: WithdrawalTransaction = async <T>(userId: string, work: (client: WithdrawalSqlClient) => Promise<T>) => {
    const prior = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    const before = structuredClone(state);
    const client: WithdrawalSqlClient = {
      async query<R>(sql: string, values: unknown[] = []) {
        const marker = /\/\* ([a-z-]+:[a-z-]+) \*\//.exec(sql)?.[1];
        if (!marker) throw new Error('Unrecognized fixture SQL: ' + sql);
        transcript.push({ marker, values: structuredClone(values), client }); events.push(marker);
        if (marker === failMarker) throw new Error('injected SQL failure');
        const rows = execute(marker, values, userId);
        return { rows: rows.map(row => structuredClone(row)) as R[] };
      }
    };
    events.push('begin:' + userId);
    try {
      const result = await work(client);
      if (failMarker === 'commit' || failMarker === 'deferred-commit') throw new Error('injected deferred commit failure');
      // Small explicit contract simulator only; no PostgreSQL trigger/role/RLS claim.
      for (const auth of state.auth) if (auth.consumed_at && !state.outbox.some(o=>o.intent_id===auth.intent_id))
        throw new Error('fixture deferred authorization requires atomic outbox');
      events.push('commit:' + userId);
      return result;
    } catch (error) {
      state = before; events.push('rollback:' + userId); throw error;
    } finally { release(); }
  };
  function owned(row: Row, userId: string) { return row.user_id === userId; }
  function execute(marker: string, v: unknown[], userId: string): Row[] {
    switch (marker) {
      case 'financial:clock': return [{ observed_at: now }];
      case 'financial:request-lock': case 'financial:budget-lock': return [];
      case 'financial:by-key': return state.intents.filter(r => owned(r,userId) && r.user_id===v[0] && r.kind===v[1] && r.request_key===v[2]);
      case 'financial:by-id': return state.intents.filter(r => owned(r,userId) && r.user_id===v[0] && r.id===v[1]);
      case 'financial:create': {
        const row = { id: 'intent-' + (++serial), user_id: v[0], kind: v[1], request_key: v[2], intent:
          Object.fromEntries(Object.entries(JSON.parse(String(v[3]))).sort(([a],[b])=>a.localeCompare(b))),
          intent_hash: v[4], expires_at: v[5], created_at: now, status: 'awaiting-authorization', completed_raw: '0', terminal: false };
        state.intents.push(row); return [row];
      }
      case 'financial:reserved': return [{ reserved_raw: state.reservations.filter(r => owned(r,userId) && r.budget_key===v[1] && r.intent_id!==v[2])
        .reduce((sum,r) => sum + BigInt(r.reserved_raw),0n).toString() }];
      case 'financial:reserve': {
        if (state.reservations.some(r => r.intent_id===v[0]&&r.budget_key===v[2])) throw new Error('duplicate reservation');
        state.reservations.push({ intent_id:v[0],user_id:v[1],budget_key:v[2],purpose:v[3],chain:v[4],network:v[5],mode:v[6],
          account_id:v[7],asset_id:v[8],asset_scale:v[9],amount_raw:v[10],fee_raw:v[11],
          reserved_raw:(BigInt(String(v[10]))+BigInt(String(v[11]))).toString() }); return [];
      }
      case 'financial:outbox': {
        if (state.outbox.some(r => r.intent_id===v[0])) throw new Error('duplicate outbox');
        state.outbox.push({ intent_id:v[0],user_id:v[1],intent_hash:v[2] }); return [];
      }
      case 'financial:queue': {
        const row = state.intents.find(r => owned(r,userId) && r.id===v[0] && r.user_id===v[1] && r.status==='awaiting-authorization');
        if (!row) return []; row.status='queued'; return [row];
      }
      case 'withdrawal:authorization': return state.auth.filter(r => owned(r,userId) && r.user_id===v[0] && r.intent_id===v[1]);
      case 'withdrawal:issue': {
        const row = { id:'auth-'+(++serial),user_id:v[0],intent_id:v[1],intent_hash:v[2],digest:v[3],expires_at:v[4],
          failures:0,delivery_state:'pending',consumed_at:null };
        state.auth.push(row); return [row];
      }
      case 'withdrawal:delivery': {
        const row=state.auth.find(r => owned(r,userId)&&r.user_id===v[0]&&r.id===v[1]&&r.delivery_state==='pending'&&!r.consumed_at);
        if (row) row.delivery_state=v[2]; return [];
      }
      case 'withdrawal:failure': {
        const row=state.auth.find(r=>owned(r,userId)&&r.user_id===v[0]&&r.id===v[1]&&!r.consumed_at);
        if (row) row.failures++; return [];
      }
      case 'withdrawal:consume': {
        const row=state.auth.find(r=>owned(r,userId)&&r.user_id===v[0]&&r.id===v[1]&&r.intent_id===v[2]&&r.intent_hash===v[3]
          &&r.digest===v[4]&&!r.consumed_at&&r.failures<5&&r.delivery_state==='sent'&&r.expires_at>now);
        if (!row) return []; row.consumed_at=now; return [row];
      }
      case 'financial:attempt': return state.attempts.filter(r=>owned(r,userId)&&r.intent_id===v[0]&&r.user_id===v[1]);
      case 'financial:prepare': {
        if(state.attempts.some(r=>r.intent_id===v[0])) throw new Error('duplicate attempt');
        const parent=state.intents.find(r=>owned(r,userId)&&r.id===v[0]&&r.user_id===v[1]);
        if(!parent||parent.status!=='queued'||parent.terminal||parent.cancelled_at||parent.expires_at<=now)
          throw new Error('attempt requires locked current queued unexpired parent');
        const row={id:'attempt-'+(++serial),intent_id:v[0],user_id:v[1],intent_hash:v[2],client_order_id:v[3],state:'prepared',
          completed_raw:'0',completed_fee_raw:'0',terminal:false};
        state.attempts.push(row);return [row];
      }
      case 'financial:prepared': {
        const row=state.intents.find(r=>owned(r,userId)&&r.id===v[0]&&r.user_id===v[1]&&r.status==='queued');
        if(row)row.status='prepared';return [];
      }
      case 'financial:dispatch-fence': {
        const row=state.attempts.find(r=>owned(r,userId)&&r.id===v[0]&&r.intent_id===v[1]&&r.user_id===v[2]&&r.state==='prepared'&&!r.terminal);
        if(!row)return [];row.state='uncertain';return [row];
      }
      case 'financial:uncertain': {
        const row=state.intents.find(r=>owned(r,userId)&&r.id===v[0]&&r.user_id===v[1]&&!r.terminal);
        if(row)row.status='uncertain';return [];
      }
      case 'financial:admitted-receipt': return state.receipts.filter(r=>owned(r,userId)&&r.user_id===v[0]&&r.intent_id===v[1]
        &&r.attempt_id===v[2]&&r.receipt_id===v[3]&&r.receipt_hash===v[4]);
      case 'financial:applied-receipt': return state.applications.filter(r=>owned(r,userId)&&r.user_id===v[0]&&r.intent_id===v[1]&&r.receipt_id===v[2]);
      case 'financial:apply-receipt': {
        const admitted=state.receipts.find(r=>owned(r,userId)&&r.user_id===v[0]&&r.intent_id===v[1]&&r.attempt_id===v[2]&&r.receipt_id===v[3]);
        if(!admitted)throw new Error('admission missing');
        const row={user_id:v[0],intent_id:v[1],attempt_id:v[2],receipt_id:v[3],delta_raw:v[4],accounting_reference:v[5]};
        state.applications.push(row);
        const current=state.attempts.find(r=>r.id===v[2])!, parent=state.intents.find(r=>r.id===v[1])!;
        const receipt=admitted.receipt as FinancialReceipt;
        if(parent.intent.venue==='polymarket-perps'&&(String(v[4])!=='0'||receipt.feeRaw!==current.completed_fee_raw)
          && !state.economics.some(e=>e.receipt_id===receipt.receiptId&&e.intent_id===parent.id&&e.user_id===parent.user_id))
          throw new Error('fixture actual economics journal missing');
        if(receipt.terminal&&receipt.cumulativeRaw==='0'&&!receipt.noFutureAcceptance)throw new Error('fixture provider tombstone required');
        const maximum=parent.intent.kind==='withdrawal'?parent.intent.amountRaw:parent.intent.quantityRaw;
        const status=receipt.terminal&&receipt.cumulativeRaw===maximum?'settled':receipt.terminal&&receipt.cumulativeRaw==='0'?'failed'
          :receipt.cumulativeRaw!=='0'?'partial':'uncertain';
        Object.assign(current,{completed_raw:receipt.cumulativeRaw,completed_fee_raw:receipt.feeRaw,terminal:receipt.terminal,state:status});
        Object.assign(parent,{completed_raw:receipt.cumulativeRaw,terminal:receipt.terminal,status});
        for(const r of state.reservations.filter(r=>r.intent_id===parent.id)) r.reserved_raw=receipt.terminal?'0':
          (BigInt(r.amount_raw)+BigInt(r.fee_raw)-(r.amount_raw!=='0'?BigInt(receipt.cumulativeRaw):0n)-(r.fee_raw!=='0'?BigInt(receipt.feeRaw):0n)).toString();
        return [];
      }
      case 'financial:cancel-expired': {
        const parent=state.intents.find(r=>owned(r,userId)&&r.id===v[0]);
        if(!parent||parent.status!=='queued'||parent.terminal||parent.expires_at>now||state.attempts.some(r=>r.intent_id===parent.id))
          throw new Error('only expired queued no-attempt can cancel');
        Object.assign(parent,{status:'cancelled',terminal:true,cancelled_at:now,cancellation_reason:'expired-before-attempt'});
        for(const r of state.reservations.filter(r=>r.intent_id===parent.id))r.reserved_raw='0';
        state.cancellations.push({intent_id:parent.id,user_id:userId,reason:'expired-before-attempt'});return [];
      }
      case 'fixture:economics': {
        const journal=JSON.parse(String(v[4]));
        const row={intent_id:v[0],user_id:v[1],receipt_id:v[2],economics_reference:v[3],journal};
        if(state.economics.some(r=>r.receipt_id===v[2]))throw new Error('duplicate economics journal');
        state.economics.push(row);return [row];
      }
      case 'reducing:venue-mapping': return state.mappings.filter(r=>owned(r,userId)&&r.position_id===v[0]&&r.user_id===v[1]
        &&r.mapping_id===v[2]&&r.mapping_hash===v[3]);
      case 'fixture:account': {
        const delta=BigInt(String(v[0])),fee=BigInt(String(v[1]??'0'));
        if(state.positionStatus==='closed'&&delta!==0n)throw new Error('closed position cannot reduce again');
        state.held=(BigInt(state.held)-delta).toString();
        state.feeHeld=(BigInt(state.feeHeld)-fee).toString();
        state.positionStatus=state.held==='0'?'closed':'open';
        return [{ held:state.held,fee_held:state.feeHeld }];
      }
      default: throw new Error('Unsupported fixture marker ' + marker);
    }
  }
  return {
    get now() { return now; }, transaction, transcript, events,
    advance(ms: number) { now=new Date(Date.parse(now)+ms).toISOString(); },
    state: () => state,
    fail: (marker: string|null) => { failMarker=marker; },
    admitMapping(record:FinancialRecord<ReducingIntent>,mapping:ReducingVenueMapping) {
      if(!state.mappings.some(r=>r.intent_id===record.id))state.mappings.push({intent_id:record.id,position_id:record.intent.positionId,user_id:record.userId,
        mapping_id:mapping.mappingId,mapping_hash:financialHash(mapping),mapping:structuredClone(mapping)});
    },
    admit(receipt: FinancialReceipt, userId: string) {
      state.receipts.push({user_id:userId,intent_id:receipt.intentId,attempt_id:receipt.attemptId,receipt_id:receipt.receiptId,
        receipt_hash:financialHash(receipt),receipt:structuredClone(receipt)});
    }
  };
}

export function financialAuthorizationFixture<I extends {chain:string;network:string;mode:string;expiresAt:string}>(
  record:FinancialRecord<I>,attempt:FinancialAttempt,now:string,providerIdentity='fixture-provider'):FinancialAuthorization {
  return {intentId:record.id,intentHash:record.intentHash,attemptId:attempt.id,clientOrderId:attempt.clientOrderId,
    userId:record.userId,chain:record.intent.chain,network:record.intent.network,mode:record.intent.mode,
    providerIdentity,deadline:record.intent.expiresAt,issuedAt:now,atomicDeadline:true,scopeProof:'fixture-scope-proof',handle:{fixture:true}};
}
export function financialFundingFixture(userId:string,budget:FinancialBudget,now:string,availableRaw='1000'):FinancialFundingEvidence {
  return {...budget,userId,availableRaw,observedAt:now,validUntil:new Date(Date.parse(now)+60_000).toISOString(),proof:'fixture-independent-funding'};
}
export function reducingMappingFixture(record:FinancialRecord<ReducingIntent>,now:string):ReducingVenueMapping {
  return {mappingId:'mapping:'+record.id,revision:'deployed-venue-r1',userId:record.userId,positionId:record.intent.positionId,
    accountId:record.intent.accountId,venue:record.intent.venue,chain:record.intent.chain,network:record.intent.network,mode:record.intent.mode,
    assetId:record.intent.assetId,assetScale:record.intent.assetScale,collateralAssetId:'USDC',collateralAssetScale:6,
    collateralAccountId:'collateral-account',observedAt:now,validUntil:new Date(Date.parse(now)+900_000).toISOString(),proof:'fixture-independent-deployed-mapping'};
}
