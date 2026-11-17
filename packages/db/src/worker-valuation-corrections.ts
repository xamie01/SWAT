import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CopyExecutionRecord } from './copy-trade-lifecycle.js';
import { hasAcceptedSourceVerificationWithClient } from './source-verification-store.js';

/** Only exact NUMERIC(38,18) text is accepted. No expected-price/float authority. */
export function workerMoney(value: string): string {
  if (typeof value !== 'string' || !/^\d{1,20}(?:\.\d{1,18})?$/.test(value)) throw new Error('Worker valuation requires exact non-negative money');
  const [whole, fraction = ''] = value.split('.');
  const normalized = `${BigInt(whole!)}.${fraction.padEnd(18, '0')}`.replace(/0+$/, '').replace(/\.$/, '');
  return normalized;
}
export function workerQuantity(value: string): string {
  if (typeof value !== 'string' || value.length > 256 || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Worker evidence requires exact non-negative quantity');
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${BigInt(whole!)}${trimmed ? `.${trimmed}` : ''}`;
}
function units(value: string): bigint {
  const [whole, fraction = ''] = workerMoney(value).split('.');
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
function identity(value: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 256) throw new Error('Invalid worker valuation identity');
  return value;
}
interface OriginalEvidence {
  id: string; execution_id: string; user_id: string | null; source_trade_id: string | null;
  evidence_type: string; evidence_id: string; base_quantity: string; quote_quantity: string | null;
  quote_native_quantity: string | null; quote_currency: string | null; quote_native_usd_price: string | null;
  price_usd: string | null; fee_usd: string | null; occurred_at: Date; completes_execution: boolean;
  confirmation_state: string; application_active: boolean;
}
/** Confirmation is mutable; all original economic/receipt fields are retained. */
export function workerOriginalEvidenceSnapshot(row: OriginalEvidence): Readonly<Record<string, unknown>> {
  const money = (v: string | null) => v === null ? null : workerMoney(v);
  return { id: row.id, executionId: row.execution_id, userId: row.user_id, sourceTradeId: row.source_trade_id,
    evidenceType: row.evidence_type, evidenceId: row.evidence_id, baseQuantity: workerQuantity(row.base_quantity),
    quoteQuantity: money(row.quote_quantity), quoteNativeQuantity: row.quote_native_quantity === null ? null : workerQuantity(row.quote_native_quantity),
    quoteCurrency: row.quote_currency, quoteNativeUsdPrice: money(row.quote_native_usd_price),
    priceUsd: money(row.price_usd), feeUsd: money(row.fee_usd), occurredAt: row.occurred_at.toISOString(),
    completesExecution: row.completes_execution };
}
export function workerOriginalEvidenceDigest(snapshot: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
export interface WorkerValuationCorrectionInput {
  readonly execution: CopyExecutionRecord;
  readonly originalEvidenceId: string;
  readonly correctionId: string;
  /** Persisted protected trusted valuation, NOT a caller-supplied price/verifier label. */
  readonly valuationId: string;
  readonly previousCorrectionId: string | null;
  readonly now: Date;
}
export interface WorkerFinancialTotals {
  base: string; quote: string | null; debit: string | null; fee: string | null;
  unknown: string; quoteUnknown: string; completes: boolean; evidenceCount: string;
}
export async function readWorkerFinancialTotalsWithClient(client: PoolClient, executionId: string): Promise<WorkerFinancialTotals> {
  const result = await client.query<WorkerFinancialTotals & { invalidCorrections: string }>(`SELECT COALESCE(SUM(base_quantity),0)::text AS base,
    SUM(effective_quote_usd)::text AS quote,
    SUM(COALESCE(effective_quote_usd,0) + COALESCE(effective_fee_usd,0))::text AS debit,
    SUM(effective_fee_usd)::text AS fee,
    COUNT(*) FILTER (WHERE effective_quote_usd IS NULL OR effective_fee_usd IS NULL)::text AS unknown,
    COUNT(*) FILTER (WHERE effective_quote_usd IS NULL)::text AS "quoteUnknown",
    COALESCE(BOOL_OR(completes_execution),false) AS completes, COUNT(*)::text AS "evidenceCount",
    COUNT(*) FILTER (WHERE valuation_correction_id IS NOT NULL
      AND NOT worker_correction_authorized(valuation_correction_id))::text AS "invalidCorrections"
    FROM worker_effective_execution_evidence WHERE execution_id = $1 AND confirmation_state IN ('confirmed','finalized')`, [executionId]);
  const row = result.rows[0];
  if (!row) throw new Error('Worker financial totals unavailable');
  if (row.invalidCorrections !== '0') throw new Error('Effective correction authorization unavailable or reversed');
  workerQuantity(row.base);
  for (const value of [row.quote, row.debit, row.fee]) if (value !== null) workerMoney(value);
  for (const count of [row.unknown, row.quoteUnknown, row.evidenceCount]) if (!/^\d+$/.test(count)) throw new Error('Worker accounting coverage unavailable');
  return row;
}
/** Caller holds canonical position/execution locks and receipt ownership on THIS client. */
export async function appendWorkerValuationCorrectionWithClient(client: PoolClient, input: WorkerValuationCorrectionInput): Promise<{ replayed: boolean; correctionId: string }> {
  identity(input.originalEvidenceId); identity(input.correctionId); identity(input.valuationId);
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw new Error('Invalid correction time');
  const execution = input.execution;
  const original = (await client.query<OriginalEvidence>(`SELECT evidence.id, evidence.execution_id, execution.user_id,
    execution.source_trade_id, evidence.evidence_type, evidence.evidence_id, evidence.base_quantity::text,
    evidence.quote_quantity::text, evidence.quote_native_quantity::text, evidence.quote_currency,
    evidence.quote_native_usd_price::text, evidence.price_usd::text, evidence.fee_usd::text,
    evidence.occurred_at, evidence.completes_execution, evidence.confirmation_state,
    application.active AS application_active
    FROM copy_execution_evidence evidence JOIN copy_executions execution ON execution.id = evidence.execution_id
    JOIN copy_position_applications application ON application.evidence_id = evidence.id AND application.execution_id = execution.id
      AND application.user_id IS NOT DISTINCT FROM execution.user_id AND application.target_account = execution.target_account
      AND application.chain = execution.chain AND application.token_mint = execution.token_mint
    WHERE evidence.id = $1 AND execution.id = $2 AND execution.user_id IS NOT DISTINCT FROM $3
      AND execution.chain = $4 AND execution.target_account = $5 AND execution.token_mint = $6
      AND execution.execution_mode = $7 FOR SHARE OF evidence, application`, [input.originalEvidenceId, execution.id,
      execution.userId, execution.chain, execution.targetAccount, execution.tokenMint, execution.executionMode])).rows[0];
  if (!original || original.execution_id !== execution.id || original.user_id !== execution.userId
      || !original.application_active || !['confirmed','finalized'].includes(original.confirmation_state)
      || original.source_trade_id !== execution.sourceTradeId) throw new Error('Correction immutable original/tenant/applied source unavailable');
  const lineage = (await client.query<{ source_trade_id: string; acquisition_evidence_id: string | null; master_wallet_address: string }>(
    `SELECT source_trade_id, acquisition_evidence_id, master_wallet_address FROM worker_correction_lineage($1,$2)`,
    [execution.id, original.id])).rows[0];
  if (!lineage) throw new Error('Correction exact source/acquisition lineage unavailable');
  const snapshot = workerOriginalEvidenceSnapshot(original), digest = workerOriginalEvidenceDigest(snapshot);
  // Exact replay uses durable admission proof. Expiry is not retroactive;
  // explicit revocation/reversal still refuses accounting via history predicate.
  const existing = (await client.query<{ valuation_id: string; original_evidence_id: string; original_digest: string;
    previous_correction_id: string | null; accepted: boolean }>(`SELECT valuation_id, original_evidence_id, original_digest, previous_correction_id,
      worker_correction_authorized(correction_id) AS accepted
      FROM copy_execution_valuation_corrections WHERE correction_id = $1 FOR SHARE`, [input.correctionId])).rows[0];
  if (existing) {
    if (existing.valuation_id !== input.valuationId || existing.original_evidence_id !== original.id
        || existing.original_digest !== digest || existing.previous_correction_id !== input.previousCorrectionId) throw new Error('Correction idempotency identity conflict');
    if (!existing.accepted) throw new Error('Historical correction explicitly invalidated');
    return { replayed: true, correctionId: input.correctionId };
  }
  if (!await hasAcceptedSourceVerificationWithClient(client, lineage.source_trade_id, input.now)) throw new Error('Correction source verification authorization unavailable or reversed');
  const trusted = (await client.query<{ valuation_id: string; revision: string; quote_usd: string | null; fee_usd: string | null;
    original_digest: string; original_evidence_id: string; execution_id: string; user_id: string | null; authorized: boolean;
    max_quote_usd: string; max_fee_usd: string }>(`SELECT valuation.valuation_id, valuation.revision::text,
      valuation.quote_usd::text, valuation.fee_usd::text, valuation.original_digest, valuation.original_evidence_id,
      valuation.execution_id, valuation.user_id, authority.max_quote_usd::text, authority.max_fee_usd::text,
      (authority.enabled AND authority.valid_until > $4 AND valuation.valid_until > $4
        AND valuation.valid_until <= authority.valid_until AND authority.user_id IS NOT DISTINCT FROM valuation.user_id
        AND authority.chain = $5 AND authority.network = binding.network
        AND authority.provider_id = valuation.provider_id AND authority.identity_digest = valuation.provider_identity_digest
        AND authority.verifier_version = valuation.verifier_version AND valuation.source_evidence_id = head.evidence_id
        AND valuation.lineage_source_trade_id = $6
        AND valuation.lineage_acquisition_evidence_id IS NOT DISTINCT FROM $7::uuid
        AND valuation.lineage_master_wallet_address = $8) AS authorized
      FROM trusted_worker_valuations valuation JOIN worker_valuation_authorities authority ON authority.authority_id = valuation.authority_id
      JOIN source_verification_bindings binding ON binding.source_trade_id = $6
      JOIN source_verification_heads head ON head.source_trade_id = binding.source_trade_id
      WHERE valuation.valuation_id = $1 AND valuation.original_evidence_id = $2 AND valuation.execution_id = $3
      FOR SHARE OF valuation, authority, binding, head`, [input.valuationId, original.id, execution.id, input.now, execution.chain,
        lineage.source_trade_id,lineage.acquisition_evidence_id,lineage.master_wallet_address])).rows[0];
  if (!trusted || trusted.authorized !== true || trusted.user_id !== execution.userId || trusted.execution_id !== execution.id
      || trusted.original_evidence_id !== original.id || trusted.original_digest !== digest) throw new Error('Persisted independent trusted valuation authorization unavailable');
  if (!/^[1-9]\d{0,37}$/.test(trusted.revision) || trusted.quote_usd === null && trusted.fee_usd === null) throw new Error('Empty or unsupported correction revision');
  if (trusted.quote_usd !== null && units(trusted.quote_usd) > units(trusted.max_quote_usd)
      || trusted.fee_usd !== null && units(trusted.fee_usd) > units(trusted.max_fee_usd)) throw new Error('Trusted valuation exceeds approved money clamp');
  const previous = (await client.query<{ correction_id: string; revision: string; effective_quote_usd: string | null;
    effective_fee_usd: string | null; quote_origin_valuation_id: string | null; fee_origin_valuation_id: string | null;
    accepted: boolean }>(`SELECT correction_id, revision::text, effective_quote_usd::text, effective_fee_usd::text,
      quote_origin_valuation_id,fee_origin_valuation_id,worker_correction_authorized(correction_id) AS accepted
      FROM copy_execution_valuation_corrections WHERE original_evidence_id = $1 ORDER BY revision DESC LIMIT 1 FOR SHARE`, [original.id])).rows[0];
  if (previous && !previous.accepted) throw new Error('Correction carried field history invalidated');
  if ((previous?.correction_id ?? null) !== input.previousCorrectionId || previous && BigInt(trusted.revision) <= BigInt(previous.revision)) throw new Error('Correction stale/conflicting predecessor or revision');
  const quote = trusted.quote_usd === null ? previous ? previous.effective_quote_usd : original.quote_quantity : workerMoney(trusted.quote_usd);
  const fee = trusted.fee_usd === null ? previous ? previous.effective_fee_usd : original.fee_usd : workerMoney(trusted.fee_usd);
  const inserted = await client.query(`INSERT INTO copy_execution_valuation_corrections
    (correction_id, valuation_id, original_evidence_id, execution_id, user_id, original_digest, original_snapshot,
      revision, previous_correction_id, effective_quote_usd, effective_fee_usd, recorded_at,
      lineage_source_trade_id,lineage_acquisition_evidence_id,lineage_master_wallet_address,
      quote_origin_valuation_id,fee_origin_valuation_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::numeric,$9,$10::numeric,$11::numeric,$12,$13,$14,$15,$16,$17) RETURNING correction_id`,
  [input.correctionId,input.valuationId,original.id,execution.id,execution.userId,digest,JSON.stringify(snapshot),trusted.revision,
    input.previousCorrectionId,quote,fee,input.now,lineage.source_trade_id,lineage.acquisition_evidence_id,lineage.master_wallet_address,
    trusted.quote_usd !== null ? input.valuationId : previous?.quote_origin_valuation_id ?? null,
    trusted.fee_usd !== null ? input.valuationId : previous?.fee_origin_valuation_id ?? null]);
  if (inserted.rows.length !== 1) throw new Error('Correction ledger write unavailable');
  return { replayed: false, correctionId: input.correctionId };
}

/** Exact cumulative re-projection, never reapply inventory or mutate original fills.
 * Cohort row must already exist; the caller serializes it before original insertion. */
export async function projectWorkerEconomicsWithClient(client: PoolClient, execution: CopyExecutionRecord): Promise<void> {
  // Every correction in the position/cohort scope must still have accepted
  // persisted provenance before any economic projection can change.
  const guarded = await client.query<{ authorized: boolean }>(`SELECT NOT EXISTS (
    SELECT 1 FROM worker_effective_execution_evidence evidence JOIN copy_executions affected ON affected.id = evidence.execution_id
    WHERE evidence.valuation_correction_id IS NOT NULL AND evidence.confirmation_state IN ('confirmed','finalized')
      AND ((affected.target_account = $1 AND affected.chain = $2 AND affected.token_mint = $3
        AND affected.user_id IS NOT DISTINCT FROM $4) OR (affected.source_trade_id = $5 AND affected.execution_mode = $6))
      AND NOT worker_correction_authorized(evidence.valuation_correction_id)) AS authorized`,
  [execution.targetAccount,execution.chain,execution.tokenMint,execution.userId,execution.sourceTradeId,execution.executionMode]);
  if (guarded.rows[0]?.authorized !== true) throw new Error('Economic projection correction authorization unavailable');
  const economics = await client.query(`UPDATE copy_executions execution SET
    confirmed_quote_quantity = totals.quote, quote_unassessed_fill_count = totals.unknown
    FROM (SELECT SUM(effective_quote_usd) AS quote, COUNT(*) FILTER (WHERE effective_quote_usd IS NULL) AS unknown
      FROM worker_effective_execution_evidence WHERE execution_id = $1 AND confirmation_state IN ('confirmed','finalized')) totals
    WHERE execution.id = $1 AND execution.user_id IS NOT DISTINCT FROM $2 RETURNING execution.id`, [execution.id,execution.userId]);
  if (economics.rows.length !== 1) throw new Error('Canonical execution economics projection unavailable');
  if (execution.sourceTradeId) {
    const capacity = await client.query(`UPDATE master_capacity_ledger ledger SET
      notional_usd = totals.quote, notional_basis = CASE WHEN totals.quote IS NULL THEN 'unpriced' ELSE 'marked-to-price' END,
      unassessed_fill_count = totals.unknown
      FROM (SELECT SUM(evidence.effective_quote_usd) AS quote,
        COUNT(*) FILTER (WHERE evidence.effective_quote_usd IS NULL) AS unknown
        FROM worker_effective_execution_evidence evidence JOIN copy_executions execution ON execution.id = evidence.execution_id
        WHERE execution.source_trade_id = $1 AND execution.execution_mode = $2
          AND evidence.confirmation_state IN ('confirmed','finalized')) totals
      WHERE ledger.source_trade_id = $1 AND ledger.execution_mode = $2 RETURNING ledger.source_trade_id`, [execution.sourceTradeId, execution.executionMode]);
    if (capacity.rows.length !== 1) throw new Error('Capacity accounting cohort missing');
  }
  // Economics-only replay over EXISTING applications; no quantity/application writes.
  const projected = await client.query(`WITH RECURSIVE ordered AS (
    SELECT ROW_NUMBER() OVER (ORDER BY evidence.occurred_at,evidence.id)::bigint AS sequence,
      execution.direction, evidence.base_quantity, evidence.effective_quote_usd + evidence.effective_fee_usd AS cost
    FROM copy_position_applications application JOIN worker_effective_execution_evidence evidence ON evidence.id = application.evidence_id
    JOIN copy_executions execution ON execution.id = application.execution_id
    WHERE application.target_account = $1 AND application.chain = $2 AND application.token_mint = $3
      AND application.user_id IS NOT DISTINCT FROM $4 AND execution.user_id IS NOT DISTINCT FROM application.user_id
      AND application.active AND evidence.confirmation_state IN ('confirmed','finalized')
  ), ledger AS (
    SELECT 0::bigint AS sequence, opening_quantity AS quantity, opening_cost_basis_usd AS basis, 0::bigint AS unknown
    FROM copy_positions WHERE target_account = $1 AND chain = $2 AND token_mint = $3 AND user_id IS NOT DISTINCT FROM $4
    UNION ALL SELECT event.sequence,
      CASE WHEN event.direction = 'buy' THEN ledger.quantity + event.base_quantity ELSE GREATEST(0,ledger.quantity-event.base_quantity) END,
      CASE WHEN event.direction = 'buy' THEN ledger.basis + COALESCE(event.cost,0)
        WHEN ledger.quantity = 0 THEN 0 ELSE GREATEST(0,ledger.basis - ledger.basis * LEAST(ledger.quantity,event.base_quantity)/ledger.quantity) END,
      ledger.unknown + CASE WHEN event.direction = 'buy' AND event.cost IS NULL THEN 1 ELSE 0 END
    FROM ledger JOIN ordered event ON event.sequence = ledger.sequence+1
  ), final AS (SELECT * FROM ledger ORDER BY sequence DESC LIMIT 1)
  UPDATE copy_positions position SET cost_basis_usd = final.basis, cost_basis_unvalued_fill_count = final.unknown
    FROM final WHERE position.target_account = $1 AND position.chain = $2 AND position.token_mint = $3
      AND position.user_id IS NOT DISTINCT FROM $4 RETURNING position.id`, [execution.targetAccount,execution.chain,execution.tokenMint,execution.userId]);
  if (projected.rows.length !== 1) throw new Error('Worker economic position projection unavailable');
  await client.query(`UPDATE copy_position_master_lots lot SET
    acquired_cost_basis_usd = evidence.effective_quote_usd + evidence.effective_fee_usd,
    remaining_cost_basis_usd = CASE WHEN lot.acquired_quantity = 0 THEN 0 ELSE
      (evidence.effective_quote_usd + evidence.effective_fee_usd) * lot.remaining_quantity / lot.acquired_quantity END
    FROM worker_effective_execution_evidence evidence WHERE lot.acquisition_evidence_id = evidence.id
      AND lot.acquisition_execution_id = evidence.execution_id AND lot.user_id IS NOT DISTINCT FROM $4
      AND lot.chain = $2 AND lot.token_mint = $3 AND evidence.confirmation_state IN ('confirmed','finalized')
      AND EXISTS (SELECT 1 FROM copy_positions position WHERE position.id = lot.position_id AND position.target_account = $1
        AND position.user_id IS NOT DISTINCT FROM lot.user_id)`, [execution.targetAccount,execution.chain,execution.tokenMint,execution.userId]);
}
