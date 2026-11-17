import type { PoolClient } from 'pg';
import type { CopyExecutionRecord } from './copy-trade-lifecycle.js';
import { hasAcceptedSourceVerificationWithClient } from './source-verification-store.js';
import { exactDecimal, compareExactDecimal, addExactDecimal, subtractExactDecimal, minimumExactDecimal } from './runtime-exact-decimal.js';

export interface SourceSellLotAllocation {
  readonly lotId: string;
  readonly quantity: string;
  readonly consumedQuantity: string;
  readonly outstandingQuantity: string;
  readonly availableQuantity: string;
  readonly acquisitionExecutionId: string;
  readonly acquisitionEvidenceId: string;
  readonly acquisitionSourceTradeId: string;
  readonly acquisitionMode: CopyExecutionRecord['executionMode'];
  readonly maxSlippageBps: number;
}
export interface SourceSellLotProof {
  readonly executionId: string;
  readonly userId: string | null;
  readonly targetAccount: string;
  readonly chain: CopyExecutionRecord['chain'];
  readonly tokenMint: string;
  readonly masterWalletAddress: string;
  readonly requestedQuantity: string;
  readonly lots: readonly SourceSellLotAllocation[];
}
interface LotRow {
  lot_id: string; remaining_quantity: string; acquisition_execution_id: string;
  acquisition_evidence_id: string; source_trade_id: string;
  execution_mode: CopyExecutionRecord['executionMode']; max_slippage_bps: number;
  reserved_quantity: string;
}
function scope(execution: CopyExecutionRecord, master: string): void {
  if (execution.direction !== 'sell' || !execution.sourceTradeId || execution.exitLotId || execution.exitTrigger
    || !execution.requestedBaseQuantity || !execution.sourceSellFraction || !execution.sourcePositionBeforeQuantity
    || !master.startsWith(`${execution.chain}:`)) throw new Error('Exact source sell allocation scope unavailable');
  exactDecimal(execution.requestedBaseQuantity, true);
}
async function lockLots(client: PoolClient, execution: CopyExecutionRecord, master: string): Promise<LotRow[]> {
  scope(execution, master);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [JSON.stringify([execution.targetAccount, execution.chain, execution.tokenMint, execution.userId])]);
  const position = await client.query<{ id: string }>(`SELECT id FROM copy_positions
    WHERE target_account = $1 AND chain = $2 AND token_mint = $3 AND user_id IS NOT DISTINCT FROM $4 FOR UPDATE`,
  [execution.targetAccount, execution.chain, execution.tokenMint, execution.userId]);
  if (!position.rows[0]) return [];
  const result = await client.query<LotRow>(`SELECT lot.id AS lot_id, lot.remaining_quantity::text,
    lot.acquisition_execution_id, lot.acquisition_evidence_id, lot.source_trade_id, acquisition.execution_mode,
    (snapshot.snapshot->>'maxSlippageBps')::integer AS max_slippage_bps,
    COALESCE((SELECT SUM(allocation.requested_quantity) FROM source_sell_lot_allocations allocation
      JOIN copy_executions pending ON pending.id = allocation.execution_id
      WHERE allocation.lot_id = lot.id AND pending.id <> $8 AND pending.reserved_base_quantity > 0),0)::text AS reserved_quantity
    FROM copy_position_master_lots lot
    JOIN copy_executions acquisition ON acquisition.id = lot.acquisition_execution_id
      AND acquisition.user_id IS NOT DISTINCT FROM lot.user_id AND acquisition.target_account = $2
      AND acquisition.chain = lot.chain AND acquisition.token_mint = lot.token_mint AND acquisition.direction = 'buy'
      AND acquisition.signal_id IS NOT DISTINCT FROM lot.signal_id AND acquisition.source_trade_id = lot.source_trade_id
    JOIN source_trades source ON source.id = lot.source_trade_id AND source.wallet_address = lot.master_wallet_address
      AND source.chain = lot.chain AND source.token_mint = lot.token_mint AND source.direction = 'buy'
      AND source.confirmation_state IN ('confirmed','finalized')
    JOIN copy_execution_evidence evidence ON evidence.id = lot.acquisition_evidence_id
      AND evidence.execution_id = acquisition.id AND evidence.confirmation_state IN ('confirmed','finalized')
    JOIN copy_position_applications application ON application.evidence_id = evidence.id AND application.active
      AND application.execution_id = acquisition.id AND application.position_id = lot.position_id
      AND application.user_id IS NOT DISTINCT FROM lot.user_id AND application.target_account = acquisition.target_account
      AND application.chain = lot.chain AND application.token_mint = lot.token_mint
    JOIN copy_execution_policy_snapshots snapshot ON snapshot.execution_id = acquisition.id
      AND snapshot.user_id IS NOT DISTINCT FROM lot.user_id AND snapshot.target_account = acquisition.target_account
      AND snapshot.chain = lot.chain AND snapshot.token_mint = lot.token_mint
      AND snapshot.master_wallet_address = lot.master_wallet_address AND snapshot.execution_mode = acquisition.execution_mode
    WHERE lot.position_id = $1 AND lot.user_id IS NOT DISTINCT FROM $3 AND lot.master_wallet_address = $4
      AND lot.chain = $5 AND lot.token_mint = $6 AND acquisition.execution_mode = $7
    ORDER BY lot.acquired_at, lot.id FOR UPDATE OF lot FOR SHARE OF acquisition,source,evidence,application,snapshot`,
  [position.rows[0].id, execution.targetAccount, execution.userId, master, execution.chain, execution.tokenMint, execution.executionMode, execution.id]);
  return result.rows;
}
export function allocateExactSourceSellLots(quantity: string, lots: readonly { lotId: string; availableQuantity: string }[]) {
  let remaining = exactDecimal(quantity, true);
  const result: { lotId: string; quantity: string }[] = [];
  const seen = new Set<string>();
  for (const lot of lots) {
    if (seen.has(lot.lotId)) throw new Error('Duplicate source sell lot');
    seen.add(lot.lotId);
    exactDecimal(lot.availableQuantity);
    if (remaining === '0') break;
    const allocated = minimumExactDecimal(remaining, lot.availableQuantity);
    if (compareExactDecimal(allocated, '0') === 0) continue;
    result.push({ lotId: lot.lotId, quantity: allocated });
    remaining = subtractExactDecimal(remaining, allocated);
  }
  if (compareExactDecimal(remaining, '0') !== 0) throw new Error('Exact source sell exceeds attributable unreserved lot inventory');
  return result;
}

