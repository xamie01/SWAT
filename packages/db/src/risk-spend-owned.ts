import type { PoolClient } from 'pg';
import type { Chain } from '@swat/shared';

export interface RiskSpendScope {
  account: string;
  chain: Chain;
  executionMode: 'paper' | 'live' | 'shadow';
  executionId: string;
  /** Durable current policy epoch from the authorized writer, never an env flag. */
  policyEpoch: string;
}

export interface RiskSpendReservationInput extends RiskSpendScope {
  /** Conservative priced maximum debit, including fees. Exact USD decimal text. */
  requestedUsd: string;
}

export type RiskSpendState = 'reserved' | 'submitted' | 'unknown' | 'partial' | 'confirmed' | 'released';
interface RiskSpendRow {
  execution_id: string;
  requested_usd: string;
  confirmed_usd: string;
  liability_usd: string;
  policy_epoch: string;
  state: RiskSpendState;
  valuation_correction_id?: string | null;
}
export interface RiskSpendReservation {
  executionId: string;
  state: RiskSpendState;
  liabilityUsd: string;
  confirmedUsd: string;
}

// Bounded exact money arithmetic. NUMERIC(38,18) in the unapplied schema;
// accepting exponents/float coercion here would under-reserve real obligations.
function riskUsd(value: string, positive = false): bigint {
  if (typeof value !== 'string' || !/^\d{1,20}(?:\.\d{1,18})?$/.test(value)) {
    throw new Error('Risk reservation requires exact non-negative USD decimal text');
  }
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (positive && units === 0n) throw new Error('Risk reservation USD must be positive');
  return units;
}
function riskUsdText(value: bigint): string {
  const text = value.toString().padStart(19, '0');
  return `${text.slice(0, -18)}.${text.slice(-18)}`.replace(/0+$/, '').replace(/\.$/, '');
}
function assertRiskSpendScope(scope: RiskSpendScope): void {
  if (typeof scope.account !== 'string' || !scope.account.trim() || scope.account.length > 128) {
    throw new Error('Risk reservation account is required');
  }
  if (!['paper', 'live', 'shadow'].includes(scope.executionMode)) throw new Error('Invalid risk reservation mode');
  if (typeof scope.executionId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scope.executionId)) {
    throw new Error('Risk reservation requires a canonical execution UUID');
  }
  if (typeof scope.policyEpoch !== 'string' || !/^[1-9]\d{0,18}$/.test(scope.policyEpoch)) {
    throw new Error('Risk reservation requires a durable policy epoch');
  }
}
const RISK_SPEND_ROWS_SQL = `SELECT execution_id::text, requested_usd::text,
       confirmed_usd::text, liability_usd::text, policy_epoch::text, state, valuation_correction_id
  FROM risk_spend_reservations
 WHERE account = $1 AND chain = $2 AND execution_mode = $3
   AND (state NOT IN ('confirmed', 'released') OR settled_at >= NOW() - INTERVAL '24 hours'
        OR execution_id = $4::uuid)
 FOR UPDATE`;
function riskSpendResult(row: RiskSpendRow): RiskSpendReservation {
  riskUsd(row.liability_usd); riskUsd(row.confirmed_usd);
  return { executionId: row.execution_id, state: row.state,
    liabilityUsd: row.liability_usd, confirmedUsd: row.confirmed_usd };
}

/** Caller owns BEGIN/tenant scope/claim/outbox/COMMIT. Missing schema or policy
 * fails closed; this helper cannot confer permission to sign or submit. The
 * policy row serializes ALL admissions/settlements/stops for this scope. */
