import type { Chain } from '@swat/shared';

/**
 * Which Solana executor a job routes to (checklist S3-7 cutover seam).
 *
 * Two paths exist at once and that is deliberate. Trojan is the incumbent;
 * Jupiter+Jito is built and unit-tested but **not certified** — `S3-9` requires a
 * capped live canary recorded under `docs/certification/solana.md`, and
 * `LIVE_ENABLED_CHAINS` plus an active `chain_certifications` row gate it besides.
 *
 * Cutting `handleJob` straight over would put an uncertified path on the money
 * path the moment Solana went live, which inverts the audit's own ordering: the
 * canary is supposed to run *before* the path carries real trades, not after.
 * So the selection is a flag that defaults to the certified path, and flipping it
 * is a config change rather than a code change — the same expand-and-contract
 * shape used for the per-chain queue split (`S3-25`).
 *
 * Retiring Trojan (`S3-6`) is what removes this seam, and it is explicitly gated
 * on `S3-9` certification.
 */

export type SolanaExecutorKind = 'trojan' | 'jupiter-jito';

/** Values `trades.executor` may hold. The column is `varchar(20)`. */
export type ExecutorName = 'trojan' | 'jupiter-jito' | 'robinhood-univ3';

/**
 * Reads the configured Solana executor.
 *
 * Defaults to `trojan`: an unset or malformed value must never silently promote
 * the uncertified path. An explicitly wrong value throws rather than falling
 * back, because a typo in an execution-routing variable should fail loudly at
 * startup, not route trades somewhere the operator did not intend.
 */
export function resolveSolanaExecutor(
  environment: NodeJS.ProcessEnv = process.env
): SolanaExecutorKind {
  const raw = environment.SOLANA_EXECUTOR?.trim();
  if (!raw) return 'trojan';
  if (raw !== 'trojan' && raw !== 'jupiter-jito') {
    throw new Error(
      `SOLANA_EXECUTOR must be 'trojan' or 'jupiter-jito', got '${raw}'`
    );
  }
  return raw;
}

/**
 * Whether the Jupiter+Jito path may carry a live trade.
 *
 * Both conditions are required, and neither implies the other: the flag is
 * operator intent, the readiness check is whether a signer and block engine are
 * actually configured. This mirrors the `LIVE_ENABLED_CHAINS` +
 * `chain_certifications` pairing that gates live mode generally — one control
 * cannot stand in for the other.
 */
export function shouldUseJupiterJito(input: {
  chain: Chain;
  configured: SolanaExecutorKind;
  jitoReady: boolean;
}): boolean {
  if (input.chain !== 'solana') return false;
  return input.configured === 'jupiter-jito' && input.jitoReady;
}

/** The value written to `trades.executor` for a Solana trade. */
export function solanaExecutorName(kind: SolanaExecutorKind): ExecutorName {
  return kind === 'jupiter-jito' ? 'jupiter-jito' : 'trojan';
}
