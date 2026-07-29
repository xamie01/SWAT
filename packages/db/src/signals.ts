import { query } from './client.js';
import { resolveChainValue } from '@swat/shared';
import type { Chain } from '@swat/shared';

type SignalInput = {
  patternType: string;
  clusterId?: string | null;
  tokenMint?: string | null;
  chain?: Chain | null;
  confidence: number;
  signalScore: number;
  triggerData: Record<string, unknown>;
  safetyFlags?: string[];
  safetyWarnings?: string[];
  tokenName?: string | null;
  tokenSymbol?: string | null;
};

function resolveSignalTarget(input: SignalInput): { chain: Chain; tokenMint: string | null } {
  if (!input.tokenMint) return { chain: input.chain ?? 'solana', tokenMint: null };
  const resolved = resolveChainValue(input.tokenMint, input.chain ?? undefined);
  return { chain: resolved.chain, tokenMint: resolved.prefixed };
}

export async function insertSignal(input: SignalInput) {
  const { chain, tokenMint } = resolveSignalTarget(input);
  const rows = await query(
    `INSERT INTO signals (pattern_type, cluster_id, token_mint, chain, confidence, signal_score, trigger_data, safety_flags, safety_warnings, token_name, token_symbol)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.patternType,
      input.clusterId ?? null,
      tokenMint,
      chain,
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
  const { chain, tokenMint } = resolveSignalTarget(input);
  // First, check if a recent signal already exists within the dedupe window.
  // This filters out signals outside the time window that the unique index alone
  // cannot enforce (the index only covers status='pending').
  const existing = await query<{ id: string }>(
    `SELECT id FROM signals
     WHERE pattern_type = $1
       AND token_mint IS NOT DISTINCT FROM $2::varchar
       AND created_at > NOW() - make_interval(mins => $3::int)
       AND status IN ('pending', 'executing', 'executed')
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.patternType, tokenMint, dedupeMinutes]
  );

  if (existing.length > 0) {
    return { inserted: false, id: existing[0].id };
  }

  // Insert with ON CONFLICT to handle the race condition atomically.
  // If two concurrent inserts race past the SELECT above, the unique index
  // (pattern_type, token_mint) WHERE status='pending' catches the duplicate.
  const rows = await query<{ id: string }>(
    `INSERT INTO signals (pattern_type, cluster_id, token_mint, chain, confidence, signal_score, trigger_data, safety_flags, safety_warnings, token_name, token_symbol, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW() + make_interval(mins => $12::int))
     ON CONFLICT (pattern_type, token_mint) WHERE status = 'pending' AND token_mint IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      input.patternType,
      input.clusterId ?? null,
      tokenMint,
      chain,
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

  if (rows.length === 0) {
    // ON CONFLICT fired — a pending signal already exists for this token+pattern.
    const dup = await query<{ id: string }>(
      `SELECT id FROM signals WHERE pattern_type = $1 AND token_mint = $2 AND status = 'pending' LIMIT 1`,
      [input.patternType, tokenMint]
    );
    return { inserted: false, id: dup[0]?.id ?? 'unknown' };
  }

  return { inserted: true, id: rows[0].id };
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
