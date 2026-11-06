import { type RedeemableMarket } from '@swat/db';
import { type PolymarketExitTrigger } from './polymarket-exit-race.js';
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
    wait(): Promise<{
        transactionHash: string;
        transactionId?: string | null;
    }>;
}
export interface PolymarketRedemptionClient {
    redeemPositions(input: {
        conditionId: string;
    }): Promise<RedemptionTransaction>;
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
    readonly releasePositionExit: (input: {
        id: string;
        reason: string;
    }) => Promise<void>;
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
export declare function runPolymarketRedemptionSweep(dependencies: RedemptionSweepDependencies): Promise<RedemptionSweepResult>;
export type { RedeemableMarket };
//# sourceMappingURL=polymarket-redemption.d.ts.map