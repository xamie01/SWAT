import { attachLpPoolRisk, listUnassessedLpPools } from '@swat/db';
import { combineTokenRisk } from './score.js';
function toContext(pool) {
    return {
        chain: pool.chain,
        baseTokenMint: pool.baseTokenMint,
        quoteTokenMint: pool.quoteTokenMint,
        poolAddress: pool.poolAddress
    };
}
export async function runRiskPass(deps) {
    const listUnassessed = deps.listUnassessed ?? listUnassessedLpPools;
    const attachRisk = deps.attachRisk ?? attachLpPoolRisk;
    const unassessed = await listUnassessed(200);
    let assessed = 0;
    let failed = 0;
    let skippedNoChecks = 0;
    for (const pool of unassessed) {
        const checks = deps.checksByChain[pool.chain];
        if (!checks || checks.length === 0) {
            // A chain with no configured checks has NOT been looked at. Attaching a
            // score of 0 would present "we have not looked yet" as "clean" and put
            // the pool on the feed — the exact failure the NULL-vs-0 split on
            // lp_pools.risk_score exists to prevent.
            skippedNoChecks += 1;
            continue;
        }
        try {
            const findings = (await Promise.all(checks.map((check) => check(toContext(pool))))).flat();
            const combined = combineTokenRisk(findings);
            await attachRisk(pool.chain, pool.poolAddress, combined.score, combined.flags);
            assessed += 1;
        }
        catch (error) {
            failed += 1;
            console.error('[lp] risk check failed for pool', pool.poolAddress, error instanceof Error ? error.message : error);
        }
    }
    return { assessed, failed, skippedNoChecks };
}
//# sourceMappingURL=risk-pass.js.map