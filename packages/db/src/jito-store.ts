import type { PoolClient } from 'pg';
import { claimJitoPendingWithClient, prepareJitoPendingWithClient, readJitoPendingWithClient,
  saveJitoBundleWithClient, jitoPendingFromRow, type DurableJitoPending, type JitoPendingRow } from './jito-pending.js';
import { assertQuantifiedJitoReceipt, assertJitoReceiptObservation, type QuantifiedJitoReceipt } from './jito-receipt.js';

export interface JitoDatabaseResolution {
  readonly status: 'filled'; readonly clientOrderId: string; readonly signature: string;
  readonly slot: number; readonly receipt: QuantifiedJitoReceipt;
}
export interface JitoDatabaseStoreOptions {
  /** Caller applies approved runtime tenant/operator scope; return ONLY after COMMIT. */
  readonly transaction: <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
}
/** Durable claim/prewrite replaces Redis as execution authority. Redis legacy
 * state may remain diagnostic, but is not promoted into a canonical receipt. */
export function createDatabaseJitoStore(options: JitoDatabaseStoreOptions) {
  return {
    claim: (execution: DurableJitoPending['execution'], intent: DurableJitoPending['intent'], attempt: DurableJitoPending['attempt']) =>
      options.transaction(client => claimJitoPendingWithClient(client, execution, intent, attempt)),
    prepare: (pending: DurableJitoPending) => options.transaction(client => prepareJitoPendingWithClient(client, pending)),
    save: (pending: DurableJitoPending) => options.transaction(client => saveJitoBundleWithClient(client, pending)),
    findPending: (id: string) => options.transaction(async client => {
      const row = await readJitoPendingWithClient(client, id);
      return row && row.state !== 'settled' ? jitoPendingFromRow(row) : null;
    }),
    findResolution: (id: string) => options.transaction(async client => {
      const result = await client.query<{ resolution: JitoDatabaseResolution | null }>(
        `SELECT resolution FROM jito_execution_pending WHERE client_order_id = $1 AND state = 'settled'`, [id]);
      const resolution = result.rows[0]?.resolution;
      if (!resolution) return null;
      const row = await readJitoPendingWithClient(client, id);
      const pending = row && jitoPendingFromRow(row);
      if (!pending || resolution.status !== 'filled' || resolution.clientOrderId !== id
        || resolution.signature !== resolution.receipt.signature || resolution.slot !== resolution.receipt.slot) throw new Error('Jito durable resolution invalid');
      const receiptValue = { ...resolution.receipt, occurredAt: new Date(resolution.receipt.occurredAt) };
      assertQuantifiedJitoReceipt(receiptValue, pending);
      return { ...resolution, receipt: receiptValue };
    }),
    listPending: () => options.transaction(async client => {
      // Persist scheduling progress BEFORE provider observation; unknown outcomes
      // retain ownership but cannot pin every bounded sweep to the oldest 100.
      const result = await client.query<JitoPendingRow>(`WITH selected AS (
        SELECT execution_id FROM jito_execution_pending WHERE state IN ('prepared','submitted')
        ORDER BY last_checked_at NULLS FIRST, prepared_at, execution_id LIMIT 100 FOR UPDATE SKIP LOCKED
      ) UPDATE jito_execution_pending pending SET last_checked_at = clock_timestamp()
        FROM selected WHERE pending.execution_id = selected.execution_id RETURNING pending.*`);
      return result.rows.map(row => jitoPendingFromRow(row)!);
    }),
    resolve: (id: string, resolution: JitoDatabaseResolution) => options.transaction(async client => {
      const row = await readJitoPendingWithClient(client, id, true);
      const pending = row && jitoPendingFromRow(row);
      if (!pending || resolution.status !== 'filled' || resolution.clientOrderId !== id
        || resolution.signature !== resolution.receipt.signature || resolution.slot !== resolution.receipt.slot) throw new Error('Jito acknowledgement identity mismatch');
      assertQuantifiedJitoReceipt(resolution.receipt, pending);
      // Financial commit is independent of cache acknowledgement; check durable
      // receipt rather than trusting a caller boolean or a venue landed status.
      const receipt = await client.query<{ receipt: QuantifiedJitoReceipt }>(`SELECT receipt FROM jito_execution_receipts
        WHERE execution_id = $1 AND settled FOR SHARE`, [pending.execution.executionId]);
      if (receipt.rows.length !== 1) throw new Error('Jito acknowledgement before financial commit');
      const committed = { ...receipt.rows[0]!.receipt, occurredAt: new Date(receipt.rows[0]!.receipt.occurredAt) };
      assertQuantifiedJitoReceipt(committed, pending);
      assertJitoReceiptObservation(committed, resolution.receipt);
      if (row!.state === 'settled') return; // Never rewrite an acknowledged resolution.
      const committedResolution: JitoDatabaseResolution = { status: 'filled', clientOrderId: id,
        signature: committed.signature, slot: committed.slot, receipt: committed };
      await client.query(`UPDATE jito_execution_pending SET state = 'settled', resolution = $2::jsonb, settled_at = NOW()
        WHERE client_order_id = $1`, [id, JSON.stringify(committedResolution)]);
    })
  };
}
