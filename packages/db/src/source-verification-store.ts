import type { PoolClient } from 'pg';
import { canonicalSourceBinding, exactSourceDecimal, sourceBindingDigest, sourceTokenQuantity,
  verifyBoundSourceEvidence, type SourceVerificationBinding, type SourceVerificationEvidence,
  type TrustedSourceVerifier } from './source-verification.js';

export interface SourceVerificationApplicationResult {
  readonly sourceTradeId: string;
  readonly confirmationState: 'observed' | 'confirmed' | 'finalized' | 'reversed';
  readonly evidenceId: string;
  readonly applied: boolean;
  readonly replayed: boolean;
}
/** Observation binding is immutable and only attached at new-source intake.
 * No inferred/backfilled network/scale authority for inherited source rows. */
export async function bindSourceObservationWithClient(client: PoolClient, sourceTradeId: string,
  input: SourceVerificationBinding, newlyInserted: boolean): Promise<void> {
  const binding = canonicalSourceBinding(input);
  const digest = sourceBindingDigest(binding);
  if (newlyInserted) await client.query(
    `INSERT INTO source_verification_bindings (source_trade_id, binding, binding_digest, network, raw_quantity, quantity_scale)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6) ON CONFLICT (source_trade_id) DO NOTHING`,
    [sourceTradeId, JSON.stringify(binding), digest, binding.network, binding.rawQuantity, binding.quantityScale]);
  const existing = (await client.query<{ binding_digest: string }>(
    `SELECT binding_digest FROM source_verification_bindings WHERE source_trade_id = $1 FOR SHARE`, [sourceTradeId])).rows[0];
  if (!existing || existing.binding_digest !== digest) throw new Error('Source observation network/raw-scale identity collision or missing immutable binding');
}

/** Internal fixed-alias SQL, shared by locked checks and candidate selection.
 * Never interpolate caller identifiers or values into this predicate. */
export const ACCEPTED_SOURCE_VERIFICATION_JOINS_SQL = `
  JOIN source_verification_bindings binding ON binding.source_trade_id = source.id
  JOIN source_verification_heads head ON head.source_trade_id = source.id
  JOIN source_verified_evidence evidence ON evidence.evidence_id = head.evidence_id
  JOIN source_provider_authorities authority ON authority.authority_id = evidence.authority_id
  JOIN source_position_applications application ON application.source_trade_id = source.id`;
export const ACCEPTED_SOURCE_VERIFICATION_PREDICATE_SQL = `
  source.confirmation_state IN ('confirmed', 'finalized')
  AND head.confirmation_state = source.confirmation_state
  AND evidence.source_trade_id = source.id AND evidence.binding_digest = binding.binding_digest
  AND evidence.finality = source.confirmation_state AND application.active
  AND application.wallet_address = source.wallet_address AND application.chain = source.chain
  AND application.token_mint = source.token_mint
  AND authority.enabled AND authority.provider_id = evidence.provider_id
  AND authority.identity_digest = evidence.provider_identity_digest
  AND authority.chain = source.chain AND authority.network = binding.network
  AND authority.verifier_version = evidence.verifier_version
  AND authority.valid_until > $2 AND evidence.provider_valid_until > $2`;

/** Predicate shared by candidates, signal insertion, new execution and replay.
 * Stored labels alone cannot satisfy it; revoked/expired authorities cannot
 * authorize fresh claims. This reads durable authority, never caller flags. */
export async function hasAcceptedSourceVerificationWithClient(client: PoolClient, sourceTradeId: string,
  now = new Date()): Promise<boolean> {
  const result = await client.query<{ accepted: boolean }>(
    `SELECT true AS accepted FROM source_trades source
       ${ACCEPTED_SOURCE_VERIFICATION_JOINS_SQL}
       WHERE source.id = $1 AND ${ACCEPTED_SOURCE_VERIFICATION_PREDICATE_SQL}
       FOR SHARE OF source, binding, head, evidence, authority, application`, [sourceTradeId, now]);
  return result.rows[0]?.accepted === true;
}

