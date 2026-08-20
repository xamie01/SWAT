import {
  claimPolymarketRedemption,
  confirmPolymarketRedemption,
  failPolymarketRedemption,
  listRedeemablePolymarketMarkets,
  releaseStalePolymarketRedemptionClaims
} from '@swat/db';

/**
 * Redemption sweep for resolved Polymarket positions (checklist S3-18).
 *
 * A resolved market stops accepting orders, so a winning position cannot be
 * sold — redemption is the only exit. Without this sweep a winning position
 * stays open in the ledger forever and its collateral is stranded.
 *
 * Verified against the live docs (`trading/positions/manage`), not memory:
 *
 *   * `redeemPositions({conditionId})` returns a transaction; `wait()` resolves
 *     to `{ transactionHash, transactionId }`.
 *   * It takes **no amount** and redeems the wallet's balances for *both*
 *     outcomes. Each winning token returns 1 pUSD, each losing token 0.
 *   * There is **no redemption deadline** — winning tokens stay redeemable
 *     indefinitely, so a market that fails today can always be retried.
 *   * The client selects the correct collateral adapter (`CtfCollateralAdapter`
 *     vs `NegRiskCtfCollateralAdapter`) from the condition id itself. This code
 *     therefore must **not** branch on `negRisk` — doing so would duplicate a
 *     decision the SDK already owns and would silently diverge if Polymarket
 *     changed the mapping.
 *
 * Prerequisite the docs state and this code cannot enforce: the collateral
 * adapter must be approved to transfer the wallet's outcome tokens. A missing
 * approval surfaces as a venue error and is recorded as a failed attempt rather
 * than retried blindly.
 */

export interface RedemptionTransaction {
  wait(): Promise<{ transactionHash: string; transactionId?: string | null }>;
}

export interface PolymarketRedemptionClient {
  redeemPositions(input: { conditionId: string }): Promise<RedemptionTransaction>;
}

export interface RedemptionSweepDependencies {
  readonly client: PolymarketRedemptionClient;
  /** Logical account label. Null for the single-operator Stage 3 posture. */
  readonly userId?: string | null;
  readonly limit?: number;
  /** Claims older than this are released so a crashed sweep cannot wedge a market. */
  readonly staleClaimMs?: number;
  readonly log?: (message: string) => void;
}

export interface RedemptionSweepResult {
  readonly scanned: number;
  readonly redeemed: number;
  readonly failed: number;
  /** Markets another sweep already held. Not an error. */
  readonly skipped: number;
  readonly staleReleased: number;
}

const DEFAULT_STALE_CLAIM_MS = 30 * 60 * 1000;

export async function runPolymarketRedemptionSweep(
  dependencies: RedemptionSweepDependencies
): Promise<RedemptionSweepResult> {
  const log = dependencies.log ?? (() => {});

  // Recover claims stranded by a crash *before* scanning, so a wedged market
  // becomes eligible again in the same pass rather than the next one.
  const staleReleased = await releaseStalePolymarketRedemptionClaims(
    dependencies.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS
  );
  if (staleReleased > 0) {
    log(`[polymarket-redemption] released ${staleReleased} stale claim(s)`);
  }

  const markets = await listRedeemablePolymarketMarkets(dependencies.limit ?? 50);
  let redeemed = 0;
  let failed = 0;
  let skipped = 0;

  for (const market of markets) {
    const claim = await claimPolymarketRedemption({
      conditionId: market.conditionId,
      userId: dependencies.userId ?? null
    });
    if (!claim) {
      // Another sweep holds it. Normal under concurrency, not a failure.
      skipped += 1;
      continue;
    }

    try {
      const transaction = await dependencies.client.redeemPositions({
        conditionId: market.conditionId
      });
      const outcome = await transaction.wait();

      if (!outcome?.transactionHash) {
        // Settled with no hash is not a provable redemption. Recording it as
        // confirmed would put unverifiable money in the ledger, so it is failed
        // and retried — safe because redemption has no deadline and a second
        // call on an already-redeemed market moves no tokens.
        await failPolymarketRedemption({
          id: claim.id,
          reason: 'redemption settled without a transaction hash'
        });
        failed += 1;
        continue;
      }

      await confirmPolymarketRedemption({
        id: claim.id,
        transactionHash: outcome.transactionHash,
        // The venue returns no per-redemption payout figure, and deriving one
        // from the pre-redemption balance would be a guess. Attribution reads
        // the on-chain transfer instead; recording an invented number here would
        // corrupt P&L permanently.
        redeemedCollateral: '0',
        winningTokenId: market.winningTokenId
      });
      redeemed += 1;
      log(
        `[polymarket-redemption] redeemed ${market.conditionId} in ${outcome.transactionHash}`
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await failPolymarketRedemption({ id: claim.id, reason });
      failed += 1;
      log(`[polymarket-redemption] ${market.conditionId} failed: ${reason}`);
    }
  }

  return { scanned: markets.length, redeemed, failed, skipped, staleReleased };
}