export async function reserveRiskSpend(client: PoolClient, input: RiskSpendReservationInput): Promise<RiskSpendReservation> {
  assertRiskSpendScope(input);
  const requested = riskUsd(input.requestedUsd, true);
  const control = await client.query<{ epoch: string; enabled: boolean; cap_usd: string; accounting_ready: boolean }>(
    `SELECT epoch::text, enabled, cap_usd::text, accounting_ready FROM risk_policy_control
      WHERE account = $1 AND chain = $2 AND execution_mode = $3 FOR UPDATE`,
    [input.account, input.chain, input.executionMode]
  );
  const policy = control.rows[0];
  if (!policy || policy.accounting_ready !== true) throw new Error('Risk policy/accounting unavailable');
  if (policy.enabled !== true) throw new Error('Risk policy is stopped');
  if (policy.epoch !== input.policyEpoch) throw new Error('Stale risk policy epoch');
  const cap = riskUsd(policy.cap_usd, true);
  const result = await client.query<RiskSpendRow>(RISK_SPEND_ROWS_SQL,
    [input.account, input.chain, input.executionMode, input.executionId]);
  const existing = result.rows.find(row => row.execution_id === input.executionId);
  if (existing) {
    if (riskUsd(existing.requested_usd) !== requested || existing.policy_epoch !== input.policyEpoch) {
      throw new Error('Risk reservation immutable terms mismatch');
    }
    if (existing.state !== 'reserved') throw new Error('Risk reservation already submitted or terminal; reconcile without new effect');
    return riskSpendResult(existing);
  }
  const used = result.rows.reduce((sum, row) => sum + riskUsd(row.liability_usd), 0n);
  if (used + requested > cap) throw new Error('Risk spending cap reached');
  const inserted = await client.query<RiskSpendRow>(
    `INSERT INTO risk_spend_reservations
      (account, chain, execution_mode, execution_id, requested_usd, policy_epoch, liability_usd)
     VALUES ($1, $2, $3, $4::uuid, $5::numeric, $6::bigint, $5::numeric)
     RETURNING execution_id::text, state, liability_usd::text, confirmed_usd::text`,
    [input.account, input.chain, input.executionMode, input.executionId, input.requestedUsd, input.policyEpoch]
  );
  if (!inserted.rows[0]) throw new Error('Risk reservation was not persisted');
  return riskSpendResult(inserted.rows[0]);
}

/** Must be called with canonical evidence inserted/deduped and cumulative USD
 * derived inside this SAME transaction. No per-fill arithmetic or stop/TTL
 * release. Unknown pricing/submission retains at least the full requested debit.
 * Proven on-chain terminal failures need an integrator-owned receipt contract;
 * this narrow helper only releases orders known never to have been submitted. */
