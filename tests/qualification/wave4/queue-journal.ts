import { requireCheck, type SqlClient } from './core.js';
import { runtimeTransaction } from './domains.js';
import { queueIdentity, type QueueIdentity, type QueueJournal } from './queue-contract.js';
import { Deadline } from './containment.js';

export async function requireEmptyQueueNamespace(redis:any,input:QueueIdentity,deadline:Deadline) {
  const identity = queueIdentity(input);
  let cursor = '0';
  do {
    deadline.check();
    const result = await redis.scan(cursor,'MATCH',`${identity.prefix}:*`,'COUNT',100);
    requireCheck(Array.isArray(result) && typeof result[0] === 'string' && /^\d+$/.test(result[0])
      && Array.isArray(result[1]) && result[1].length === 0,'Owned queue namespace is not pristine');
    cursor = result[0];
  } while (cursor !== '0');
  deadline.check();
}
export async function queueJournal(client:SqlClient,input:QueueIdentity):Promise<QueueJournal> {
  const identity = queueIdentity(input);
  return runtimeTransaction(client,input.userId,async c=>{
    const rows = (await c.query(`SELECT o.id::text AS "operationId",o.user_id::text AS "userId",
      o.position_id::text AS "positionId",e.acquisition_key AS "acquisitionKey",o.status,
      e.data->'currentAmount'->>'raw' AS raw,e.data->>'revision' AS revision,
      e.data->>'cumulativeFeesMicroUsd' AS fees,e.data->>'cumulativeCostsMicroUsd' AS costs,
      e.data->>'realizedMicroUsd' AS realized,o.data AS operation,e.data AS position,e.acquisition_data AS acquisition,
      p.state AS "legacyState",to_jsonb(p) AS legacy,
      (SELECT to_jsonb(r) FROM lp_exact_receipts r WHERE r.operation_id=o.id AND r.user_id=o.user_id) AS "receiptRow",
      (SELECT count(*)::text FROM lp_exact_receipts r WHERE r.operation_id=o.id AND r.user_id=o.user_id) AS receipts,
      (SELECT r.data FROM lp_exact_receipts r WHERE r.operation_id=o.id AND r.user_id=o.user_id) AS receipt,
      (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.id) FROM lp_position_state_history h WHERE h.position_id=o.position_id) AS history
      FROM lp_exact_operations o JOIN lp_exact_positions e ON e.position_id=o.position_id AND e.user_id=o.user_id
      JOIN lp_positions p ON p.id=e.position_id AND p.user_id=e.user_id
      WHERE o.id=$1 AND o.user_id=$2 AND e.acquisition_key=$3`,[input.operationId,input.userId,identity.acquisitionKey])).rows;
    requireCheck(rows.length === 1,'Run-bound SQL queue operation unavailable');
    return rows[0] as QueueJournal;
  });
}
export function queueStream(rows:unknown):{event:string;jobId:string}[] {
  requireCheck(Array.isArray(rows),'Owned queue stream unavailable');
  return rows.map((row:any)=>{
    requireCheck(Array.isArray(row) && /^\d+-\d+$/.test(row[0]) && Array.isArray(row[1])
      && row[1].length % 2 === 0,'Malformed owned queue event');
    const fields:Record<string,string> = {};
    for (let i=0;i<row[1].length;i+=2) {
      requireCheck(typeof row[1][i] === 'string' && typeof row[1][i+1] === 'string'
        && !(row[1][i] in fields),'Malformed owned queue event fields');
      fields[row[1][i]] = row[1][i+1];
    }
    requireCheck(typeof fields.event === 'string','Owned queue event type unavailable');
    return {event:fields.event!,jobId:fields.jobId ?? ''};
  });
}
