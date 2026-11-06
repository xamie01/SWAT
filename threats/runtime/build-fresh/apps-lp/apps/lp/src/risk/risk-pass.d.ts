import { attachLpPoolRisk, listUnassessedLpPools } from '@swat/db';
import type { TokenRiskCheck } from './types.js';
/**
 * The risk pass (Track C6) — attaches a risk score to every scanned pool so
 * nothing reaches the Discover feed without one.
 *
 * Runs after the scan job, over pools whose `risk_score` is still NULL. One
 * pool's check failing must not block the others: the failed pool simply stays
 * unassessed (and therefore unlisted) until the next pass — "we have not
 * looked yet" is the honest state, and the feed already excludes it.
 */
export interface RiskPassDeps {
    /** Checks per chain; a pool is assessed by its chain's checks. */
    readonly checksByChain: Record<string, readonly TokenRiskCheck[]>;
    readonly listUnassessed?: typeof listUnassessedLpPools;
    readonly attachRisk?: typeof attachLpPoolRisk;
}
export interface RiskPassSummary {
    readonly assessed: number;
    readonly failed: number;
    /** Pools on a chain with no checks configured — left unassessed, never scored 0. */
    readonly skippedNoChecks: number;
}
export declare function runRiskPass(deps: RiskPassDeps): Promise<RiskPassSummary>;
//# sourceMappingURL=risk-pass.d.ts.map