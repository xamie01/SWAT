import { query } from './client.js';

export async function insertSignal(input: {
  patternType: string;
  clusterId?: string | null;
  tokenMint?: string | null;
  confidence: number;
  signalScore: number;
  triggerData: Record<string, unknown>;
}) {
  const rows = await query(
    `INSERT INTO signals (pattern_type, cluster_id, token_mint, confidence, signal_score, trigger_data)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.patternType,
      input.clusterId ?? null,
      input.tokenMint ?? null,
      input.confidence,
      input.signalScore,
      JSON.stringify(input.triggerData)
    ]
  );
  return rows[0];
}

export async function listSignals(limit = 100) {
  return query(
    `SELECT id, pattern_type, cluster_id, token_mint, confidence, signal_score, status, created_at
     FROM signals
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
}
