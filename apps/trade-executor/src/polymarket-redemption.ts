import {
  claimPolymarketRedemption,
  confirmPolymarketRedemption,
  failPolymarketRedemption,
  listRedeemablePolymarketMarkets,
  releaseStalePolymarketRedemptionClaims,
  type RedeemableMarket
} from '@swat/db';
import { UnrecoverableError } from 'bullmq';
import {
  mapPolymarketRedemptionToPositions,
  type PolymarketExitTrigger,
  type PolymarketRedeemedPosition
} from './polymarket-exit-race.js';

/**
 * Redemption sweep for resolved Polymarket positions (checklist S3-18), acting as
 * one of the two racing exit triggers (`S4-M19`) over positions we can prove we
 * hold (`S4-M37`).
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
 *
 * **Two claims, deliberately.** `claimPolymarketRedemption` is keyed by
 * *condition* and guards the on-chain call, which is condition-scoped because
 * `redeemPositions` redeems both outcomes at once. `claimPositionExit` is keyed
 * by *position* and guards the race against the mirrored sell, which is
 * position-scoped because a condition holds two outcomes and a mirrored sell of
 * one must not suppress the exit of the other. Collapsing the two into a single
 * condition-level guard is precisely the mistake `S4-M20` forbids, which is why
 * `mapPolymarketRedemptionToPositions` asserts distinctness on the fan-out before
 * any claim is taken.
 *
 * **Why the position-exit ports are injected rather than imported.** The sweep
 * has to be drivable without Postgres — this repo's pure/DB split — and the race
 * is the part with the interesting decisions in it. Injecting the three claim
 * operations lets the whole race be tested against fakes.
 */

export interface RedemptionTransaction {
  wait(): Promise<{ transactionHash: string; transactionId?: string | null }>;
}

export interface PolymarketRedemptionClient {
  redeemPositions(input: { conditionId: string }): Promise<RedemptionTransaction>;
}

export interface PolymarketPositionExitClaimed {
  readonly id: string;
  readonly positionKey: string;
  readonly exitTrigger: PolymarketExitTrigger;
}

export interface PolymarketPositionExitPorts {
  /**
   * Claim one position for the redemption trigger, or return null when the
   * mirrored sell already won the race for it.
   */
  readonly claimPositionExit: (input: {
    positionKey: string;
    conditionId: string;
    outcomeTokenId: string;
    exitTrigger: PolymarketExitTrigger;
    userId: string | null;
  }) => Promise<PolymarketPositionExitClaimed | null>;
  readonly confirmPositionExit: (input: {
    id: string;
    transactionHash?: string | null;
  }) => Promise<void>;
  readonly releasePositionExit: (input: { id: string; reason: string }) => Promise<void>;
  readonly releaseStalePositionExits?: (olderThanMs: number) => Promise<number>;
}

/**
 * **The exit ports are required, and that is a deliberate change from `Partial`.**
 *
 * They were optional, defaulting to `unwiredPositionExitPort` -- which throws, so
 * the intent was fail-closed. It was not: the only production call site omitted
 * them for months, every market that mapped to a position was counted `failed`,
 * and `S4-M19`'s single-winner claim was **inert in production** while 705 tests
 * stayed green. Found 2026-09-01 while wiring `S4-M45`.
 *
 * A runtime throw cannot catch a *missing wire*, because the code path that would
 * throw is only reached in a deployment nobody tests. Requiring the fields moves
 * the same guarantee to compile time, where omitting one is a type error rather
 * than a silent degradation. `unwiredPositionExitPort` is kept for tests that
 * deliberately exercise the unwired path.
 */
export interface RedemptionSweepDependencies extends PolymarketPositionExitPorts {
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
  /** Positions the mirrored sell had already claimed. The race working, not an error. */
  readonly lostRaces: number;
}

const DEFAULT_STALE_CLAIM_MS = 30 * 60 * 1000;

/**
 * The default when the caller has not wired the position-exit ports.
 *
 * Throws rather than degrading to "redeem anyway". Without a position-scoped
 * claim the two exit triggers can both fire on one position — a master selling
 * moments before resolution is the ordinary case — and the result is the position
 * being exited twice. Refusing costs a stranded position and a loud log; not
 * refusing costs a double exit.
 */
function unwiredPositionExitPort(): never {
  throw new UnrecoverableError(
    'Polymarket position-exit claim port is not wired; refusing to redeem, because '
    + 'without it the mirrored sell and the redemption can both exit the same position'
  );
}

