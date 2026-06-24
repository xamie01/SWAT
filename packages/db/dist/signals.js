import { query } from './client.js';
export async function insertSignal(input) {
    const rows = await query(`INSERT INTO signals (pattern_type, cluster_id, token_mint, confidence, signal_score, trigger_data, safety_flags, safety_warnings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`, [
        input.patternType,
        input.clusterId ?? null,
        input.tokenMint ?? null,
        input.confidence,
        input.signalScore,
        JSON.stringify(input.triggerData),
        input.safetyFlags ?? [],
        input.safetyWarnings ?? []
    ]);
    return rows[0];
}
export async function insertSignalWithDedupe(input, dedupeMinutes = 10) {
    const rows = await query(`WITH existing AS (
      SELECT *
      FROM signals
      WHERE pattern_type = $1
        AND cluster_id IS NOT DISTINCT FROM $2::uuid
        AND token_mint IS NOT DISTINCT FROM $3::varchar
        AND created_at > NOW() - make_interval(mins => $9::int)
      ORDER BY created_at DESC
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO signals (pattern_type, cluster_id, token_mint, confidence, signal_score, trigger_data, safety_flags, safety_warnings, expires_at)
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, NOW() + make_interval(mins => $9::int)
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING *
    )
    SELECT true as inserted, id FROM inserted
    UNION ALL
    SELECT false as inserted, id FROM existing`, [
        input.patternType,
        input.clusterId ?? null,
        input.tokenMint ?? null,
        input.confidence,
        input.signalScore,
        JSON.stringify(input.triggerData),
        input.safetyFlags ?? [],
        input.safetyWarnings ?? [],
        dedupeMinutes
    ]);
    return rows[0] ?? null;
}
export async function listSignals(limit = 100) {
    return query(`SELECT id, pattern_type, cluster_id, token_mint, confidence, signal_score, status, created_at, expires_at
     FROM signals
     ORDER BY created_at DESC, id DESC
     LIMIT $1`, [limit]);
}
//# sourceMappingURL=signals.js.map