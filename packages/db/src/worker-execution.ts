import type { PoolClient } from 'pg';
import type { Chain, CopyExecutionMode } from '@swat/shared';
import { getCopyExecutionByIdWithClient, type CopyExecutionRecord } from './copy-trade-lifecycle.js';
import { assertExactExitQuantity } from './lot-allocation.js';
import { hasAcceptedSourceVerificationWithClient } from './source-verification-store.js';
import { readSourceSellLotProofWithClient, type SourceSellLotProof } from './source-sell-lot-allocation.js';

export interface WorkerExecutionContext {
  readonly execution: CopyExecutionRecord;
  readonly masterWalletAddress: string;
  readonly sourceSellLots?: SourceSellLotProof | null;
  readonly ownedExit: null | { readonly lotId: string; readonly availableQuantity: string;
    readonly requestedQuantity: string; readonly acquisitionMode: CopyExecutionMode; readonly maxSlippageBps: number };
}

/** Read immutable lot/source scope under the SAME position-first lock order as
 * canonical claims. Queue data supplies only the ID, not ownership or inventory. */
export async function readWorkerExecutionContextWithClient(client: PoolClient, executionId: string): Promise<WorkerExecutionContext | null> {
  const discovered = await client.query<{ target_account: string; chain: Chain; token_mint: string; user_id: string | null }>(
    `SELECT target_account, chain, token_mint, user_id FROM copy_executions WHERE id = $1`, [executionId]
  );
  const scope = discovered.rows[0];
  if (!scope) return null;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [JSON.stringify([scope.target_account, scope.chain, scope.token_mint, scope.user_id])]);
  const execution = await getCopyExecutionByIdWithClient(client, executionId);
  if (!execution || execution.targetAccount !== scope.target_account || execution.chain !== scope.chain
    || execution.tokenMint !== scope.token_mint || execution.userId !== scope.user_id) throw new Error('Worker execution immutable scope changed');
  if (execution.exitLotId) {
    const lots = await client.query<{ master_wallet_address: string; remaining_quantity: string; execution_mode: CopyExecutionMode; max_slippage_bps: number }>(
      `SELECT lot.master_wallet_address, lot.remaining_quantity::text, acquisition.execution_mode,
         (snapshot.snapshot->>'maxSlippageBps')::integer AS max_slippage_bps
       FROM copy_position_master_lots lot
       JOIN copy_positions position ON position.id = lot.position_id
         AND position.user_id IS NOT DISTINCT FROM lot.user_id AND position.target_account = $3
         AND position.chain = lot.chain AND position.token_mint = lot.token_mint
       JOIN copy_executions acquisition ON acquisition.id = lot.acquisition_execution_id
         AND acquisition.user_id IS NOT DISTINCT FROM lot.user_id AND acquisition.target_account = position.target_account
         AND acquisition.chain = lot.chain AND acquisition.token_mint = lot.token_mint AND acquisition.direction = 'buy'
         AND acquisition.signal_id IS NOT DISTINCT FROM lot.signal_id AND acquisition.source_trade_id = lot.source_trade_id
       JOIN source_trades source ON source.id = lot.source_trade_id AND source.wallet_address = lot.master_wallet_address
         AND source.chain = lot.chain AND source.token_mint = lot.token_mint AND source.direction = 'buy'
       JOIN copy_execution_evidence evidence ON evidence.id = lot.acquisition_evidence_id
         AND evidence.execution_id = acquisition.id AND evidence.confirmation_state IN ('confirmed','finalized')
       JOIN copy_position_applications application ON application.evidence_id = evidence.id AND application.active
         AND application.execution_id = acquisition.id AND application.position_id = position.id
         AND application.user_id IS NOT DISTINCT FROM lot.user_id
         AND application.target_account = position.target_account AND application.chain = lot.chain AND application.token_mint = lot.token_mint
       JOIN copy_execution_policy_snapshots snapshot ON snapshot.execution_id = acquisition.id
         AND snapshot.user_id IS NOT DISTINCT FROM lot.user_id AND snapshot.target_account = position.target_account
         AND snapshot.master_wallet_address = lot.master_wallet_address AND snapshot.execution_mode = acquisition.execution_mode
         AND snapshot.chain = lot.chain AND snapshot.token_mint = lot.token_mint
       WHERE lot.id = $1 AND lot.user_id IS NOT DISTINCT FROM $2 AND lot.chain = $4 AND lot.token_mint = $5
         AND lot.signal_id IS NOT DISTINCT FROM $6
       FOR UPDATE OF position, lot FOR SHARE OF acquisition, source, evidence, application, snapshot`,
      [execution.exitLotId, execution.userId, execution.targetAccount, execution.chain, execution.tokenMint, execution.signalId]
    );
    const lot = lots.rows[0];
    if (!lot || !execution.requestedBaseQuantity) return null;
    // Terminal replays can have zero remaining quantity; never turn them into a
    // new admission. The orchestrator returns terminal before policy sizing.
    const ownedExit = { lotId: execution.exitLotId, availableQuantity: lot.remaining_quantity,
      requestedQuantity: execution.requestedBaseQuantity, acquisitionMode: lot.execution_mode, maxSlippageBps: lot.max_slippage_bps };
    return { execution, masterWalletAddress: lot.master_wallet_address, ownedExit };
  }
  if (!execution.sourceTradeId) return null;
  const sources = await client.query<{ wallet_address: string }>(
    `SELECT source.wallet_address FROM source_trades source JOIN signals signal ON signal.source_trade_id = source.id
     WHERE source.id = $1 AND signal.id = $2 AND source.chain = $3 AND source.token_mint = $4 AND source.direction = $5
     FOR SHARE OF source, signal`, [execution.sourceTradeId, execution.signalId, execution.chain, execution.tokenMint, execution.direction]
  );
  const source = sources.rows[0];
  if (!source || !await hasAcceptedSourceVerificationWithClient(client, execution.sourceTradeId)) return null;
  const sourceSellLots = execution.direction === 'sell'
    ? await readSourceSellLotProofWithClient(client, execution, source.wallet_address) : null;
  if (execution.direction === 'sell' && !sourceSellLots) return null;
  return { execution, masterWalletAddress: source.wallet_address, ownedExit: null, sourceSellLots };
}

