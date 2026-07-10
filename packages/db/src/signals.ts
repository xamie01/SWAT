import { query } from './client.js';

type SignalInput = {
  patternType: string;
  clusterId?: string | null;
  tokenMint?: string | null;
  confidence: number;
  signalScore: number;
  triggerData: Record<string, unknown>;
  safetyFlags?: string[];
  safetyWarnings?: string[];
  tokenName?: string | null;
  tokenSymbol?: string | null;
};

export async function insertSignal(input: SignalInput) {
  const rows = await query(
    `INSERT INTO signals (pattern_type, cluster_id, token_mint, confidence, signal_score, trigger_data, safety_flags, safety_warnings, token_name, token_symbol)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.patternType,
      input.clusterId ?? null,
      input.tokenMint ?? null,
      input.confidence,
      input.signalScore,
      JSON.stringify(input.triggerData),
      input.safetyFlags ?? [],
      input.safetyWarnings ?? [],
      input.tokenName ?? null,
      input.tokenSymbol ?? null
    ]
  );
  return rows[0];
}

export async function insertSignalWithDedupe(input: SignalInput, dedupeMinutes = 10) {
  const rows = await query<{ inserted: boolean; id: string }>(
    `WITH existing AS (
      SELECT *
      FROM signals
      WHERE pattern_type = $1
        -- Dedupe on (pattern_type, token_mint) only — NOT cluster_id. Clustering
        -- is not a partition: a wallet can appear in several cluster_memberships
        -- rows (e.g. a behavioral cluster is anchored per lexicographic pair, so
        -- one wallet can be the anchor of several distinct clusters). The same
        -- real-world coordinated buy on one token can therefore be detected via
        -- multiple cluster_ids, and keying dedupe on cluster_id let each of those
        -- fire its own "duplicate" signal for the same coin. The user only cares
        -- about not re-alerting the same token/pattern within the window.
        AND token_mint IS NOT DISTINCT FROM $3::varchar
        AND created_at > NOW() - make_interval(mins => $11::int)
      ORDER BY created_at DESC
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO signals (pattern_type, cluster_id, token_mint, confidence, signal_score, trigger_data, safety_flags, safety_warnings, token_name, token_symbol, expires_at)
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + make_interval(mins => $11::int)
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING *
    )
    SELECT true as inserted, id FROM inserted
    UNION ALL
    SELECT false as inserted, id FROM existing`,
    [
      input.patternType,
      input.clusterId ?? null,
      input.tokenMint ?? null,
      input.confidence,
      input.signalScore,
      JSON.stringify(input.triggerData),
      input.safetyFlags ?? [],
      input.safetyWarnings ?? [],
      input.tokenName ?? null,
      input.tokenSymbol ?? null,
      dedupeMinutes
    ]
  );

  return rows[0] ?? null;
}

export async function listSignals(limit = 100) {
  return query(
    `SELECT id, pattern_type, cluster_id, token_mint, confidence, signal_score, status, created_at, expires_at, token_name, token_symbol
     FROM signals
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [limit]
  );
}
