import { claimPolymarketRedemption, confirmPolymarketRedemption, failPolymarketRedemption, listRedeemablePolymarketMarkets, releaseStalePolymarketRedemptionClaims } from '@swat/db';
import { UnrecoverableError } from 'bullmq';
import { mapPolymarketRedemptionToPositions } from './polymarket-exit-race.js';
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
function unwiredPositionExitPort() {
    throw new UnrecoverableError('Polymarket position-exit claim port is not wired; refusing to redeem, because '
        + 'without it the mirrored sell and the redemption can both exit the same position');
}
export async function runPolymarketRedemptionSweep(dependencies) {
    const log = dependencies.log ?? (() => { });
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
        let positions;
        try {
            positions = mapPolymarketRedemptionToPositions(market.conditionId, market.positions);
        }
        catch (error) {
            failed += 1;
            const reason = error instanceof Error ? error.message : String(error);
            log(`[polymarket-redemption] ${market.conditionId} rejected before claiming: ${reason}`);
            continue;
        }
        // One winner per position, not one per trigger. A position the mirrored sell
        // already claimed is skipped here even though the condition as a whole may
        // still be redeemable through its other outcome.
        const claims = [];
        let claimError = null;
        for (const { position, positionKey } of positions) {
            try {
                const claim = await claimPositionExit({
                    positionKey,
                    conditionId: market.conditionId,
                    outcomeTokenId: position.tokenId,
                    exitTrigger: 'redemption',
                    userId
                });
                if (claim)
                    claims.push(claim);
                else {
                    lostRaces += 1;
                    log(`[polymarket-redemption] ${positionKey} is already exiting via the other `
                        + 'trigger; the race has one winner per position');
                }
            }
            catch (error) {
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
                await releaseClaims(claims, releasePositionExit, 'redemption settled without a transaction hash');
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
            log(`[polymarket-redemption] redeemed ${market.conditionId} in ${outcome.transactionHash}`);
        }
        catch (error) {
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
async function releaseClaims(claims, release, reason) {
    for (const claim of claims) {
        await release({ id: claim.id, reason }).catch(() => { });
    }
}
//# sourceMappingURL=polymarket-redemption.js.map