/** No transaction ownership: verifier authority/evidence/history/head/projection
 * commit or rollback together in the caller's trusted transaction. */
export async function applyVerifiedSourceEvidenceWithClient(client: PoolClient, input: {
  sourceTradeId: string; evidence: SourceVerificationEvidence; verifier: TrustedSourceVerifier; now?: Date;
}): Promise<SourceVerificationApplicationResult> {
  const now = input.now ?? new Date();
  const discovered = (await client.query<{ wallet_address: string; chain: string; token_mint: string }>(
    `SELECT wallet_address, chain, token_mint FROM source_trades WHERE id = $1`, [input.sourceTradeId])).rows[0];
  if (!discovered) throw new Error('Source event is unavailable');
  // Same position -> source order for every verification/recovery operation.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [JSON.stringify(['source-verification', discovered.wallet_address, discovered.chain, discovered.token_mint])]);
  const source = (await client.query<{ wallet_address: string; chain: string; token_mint: string;
    direction: string; transaction_hash: string; source_event_type: string; source_event_id: string;
    source_event_index: string; token_amount: string; amount_usd: string | null; price_usd: string | null;
    fee_usd: string | null; event_at: Date; confirmation_state: SourceVerificationApplicationResult['confirmationState'] }>(
    `SELECT wallet_address, chain, token_mint, direction, transaction_hash, source_event_type,
       source_event_id, source_event_index, token_amount::text, amount_usd::text, price_usd::text,
       fee_usd::text, event_at, confirmation_state FROM source_trades WHERE id = $1 FOR UPDATE`, [input.sourceTradeId])).rows[0];
  if (!source || source.wallet_address !== discovered.wallet_address || source.chain !== discovered.chain
      || source.token_mint !== discovered.token_mint) throw new Error('Source event immutable scope changed');
  const stored = (await client.query<{ binding: SourceVerificationBinding; binding_digest: string }>(
    `SELECT binding, binding_digest FROM source_verification_bindings WHERE source_trade_id = $1 FOR SHARE`,
    [input.sourceTradeId])).rows[0];
  if (!stored || sourceBindingDigest(stored.binding) !== stored.binding_digest) throw new Error('Source immutable verification binding is unavailable');
  const binding = canonicalSourceBinding(stored.binding);
  if (binding.chain !== source.chain || binding.walletAddress !== source.wallet_address || binding.tokenMint !== source.token_mint
      || binding.side !== source.direction || binding.transactionHash !== source.transaction_hash
      || binding.sourceEventType !== source.source_event_type || binding.sourceEventId !== source.source_event_id
      || binding.sourceEventIndex !== source.source_event_index || binding.eventAt !== source.event_at.toISOString()
      || sourceTokenQuantity(binding.rawQuantity, binding.quantityScale) !== exactSourceDecimal(source.token_amount)
      || binding.amountUsd !== exactSourceDecimal(source.amount_usd) || binding.priceUsd !== exactSourceDecimal(source.price_usd)
      || binding.feeUsd !== exactSourceDecimal(source.fee_usd)) throw new Error('Stored source binding differs from immutable source payload');
  const verified = await verifyBoundSourceEvidence({ expected: binding, evidence: input.evidence, verifier: input.verifier, now });
  const { evidence, provider, evidenceDigest } = verified;
  const authority = (await client.query<{ identity_digest: string; provider_id: string; chain: string;
    network: string; verifier_version: string; valid_until: Date; enabled: boolean }>(
    `SELECT identity_digest, provider_id, chain, network, verifier_version, valid_until, enabled
     FROM source_provider_authorities WHERE authority_id = $1 FOR SHARE`, [provider.authorityId])).rows[0];
  if (!authority || !authority.enabled || authority.identity_digest !== provider.identityDigest
      || authority.provider_id !== provider.providerId || authority.chain !== provider.chain || authority.network !== provider.network
      || authority.verifier_version !== provider.verifierVersion || authority.valid_until.getTime() <= now.getTime()
      || Date.parse(provider.validUntil) > authority.valid_until.getTime()) throw new Error('Approved source provider authority is unavailable or mismatched');
  const inserted = await client.query(
    `INSERT INTO source_verified_evidence (evidence_id, source_trade_id, binding_digest, evidence_digest,
       provider_id, authority_id, provider_identity_digest, provider_valid_until, verifier_version,
       finality, revision, reverses_evidence_id, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12, $13::jsonb)
     ON CONFLICT (evidence_id) DO NOTHING`, [evidence.evidenceId, input.sourceTradeId, stored.binding_digest,
      evidenceDigest, provider.providerId, provider.authorityId, provider.identityDigest, provider.validUntil,
      provider.verifierVersion, evidence.finality, evidence.revision, evidence.reversesEvidenceId, JSON.stringify(evidence)]);
  const persisted = (await client.query<{ source_trade_id: string; evidence_digest: string }>(
    `SELECT source_trade_id, evidence_digest FROM source_verified_evidence WHERE evidence_id = $1 FOR SHARE`,
    [evidence.evidenceId])).rows[0];
  if (!persisted || persisted.source_trade_id !== input.sourceTradeId || persisted.evidence_digest !== evidenceDigest) {
    throw new Error('Source evidence identity collision');
  }
  const head = (await client.query<{ evidence_id: string; revision: string; confirmation_state: SourceVerificationApplicationResult['confirmationState'];
    authority_id: string }>(
    `SELECT head.evidence_id, head.revision::text, head.confirmation_state, evidence.authority_id
     FROM source_verification_heads head JOIN source_verified_evidence evidence ON evidence.evidence_id = head.evidence_id
     WHERE head.source_trade_id = $1 FOR UPDATE OF head`, [input.sourceTradeId])).rows[0];
  if (head?.evidence_id === evidence.evidenceId) return { sourceTradeId: input.sourceTradeId,
    confirmationState: source.confirmation_state, evidenceId: evidence.evidenceId, applied: false, replayed: true };
  const history = (await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM source_verification_history WHERE evidence_id = $1) AS exists`, [evidence.evidenceId])).rows[0];
  if (inserted.rowCount === 0 && history?.exists) return { sourceTradeId: input.sourceTradeId,
    confirmationState: source.confirmation_state, evidenceId: evidence.evidenceId, applied: false, replayed: true };
  if (head && (head.authority_id !== provider.authorityId || BigInt(evidence.revision) <= BigInt(head.revision))) {
    throw new Error('Out-of-order or conflicting source evidence revision/authority');
  }
  if (source.confirmation_state === 'reversed') throw new Error('Reversed source event cannot be resurrected');
  if (head && head.confirmation_state !== source.confirmation_state) throw new Error('Source verification head/state mismatch');
  if (!head && source.confirmation_state !== 'observed') throw new Error('Historical source finality label is not accepted evidence');
  if (evidence.finality === 'reversed') {
    if (!head || head.evidence_id !== evidence.reversesEvidenceId || !['confirmed', 'finalized'].includes(head.confirmation_state)) {
      throw new Error('Source reversal does not reference current accepted evidence');
    }
  } else if (head && !(head.confirmation_state === 'confirmed' && evidence.finality === 'finalized')) {
    throw new Error('Invalid verified source confirmation transition');
  }
  await client.query(
    `INSERT INTO source_verified_position_scopes (wallet_address, chain, token_mint, network, quantity_scale)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (wallet_address, chain, token_mint) DO NOTHING`,
    [source.wallet_address, source.chain, source.token_mint, binding.network, binding.quantityScale]);
  const scope = (await client.query<{ network: string; quantity_scale: number }>(
    `SELECT network, quantity_scale FROM source_verified_position_scopes
     WHERE wallet_address = $1 AND chain = $2 AND token_mint = $3 FOR UPDATE`,
    [source.wallet_address, source.chain, source.token_mint])).rows[0];
  if (!scope || scope.network !== binding.network || scope.quantity_scale !== binding.quantityScale) {
    throw new Error('Source position network/quantity-scale collision');
  }
  await client.query(
    `INSERT INTO wallet_positions (wallet_address, chain, token_mint) VALUES ($1, $2, $3)
     ON CONFLICT (wallet_address, chain, token_mint) DO NOTHING`, [source.wallet_address, source.chain, source.token_mint]);
  const legacy = (await client.query<{ unsafe: boolean }>(
    `SELECT (opening_balance <> 0 OR opening_cost_basis_usd <> 0 OR EXISTS (
       SELECT 1 FROM source_position_applications application LEFT JOIN source_verification_heads accepted
         ON accepted.source_trade_id = application.source_trade_id
       WHERE application.wallet_address = $1 AND application.chain = $2 AND application.token_mint = $3
         AND application.active AND accepted.source_trade_id IS NULL)) AS unsafe
     FROM wallet_positions WHERE wallet_address = $1 AND chain = $2 AND token_mint = $3 FOR UPDATE`,
    [source.wallet_address, source.chain, source.token_mint])).rows[0];
  if (!legacy || legacy.unsafe) throw new Error('Inherited source position opening/application authority is unverified');
  await client.query(
    `INSERT INTO source_position_applications (source_trade_id, wallet_address, chain, token_mint, active, applied_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT (source_trade_id) DO UPDATE
       SET active = EXCLUDED.active, updated_at = EXCLUDED.updated_at`,
    [input.sourceTradeId, source.wallet_address, source.chain, source.token_mint, evidence.finality !== 'reversed', now]);
  await client.query(
    `UPDATE source_trades SET confirmation_state = $2, status = $2, confirmation_updated_at = $3 WHERE id = $1`,
    [input.sourceTradeId, evidence.finality, now]);
  if (head) {
    const updated = await client.query(
      `UPDATE source_verification_heads SET evidence_id = $2, revision = $3::numeric, confirmation_state = $4
       WHERE source_trade_id = $1 AND evidence_id = $5`,
      [input.sourceTradeId, evidence.evidenceId, evidence.revision, evidence.finality, head.evidence_id]);
    if (updated.rowCount !== 1) throw new Error('Locked source verification head changed before transition');
  } else {
    await client.query(
      `INSERT INTO source_verification_heads (source_trade_id, evidence_id, revision, confirmation_state)
       VALUES ($1, $2, $3::numeric, $4)`,
      [input.sourceTradeId, evidence.evidenceId, evidence.revision, evidence.finality]);
  }
  await client.query(
    `INSERT INTO source_verification_history (source_trade_id, evidence_id, from_state, to_state, applied, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6)`, [input.sourceTradeId, evidence.evidenceId, source.confirmation_state,
      evidence.finality, evidence.finality !== 'reversed', now]);
  await client.query(
    `INSERT INTO source_trade_confirmation_history (source_trade_id, confirmation_state, evidence_id, observed_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT (source_trade_id, confirmation_state, evidence_id) DO NOTHING`,
    [input.sourceTradeId, evidence.finality, evidence.evidenceId, now]);
  await rebuildVerifiedSourcePositionWithClient(client, input.sourceTradeId, evidence.evidenceId, now);
  return { sourceTradeId: input.sourceTradeId, confirmationState: evidence.finality,
    evidenceId: evidence.evidenceId, applied: true, replayed: false };
}

/** Complete basis is null whenever a verified acquisition has unknown cost.
 * wallet_positions.cost_basis_usd is only a known-cost subtotal; readers must
 * use this assessment (or equivalent scoped SQL), never label it a total. */
export interface VerifiedSourcePositionAssessment {
  readonly quantity: string;
  readonly costBasisUsd: string | null;
  readonly knownCostBasisSubtotalUsd: string;
  readonly unvaluedAcquisitionCount: number;
  readonly basisAssessment: 'partial' | 'verified';
  readonly network: string;
  readonly quantityScale: number;
}
export async function readVerifiedSourcePositionAssessmentWithClient(client: PoolClient, input: {
  walletAddress: string; chain: SourceVerificationBinding['chain']; tokenMint: string;
}): Promise<VerifiedSourcePositionAssessment | null> {
  const row = (await client.query<{ quantity: string; known_cost_basis_subtotal_usd: string;
    unvalued_acquisition_count: string; network: string; quantity_scale: number }>(
    `SELECT position.balance::text AS quantity, position.cost_basis_usd::text AS known_cost_basis_subtotal_usd,
       scope.unvalued_acquisition_count::text, scope.network, scope.quantity_scale
     FROM wallet_positions position JOIN source_verified_position_scopes scope
       ON scope.wallet_address = position.wallet_address AND scope.chain = position.chain AND scope.token_mint = position.token_mint
     WHERE position.wallet_address = $1 AND position.chain = $2 AND position.token_mint = $3
       AND position.opening_balance = 0 AND position.opening_cost_basis_usd = 0
       AND NOT EXISTS (
         SELECT 1 FROM source_position_applications application LEFT JOIN source_verification_heads head
           ON head.source_trade_id = application.source_trade_id
         WHERE application.wallet_address = position.wallet_address AND application.chain = position.chain
           AND application.token_mint = position.token_mint AND application.active AND head.source_trade_id IS NULL)
     FOR SHARE OF position, scope`, [input.walletAddress, input.chain, input.tokenMint])).rows[0];
  if (!row) return null;
  const count = Number(row.unvalued_acquisition_count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Source position assessment count is invalid');
  const subtotal = exactSourceDecimal(row.known_cost_basis_subtotal_usd)!;
  return { quantity: exactSourceDecimal(row.quantity)!, costBasisUsd: count === 0 ? subtotal : null,
    knownCostBasisSubtotalUsd: subtotal, unvaluedAcquisitionCount: count,
    basisAssessment: count === 0 ? 'verified' : 'partial', network: row.network, quantityScale: row.quantity_scale };
}

/** Deterministic numeric replay in event-time/UUID order. Unknown economics are
 * counted, not silently converted into known zero cost. Snapshot history is
 * append-only; projection updates do not mutate fills/evidence. */
export async function rebuildVerifiedSourcePositionWithClient(client: PoolClient, sourceTradeId: string,
  evidenceId: string | null, now = new Date()): Promise<void> {
  const guarded = (await client.query<{ verified: boolean }>(
    `SELECT (position.opening_balance = 0 AND position.opening_cost_basis_usd = 0
       AND binding.network = scope.network AND binding.quantity_scale = scope.quantity_scale
       AND NOT EXISTS (
         SELECT 1 FROM source_position_applications application LEFT JOIN source_verification_heads accepted
           ON accepted.source_trade_id = application.source_trade_id
         WHERE application.wallet_address = source.wallet_address AND application.chain = source.chain
           AND application.token_mint = source.token_mint AND application.active AND accepted.source_trade_id IS NULL
       )) AS verified
     FROM source_trades source JOIN source_verification_bindings binding ON binding.source_trade_id = source.id
     JOIN source_verification_heads head ON head.source_trade_id = source.id
     JOIN source_verified_position_scopes scope ON scope.wallet_address = source.wallet_address
       AND scope.chain = source.chain AND scope.token_mint = source.token_mint
     JOIN wallet_positions position ON position.wallet_address = source.wallet_address
       AND position.chain = source.chain AND position.token_mint = source.token_mint
     WHERE source.id = $1 FOR UPDATE OF position, scope FOR SHARE OF source, binding, head`, [sourceTradeId])).rows[0];
  if (!guarded?.verified) throw new Error('Source recovery requires verified immutable position scope');
  await client.query(
    `WITH RECURSIVE scope AS (
       SELECT wallet_address, chain, token_mint FROM source_trades WHERE id = $1
     ), ordered AS (
       SELECT ROW_NUMBER() OVER (ORDER BY source.event_at, source.id)::bigint AS sequence,
         source.direction, source.token_amount, source.event_at,
         COALESCE(source.amount_usd, source.price_usd * source.token_amount) AS cost
       FROM source_position_applications application JOIN source_trades source ON source.id = application.source_trade_id
       JOIN source_verification_heads head ON head.source_trade_id = source.id
       JOIN source_verified_evidence evidence ON evidence.evidence_id = head.evidence_id
       JOIN source_verification_bindings binding ON binding.source_trade_id = source.id
       JOIN scope ON scope.wallet_address = source.wallet_address AND scope.chain = source.chain AND scope.token_mint = source.token_mint
       WHERE application.active AND source.confirmation_state IN ('confirmed', 'finalized')
         AND head.confirmation_state = source.confirmation_state AND evidence.binding_digest = binding.binding_digest
     ), ledger AS (
       SELECT 0::bigint AS sequence, 0::numeric AS quantity, 0::numeric AS basis,
         0::numeric AS acquired, 0::numeric AS reduced, 0::numeric AS unmatched,
         0::bigint AS unvalued, NULL::timestamptz AS last_event_at
       UNION ALL
       SELECT event.sequence,
         CASE WHEN event.direction IN ('buy', 'transfer_in') THEN ledger.quantity + event.token_amount
           ELSE GREATEST(0, ledger.quantity - event.token_amount) END,
         CASE WHEN event.direction IN ('buy', 'transfer_in') THEN ledger.basis + COALESCE(event.cost, 0)
           WHEN ledger.quantity = 0 THEN ledger.basis
           ELSE GREATEST(0, ledger.basis - ledger.basis * LEAST(ledger.quantity, event.token_amount) / ledger.quantity) END,
         ledger.acquired + CASE WHEN event.direction IN ('buy', 'transfer_in') THEN event.token_amount ELSE 0 END,
         ledger.reduced + CASE WHEN event.direction IN ('sell', 'transfer_out') THEN event.token_amount ELSE 0 END,
         ledger.unmatched + CASE WHEN event.direction IN ('sell', 'transfer_out') THEN GREATEST(0, event.token_amount - ledger.quantity) ELSE 0 END,
         ledger.unvalued + CASE WHEN event.direction IN ('buy', 'transfer_in') AND event.cost IS NULL THEN 1 ELSE 0 END,
         event.event_at FROM ledger JOIN ordered event ON event.sequence = ledger.sequence + 1
     ), final AS (SELECT * FROM ledger ORDER BY sequence DESC LIMIT 1), updated AS (
       UPDATE wallet_positions position SET balance = final.quantity, cost_basis_usd = final.basis,
         total_acquired_quantity = final.acquired, total_reduced_quantity = final.reduced,
         unmatched_reduction_quantity = final.unmatched, last_event_at = final.last_event_at, updated_at = $3
       FROM scope, final WHERE position.wallet_address = scope.wallet_address AND position.chain = scope.chain
         AND position.token_mint = scope.token_mint RETURNING position.*
     ), assess AS (
       UPDATE source_verified_position_scopes projection SET unvalued_acquisition_count = final.unvalued
       FROM scope, final WHERE projection.wallet_address = scope.wallet_address AND projection.chain = scope.chain
         AND projection.token_mint = scope.token_mint
     ) INSERT INTO source_position_economic_history (source_trade_id, evidence_id, snapshot, recorded_at)
       SELECT $1, $2, jsonb_build_object('quantity', updated.balance::text,
         'costBasisUsd', CASE WHEN final.unvalued = 0 THEN updated.cost_basis_usd::text ELSE NULL END,
         'knownCostBasisSubtotalUsd', updated.cost_basis_usd::text,
         'basisAssessment', CASE WHEN final.unvalued = 0 THEN 'verified' ELSE 'partial' END,
         'acquired', updated.total_acquired_quantity::text, 'reduced', updated.total_reduced_quantity::text,
         'unmatched', updated.unmatched_reduction_quantity::text, 'unvaluedAcquisitions', final.unvalued,
         'lastEventAt', updated.last_event_at), $3 FROM updated, final
       WHERE $2::text IS NOT NULL ON CONFLICT (evidence_id) DO NOTHING`, [sourceTradeId, evidenceId, now]);
}