export interface WorkerAttempt {
  readonly executionId: string;
  readonly userId: string | null;
  readonly policyRevision: string;
  readonly riskEpoch: string | null;
  readonly fence: string;
}

export async function prepareWorkerAttemptWithClient(client: PoolClient, execution: CopyExecutionRecord,
  policyRevision: string, riskEpoch: string | null): Promise<WorkerAttempt | null> {
  if (!['requested', 'simulated'].includes(execution.state) || execution.submissionId || execution.submissionAttempts !== 0
    || execution.confirmedBaseQuantity !== '0') return null;
  const evidence = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM copy_execution_evidence WHERE execution_id = $1) AS exists`, [execution.id]
  );
  if (evidence.rows[0]?.exists !== false) return null;
  const inserted = await client.query<{ fence: string }>(`INSERT INTO copy_execution_worker_attempts
    (execution_id,user_id,policy_revision,risk_epoch) VALUES ($1,$2,$3,$4::bigint)
    ON CONFLICT (execution_id) DO NOTHING RETURNING fence::text`, [execution.id, execution.userId, policyRevision, riskEpoch]);
  if (!inserted.rows[0]) return null; // Prepared lease expiry is uncertainty, never resend.
  return { executionId: execution.id, userId: execution.userId, policyRevision, riskEpoch, fence: inserted.rows[0].fence };
}

export async function markWorkerAttemptDispatchedWithClient(client: PoolClient, attempt: WorkerAttempt): Promise<void> {
  const result = await client.query(`UPDATE copy_execution_worker_attempts SET state = 'dispatched', dispatched_at = NOW()
    WHERE execution_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND fence = $3::bigint
      AND policy_revision = $4 AND risk_epoch IS NOT DISTINCT FROM $5::bigint AND state = 'prepared' RETURNING execution_id`,
  [attempt.executionId, attempt.userId, attempt.fence, attempt.policyRevision, attempt.riskEpoch]);
  if (result.rows.length !== 1) throw new Error('Worker attempt no longer has pre-effect authority');
}

export async function assertWorkerAttemptWithClient(client: PoolClient, attempt: WorkerAttempt): Promise<void> {
  const result = await client.query(`SELECT execution_id FROM copy_execution_worker_attempts
    WHERE execution_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND fence = $3::bigint AND policy_revision = $4
      AND risk_epoch IS NOT DISTINCT FROM $5::bigint AND state = 'dispatched' FOR UPDATE`,
  [attempt.executionId, attempt.userId, attempt.fence, attempt.policyRevision, attempt.riskEpoch]);
  if (result.rows.length !== 1) throw new Error('Worker settlement attempt identity/fence mismatch');
}

export async function finishWorkerAttemptWithClient(client: PoolClient, attempt: WorkerAttempt, state: 'settled' | 'unknown'): Promise<void> {
  await assertWorkerAttemptWithClient(client, attempt);
  await client.query(`UPDATE copy_execution_worker_attempts SET state = $2,
    settled_at = CASE WHEN $2 = 'settled' THEN NOW() ELSE NULL END WHERE execution_id = $1`, [attempt.executionId, state]);
}

/** Economic quantities remain decimal text all the way to SQL. */
export function assertWorkerBaseQuantity(value: unknown): asserts value is string { assertExactExitQuantity(value); }