export async function runPolymarketRedemptionSweep(
  dependencies: RedemptionSweepDependencies
): Promise<RedemptionSweepResult> {
  const log = dependencies.log ?? (() => {});
  const userId = dependencies.userId ?? null;
  const staleClaimMs = dependencies.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const claimPositionExit = dependencies.claimPositionExit ?? unwiredPositionExitPort;
  const confirmPositionExit = dependencies.confirmPositionExit ?? unwiredPositionExitPort;
  const releasePositionExit = dependencies.releasePositionExit ?? unwiredPositionExitPort;

  // Recover claims stranded by a crash *before* scanning, so a wedged market
  // becomes eligible again in the same pass rather than the next one. Both
  // ledgers are recovered: a stuck position-exit claim would block the race even
  // after the condition-level redemption claim was released.
  const staleReleased = await releaseStalePolymarketRedemptionClaims(staleClaimMs);
  if (staleReleased > 0) {
    log(`[polymarket-redemption] released ${staleReleased} stale claim(s)`);
  }
  if (dependencies.releaseStalePositionExits) {
    const staleExits = await dependencies.releaseStalePositionExits(staleClaimMs);
    if (staleExits > 0) {
      log(`[polymarket-redemption] released ${staleExits} stale position exit claim(s)`);
    }
  }

  const markets = await listRedeemablePolymarketMarkets({
    userId,
    limit: dependencies.limit ?? 50
  });
  let redeemed = 0;
  let failed = 0;
  let skipped = 0;
  let lostRaces = 0;

  for (const market of markets) {
    // The `S4-M20` fan-out guard, taken before anything is claimed. Going from a
    // condition back to "the position" is the exact step that would merge two
    // outcome rows into one, so it is refused here rather than corrected later.
    let positions: PolymarketRedeemedPosition[];
    try {
      positions = mapPolymarketRedemptionToPositions(market.conditionId, market.positions);
    } catch (error) {
      failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      log(`[polymarket-redemption] ${market.conditionId} rejected before claiming: ${reason}`);
      continue;
    }

    // One winner per position, not one per trigger. A position the mirrored sell
    // already claimed is skipped here even though the condition as a whole may
    // still be redeemable through its other outcome.
    const claims: PolymarketPositionExitClaimed[] = [];
    let claimError: string | null = null;
    for (const { position, positionKey } of positions) {
      try {
        const claim = await claimPositionExit({
          positionKey,
          conditionId: market.conditionId,
          outcomeTokenId: position.tokenId,
          exitTrigger: 'redemption',
          userId
        });
        if (claim) claims.push(claim);
        else {
          lostRaces += 1;
          log(
            `[polymarket-redemption] ${positionKey} is already exiting via the other `
            + 'trigger; the race has one winner per position'
          );
        }
      } catch (error) {
        claimError = error instanceof Error ? error.message : String(error);
        break;
      }
    }

    if (claimError) {
      await releaseClaims(claims, releasePositionExit, claimError);
      failed += 1;
      log(`[polymarket-redemption] ${market.conditionId} exit claim failed: ${claimError}`);
      continue;
    }
    if (claims.length === 0) {
      // Every outcome we hold in this condition is already exiting elsewhere.
      skipped += 1;
      continue;
    }

    const claim = await claimPolymarketRedemption({
      conditionId: market.conditionId,
      userId
    });
    if (!claim) {
      // Another sweep holds it. Normal under concurrency, not a failure.
      await releaseClaims(claims, releasePositionExit, 'another sweep holds the condition claim');
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
        await releaseClaims(
          claims,
          releasePositionExit,
          'redemption settled without a transaction hash'
        );
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
      // Confirmed per position, not per condition: the redemption transaction is
      // the evidence for every outcome row it settled, and each row is a separate
      // position whose exit is now finished.
      for (const positionClaim of claims) {
        await confirmPositionExit({
          id: positionClaim.id,
          transactionHash: outcome.transactionHash
        });
      }
      redeemed += 1;
      log(
        `[polymarket-redemption] redeemed ${market.conditionId} in ${outcome.transactionHash}`
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await failPolymarketRedemption({ id: claim.id, reason });
      await releaseClaims(claims, releasePositionExit, reason);
      failed += 1;
      log(`[polymarket-redemption] ${market.conditionId} failed: ${reason}`);
    }
  }

  return { scanned: markets.length, redeemed, failed, skipped, staleReleased, lostRaces };
}

/**
 * Hand every position claim back so the race can be re-run.
 *
 * A claim left behind would block both triggers forever on a position that was
 * never actually exited — the single-shot guard turned into a permanent stop.
 * Release failures are swallowed on purpose: the caller is already handling the
 * error that got us here, and the stale-claim sweep recovers anything left.
 */
async function releaseClaims(
  claims: readonly PolymarketPositionExitClaimed[],
  release: (input: { id: string; reason: string }) => Promise<void>,
  reason: string
): Promise<void> {
  for (const claim of claims) {
    await release({ id: claim.id, reason }).catch(() => {});
  }
}

export type { RedeemableMarket };