export async function updateRiskSpendReservation(client: PoolClient, input: RiskSpendScope & {
  state: RiskSpendState;
  confirmedUsd: string | null;
  provenNotSubmitted?: boolean;
  /** Persisted correction ledger identity; cannot be a caller-authorized amount. */
  valuationCorrectionId?: string;
}): Promise<RiskSpendReservation> {
  assertRiskSpendScope(input);
  if (!['reserved', 'submitted', 'unknown', 'partial', 'confirmed', 'released'].includes(input.state)) {
    throw new Error('Invalid risk reservation state');
  }
  await client.query(`SELECT epoch FROM risk_policy_control
    WHERE account = $1 AND chain = $2 AND execution_mode = $3 FOR UPDATE`,
  [input.account, input.chain, input.executionMode]);
  const result = await client.query<RiskSpendRow>(RISK_SPEND_ROWS_SQL,
    [input.account, input.chain, input.executionMode, input.executionId]);
  const row = result.rows.find(row => row.execution_id === input.executionId);
  if (!row || row.policy_epoch !== input.policyEpoch) throw new Error('Risk reservation identity/epoch missing');
  const canonical = await client.query<{
    state: string; submission_id: string | null; confirmed_usd: string | null;
    unvalued_count: string; completes_execution: boolean;
  }>(`SELECT execution.state, execution.submission_id,
      (SELECT SUM(COALESCE(evidence.effective_quote_usd,0) + COALESCE(evidence.effective_fee_usd,0))::text FROM worker_effective_execution_evidence evidence
       WHERE evidence.execution_id = execution.id AND evidence.confirmation_state IN ('confirmed','finalized')) AS confirmed_usd,
      (SELECT COUNT(*)::text FROM worker_effective_execution_evidence evidence WHERE evidence.execution_id = execution.id
       AND evidence.confirmation_state IN ('confirmed','finalized') AND (evidence.effective_quote_usd IS NULL OR evidence.effective_fee_usd IS NULL)) AS unvalued_count,
      EXISTS (SELECT 1 FROM copy_execution_evidence evidence WHERE evidence.execution_id = execution.id
       AND evidence.confirmation_state IN ('confirmed','finalized') AND evidence.completes_execution) AS completes_execution
     FROM copy_executions execution WHERE execution.id = $4::uuid AND execution.chain = $2
       AND execution.execution_mode = $3 AND execution.direction = 'buy'
       AND COALESCE(execution.user_id::text, 'operator') = $1 FOR UPDATE OF execution`,
    [input.account, input.chain, input.executionMode, input.executionId]);
  const evidence = canonical.rows[0];
  if (!evidence) throw new Error('Canonical risk execution ownership/evidence unavailable');
  const previous = riskUsd(row.confirmed_usd);
  const confirmed = input.confirmedUsd === null ? previous : riskUsd(input.confirmedUsd);
  let correctionAuthorized = false;
  if (input.valuationCorrectionId) {
    const authorization = await client.query<{ authorized: boolean }>(`SELECT worker_correction_authorized(correction.correction_id) AS authorized
      FROM copy_execution_valuation_corrections correction
      JOIN copy_executions execution ON execution.id = correction.execution_id
      WHERE correction.correction_id = $5 AND execution.id = $4::uuid
        AND COALESCE(execution.user_id::text,'operator') = $1 AND execution.chain = $2 AND execution.execution_mode = $3
        AND correction.user_id IS NOT DISTINCT FROM execution.user_id FOR SHARE OF correction`,
    [input.account,input.chain,input.executionMode,input.executionId,input.valuationCorrectionId]);
    correctionAuthorized = authorization.rows[0]?.authorized === true;
    if (!correctionAuthorized) throw new Error('Risk correction authorization unavailable');
  }
  if (confirmed < previous && !correctionAuthorized) throw new Error('Risk cumulative evidence reversal refused');
  if (input.confirmedUsd !== null && (evidence.confirmed_usd === null
      ? confirmed !== 0n : riskUsd(evidence.confirmed_usd) !== confirmed)) {
    throw new Error('Risk USD does not match canonical cumulative evidence');
  }
  if (input.state === 'confirmed' && (evidence.state !== 'confirmed'
      || evidence.completes_execution !== true || evidence.unvalued_count !== '0')) {
    throw new Error('Canonical terminal risk evidence is incomplete/unvalued');
  }
  if (correctionAuthorized && row.valuation_correction_id === input.valuationCorrectionId
      && row.state === input.state && confirmed === previous) return riskSpendResult(row);
  if ((row.state === 'confirmed' || row.state === 'released') && !correctionAuthorized) {
    if (row.state !== input.state || confirmed !== previous) throw new Error('Risk terminal evidence is immutable');
    return riskSpendResult(row);
  }
  if (correctionAuthorized && (row.state === 'released' || !['unknown','partial','confirmed'].includes(input.state))) {
    throw new Error('Correction cannot release or recreate an execution liability');
  }
  if (input.state === 'reserved' && row.state !== 'reserved') throw new Error('Submitted liability cannot return to reserved');
  if (input.state === 'released' && (input.provenNotSubmitted !== true || row.state !== 'reserved'
      || confirmed !== 0n || evidence.submission_id !== null || !['requested', 'simulated', 'failed', 'cancelled'].includes(evidence.state))) {
    throw new Error('Cannot release submitted/unknown liability as a non-submission');
  }
  if (input.state === 'confirmed' && input.confirmedUsd === null) throw new Error('Confirmed USD pricing is unknown');
  const requested = riskUsd(row.requested_usd, true);
  const liability = input.state === 'released' ? 0n : input.state === 'confirmed'
    ? confirmed : [requested, riskUsd(row.liability_usd), confirmed].reduce((max, n) => n > max ? n : max);
  const updated = await client.query<RiskSpendRow>(
    `UPDATE risk_spend_reservations SET state = $5, confirmed_usd = $6::numeric,
       liability_usd = $7::numeric, settled_at = CASE WHEN $5 IN ('confirmed','released') THEN NOW() ELSE NULL END,
       valuation_correction_id = COALESCE($8,valuation_correction_id)
     WHERE account = $1 AND chain = $2 AND execution_mode = $3 AND execution_id = $4::uuid
     RETURNING execution_id::text, state, liability_usd::text, confirmed_usd::text`,
    [input.account, input.chain, input.executionMode, input.executionId, input.state, riskUsdText(confirmed), riskUsdText(liability), input.valuationCorrectionId ?? null]
  );
  if (!updated.rows[0]) throw new Error('Risk reservation update was not persisted');
  return riskSpendResult(updated.rows[0]);
}
