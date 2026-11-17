import type { PoolClient } from 'pg';
import { withTenantTransaction, type UserScope } from './tenancy.js';
import {
  lpDecimal, lpExactHash, lpMicro, lpSnapshot, lpStoredMicro,
  type LpExactOperation, type LpExactPosition, type LpExactSubscription, type LpPaperReceipt
} from './lp-exact.js';
import {
  lpResultAfterReceipt, type LpAcquisitionCommit, type LpOperationCommit,
  type LpPaperStore, type LpPaperTransaction
} from './lp-paper-service.js';

export type LpTenantTransaction = <T>(scope: UserScope, action: (client: PoolClient) => Promise<T>) => Promise<T>;
interface ExactPositionRow { data: LpExactPosition; state: LpExactPosition['state']; auto_rebalance: boolean }
interface ExactOperationRow { data: LpExactOperation }
function position(row: ExactPositionRow | undefined): LpExactPosition | null {
  return row ? { ...lpSnapshot(row.data), state: row.state, autoRebalance: row.auto_rebalance } : null;
}
const positionSelect = `SELECT e.data, p.state, p.auto_rebalance FROM lp_exact_positions e
  JOIN lp_positions p ON p.id=e.position_id AND p.user_id=e.user_id`;
function operation(row: ExactOperationRow | undefined): LpExactOperation | null { return row ? lpSnapshot(row.data) : null; }
async function journal(client: PoolClient, id: string, from: string | null, to: string, reason: string): Promise<void> {
  await client.query('INSERT INTO lp_position_state_history (position_id,from_state,to_state,reason) VALUES ($1,$2,$3,$4)', [id, from, to, reason]);
}
function transactionStore(client: PoolClient, userId: string): LpPaperTransaction {
  async function getPosition(id: string): Promise<LpExactPosition | null> {
    const rows = await client.query<ExactPositionRow>(`${positionSelect} WHERE e.user_id=$1 AND e.position_id=$2 FOR UPDATE OF p,e`, [userId, id]);
    return position(rows.rows[0]);
  }
  async function getOperation(id: string): Promise<LpExactOperation | null> {
    const rows = await client.query<ExactOperationRow>('SELECT data FROM lp_exact_operations WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, id]);
    return operation(rows.rows[0]);
  }
  return {
    acquisition: async key => {
      const rows = await client.query<ExactPositionRow>(`${positionSelect} WHERE e.user_id=$1 AND e.acquisition_key=$2 FOR UPDATE OF p,e`, [userId, key]);
      return position(rows.rows[0]);
    },
    position: getPosition,
    operation: getOperation,
    operationByKey: async key => {
      const rows = await client.query<ExactOperationRow>('SELECT data FROM lp_exact_operations WHERE user_id=$1 AND operation_key=$2 FOR UPDATE', [userId, key]);
      return operation(rows.rows[0]);
    },
    pendingForPosition: async id => {
      const rows = await client.query<ExactOperationRow>("SELECT data FROM lp_exact_operations WHERE user_id=$1 AND position_id=$2 AND status='pending' FOR UPDATE", [userId, id]);
      return operation(rows.rows[0]);
    },
    pending: async limit => {
      const rows = await client.query<ExactOperationRow>("SELECT data FROM lp_exact_operations WHERE user_id=$1 AND status='pending' ORDER BY created_at,id LIMIT $2", [userId, limit]);
      return rows.rows.map(row => operation(row)!);
    },
    policy: async (chain, poolAddress) => {
      const configs = await client.query<{ cap: string }>('SELECT max_pool_allocation_pct::text AS cap FROM lp_guardrail_configs WHERE user_id=$1 FOR UPDATE', [userId]);
      const capText = configs.rows[0]?.cap ?? '50.00';
      const capMicro = lpStoredMicro(capText);
      if (lpMicro(capMicro) % 10_000n !== 0n) throw new Error('LP exact cap scale unavailable');
      const poolCapBps = Number(lpMicro(capMicro) / 10_000n);
      const totals = await client.query<{ total: string; pool: string; unassessed: string }>(
        `SELECT COALESCE(SUM(deposit_value_usd),0)::text AS total,
          COALESCE(SUM(deposit_value_usd) FILTER(WHERE chain=$2 AND pool_address=$3),0)::text AS pool,
          COUNT(*) FILTER(WHERE deposit_value_usd IS NULL OR acquisition_mode <> 'paper' OR acquisition_provenance <> 'exact-injected-paper-v2')::text AS unassessed
         FROM lp_positions WHERE user_id=$1 AND state <> 'closed'`, [userId, chain, poolAddress]);
      const row = totals.rows[0]; if (!row) throw new Error('LP exact exposure unavailable');
      return { totalMicroUsd: lpStoredMicro(row.total), poolMicroUsd: lpStoredMicro(row.pool), unassessedPositions: Number(row.unassessed), poolCapBps };
    },
    subscription: async id => {
      const rows = await client.query<{ id: string; user_id: string; master_wallet_address: string; chain: LpExactSubscription['chain']; venue: LpExactSubscription['venue'];
        budget: string; cap: string; status: LpExactSubscription['status']; created_at: Date; updated_at: Date }>(
        'SELECT id,user_id,master_wallet_address,chain,venue,allocated_budget_usd::text AS budget,max_capital_per_position_usd::text AS cap,status,created_at,updated_at FROM lp_copy_subscriptions WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, id]);
      const row = rows.rows[0];
      return row ? { id: row.id, userId: row.user_id, masterWalletAddress: row.master_wallet_address, chain: row.chain, venue: row.venue,
        budgetMicroUsd: lpStoredMicro(row.budget), capMicroUsd: lpStoredMicro(row.cap), status: row.status,
        createdAt: row.created_at.toISOString(), revision: lpExactHash({ status: row.status, budget: row.budget, cap: row.cap, updatedAt: row.updated_at.toISOString() }) } : null;
    },
    copyPosition: async (subscriptionId, eventId) => {
      const rows = await client.query<ExactPositionRow>(`${positionSelect} WHERE e.user_id=$1 AND e.subscription_id=$2 AND e.master_event_id=$3 FOR UPDATE OF p,e`, [userId, subscriptionId, eventId]);
      return position(rows.rows[0]);
    },
    copySpentMicroUsd: async subscriptionId => {
      const rows = await client.query<{ spent: string }>("SELECT COALESCE(SUM((data->>'depositMicroUsd')::numeric),0)::text AS spent FROM lp_exact_positions WHERE user_id=$1 AND subscription_id=$2", [userId, subscriptionId]);
      const spent = rows.rows[0]?.spent; if (spent === undefined) throw new Error('LP copy budget observation unavailable');
      lpMicro(spent); return spent;
    },
    insertAcquisition: async (input: LpAcquisitionCommit) => {
      const { request, quote, plan, origin, fingerprint } = input;
      // Compatibility columns retain exact NUMERIC text, but old numeric DTO is NOT an exact financial interface.
      const weights = plan.rungs.map(rung => ({ priceLower: rung.priceLower, priceUpper: rung.priceUpper,
        weight: Number(BigInt(rung.allocation.raw) * 1_000_000_000_000n / BigInt(request.deposit.raw)) / 1_000_000_000_000,
        ...(rung.binLower === undefined ? {} : { binId: rung.binLower }),
        ...(rung.tickLower === undefined ? {} : { tickLower: rung.tickLower, tickUpper: rung.tickUpper }) }));
      const rows = await client.query<{ id: string }>(
        `INSERT INTO lp_positions(user_id,chain,protocol,pool_address,strategy_type,range_lower,range_upper,rung_allocations,
          deposit_amount,deposit_asset,state,auto_rebalance,acquisition_mode,acquisition_provenance,deposit_value_usd,
          valuation_evidence,paper_plan,acquisition_key,acquisition_fingerprint)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::numeric,$10,'building',$11,'paper','exact-injected-paper-v2',
          $12::numeric,$13::jsonb,$14::jsonb,$15,$16) RETURNING id`,
        [userId, request.chain, quote.pool.protocol, request.poolAddress, request.strategy.distribution, request.strategy.rangeLower,
          request.strategy.rangeUpper, JSON.stringify(weights), lpDecimal(request.deposit), request.depositAsset, request.autoRebalance === true,
          lpDecimal({ raw: quote.valueMicroUsd, scale: 6 }), JSON.stringify(quote), JSON.stringify(plan), request.operationKey, fingerprint]);
      const id = rows.rows[0]?.id; if (!id) throw new Error('LP acquisition insert missing id');
      const data: LpExactPosition = { id, userId, chain: request.chain, protocol: quote.pool.protocol, poolAddress: request.poolAddress,
        depositAsset: request.depositAsset, acquisitionKey: request.operationKey, acquisitionFingerprint: fingerprint, mode: 'paper',
        deposit: request.deposit, depositMicroUsd: quote.valueMicroUsd, acquisitionQuote: quote, copyOrigin: origin,
        currentAmount: request.deposit, plan, revision: '0', state: 'active', autoRebalance: request.autoRebalance === true,
        cumulativeFeesMicroUsd: '0', cumulativeCostsMicroUsd: '0', realizedMicroUsd: null, lastReceiptKey: null };
      await client.query(`INSERT INTO lp_exact_positions(position_id,user_id,acquisition_key,subscription_id,master_event_id,data)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [id, userId, request.operationKey, origin?.subscriptionId ?? null, origin?.eventId ?? null, JSON.stringify(data)]);
      await journal(client, id, null, 'building', 'exact valued injected paper acquisition; no broadcast');
      await client.query("UPDATE lp_positions SET state='active',updated_at=statement_timestamp() WHERE id=$1 AND user_id=$2", [id, userId]);
      await journal(client, id, 'building', 'active', 'exact plan committed; keyless injected evidence only');
      if (origin) {
        await client.query(`INSERT INTO lp_copy_executions(subscription_id,user_id,master_position_id,follower_position_id,chain,action,
          master_deposit_usd,follower_deposit_usd,scale_ratio,status,error_message)
          VALUES($1,$2,$3,$4,$5,'mint',$6::numeric,$7::numeric,$7::numeric/$6::numeric,'executed','exact valued injected paper acquisition only; no live execution')`,
          [origin.subscriptionId, userId, origin.masterPositionId, id, request.chain,
            lpDecimal({ raw: origin.masterDepositMicroUsd, scale: 6 }), lpDecimal({ raw: quote.valueMicroUsd, scale: 6 })]);
      }
      return lpSnapshot(data);
    },
    insertOperation: async (input: LpOperationCommit) => {
      const rows = await client.query<{ id: string }>('SELECT gen_random_uuid()::text AS id');
      const id = rows.rows[0]?.id; if (!id) throw new Error('LP durable operation id unavailable');
      const data: LpExactOperation = { id, userId, positionId: input.position.id, operationKey: input.operationKey,
        fingerprint: input.fingerprint, action: input.action, positionRevision: input.position.revision,
        amountBefore: input.position.currentAmount, quote: input.quote, plan: input.plan,
        receiptKey: input.receiptKey, status: 'pending', receipt: null };
      await client.query(`INSERT INTO lp_exact_operations(id,user_id,position_id,operation_key,receipt_key,status,data)
        VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb)`, [id, userId, data.positionId, data.operationKey, data.receiptKey, JSON.stringify(data)]);
      return lpSnapshot(data);
    },
    settle: async (op, current, receipt: LpPaperReceipt) => {
      const next = lpResultAfterReceipt(current, op, receipt);
      // Receipt inserted before financial state update; all four writes share this checked-out transaction.
      await client.query(`INSERT INTO lp_exact_receipts(user_id,operation_id,position_id,receipt_key,provider_id,receipt_id,receipt_hash,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [userId, op.id, current.id, receipt.receiptKey, receipt.providerId, receipt.receiptId, lpExactHash(receipt), JSON.stringify(receipt)]);
      const done = { ...op, status: 'completed' as const, receipt };
      await client.query("UPDATE lp_exact_operations SET status='completed',data=$3::jsonb,completed_at=statement_timestamp() WHERE user_id=$1 AND id=$2 AND status='pending'", [userId, op.id, JSON.stringify(done)]);
      await client.query('UPDATE lp_exact_positions SET data=$3::jsonb WHERE user_id=$1 AND position_id=$2', [userId, current.id, JSON.stringify(next)]);
      if (op.action === 'rebalance') {
        await client.query(`UPDATE lp_positions SET state='active',paper_plan=$3::jsonb,range_lower=$4,range_upper=$5,
          updated_at=statement_timestamp() WHERE user_id=$1 AND id=$2`, [userId, current.id, JSON.stringify(next.plan), next.plan.strategy.rangeLower, next.plan.strategy.rangeUpper]);
        await journal(client, current.id, current.state, 'active', `receipt ${receipt.receiptKey}: exact paper replacement plan and costs committed`);
      } else {
        await client.query("UPDATE lp_positions SET state='closed',closed_at=statement_timestamp(),updated_at=statement_timestamp() WHERE user_id=$1 AND id=$2", [userId, current.id]);
        await journal(client, current.id, current.state, 'closed', `receipt ${receipt.receiptKey}: exact paper zero inventory settlement; no broadcast`);
      }
      return lpSnapshot(done);
    }
  };
}
/** Production transaction boundary is lazy: constructing/importing the factory performs no SQL. */
export function createLpPaperSqlStore(run: LpTenantTransaction = withTenantTransaction): LpPaperStore {
  return {
    transaction: async (scope, action) => {
      if (!scope || !scope.userId.trim() || scope.userId === '*') throw new Error('LP SQL tenant scope required');
      return run(scope, async client => {
        const owner = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [scope.userId]);
        if (!owner.rows[0]) throw new Error('LP owner unavailable');
        return action(transactionStore(client, scope.userId));
      });
    }
  };
}