/** Called after the canonical source claim, on its SAME client BEFORE descriptor
 * persistence/queue. Replays require existing proof, never invent new allocation
 * after any effect. Each row immutable; reductions must consume these exact lots. */
export async function persistSourceSellLotAllocationWithClient(client: PoolClient, execution: CopyExecutionRecord,
  masterWalletAddress: string): Promise<SourceSellLotProof | null> {
  scope(execution, masterWalletAddress);
  const exists = await client.query<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM source_sell_lot_allocations WHERE execution_id = $1) AS exists', [execution.id]);
  if (exists.rows[0]?.exists) return readSourceSellLotProofWithClient(client, execution, masterWalletAddress);
  if (!['requested','simulated'].includes(execution.state) || execution.submissionId || execution.submissionAttempts !== 0
    || compareExactDecimal(execution.confirmedBaseQuantity, '0') !== 0) throw new Error('Source sell allocation cannot be backfilled after effect');
  const attempts = await client.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM copy_execution_worker_attempts WHERE execution_id = $1)
    OR EXISTS (SELECT 1 FROM copy_execution_evidence WHERE execution_id = $1) AS exists`, [execution.id]);
  if (attempts.rows[0]?.exists !== false) throw new Error('Source sell allocation requires pristine canonical claim');
  const rows = await lockLots(client, execution, masterWalletAddress);
  const allocation = allocateExactSourceSellLots(execution.requestedBaseQuantity!, rows.map(row => ({ lotId: row.lot_id,
    availableQuantity: subtractExactDecimal(row.remaining_quantity, row.reserved_quantity) })));
  for (const [ordinal, allocated] of allocation.entries()) {
    const lot = rows.find(row => row.lot_id === allocated.lotId)!;
    if (!await hasAcceptedSourceVerificationWithClient(client, lot.source_trade_id)) throw new Error('Source sell acquisition verifier unavailable');
    await client.query(`INSERT INTO source_sell_lot_allocations
      (execution_id,lot_id,ordinal,user_id,chain,target_account,token_mint,master_wallet_address,execution_mode,
        requested_quantity,acquisition_execution_id,acquisition_evidence_id,acquisition_source_trade_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11,$12,$13)`,
    [execution.id, lot.lot_id, ordinal, execution.userId, execution.chain, execution.targetAccount, execution.tokenMint,
      masterWalletAddress, execution.executionMode, allocated.quantity, lot.acquisition_execution_id, lot.acquisition_evidence_id, lot.source_trade_id]);
  }
  return readSourceSellLotProofWithClient(client, execution, masterWalletAddress);
}

/** Fresh exact owned-lot proof. Wrong master/tenant/mode, reorged acquisition or
 * changed provenance refuses; a master aggregate can NEVER satisfy this API. */
export async function readSourceSellLotProofWithClient(client: PoolClient, execution: CopyExecutionRecord,
  masterWalletAddress: string): Promise<SourceSellLotProof | null> {
  scope(execution, masterWalletAddress);
  if (!await hasAcceptedSourceVerificationWithClient(client, execution.sourceTradeId!)) return null;
  const rows = await lockLots(client, execution, masterWalletAddress);
  const stored = await client.query<{ lot_id: string; ordinal: number; requested_quantity: string;
    acquisition_execution_id: string; acquisition_evidence_id: string; acquisition_source_trade_id: string }>(
    `SELECT lot_id,ordinal,requested_quantity::text,acquisition_execution_id,acquisition_evidence_id,acquisition_source_trade_id
      FROM source_sell_lot_allocations WHERE execution_id = $1 AND user_id IS NOT DISTINCT FROM $2
      AND chain = $3 AND target_account = $4 AND token_mint = $5 AND master_wallet_address = $6 AND execution_mode = $7
      ORDER BY ordinal FOR SHARE`, [execution.id, execution.userId, execution.chain, execution.targetAccount,
      execution.tokenMint, masterWalletAddress, execution.executionMode]);
  if (!stored.rows.length) return null;
  await client.query(`SELECT evidence.id FROM copy_position_master_lot_reductions reduction
    JOIN copy_execution_evidence evidence ON evidence.id = reduction.sell_evidence_id
    JOIN copy_position_applications application ON application.evidence_id = evidence.id
    WHERE reduction.sell_execution_id = $1 ORDER BY evidence.id FOR SHARE OF evidence,application`, [execution.id]);
  const reductions = await client.query<{ lot_id: string; quantity: string; scope_valid: boolean }>(
    `SELECT reduction.lot_id,reduction.quantity::text,
      (evidence.execution_id = $1 AND evidence.confirmation_state IN ('confirmed','finalized')
        AND evidence.base_quantity = (SELECT SUM(peer.quantity) FROM copy_position_master_lot_reductions peer
          WHERE peer.sell_execution_id = $1 AND peer.sell_evidence_id = evidence.id)
        AND application.evidence_id = evidence.id AND application.active AND application.execution_id = $1
        AND application.user_id IS NOT DISTINCT FROM $2 AND application.target_account = $3
        AND application.chain = $4 AND application.token_mint = $5
        AND position.id = application.position_id AND position.user_id IS NOT DISTINCT FROM $2
        AND position.target_account = $3 AND position.chain = $4 AND position.token_mint = $5
        AND lot.position_id = position.id AND lot.user_id IS NOT DISTINCT FROM $2
        AND lot.chain = $4 AND lot.token_mint = $5 AND lot.master_wallet_address = $6) IS TRUE AS scope_valid
      FROM copy_position_master_lot_reductions reduction
      LEFT JOIN copy_execution_evidence evidence ON evidence.id = reduction.sell_evidence_id
      LEFT JOIN copy_position_applications application ON application.evidence_id = evidence.id
      LEFT JOIN copy_position_master_lots lot ON lot.id = reduction.lot_id
      LEFT JOIN copy_positions position ON position.id = lot.position_id
      WHERE reduction.sell_execution_id = $1 ORDER BY reduction.lot_id,reduction.sell_evidence_id FOR SHARE OF reduction`,
    [execution.id, execution.userId, execution.targetAccount, execution.chain, execution.tokenMint, masterWalletAddress]);
  const consumedByLot = new Map<string, string>();
  let consumedTotal = '0';
  for (const reduction of reductions.rows) {
    if (reduction.scope_valid !== true || !stored.rows.some(allocation => allocation.lot_id === reduction.lot_id)) return null;
    exactDecimal(reduction.quantity, true);
    consumedTotal = addExactDecimal(consumedTotal, reduction.quantity);
    consumedByLot.set(reduction.lot_id, addExactDecimal(consumedByLot.get(reduction.lot_id) ?? '0', reduction.quantity));
  }
  if (compareExactDecimal(consumedTotal, exactDecimal(execution.confirmedBaseQuantity)) !== 0
    || compareExactDecimal(consumedTotal, execution.requestedBaseQuantity!) > 0) return null;
  let prefixRemaining = consumedTotal;
  let total = '0';
  const lots: SourceSellLotAllocation[] = [];
  for (const [ordinal, allocation] of stored.rows.entries()) {
    const lot = rows.find(row => row.lot_id === allocation.lot_id);
    if (!lot || allocation.ordinal !== ordinal || allocation.acquisition_execution_id !== lot.acquisition_execution_id
      || allocation.acquisition_evidence_id !== lot.acquisition_evidence_id || allocation.acquisition_source_trade_id !== lot.source_trade_id
      || lot.execution_mode !== execution.executionMode
      || !Number.isSafeInteger(lot.max_slippage_bps) || lot.max_slippage_bps < 1 || lot.max_slippage_bps > 5000
      || !await hasAcceptedSourceVerificationWithClient(client, lot.source_trade_id)) return null;
    exactDecimal(allocation.requested_quantity, true);
    const consumed = consumedByLot.get(allocation.lot_id) ?? '0';
    const expectedConsumed = minimumExactDecimal(prefixRemaining, allocation.requested_quantity);
    if (compareExactDecimal(consumed, expectedConsumed) !== 0) return null;
    prefixRemaining = subtractExactDecimal(prefixRemaining, expectedConsumed);
    const outstanding = subtractExactDecimal(allocation.requested_quantity, consumed);
    const available = subtractExactDecimal(lot.remaining_quantity, lot.reserved_quantity);
    if (!['failed','cancelled'].includes(execution.state) && compareExactDecimal(outstanding, available) > 0) return null;
    total = addExactDecimal(total, allocation.requested_quantity);
    lots.push({ lotId: lot.lot_id, quantity: allocation.requested_quantity, consumedQuantity: consumed,
      outstandingQuantity: outstanding, availableQuantity: available,
      acquisitionExecutionId: lot.acquisition_execution_id, acquisitionEvidenceId: lot.acquisition_evidence_id,
      acquisitionSourceTradeId: lot.source_trade_id, acquisitionMode: lot.execution_mode, maxSlippageBps: lot.max_slippage_bps });
  }
  if (prefixRemaining !== '0' || compareExactDecimal(total, execution.requestedBaseQuantity!) !== 0) return null;
  return { executionId: execution.id, userId: execution.userId, chain: execution.chain, targetAccount: execution.targetAccount,
    tokenMint: execution.tokenMint, masterWalletAddress, requestedQuantity: execution.requestedBaseQuantity!, lots };
}
