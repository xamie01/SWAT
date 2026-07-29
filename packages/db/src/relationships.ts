import { query } from './client.js';
import { resolveChainAddress } from '@swat/shared';
import type { Chain } from '@swat/shared';

/**
 * Record (or reinforce) a funding relationship: `funder` sent SOL to `funded`.
 *
 * Confidence scales with transfer size (a one-off dust transfer is weak
 * evidence; a multi-SOL transfer is strong). Repeated transfers accumulate
 * total lamports and transfer count in `evidence`.
 */
export async function recordFundingEdge(
  funder: string,
  funded: string,
  lamports: number,
  chain: Chain = 'solana'
) {
  const prefixedFunder = resolveChainAddress(funder, chain).prefixed;
  const prefixedFunded = resolveChainAddress(funded, chain).prefixed;
  if (prefixedFunder === prefixedFunded) return;
  if (!Number.isFinite(lamports) || lamports <= 0) return;

  // Map 0–10 SOL onto roughly 0.5–0.95 confidence; clamp.
  const sol = lamports / 1e9;
  const confidence = Math.min(0.95, 0.5 + sol * 0.045);

  await query(
    `INSERT INTO wallet_relationships (wallet_a, wallet_b, relationship_type, confidence, evidence)
     VALUES ($1, $2, 'funding', $3, jsonb_build_object('total_lamports', $4::bigint, 'transfers', 1))
     ON CONFLICT (wallet_a, wallet_b, relationship_type) DO UPDATE SET
       confidence = GREATEST(wallet_relationships.confidence, EXCLUDED.confidence),
       evidence = jsonb_build_object(
         'total_lamports',
         COALESCE((wallet_relationships.evidence->>'total_lamports')::bigint, 0) + $4::bigint,
         'transfers',
         COALESCE((wallet_relationships.evidence->>'transfers')::int, 0) + 1
       ),
       updated_at = NOW()`,
    [prefixedFunder, prefixedFunded, confidence, Math.round(lamports)]
  );
}
